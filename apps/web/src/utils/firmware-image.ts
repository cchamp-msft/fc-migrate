import { ALPHA_BOARDS, checkAlphaImage, parseIntelHex, type AlphaBoard, type HexImage, type ImageCheck } from "@bf-migrate/core";
import type { HostedFirmware } from "../data/hosted-firmware";

/** A firmware file the pilot chose or this site served, parsed and checked for a G4 Alpha. */
export interface ChosenImage {
  name: string;
  image: HexImage;
  check: ImageCheck;
  sha256: string;
  /** Set when the image is this site's own release rather than the pilot's file. */
  hosted?: HostedFirmware;
}

export async function sha256Of(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Downloads one of this site's releases. Refused unless its bytes match the pinned SHA-256. */
export async function fetchHostedFirmware(firmware: HostedFirmware): Promise<string> {
  const response = await fetch(`${import.meta.env.BASE_URL}${firmware.path}`, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not download ${firmware.fileName} (HTTP ${response.status}). Nothing was written.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if ((await sha256Of(bytes)) !== firmware.sha256) {
    throw new Error(`The downloaded ${firmware.fileName} does not match release ${firmware.release}'s SHA-256, so it was not used. Nothing was written.`);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Parses and checks a file for a G4 Alpha board, the HD unless another is named. Only the simulated
 * board accepts the demo's stand-in.
 */
export async function readAlphaImage(name: string, text: string, forHardware: boolean, board?: AlphaBoard, hosted?: HostedFirmware): Promise<ChosenImage> {
  const image = parseIntelHex(text);
  const chosen: ChosenImage = { name, image, check: checkAlphaImage(image, { forHardware, board }), sha256: await sha256Of(text) };
  if (hosted) chosen.hosted = hosted;
  return chosen;
}

/** This site's release for a board, downloaded, pinned and checked against the board it was built for. */
export async function loadHostedAlphaImage(firmware: HostedFirmware, forHardware: boolean): Promise<ChosenImage> {
  const board = ALPHA_BOARDS.find((entry) => entry.boardName === firmware.boardName);
  return readAlphaImage(firmware.fileName, await fetchHostedFirmware(firmware), forHardware, board, firmware);
}
