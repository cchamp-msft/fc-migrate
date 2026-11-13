/** What differs between the ST-Link models Alpha Migrate supports. */
export interface StlinkModel {
  name: "ST-Link/V2" | "ST-Link/V2-1";
  productId: number;
  /** Bulk OUT endpoint number for commands and data. */
  outEndpoint: number;
  /** Bulk IN endpoint number for replies. */
  inEndpoint: number;
  /** The debug interface: interface 0 on both (MI_00 on the composite V2-1). */
  interfaceNumber: number;
  /** Largest 32-bit memory transfer per command, in bytes. */
  maxTransfer: number;
}

/**
 * webstlink caps 32-bit transfers at 1024 bytes; OpenOCD allows up to the 6 KB probe
 * buffer on full-speed probes. 1024 is used until a hardware run measures more. It
 * also matches the 1 KB TAR auto-increment window, which no transfer may cross.
 */
const TRANSFER_CAP = 1024;

const MODELS: readonly StlinkModel[] = [
  { name: "ST-Link/V2", productId: 0x3748, outEndpoint: 2, inEndpoint: 1, interfaceNumber: 0, maxTransfer: TRANSFER_CAP },
  { name: "ST-Link/V2-1", productId: 0x374b, outEndpoint: 1, inEndpoint: 1, interfaceNumber: 0, maxTransfer: TRANSFER_CAP },
  { name: "ST-Link/V2-1", productId: 0x3752, outEndpoint: 1, inEndpoint: 1, interfaceNumber: 0, maxTransfer: TRANSFER_CAP },
];

export const STLINK_VENDOR_ID = 0x0483;

/** USB IDs of the probes Alpha Migrate supports, for the browser's device chooser. */
export const STLINK_USB_FILTERS: readonly { vendorId: number; productId: number }[] = MODELS.map((model) => ({
  vendorId: STLINK_VENDOR_ID,
  productId: model.productId,
}));

export function stlinkModelFor(vendorId: number, productId: number): StlinkModel | undefined {
  if (vendorId !== STLINK_VENDOR_ID) return undefined;
  return MODELS.find((model) => model.productId === productId);
}

/**
 * Oldest JTAG firmware the session accepts. J22 adds the SWD clock command; it also
 * covers GETLASTRWSTATUS2 (J15). ST's firmware updater brings any V2 past this.
 */
export const MIN_JTAG_FIRMWARE = 22;

/** Default SWD clock: the clock the tested CubeProgrammer run used. */
export const DEFAULT_SWD_CLOCK_KHZ = 480;
