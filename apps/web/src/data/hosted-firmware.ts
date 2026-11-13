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
  path: "firmware/v2026.6.2-1/betaflight_2026.6.2_STM32G474_TMOTORG4ALPHAHD.hex",
  fileName: "betaflight_2026.6.2_STM32G474_TMOTORG4ALPHAHD.hex",
  sha256: "73e4d2aa796fcf4eb97c6021f822d8cf15d14b41d4cafc8d9f6a4c6588e30b59",
  releaseUrl: `${REPO}/releases/tag/v2026.6.2-1`,
  sourceUrl: `${REPO}/tree/v2026.6.2-1`,
  betaflightSourceUrl: "https://github.com/betaflight/betaflight/tree/2026.6.2",
};
