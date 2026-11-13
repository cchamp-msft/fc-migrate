import type { ByteTransport, Unsubscribe } from "../transport.js";
import { encodeRequest, MspDecoder, type MspFrame } from "./codec.js";

export class MspTimeoutError extends Error {
  constructor(readonly command: number) {
    super(`MSP command ${command} timed out`);
    this.name = "MspTimeoutError";
  }
}

export class MspRemoteError extends Error {
  constructor(readonly command: number) {
    super(`Flight controller rejected MSP command ${command}`);
    this.name = "MspRemoteError";
  }
}

export interface MspRequestOptions {
  timeoutMs?: number;
  retries?: number;
}

interface PendingRequest {
  command: number;
  resolve: (payload: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 1000;

/** Request/response MSP client. Requests are serialised so replies cannot be confused. */
export class MspClient {
  private readonly decoder = new MspDecoder();
  private pending: PendingRequest | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: Unsubscribe;

  constructor(private readonly transport: ByteTransport) {
    this.unsubscribe = transport.onData((chunk) => {
      for (const frame of this.decoder.push(chunk)) this.handleFrame(frame);
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.pending?.reject(new Error("MSP client disposed"));
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
  }

  request(command: number, payload?: Uint8Array, options: MspRequestOptions = {}): Promise<Uint8Array> {
    const run = () => this.attempt(command, payload, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.retries ?? 0);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Sends a command whose reply cannot be relied on, such as a reboot request. */
  async sendWithoutReply(command: number, payload?: Uint8Array): Promise<void> {
    await this.transport.write(encodeRequest(command, payload));
  }

  private async attempt(command: number, payload: Uint8Array | undefined, timeoutMs: number, retries: number): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.exchange(command, payload, timeoutMs);
      } catch (error) {
        if (!(error instanceof MspTimeoutError) || attempt >= retries) throw error;
      }
    }
  }

  private exchange(command: number, payload: Uint8Array | undefined, timeoutMs: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new MspTimeoutError(command));
      }, timeoutMs);
      this.pending = { command, resolve, reject, timer };
      this.transport.write(encodeRequest(command, payload)).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private handleFrame(frame: MspFrame): void {
    const pending = this.pending;
    if (!pending || pending.command !== frame.command) return;
    clearTimeout(pending.timer);
    this.pending = undefined;
    if (frame.error) pending.reject(new MspRemoteError(frame.command));
    else pending.resolve(frame.payload);
  }
}
