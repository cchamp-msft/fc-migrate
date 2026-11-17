import type { AlphaBoardId } from "@bf-migrate/core";

/**
 * Firmware this site serves for boards Betaflight's cloud build does not carry yet. Each
 * file is a release of fc-migrate-firmware, copied byte for byte into `public/` and pinned
 * by its SHA-256: the page refuses a download that does not match before anything is
 * written. The release and source links are where the GPL's Corresponding Source lives.
 */
export interface HostedFirmware {
  /** The fc-migrate-firmware release tag. */
  release: string;
  /** The Betaflight release it is built from. */
  betaflight: string;
  /** The revision the firmware reports in `version`. */
  revision: string;
  boardName: string;
  /** The build options it was built with; a hosted build cannot change them. */
  options: readonly string[];
  /** Path under the site's base URL. */
  path: string;
  /** File name offered when the pilot saves it. */
  fileName: string;
  sha256: string;
  releaseUrl: string;
  /** This repository at the release tag: configs, patches and build workflow. */
  sourceUrl: string;
  betaflightSourceUrl: string;
}

const REPO = "https://github.com/cchamp-msft/fc-migrate-firmware";

export const ALPHA_HD_FIRMWARE: HostedFirmware = {
  release: "v2026.6.2-1",
  betaflight: "2026.6.2",
  revision: "988912efd",
  boardName: "TMOTORG4ALPHAHD",
  options: ["USE_SERIALRX", "USE_SERIALRX_CRSF", "USE_SERIALRX_SBUS", "USE_TELEMETRY", "USE_TELEMETRY_CRSF", "USE_OSD_HD", "USE_DSHOT", "USE_LED_STRIP", "USE_PINIO", "USE_VTX"],
  path: "firmware/v2026.6.2-1/betaflight_2026.6.2_STM32G474_TMOTORG4ALPHAHD.hex",
  fileName: "betaflight_2026.6.2_STM32G474_TMOTORG4ALPHAHD.hex",
  sha256: "73e4d2aa796fcf4eb97c6021f822d8cf15d14b41d4cafc8d9f6a4c6588e30b59",
  releaseUrl: `${REPO}/releases/tag/v2026.6.2-1`,
  sourceUrl: `${REPO}/tree/v2026.6.2-1`,
  betaflightSourceUrl: "https://github.com/betaflight/betaflight/tree/2026.6.2",
};

/**
 * The Analog board's release. Release builds are not byte-reproducible, so this is a CI build of
 * the source that was booted on the first Analog board, not the bytes flashed there.
 */
export const ALPHA_ANALOG_FIRMWARE: HostedFirmware = {
  release: "v2026.6.2-2",
  betaflight: "2026.6.2",
  revision: "8f849dc3e",
  boardName: "TMOTORG4ALPHAANALOG",
  options: ["USE_SERIALRX", "USE_SERIALRX_CRSF", "USE_SERIALRX_SBUS", "USE_TELEMETRY", "USE_TELEMETRY_CRSF", "USE_OSD_SD", "USE_DSHOT", "USE_LED_STRIP", "USE_PINIO", "USE_VTX"],
  path: "firmware/v2026.6.2-2/betaflight_2026.6.2_STM32G474_TMOTORG4ALPHAANALOG.hex",
  fileName: "betaflight_2026.6.2_STM32G474_TMOTORG4ALPHAANALOG.hex",
  sha256: "4b4affc3b339ea1e345c872720cbc5a3cc0f6af8c8c11dc7cd6404ccb10aa672",
  releaseUrl: `${REPO}/releases/tag/v2026.6.2-2`,
  sourceUrl: `${REPO}/tree/v2026.6.2-2`,
  betaflightSourceUrl: "https://github.com/betaflight/betaflight/tree/2026.6.2",
};

/** This site's build for each Alpha board. */
export const HOSTED_ALPHA_FIRMWARE: Partial<Record<AlphaBoardId, HostedFirmware>> = {
  hd: ALPHA_HD_FIRMWARE,
  analog: ALPHA_ANALOG_FIRMWARE,
};
