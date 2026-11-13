import type { MspClient } from "../msp/client.js";
import { MspRemoteError } from "../msp/client.js";
import { MspCode, MspTextType } from "../msp/codes.js";
import { decodeBuildOptions, type DecodedBuildOption } from "./build-options.js";

/** Build options are only reported from this MSP API version onwards. */
export const API_WITH_BUILD_OPTIONS = { major: 1, minor: 46 } as const;

export interface ApiVersion {
  protocol: number;
  major: number;
  minor: number;
}

export interface BoardInfo {
  boardIdentifier: string;
  hardwareRevision: number;
  boardType: number;
  targetCapabilities: number;
  targetName: string;
  boardName: string;
  manufacturerId: string;
  mcuTypeId: number | undefined;
  configurationState: number | undefined;
}

export interface BuildInfo {
  date: string;
  time: string;
  gitRevision: string;
  optionIds: number[];
}

export interface FcIdentity {
  api: ApiVersion;
  variant: string;
  firmwareVersion: string;
  board: BoardInfo;
  build: BuildInfo;
  buildOptions: DecodedBuildOption[];
  /** False when the firmware is too old to report its build options. */
  buildOptionsKnown: boolean;
  buildKey: string | undefined;
  releaseName: string | undefined;
  craftName: string;
  uid: string;
}

class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  skip(count: number): void {
    this.offset += count;
  }

  ascii(length: number): string {
    const end = Math.min(this.offset + length, this.bytes.length);
    let text = "";
    for (let index = this.offset; index < end; index++) text += String.fromCharCode(this.bytes[index]!);
    this.offset = end;
    return text;
  }

  /** Reads text prefixed by a one byte length. */
  pascal(): string {
    return this.ascii(this.u8());
  }
}

export function decodeApiVersion(payload: Uint8Array): ApiVersion {
  const reader = new Reader(payload);
  return { protocol: reader.u8(), major: reader.u8(), minor: reader.u8() };
}

/** Firmware from 2025.12 onward may send a text version when the first byte is 10 or more. */
export function decodeFirmwareVersion(payload: Uint8Array): string {
  const reader = new Reader(payload);
  const major = reader.u8();
  const second = reader.u8();
  const third = reader.u8();
  if (major < 10 || reader.remaining === 0) return `${major}.${second}.${third}`;
  return reader.pascal();
}

export function decodeBoardInfo(payload: Uint8Array): BoardInfo {
  const reader = new Reader(payload);
  const boardIdentifier = reader.ascii(4);
  const hardwareRevision = reader.u16();
  const boardType = reader.u8();
  const targetCapabilities = reader.u8();
  const targetName = reader.pascal();
  const boardName = reader.pascal();
  const manufacturerId = reader.pascal();
  reader.skip(32); // board signature
  return {
    boardIdentifier,
    hardwareRevision,
    boardType,
    targetCapabilities,
    targetName,
    boardName,
    manufacturerId,
    mcuTypeId: reader.remaining > 0 ? reader.u8() : undefined,
    configurationState: reader.remaining > 0 ? reader.u8() : undefined,
  };
}

export function decodeBuildInfo(payload: Uint8Array, api: ApiVersion): BuildInfo {
  const reader = new Reader(payload);
  const date = reader.ascii(11);
  const time = reader.ascii(8);
  const gitRevision = reader.ascii(7);
  const optionIds: number[] = [];
  if (supportsBuildOptions(api)) {
    while (reader.remaining >= 2) {
      const id = reader.u16();
      if (id === 0) break;
      optionIds.push(id);
    }
  }
  return { date, time, gitRevision, optionIds };
}

export function supportsBuildOptions(api: ApiVersion): boolean {
  return api.major > API_WITH_BUILD_OPTIONS.major || (api.major === API_WITH_BUILD_OPTIONS.major && api.minor >= API_WITH_BUILD_OPTIONS.minor);
}

function ascii(payload: Uint8Array): string {
  return String.fromCharCode(...payload);
}

function hex(payload: Uint8Array): string {
  return [...payload].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reads optional text. The firmware answers with an MSP error when the value is not built in. */
async function readOptionalText(msp: MspClient, type: number): Promise<string | undefined> {
  try {
    const reply = await msp.request(MspCode.GET_TEXT, Uint8Array.of(type), { retries: 1 });
    const reader = new Reader(reply);
    reader.skip(1);
    const text = reader.pascal();
    return text.length > 0 ? text : undefined;
  } catch (error) {
    if (error instanceof MspRemoteError) return undefined;
    throw error;
  }
}

/** Reads everything needed to identify the firmware and board over MSP. */
export async function readFcIdentity(msp: MspClient): Promise<FcIdentity> {
  const api = decodeApiVersion(await msp.request(MspCode.API_VERSION, undefined, { retries: 2 }));
  const variant = ascii(await msp.request(MspCode.FC_VARIANT, undefined, { retries: 2 }));
  const firmwareVersion = decodeFirmwareVersion(await msp.request(MspCode.FC_VERSION, undefined, { retries: 2 }));
  const board = decodeBoardInfo(await msp.request(MspCode.BOARD_INFO, undefined, { retries: 2 }));
  const build = decodeBuildInfo(await msp.request(MspCode.BUILD_INFO, undefined, { retries: 2 }), api);
  const uid = hex(await msp.request(MspCode.UID, undefined, { retries: 2 }));
  const buildKey = await readOptionalText(msp, MspTextType.BUILD_KEY);
  const releaseName = await readOptionalText(msp, MspTextType.RELEASE_NAME);
  const craftName = (await readOptionalText(msp, MspTextType.CRAFT_NAME)) ?? ascii(await msp.request(MspCode.NAME, undefined, { retries: 1 }));

  return {
    api,
    variant,
    firmwareVersion,
    board,
    build,
    buildOptions: decodeBuildOptions(build.optionIds),
    buildOptionsKnown: supportsBuildOptions(api),
    buildKey,
    releaseName,
    craftName,
    uid,
  };
}
