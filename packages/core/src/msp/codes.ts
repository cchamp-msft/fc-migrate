/** MSP command identifiers used by the migrator. Values are defined by the firmware. */
export const MspCode = {
  API_VERSION: 1,
  FC_VARIANT: 2,
  FC_VERSION: 3,
  BOARD_INFO: 4,
  BUILD_INFO: 5,
  NAME: 10,
  REBOOT: 68,
  UID: 160,
  GET_TEXT: 0x3006,
} as const;

/** Text selectors for {@link MspCode.GET_TEXT}. */
export const MspTextType = {
  PILOT_NAME: 1,
  CRAFT_NAME: 2,
  PID_PROFILE_NAME: 3,
  RATE_PROFILE_NAME: 4,
  BUILD_KEY: 5,
  RELEASE_NAME: 6,
} as const;

/** Reboot targets accepted by {@link MspCode.REBOOT}. */
export const MspRebootMode = {
  FIRMWARE: 0,
  BOOTLOADER_ROM: 1,
  MSC: 2,
  MSC_UTC: 3,
  BOOTLOADER_FLASH: 4,
} as const;
