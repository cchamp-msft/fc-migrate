import {
  applyScript,
  BuildApi,
  DfuFlasher,
  parseConfig,
  parseIntelHex,
  selectBuildOptions,
  verifyApplied,
  type DfuProgress,
  type HexImage,
  type MigrationPlan,
  type UsbDeviceLike,
  type ValueMismatch,
} from "@bf-migrate/core";
import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";
import { useConnectionStore } from "./connection";
import { saveFile } from "../utils/save-file";

export type UpgradeStep = "idle" | "backup" | "build" | "bootloader" | "permission" | "flash" | "reconnect" | "apply" | "review" | "saving" | "done" | "failed";

const STM32_DFU_FILTER = { vendorId: 0x0483, productId: 0xdf11 };
const DFU_WAIT_MS = 12_000;
const DFU_POLL_MS = 300;
const INTERNAL_FLASH_START = 0x08000000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findAuthorizedDfuDevice(): Promise<USBDevice | undefined> {
  const devices = await navigator.usb.getDevices();
  return devices.find((device) => device.vendorId === STM32_DFU_FILTER.vendorId && device.productId === STM32_DFU_FILTER.productId);
}

async function waitForAuthorizedDfuDevice(): Promise<USBDevice | undefined> {
  const started = Date.now();
  while (Date.now() - started < DFU_WAIT_MS) {
    const device = await findAuthorizedDfuDevice();
    if (device) return device;
    await delay(DFU_POLL_MS);
  }
  return undefined;
}

/** Runs one firmware upgrade: nothing is saved to the board until the pilot confirms. */
export const useUpgradeStore = defineStore("upgrade", () => {
  const connection = useConnectionStore();
  const step = ref<UpgradeStep>("idle");
  const message = ref("");
  const error = ref("");
  const progress = ref<DfuProgress>();
  const unavailableOptions = ref<string[]>([]);
  const rejected = ref<{ line: string; message?: string }[]>([]);
  const mismatches = ref<ValueMismatch[]>([]);
  const plan = shallowRef<MigrationPlan>();
  const firmware = shallowRef<HexImage>();

  const running = computed(() => !["idle", "permission", "review", "done", "failed"].includes(step.value));

  function fail(reason: unknown): void {
    step.value = "failed";
    error.value = reason instanceof Error ? reason.message : String(reason);
    // A board that never came back would otherwise leave Connect disabled.
    if (connection.status === "rebooting") void connection.disconnect();
  }

  function reset(): void {
    step.value = "idle";
    message.value = "";
    error.value = "";
    progress.value = undefined;
    unavailableOptions.value = [];
    rejected.value = [];
    mismatches.value = [];
  }

  // Results describe a board that is gone once it disconnects. A failure stays on
  // screen, because its recovery steps matter most when the board is not connected.
  watch(
    () => connection.identity,
    (current) => {
      if (!current && !running.value && step.value !== "failed") reset();
    },
  );

  /** Backs up, builds, and reboots to the bootloader. Flashing continues in `flashWith`. */
  async function start(chosenPlan: MigrationPlan): Promise<void> {
    reset();
    plan.value = chosenPlan;
    const identity = connection.identity;
    const snapshot = connection.snapshot;
    const link = connection.link;
    if (!identity || !snapshot || !link) return fail(new Error("The board is not connected."));

    try {
      step.value = "backup";
      message.value = "Saving your current configuration";
      const stem = `${identity.board.boardName}_${identity.firmwareVersion}_${new Date().toISOString().slice(0, 10)}`;
      saveFile(`backup_${stem}_diff.txt`, `${snapshot.diffAll}\n`, "text/plain");
      saveFile(`backup_${stem}_dump.txt`, `${snapshot.dumpAll}\n`, "text/plain");

      step.value = "build";
      message.value = `Requesting ${chosenPlan.targetVersion} with this board's options`;
      const api = new BuildApi();
      const defines = identity.buildOptions.flatMap((entry) => (entry.option ? [entry.option.define] : []));
      const selection = selectBuildOptions(defines, await api.getOptions(chosenPlan.targetVersion));
      unavailableOptions.value = selection.unavailable;
      const ticket = await api.requestBuild({ target: identity.board.boardName, release: chosenPlan.targetVersion, options: selection.options });
      await api.waitForBuild(ticket.key, (state) => (message.value = `Firmware build: ${state}`));
      firmware.value = parseIntelHex(await api.downloadFirmware(ticket.url));

      step.value = "bootloader";
      message.value = "Restarting the board into its bootloader";
      await connection.enterBootloader();

      const device = await waitForAuthorizedDfuDevice();
      if (device) await flashWith(device);
      else {
        step.value = "permission";
        message.value = "Your browser needs permission to reach the bootloader.";
      }
    } catch (reason) {
      fail(reason);
    }
  }

  /** Called from a button, because the browser's USB chooser requires a user click. */
  async function grantDfuPermission(): Promise<void> {
    try {
      await flashWith(await navigator.usb.requestDevice({ filters: [STM32_DFU_FILTER] }));
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "NotFoundError") {
        message.value = "No bootloader was selected. If the list was empty, re-plug the board while holding BOOT, then try again.";
        return;
      }
      fail(reason);
    }
  }

  async function flashWith(device: USBDevice): Promise<void> {
    const image = firmware.value;
    const chosenPlan = plan.value;
    const identity = connection.identity;
    if (!image || !chosenPlan || !identity) return fail(new Error("The upgrade lost its firmware. Start again."));

    try {
      step.value = "flash";
      message.value = "Saving the current firmware, then writing the new one";
      const flasher = new DfuFlasher(device as unknown as UsbDeviceLike, (update) => (progress.value = update));
      const layout = await flasher.open();

      // Build services may not offer this exact firmware again, so keep a copy when the chip allows it.
      try {
        const dump = await flasher.readFlash(INTERNAL_FLASH_START, layout.flash.totalSize);
        saveFile(`firmware_backup_${identity.board.boardName}_${identity.firmwareVersion}.bin`, dump.slice().buffer, "application/octet-stream");
      } catch {
        message.value = "This board would not allow a firmware backup. Your configuration backup is saved.";
      }

      await flasher.flash(image);

      step.value = "reconnect";
      message.value = "Waiting for the new firmware to start";
      await connection.reconnectAfterFlash();

      step.value = "apply";
      message.value = "Sending your configuration";
      const link = connection.link;
      if (!link) throw new Error("The board did not reconnect after flashing. Re-plug it, then connect again.");
      const result = await applyScript(link.cli, chosenPlan.script, (update) => {
        progress.value = undefined;
        message.value = `Sending your configuration (${update.done} of ${update.total})`;
      });
      rejected.value = result.failures.map((entry) => ({ line: entry.line, message: entry.message }));

      const dump = await link.cli.runQuietly("dump all", 45_000);
      mismatches.value = verifyApplied(chosenPlan, parseConfig(dump.output));

      step.value = "review";
      message.value = "";
    } catch (reason) {
      fail(reason);
    }
  }

  /** Writes the applied configuration to the board and confirms it survived a reboot. */
  async function confirmSave(): Promise<void> {
    const chosenPlan = plan.value;
    if (!chosenPlan) return;
    try {
      step.value = "saving";
      message.value = "Saving and restarting";
      await connection.saveAndReconnect();
      const link = connection.link;
      if (!link) throw new Error("The board did not come back after saving.");
      const dump = await link.cli.runQuietly("dump all", 45_000);
      mismatches.value = verifyApplied(chosenPlan, parseConfig(dump.output));
      step.value = "done";
      message.value = "";
    } catch (reason) {
      fail(reason);
    }
  }

  /** Abandons the applied settings. A reboot restores what the board last saved. */
  async function discardApplied(): Promise<void> {
    await connection.disconnect();
    reset();
  }

  return { step, message, error, progress, unavailableOptions, rejected, mismatches, plan, running, start, grantDfuPermission, confirmSave, discardApplied, reset };
});
