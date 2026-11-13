import {
  ALPHA_TEXTS,
  buildBoardReport,
  classifyBoard,
  DfuFlasher,
  isMigratedAlpha,
  SessionError,
  type AlphaTextKey,
  type Classification,
  type ConnectMode,
  type DfuProgress,
  type G4Readings,
  type G4Session,
  type UsbDeviceLike,
} from "@bf-migrate/core";
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { ALPHA_HD_FIRMWARE } from "../data/hosted-firmware";
import { STM32_DFU_FILTER, waitForAuthorizedDfuDevice } from "../utils/dfu-device";
import { loadHostedAlphaImage, readAlphaImage, type ChosenImage } from "../utils/firmware-image";
import { saveFile } from "../utils/save-file";
import { useConnectionStore } from "./connection";

/** Where the ST-Link session comes from: a real probe the user chose, or the demo simulator. */
export interface ProbeSource {
  simulated: boolean;
  /** `onAttached` fires in `holdReset` mode once the pilot can let go of the button. */
  open(mode: ConnectMode, onAttached?: () => void): Promise<G4Session>;
  /** Demo only: stands in for the pilot pressing and releasing the board's reset button. */
  pressReset?(): void;
  releaseReset?(): void;
}

export type AlphaStep =
  | "intro"
  | "variant"
  | "wiring"
  | "probe"
  | "connecting"
  | "hold-reset"
  | "confirm-chip"
  | "report"
  | "firmware"
  | "unlock"
  | "write"
  | "working"
  | "done"
  | "stopped"
  | "failed";

export type { ChosenImage };

export type UsbStep = "idle" | "working" | "permission" | "done" | "failed";

const DEMO_ON_HARDWARE = "The demo's stand-in image is not firmware and would lock a real board up. Choose a Betaflight .hex file for this board.";

function describeError(reason: unknown): string {
  if (reason instanceof SessionError) {
    const hint: Record<SessionError["kind"], string> = {
      "no-target": "Check the three wires and that the board has USB power. A permanently locked chip (Level 2) looks the same, and nothing can recover it.",
      "wrong-chip": "Nothing has been changed.",
      "probe-firmware": "Update the ST-Link with ST's ST-LinkUpgrade tool, then try again.",
      usb: "Check the ST-Link's USB cable, then try again.",
      timeout: "Check the wires, then try again.",
      flash: "Try again. The ST-Link can always rewrite an unlocked board.",
      refused: "Choose a Betaflight .hex file for this board.",
    };
    const sentence = reason.message.endsWith(".") ? reason.message : `${reason.message}.`;
    return `${sentence} ${hint[reason.kind]}`;
  }
  return reason instanceof Error ? reason.message : String(reason);
}

/** Runs Alpha Migrate. Every change to the chip waits for a confirmation recorded here. */
export const useAlphaStore = defineStore("alpha", () => {
  const connection = useConnectionStore();
  const step = ref<AlphaStep>("intro");
  const source = shallowRef<ProbeSource>();
  const session = shallowRef<G4Session>();
  /** Kept after the session closes, for the report. */
  const probeInfo = shallowRef<G4Session["probe"]>();
  const readings = shallowRef<G4Readings>();
  const classification = shallowRef<Classification>();
  /** The ST-Link flow's image. Cleared whenever the probe changes, so a simulated choice never reaches a real chip. */
  const chosen = shallowRef<ChosenImage>();
  /** The USB rewrite's image, kept apart from the ST-Link flow's: a board on USB is always real. */
  const usbChosen = shallowRef<ChosenImage>();
  const confirmations = ref<{ id: string; version: number; at: string }[]>([]);
  const reportSaved = ref(false);
  const clearBootPin = ref(true);
  const keepSettings = ref(true);
  const message = ref("");
  const progress = ref<{ done: number; total: number }>();
  const error = ref("");
  /** Where the flow returns to after a failure the pilot can retry. */
  const resumeAt = ref<AlphaStep>("probe");
  /** True between attaching under reset and the pilot releasing the button. */
  const awaitingRelease = ref(false);
  const usbStep = ref<UsbStep>("idle");
  /** True while this site's release is downloading. */
  const hostedLoading = ref(false);
  const usbMessage = ref("");
  const usbProgress = ref<DfuProgress>();

  const simulated = computed(() => source.value?.simulated ?? false);
  const migratedOverUsb = computed(() => !!connection.identity && !connection.isDemo && isMigratedAlpha(connection.identity));

  function confirm(key: AlphaTextKey): void {
    const text = ALPHA_TEXTS[key];
    confirmations.value = [...confirmations.value, { id: text.id, version: text.version, at: new Date().toISOString() }];
  }

  /**
   * Stops the flow and lets go of the ST-Link, which also lets a chip halted under
   * reset run again. A retry reconnects and reads the chip afresh.
   */
  function fail(reason: unknown, retryAt: AlphaStep): void {
    error.value = describeError(reason);
    resumeAt.value = retryAt;
    message.value = "";
    progress.value = undefined;
    step.value = "failed";
    void closeSession();
  }

  async function closeSession(): Promise<void> {
    const current = session.value;
    session.value = undefined;
    await current?.close().catch(() => undefined);
  }

  async function reset(): Promise<void> {
    await closeSession();
    source.value = undefined;
    probeInfo.value = undefined;
    readings.value = undefined;
    classification.value = undefined;
    chosen.value = undefined;
    confirmations.value = [];
    reportSaved.value = false;
    clearBootPin.value = true;
    keepSettings.value = true;
    message.value = "";
    progress.value = undefined;
    error.value = "";
    step.value = "intro";
  }

  function goTo(next: AlphaStep): void {
    error.value = "";
    step.value = next;
  }

  function useSource(next: ProbeSource): void {
    // An image chosen for one probe (the demo's stand-in for the simulated one) never carries over.
    chosen.value = undefined;
    source.value = next;
    void connect("hotplug");
  }

  /** Reads the chip after a successful connect, and decides where the flow goes. */
  async function identify(): Promise<void> {
    const current = session.value;
    if (!current) return;
    message.value = "Reading the chip";
    readings.value = await current.readAll();
    classification.value = classifyBoard(readings.value);
    message.value = "";
    step.value = "confirm-chip";
  }

  async function connect(mode: ConnectMode): Promise<void> {
    const probe = source.value;
    if (!probe) return goTo("probe");
    await closeSession();
    step.value = "connecting";
    message.value = mode === "holdReset" ? "Connecting. Keep holding the reset button" : "Connecting to the chip";
    try {
      session.value = await probe.open(mode, () => {
        awaitingRelease.value = true;
        message.value = "Connected. Release the reset button now";
      });
      awaitingRelease.value = false;
      probeInfo.value = session.value.probe;
      await identify();
    } catch (reason) {
      awaitingRelease.value = false;
      // A running Alpha uses the clock pin, so the first try often fails until reset is held.
      if (reason instanceof SessionError && reason.kind === "no-target" && mode === "hotplug") {
        message.value = "";
        step.value = "hold-reset";
        return;
      }
      fail(reason, mode === "holdReset" ? "hold-reset" : "probe");
    }
  }

  /** After the pilot confirms the chip, the next step depends on what is on it. */
  function chipConfirmed(): void {
    const found = classification.value;
    if (!found) return;
    confirm("confirmChip");
    if (found.kind === "wrong-chip" || found.kind === "protected") {
      void closeSession();
      return goTo("stopped");
    }
    goTo(found.kind === "locked" ? "report" : "firmware");
  }

  function saveReport(): void {
    const probe = probeInfo.value;
    if (!probe || !readings.value || !classification.value) return;
    const report = buildBoardReport({ probe, readings: readings.value, classification: classification.value, confirmations: confirmations.value, simulated: simulated.value });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    saveFile(`g4-alpha-report_${simulated.value ? "SIMULATED_" : ""}${readings.value.uid ?? "unknown"}_${stamp}.json`, `${JSON.stringify(report, null, 2)}\n`, "application/json");
    reportSaved.value = true;
  }

  async function chooseImage(name: string, text: string): Promise<void> {
    try {
      chosen.value = await readAlphaImage(name, text, !simulated.value);
    } catch (reason) {
      chosen.value = undefined;
      error.value = describeError(reason);
    }
  }

  /** Loads this site's release for the board, for the ST-Link flow or the USB rewrite. */
  async function chooseHosted(target: "stlink" | "usb"): Promise<void> {
    const firmware = ALPHA_HD_FIRMWARE;
    hostedLoading.value = true;
    if (target === "usb") {
      usbStep.value = "idle";
      usbMessage.value = "";
    } else error.value = "";
    try {
      const loaded = await loadHostedAlphaImage(firmware, target === "usb" || !simulated.value);
      if (target === "usb") usbChosen.value = loaded;
      else chosen.value = loaded;
    } catch (reason) {
      if (target === "usb") {
        usbChosen.value = undefined;
        failUsb(reason);
      } else {
        chosen.value = undefined;
        error.value = describeError(reason);
      }
    } finally {
      hostedLoading.value = false;
    }
  }

  async function chooseUsbImage(name: string, text: string): Promise<void> {
    usbStep.value = "idle";
    usbMessage.value = "";
    try {
      usbChosen.value = await readAlphaImage(name, text, true);
    } catch (reason) {
      usbChosen.value = undefined;
      usbStep.value = "failed";
      usbMessage.value = describeError(reason);
    }
  }

  function firmwareConfirmed(): void {
    if (!chosen.value?.check.ok) return;
    confirm("firmware");
    // Recorded only when the pilot keeps the change, so the report says what was agreed.
    if (classification.value?.bootPinHonoured && clearBootPin.value) confirm("bootPin");
    goTo(classification.value?.kind === "locked" ? "unlock" : "write");
  }

  async function run(label: string, work: () => Promise<void>, retryAt: AlphaStep): Promise<boolean> {
    step.value = "working";
    message.value = label;
    progress.value = undefined;
    try {
      await work();
      progress.value = undefined;
      return true;
    } catch (reason) {
      fail(reason, retryAt);
      return false;
    }
  }

  /** The one-way step. Only reachable after the typed confirmation. */
  async function unlock(typed: string): Promise<void> {
    const current = session.value;
    if (!current || typed.trim() !== ALPHA_TEXTS.unlock.typed || classification.value?.kind !== "locked") return;
    // Every stage can be opened at any time, so the one-way step checks its own prerequisites.
    if (!reportSaved.value || !chosen.value?.check.ok) return;
    confirm("unlock");
    const ok = await run("Removing read protection. The chip is erasing itself; this takes a few seconds", () => current.removeReadProtection({ clearSwBoot0: clearBootPin.value && !!classification.value?.bootPinHonoured }), "probe");
    if (!ok) return;
    // Read again, so the next step works from what the chip now reports, not from memory.
    try {
      await identify();
    } catch (reason) {
      return fail(reason, "probe");
    }
    const after: Classification | undefined = classification.value;
    if (after?.kind !== "blank") return fail(new Error(`After the erase the board reads as "${after?.title ?? "unreadable"}", not empty. Nothing more was written. Save the report and stop here.`), "probe");
    goTo("write");
  }

  async function write(): Promise<void> {
    const current = session.value;
    const image = chosen.value;
    const found = classification.value;
    if (!current || !image?.check.ok || !found) return;
    if (found.kind === "locked" || found.kind === "wrong-chip" || found.kind === "protected") return;
    if (image.check.demo && !simulated.value) return fail(new Error(DEMO_ON_HARDWARE), "probe");
    confirm(found.kind === "blank" ? "write" : "rewrite");
    const blocks = image.image.data;
    const onProgress = (done: number, total: number) => (progress.value = { done, total });

    if (found.rdp === 0 && found.bootPinHonoured && clearBootPin.value) {
      if (!(await run("Switching off the BOOT0 pin", () => current.clearSwBoot0(), "write"))) return;
    }
    const fullErase = found.kind !== "blank" && !keepSettings.value;
    if (!(await run(fullErase ? "Erasing the whole flash" : "Erasing the pages the firmware uses", () => current.erase(blocks, fullErase ? "mass" : "pages", onProgress), "write"))) return;
    if (!(await run("Writing Betaflight", () => current.program(blocks, onProgress), "write"))) return;
    let mismatch: number | undefined;
    if (!(await run("Checking what was written", async () => void (mismatch = await current.verify(blocks, onProgress)), "write"))) return;
    if (mismatch !== undefined) return fail(new Error(`The flash differs from the file at 0x${mismatch.toString(16)}. Write again; the ST-Link can always retry.`), "write");
    if (!(await run("Starting Betaflight", () => current.resetAndRun(), "write"))) return;
    confirm("done");
    await closeSession();
    goTo("done");
  }

  /** Every retry reconnects and reads the chip again, so the next step matches the board. */
  function retry(): void {
    if (resumeAt.value === "hold-reset") return goTo("hold-reset");
    if (source.value) return void connect("hotplug");
    goTo("probe");
  }

  /** Called when the pilot leaves the page: never keep the ST-Link claimed or the chip halted. */
  function release(): void {
    if (!session.value || step.value === "working") return;
    fail(new Error("The ST-Link was released when you left this page. Reconnect to carry on; the chip is read again first."), "probe");
  }

  function failUsb(reason: unknown): void {
    usbStep.value = "failed";
    usbMessage.value = describeError(reason);
  }

  /** A migrated board connected over USB: flash a new image through its own DFU bootloader. */
  async function flashOverUsb(): Promise<void> {
    const image = usbChosen.value;
    const identity = connection.identity;
    const snapshot = connection.snapshot;
    if (!image?.check.ok || !identity || !snapshot || !migratedOverUsb.value) return;
    if (image.check.demo) return failUsb(new Error(DEMO_ON_HARDWARE));
    usbStep.value = "working";
    usbProgress.value = undefined;
    try {
      usbMessage.value = "Saving your configuration";
      saveFile(`backup_${identity.board.boardName}_${identity.firmwareVersion}_${new Date().toISOString().slice(0, 10)}_diff.txt`, `${snapshot.diffAll}\n`);
      usbMessage.value = "Restarting the board into its bootloader";
      await connection.enterBootloader();
      const device = await waitForAuthorizedDfuDevice();
      if (!device) {
        usbStep.value = "permission";
        usbMessage.value = "The board is in its bootloader. Your browser needs permission to reach it.";
        return;
      }
      await writeOverDfu(device, image);
    } catch (reason) {
      failUsb(reason);
    }
  }

  /** Called from the pilot's click, which requestDevice needs; the restart used up the first one. */
  async function grantDfuPermission(): Promise<void> {
    const image = usbChosen.value;
    if (usbStep.value !== "permission" || !image?.check.ok || image.check.demo) return;
    try {
      const device = await navigator.usb.requestDevice({ filters: [STM32_DFU_FILTER] });
      usbStep.value = "working";
      await writeOverDfu(device, image);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "NotFoundError") {
        usbMessage.value = "No bootloader was chosen. Choose STM32 BOOTLOADER in the list. If it is not there, unplug the board, plug it back in and start again.";
        return;
      }
      failUsb(reason);
    }
  }

  async function writeOverDfu(device: USBDevice, image: ChosenImage): Promise<void> {
    usbMessage.value = "Writing the firmware";
    const flasher = new DfuFlasher(device as unknown as UsbDeviceLike, (update) => (usbProgress.value = update));
    await flasher.open();
    await flasher.flash(image.image);
    usbMessage.value = "Waiting for Betaflight to start";
    await connection.reconnectAfterFlash();
    usbStep.value = "done";
    usbMessage.value = "";
  }

  return {
    step,
    source,
    session,
    probeInfo,
    readings,
    classification,
    chosen,
    usbChosen,
    confirmations,
    reportSaved,
    clearBootPin,
    keepSettings,
    message,
    progress,
    error,
    simulated,
    awaitingRelease,
    migratedOverUsb,
    usbStep,
    usbMessage,
    usbProgress,
    hostedLoading,
    confirm,
    goTo,
    reset,
    useSource,
    connect,
    chipConfirmed,
    saveReport,
    chooseImage,
    chooseUsbImage,
    chooseHosted,
    firmwareConfirmed,
    unlock,
    write,
    retry,
    release,
    flashOverUsb,
    grantDfuPermission,
  };
});
