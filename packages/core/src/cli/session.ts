import type { ByteTransport, Unsubscribe } from "../transport.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("latin1");

const ERROR_LINE = /^###ERROR[^\n]*/gm;
const ENTER_SETTLE_MS = 120;
const ENTER_ATTEMPT_TIMEOUT_MS = 700;
const ENTER_ATTEMPTS = 4;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CliTimeoutError extends Error {
  constructor(readonly command: string) {
    super(`CLI command timed out: ${command}`);
    this.name = "CliTimeoutError";
  }
}

export interface CliResult {
  command: string;
  /** Command output without the echoed command or the following prompt. */
  output: string;
  errors: string[];
}

interface Waiter {
  marker: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Text session with the Betaflight CLI.
 *
 * Command completion is detected deterministically: a comment holding a unique
 * sentinel is sent straight after each command. The firmware handles bytes in
 * order and echoes input, so seeing the sentinel means the command has finished.
 * Comments are stripped before parsing, so the sentinel has no effect.
 */
export class CliSession {
  private buffer = "";
  private waiter: Waiter | undefined;
  private sentinelCounter = 0;
  private silenced = 0;
  private readonly outputListeners = new Set<(text: string) => void>();
  private readonly unsubscribe: Unsubscribe;
  private active = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly transport: ByteTransport) {
    this.unsubscribe = transport.onData((chunk) => this.handleData(chunk));
  }

  get isActive(): boolean {
    return this.active;
  }

  dispose(): void {
    this.unsubscribe();
    this.outputListeners.clear();
    this.active = false;
  }

  /** Subscribes to raw terminal text. Output from {@link runQuietly} is not delivered. */
  onOutput(listener: (text: string) => void): Unsubscribe {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  /**
   * Enters CLI mode. Safe to call when the firmware is already in CLI mode.
   *
   * The `#` must travel alone: the firmware discards anything else it reads in the
   * same pass as the byte that switches it into CLI mode.
   */
  async enter(): Promise<void> {
    this.active = true;
    this.buffer = "";
    this.silenced++;
    try {
      await this.transport.write(encoder.encode("#"));
      await delay(ENTER_SETTLE_MS);
      await this.syncWithSentinel();
    } catch (error) {
      this.active = false;
      throw error;
    } finally {
      this.silenced--;
    }
  }

  /**
   * Runs one command and shows it in the terminal once it has finished. The raw
   * exchange stays hidden so the completion sentinel never reaches the user.
   */
  run(command: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<CliResult> {
    return this.enqueue(async () => {
      this.silenced++;
      let result: CliResult;
      try {
        result = await this.execute(command, timeoutMs);
      } finally {
        this.silenced--;
      }
      const transcript = `# ${command}\n${result.output ? `${result.output}\n` : ""}`;
      for (const listener of [...this.outputListeners]) listener(transcript);
      return result;
    });
  }

  /** Same as {@link run}, without showing the exchange in the interactive terminal. */
  runQuietly(command: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<CliResult> {
    return this.enqueue(async () => {
      this.silenced++;
      try {
        return await this.execute(command, timeoutMs);
      } finally {
        this.silenced--;
      }
    });
  }

  /** Sends text as typed at the terminal. The reply arrives through {@link onOutput}. */
  sendInteractive(line: string): Promise<void> {
    return this.transport.write(encoder.encode(`${line}\r`));
  }

  /** Sends a command that reboots the board, so no prompt will follow. */
  async sendFinal(command: string): Promise<void> {
    this.active = false;
    await this.transport.write(encoder.encode(`${command}\r`));
  }

  /** Leaves the CLI. The firmware reboots unless `reboot` is false and supports `noreboot`. */
  async exit(reboot = true): Promise<void> {
    await this.sendFinal(reboot ? "exit" : "exit noreboot");
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async execute(command: string, timeoutMs: number): Promise<CliResult> {
    if (!this.active) throw new Error("CLI session is not active");
    this.buffer = "";
    const marker = this.nextSentinel();
    await this.transport.write(encoder.encode(`${command}\r#${marker}\r`));
    await this.waitFor(marker, timeoutMs, command);

    const output = extractOutput(this.buffer, command, marker);
    return { command, output, errors: output.match(ERROR_LINE) ?? [] };
  }

  private async syncWithSentinel(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const marker = this.nextSentinel();
      await this.transport.write(encoder.encode(`\r#${marker}\r`));
      try {
        await this.waitFor(marker, ENTER_ATTEMPT_TIMEOUT_MS, "enter CLI");
        return;
      } catch (error) {
        if (attempt >= ENTER_ATTEMPTS) throw error;
      }
    }
  }

  private nextSentinel(): string {
    this.sentinelCounter += 1;
    return `~bfm${this.sentinelCounter}~`;
  }

  private waitFor(marker: string, timeoutMs: number, label: string): Promise<void> {
    if (this.buffer.includes(marker)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new CliTimeoutError(label));
      }, timeoutMs);
      this.waiter = { marker, resolve, reject, timer };
    });
  }

  private handleData(chunk: Uint8Array): void {
    if (!this.active) return;
    const text = decoder.decode(chunk);
    this.buffer += text;
    if (this.silenced === 0) for (const listener of [...this.outputListeners]) listener(text);

    const waiter = this.waiter;
    if (waiter && this.buffer.includes(waiter.marker)) {
      clearTimeout(waiter.timer);
      this.waiter = undefined;
      waiter.resolve();
    }
  }
}

/** Removes the echoed command, trailing prompt and sentinel from captured text. */
export function extractOutput(captured: string, command: string, marker: string): string {
  const normalised = captured.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const sentinelIndex = normalised.indexOf(`#${marker}`);
  let body = sentinelIndex >= 0 ? normalised.slice(0, sentinelIndex) : normalised;

  const echoIndex = body.indexOf(command);
  if (echoIndex >= 0) {
    const lineEnd = body.indexOf("\n", echoIndex);
    body = lineEnd >= 0 ? body.slice(lineEnd + 1) : "";
  }

  return body.replace(/\n?# ?$/, "").replace(/\n+$/, "");
}
