import {
  FcLink,
  FcRebootingError,
  parseConfig,
  parseCurrentValues,
  schemaFromCli,
  type ByteTransport,
  type CompletionContext,
  type ConfigDocument,
  type ConfigSnapshot,
  type FcIdentity,
} from "@bf-migrate/core";
import { SimulatedFc } from "@bf-migrate/core/testing";
import { defineStore } from "pinia";
import { computed, markRaw, ref, shallowRef } from "vue";
import { demoProfile } from "../demo/profile";
import { WebSerialTransport } from "../transport/web-serial";

export type ConnectionStatus = "idle" | "connecting" | "rebooting" | "connected" | "lost";

const MAX_TERMINAL_CHARS = 200_000;
const REBOOT_SETTLE_MS = 1200;
const OPEN_RETRY_MS = 300;
const OPEN_TIMEOUT_MS = 15_000;
const IDENTIFY_ATTEMPTS = 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openWithRetry(transport: ByteTransport): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await transport.open();
      return;
    } catch (error) {
      if (Date.now() - started > OPEN_TIMEOUT_MS) throw error;
      await delay(OPEN_RETRY_MS);
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotFoundError") return "";
  if (error instanceof DOMException && error.name === "NetworkError") return "The port is busy. Close Betaflight Configurator or any other app using it, then try again.";
  return error instanceof Error ? error.message : String(error);
}

/** Lists what `feature list` or `beeper list` reports as available. */
function parseAvailable(text: string): string[] {
  const line = text.split("\n").find((entry) => /^Available/i.test(entry));
  const source = line ? line.replace(/^Available:?/i, "") : text;
  return source.split(/\s+/).filter((token) => /^[A-Z][A-Z0-9_]+$/.test(token));
}

export const useConnectionStore = defineStore("connection", () => {
  const status = ref<ConnectionStatus>("idle");
  const error = ref("");
  const isDemo = ref(false);
  const identity = shallowRef<FcIdentity>();
  const snapshot = shallowRef<ConfigSnapshot>();
  const completion = shallowRef<CompletionContext>();
  const terminal = ref("");
  const link = shallowRef<FcLink>();
  let transport: ByteTransport | undefined;
  let stopTerminal: (() => void) | undefined;
  let stopClose: (() => void) | undefined;
  let expectingClose = false;

  const isConnected = computed(() => status.value === "connected");
  const isBusy = computed(() => status.value === "connecting" || status.value === "rebooting");
  const diff = computed<ConfigDocument | undefined>(() => (snapshot.value ? parseConfig(snapshot.value.diffAll) : undefined));

  function appendTerminal(text: string): void {
    const next = terminal.value + text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    terminal.value = next.length > MAX_TERMINAL_CHARS ? next.slice(-MAX_TERMINAL_CHARS) : next;
  }

  function releaseLink(): void {
    stopTerminal?.();
    stopClose?.();
    stopTerminal = undefined;
    stopClose = undefined;
    link.value?.dispose();
    link.value = undefined;
  }

  async function establish(active: ByteTransport): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      await openWithRetry(active);
      const candidate = markRaw(new FcLink(active));
      try {
        identity.value = await candidate.identify();
        link.value = candidate;
        break;
      } catch (reason) {
        candidate.dispose();
        expectingClose = true;
        await active.close().catch(() => undefined);
        expectingClose = false;
        if (!(reason instanceof FcRebootingError) || attempt >= IDENTIFY_ATTEMPTS) throw reason;
        await delay(REBOOT_SETTLE_MS);
      }
    }

    const current = link.value;
    const captured = await current.readSnapshot();
    snapshot.value = captured;
    const featureList = await current.cli.runQuietly("feature list").catch(() => undefined);
    const beeperList = await current.cli.runQuietly("beeper list").catch(() => undefined);

    completion.value = markRaw({
      schema: schemaFromCli({
        firmwareVersion: identity.value!.firmwareVersion,
        source: "live-board",
        capturedFrom: identity.value!.board.boardName,
        getOutput: captured.get,
        helpOutput: captured.help,
      }),
      currentValues: parseCurrentValues(captured.get),
      features: featureList ? parseAvailable(featureList.output) : [],
      beepers: beeperList ? parseAvailable(beeperList.output) : [],
    });

    stopTerminal = current.cli.onOutput(appendTerminal);
    stopClose = active.onClose((reason) => {
      if (reason === "lost" && !expectingClose) handleLost();
    });
    status.value = "connected";
  }

  /** Forgets everything read from the board, so no page keeps showing it. */
  function clearBoard(): void {
    identity.value = undefined;
    snapshot.value = undefined;
    completion.value = undefined;
    terminal.value = "";
    isDemo.value = false;
  }

  function markLost(reason: string): void {
    releaseLink();
    transport = undefined;
    clearBoard();
    status.value = "lost";
    error.value = reason;
  }

  function handleLost(): void {
    markLost("The board disconnected.");
  }

  async function connectWith(makeTransport: () => Promise<ByteTransport>, demo: boolean): Promise<void> {
    if (isBusy.value) return;
    error.value = "";
    status.value = "connecting";
    try {
      transport = await makeTransport();
      isDemo.value = demo;
      terminal.value = "";
      await establish(transport);
    } catch (reason) {
      releaseLink();
      await transport?.close().catch(() => undefined);
      transport = undefined;
      clearBoard();
      status.value = "idle";
      error.value = describeError(reason);
    }
  }

  function connectSerial(): Promise<void> {
    return connectWith(() => WebSerialTransport.choosePort(), false);
  }

  function connectDemo(): Promise<void> {
    return connectWith(async () => markRaw(new SimulatedFc(demoProfile, { latencyMs: 1 })), true);
  }

  async function disconnect(): Promise<void> {
    const current = link.value;
    const active = transport;
    expectingClose = true;
    transport = undefined;
    // Clear first: closing a port can be slow, and the pages should not wait for it.
    clearBoard();
    status.value = "idle";
    error.value = "";
    if (current?.cli.isActive) await current.cli.exit().catch(() => undefined);
    releaseLink();
    await active?.close().catch(() => undefined);
    expectingClose = false;
  }

  /** Sends the board to its ROM bootloader. The serial port disappears when it does. */
  async function enterBootloader(): Promise<void> {
    const active = transport;
    const current = link.value;
    if (!active || !current) throw new Error("The board is not connected.");
    status.value = "rebooting";
    expectingClose = true;
    if (current.cli.isActive) await current.cli.sendFinal("bl rom");
    else await current.rebootToBootloader();
    releaseLink();
    await active.close().catch(() => undefined);
    expectingClose = false;
  }

  /** Reconnects to the board's serial port once new firmware has started. */
  async function reconnectAfterFlash(): Promise<void> {
    const active = transport;
    if (!active) throw new Error("The serial connection was lost.");
    status.value = "rebooting";
    await delay(REBOOT_SETTLE_MS);
    await establish(active);
  }

  /** Saves the configuration. The firmware restarts, so the connection is re-established. */
  async function saveAndReconnect(): Promise<void> {
    const session = link.value?.cli;
    if (!session) throw new Error("The board is not connected.");
    await session.sendFinal("save");
    await reconnectAfterReboot();
  }

  /** Reconnects after a command that reboots the board, such as `save`. */
  async function reconnectAfterReboot(): Promise<void> {
    const active = transport;
    if (!active) return;
    status.value = "rebooting";
    expectingClose = true;
    releaseLink();
    await active.close().catch(() => undefined);
    expectingClose = false;
    await delay(REBOOT_SETTLE_MS);
    try {
      await establish(active);
      appendTerminal("\n# Board restarted and reconnected.\n");
    } catch (reason) {
      markLost(`The board did not come back: ${describeError(reason)}`);
    }
  }

  return {
    status,
    error,
    isDemo,
    identity,
    snapshot,
    completion,
    terminal,
    link,
    diff,
    isConnected,
    isBusy,
    connectSerial,
    connectDemo,
    disconnect,
    reconnectAfterReboot,
    enterBootloader,
    reconnectAfterFlash,
    saveAndReconnect,
    appendTerminal,
  };
});
