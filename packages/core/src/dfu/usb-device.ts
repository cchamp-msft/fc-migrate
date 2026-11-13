/*
 * This file is part of Betaflight.
 *
 * Betaflight is free software. You can redistribute this software
 * and/or modify this software under the terms of the GNU General
 * Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later
 * version.
 *
 * Betaflight is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 *
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public
 * License along with this software.
 *
 * If not, see <http://www.gnu.org/licenses/>.
 */

/** The setup packet of a control transfer. */
export interface UsbControlSetup {
  requestType: "standard" | "class" | "vendor";
  recipient: "device" | "interface" | "endpoint" | "other";
  request: number;
  value: number;
  index: number;
}

export type UsbTransferStatus = "ok" | "stall" | "babble";

/** Status is optional because the WebUSB typings declare it so; anything but "ok" is a failure. */
export interface UsbInTransfer {
  readonly status?: UsbTransferStatus;
  readonly data?: DataView;
}

export interface UsbOutTransfer {
  readonly status?: UsbTransferStatus;
}

export interface UsbAlternateLike {
  readonly alternateSetting: number;
}

export interface UsbInterfaceLike {
  readonly interfaceNumber: number;
  /** The alternate setting currently selected on this interface. */
  readonly alternate: UsbAlternateLike;
}

export interface UsbConfigurationLike {
  readonly interfaces: readonly UsbInterfaceLike[];
}

/** The parts of a WebUSB `USBDevice` the DFU flasher uses. */
export interface UsbDeviceLike {
  /** Null until a configuration is selected. */
  readonly configuration?: UsbConfigurationLike | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>;
  controlTransferIn(setup: UsbControlSetup, length: number): Promise<UsbInTransfer>;
  controlTransferOut(setup: UsbControlSetup, data?: Uint8Array<ArrayBuffer>): Promise<UsbOutTransfer>;
}
