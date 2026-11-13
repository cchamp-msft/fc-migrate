import type { AlphaBoard } from "@bf-migrate/core";

/**
 * Board photos for the Alpha Migrate steps. The files in public/alpha/ are web-sized copies of
 * the annotated photos in the alpha-to-betaflight guide repo (images/); update both together.
 */
export interface BoardPhoto {
  src: string;
  alt: string;
  caption: string;
}

export interface AlphaPhotos {
  /** Where to solder the ST-Link. */
  wiring: BoardPhoto[];
  /** The reset button, for the hold-reset connect. */
  reset?: BoardPhoto;
  /** Where the receiver goes under Betaflight. */
  receiver?: BoardPhoto;
}

const base = `${import.meta.env.BASE_URL}alpha/`;

const hdSwd: BoardPhoto = {
  src: `${base}g4-hd/swd-pads.jpg`,
  alt: "Component side of the Pacer G4 Alpha HD with the SWDIO pad, the SWCLK pad and the reset button marked",
  caption: "Component side: SWDIO to the upper pad, SWCLK to the lower pad. The reset button is marked in yellow.",
};

const hdPadSide: BoardPhoto = {
  src: `${base}g4-hd/pad-side.jpg`,
  alt: "Pad side of the Pacer G4 Alpha HD with a GND pad and the T1, R1, 5V and ground pads marked",
  caption: "Pad side: ST-Link GND in green (any GND or - pad works). The receiver goes on the orange pads.",
};

export const ALPHA_PHOTOS: Partial<Record<AlphaBoard["id"], AlphaPhotos>> = {
  hd: {
    wiring: [
      hdSwd,
      {
        src: `${base}g4-hd/swd-pads-closeup.jpg`,
        alt: "Close-up of the two SWD pads between the USB-C socket and the chip",
        caption: "Close-up: the two gold pads between the USB-C socket and the chip.",
      },
      hdPadSide,
    ],
    reset: hdSwd,
    receiver: {
      ...hdPadSide,
      caption: "Wire the receiver to the orange pads: T1 to its RX, R1 to its TX, plus 5V and -.",
    },
  },
};
