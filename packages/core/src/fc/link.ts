import { CliSession } from "../cli/session.js";
import { MspClient, MspTimeoutError } from "../msp/client.js";
import { MspCode, MspRebootMode } from "../msp/codes.js";
import type { ByteTransport } from "../transport.js";
import { readFcIdentity, type FcIdentity } from "./identity.js";

/** Raised when the board was left in CLI mode and has been told to reboot out of it. */
export class FcRebootingError extends Error {
  constructor() {
    super("The flight controller was in CLI mode and is rebooting");
    this.name = "FcRebootingError";
  }
}

export interface ConfigSnapshot {
  version: string;
  status: string;
  diffAll: string;
  dumpAll: string;
  get: string;
  help: string;
}

/** Owns the connection to one flight controller and its MSP and CLI layers. */
export class FcLink {
  readonly msp: MspClient;
  readonly cli: CliSession;

  constructor(readonly transport: ByteTransport) {
    this.msp = new MspClient(transport);
    this.cli = new CliSession(transport);
  }

  dispose(): void {
    this.msp.dispose();
    this.cli.dispose();
  }

  /**
   * Identifies the firmware over MSP.
   *
   * A board left in CLI mode ignores MSP, so a silent board is probed for a CLI
   * prompt and rebooted back to normal operation. Callers reopen the port and retry.
   */
  async identify(): Promise<FcIdentity> {
    try {
      await this.msp.request(MspCode.API_VERSION, undefined, { timeoutMs: 400, retries: 1 });
    } catch (error) {
      if (!(error instanceof MspTimeoutError)) throw error;
      await this.cli.enter();
      await this.cli.exit();
      throw new FcRebootingError();
    }
    return readFcIdentity(this.msp);
  }

  /** Reads every piece of configuration text. Leaves the board in CLI mode. */
  async readSnapshot(): Promise<ConfigSnapshot> {
    if (!this.cli.isActive) await this.cli.enter();
    const version = await this.cli.runQuietly("version");
    const status = await this.cli.runQuietly("status");
    const diffAll = await this.cli.runQuietly("diff all", 30_000);
    const dumpAll = await this.cli.runQuietly("dump all", 45_000);
    const get = await this.cli.runQuietly("get", 45_000);
    const help = await this.cli.runQuietly("help");
    return { version: version.output, status: status.output, diffAll: diffAll.output, dumpAll: dumpAll.output, get: get.output, help: help.output };
  }

  /** Reboots into the STM32 ROM bootloader so the board can be flashed over DFU. */
  async rebootToBootloader(): Promise<void> {
    await this.msp.sendWithoutReply(MspCode.REBOOT, Uint8Array.of(MspRebootMode.BOOTLOADER_ROM));
  }
}
