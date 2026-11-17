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
  /** Where to solder the probe. */
  wiring: BoardPhoto[];
  /** The reset button, for the hold-reset connect. */
  reset?: BoardPhoto;
  /** Where the receiver goes under Betaflight. */
  receiver?: BoardPhoto;
}

const base = `${import.meta.env.BASE_URL}alpha/`;

/** The probe end, the same for both boards: a Flipper Zero's header pins, on the Analog board. */
const flipperWiring: BoardPhoto = {
  src: `${base}probe/flipper-dap-link.jpg`,
  alt: "A Flipper Zero running DAP Link, wired by pins 2, 3 and 8 to the SWD pads of a Pacer G4 Alpha Analog",
  caption: "With a Flipper Zero: pin 2 to SWCLK, pin 3 to SWDIO, pin 8 to GND, shown on an Analog board. The pin numbers are printed on the case beside the header. The board's blue LEDs wash out the wire colours at its end, so follow each wire from the Flipper.",
};

const hdPadSide: BoardPhoto = {
  src: `${base}g4-hd/pad-side.jpg`,
  alt: "Pad side of the Pacer G4 Alpha HD with a GND pad and the T1, R1, 5V and ground pads marked",
  caption: "Pad side: the green pad is another place for the probe's GND. The orange pads are where the receiver goes under Betaflight, not the receiver plug: T1 to its RX, R1 to its TX, plus 5V and -.",
};

export const ALPHA_PHOTOS: Partial<Record<AlphaBoard["id"], AlphaPhotos>> = {
  hd: {
    wiring: [
      {
        src: `${base}g4-hd/swd-pads.jpg`,
        alt: "Component side of the Pacer G4 Alpha HD with the SWDIO, SWCLK and GND pads marked",
        caption: "Component side: SWDIO to the upper pad beside the USB-C socket, SWCLK to the lower one, GND to the upper pad on the right edge.",
      },
      {
        src: `${base}g4-hd/swd-pads-closeup.jpg`,
        alt: "Close-up of the two SWD pads between the USB-C socket and the chip",
        caption: "Close-up: the two gold pads between the USB-C socket and the chip.",
      },
      hdPadSide,
      flipperWiring,
    ],
    reset: {
      src: `${base}g4-hd/reset-button.jpg`,
      alt: "The reset button beside the USB-C socket on the Pacer G4 Alpha HD, marked in yellow",
      caption: "The reset button, beside the USB-C socket.",
    },
    receiver: {
      ...hdPadSide,
      caption: "Wire the receiver to the orange pads: T1 to its RX, R1 to its TX, plus 5V and -. Not the receiver plug.",
    },
  },
  analog: {
    wiring: [
      {
        src: `${base}g4-analog/swd-pads.jpg`,
        alt: "Component side of the Pacer G4 Alpha Analog with the SWDIO, SWCLK and GND pads marked",
        caption: "Component side: SWDIO to the upper pad beside the USB-C socket, SWCLK to the lower one, GND to the upper pad on the right edge.",
      },
      {
        src: `${base}g4-analog/swd-pads-closeup.jpg`,
        alt: "Close-up of the two SWD pads between the USB-C socket and the chip on the Pacer G4 Alpha Analog",
        caption: "Close-up: the two gold pads between the USB-C socket and the chip.",
      },
      flipperWiring,
    ],
    reset: {
      src: `${base}g4-analog/reset-button.jpg`,
      alt: "The reset button above the USB-C socket on the Pacer G4 Alpha Analog, marked in yellow",
      caption: "The reset button, above the USB-C socket.",
    },
  },
};
