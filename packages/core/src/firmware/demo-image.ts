import type { HexBlock } from "./hex.js";

/**
 * Carried by the web app's demo stand-in image. It is not firmware: written to a real
 * board it locks the core up at the first instruction. The image check refuses it for
 * real hardware, and every flasher refuses it again before erasing anything.
 */
export const DEMO_IMAGE_MARKER = "fc-migrate demo image, not firmware";

const MARKER_BYTES = new TextEncoder().encode(DEMO_IMAGE_MARKER);

/** True when any block carries the demo marker. */
export function isDemoImage(blocks: readonly HexBlock[]): boolean {
  return blocks.some(({ bytes }) => {
    outer: for (let i = 0; i <= bytes.length - MARKER_BYTES.length; i++) {
      for (let j = 0; j < MARKER_BYTES.length; j++) if (bytes[i + j] !== MARKER_BYTES[j]) continue outer;
      return true;
    }
    return false;
  });
}

/** What the flashers say when they refuse it. */
export const DEMO_IMAGE_REFUSED = "this is the demo's stand-in image, not firmware, and it would lock the board up. Nothing was erased or written.";
