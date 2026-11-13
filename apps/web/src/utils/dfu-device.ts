/** The STM32 ROM bootloader's USB DFU device. */
export const STM32_DFU_FILTER = { vendorId: 0x0483, productId: 0xdf11 };

/** How long a board takes to come back as its bootloader after `bl rom`, at most. */
const DFU_WAIT_MS = 12_000;
const DFU_POLL_MS = 300;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A connected STM32 bootloader this site already has permission to use. */
export async function findAuthorizedDfuDevice(): Promise<USBDevice | undefined> {
  const devices = await navigator.usb.getDevices();
  return devices.find((device) => device.vendorId === STM32_DFU_FILTER.vendorId && device.productId === STM32_DFU_FILTER.productId);
}

/**
 * Waits for the board to reappear as its bootloader. Only a device the site already has
 * permission for is found. Otherwise this resolves undefined, and the pilot grants
 * permission with a click: requestDevice needs a fresh user gesture, which the restart
 * has used up.
 */
export async function waitForAuthorizedDfuDevice(): Promise<USBDevice | undefined> {
  const started = Date.now();
  while (Date.now() - started < DFU_WAIT_MS) {
    const device = await findAuthorizedDfuDevice();
    if (device) return device;
    await delay(DFU_POLL_MS);
  }
  return undefined;
}
