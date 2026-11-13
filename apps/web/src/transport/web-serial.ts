import { TransportEvents, type ByteTransport, type CloseReason, type Unsubscribe } from "@bf-migrate/core";

const BAUD_RATE = 115200;

/** USB serial bridges used by flight controllers: STM32 VCP and common USB-UART chips. */
const SERIAL_FILTERS: SerialPortFilter[] = [
  { usbVendorId: 0x0483 },
  { usbVendorId: 0x2e3c },
  { usbVendorId: 0x314b },
  { usbVendorId: 0x28e9 },
  { usbVendorId: 0x2e8a },
  { usbVendorId: 0x10c4 },
  { usbVendorId: 0x0403 },
  { usbVendorId: 0x1a86 },
];

export function isWebSerialAvailable(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export function isWebUsbAvailable(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

/**
 * WebSerial transport. A board that reboots comes back as a new port object, so
 * `open` looks the port up again by its USB identity.
 */
export class WebSerialTransport implements ByteTransport {
  private readonly events = new TransportEvents();
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private closing = false;
  private opened = false;
  private readonly usbInfo: SerialPortInfo;

  constructor(private port: SerialPort) {
    this.usbInfo = port.getInfo();
  }

  static async choosePort(): Promise<WebSerialTransport> {
    return new WebSerialTransport(await navigator.serial.requestPort({ filters: SERIAL_FILTERS }));
  }

  get isOpen(): boolean {
    return this.opened;
  }

  async open(): Promise<void> {
    this.closing = false;
    try {
      await this.port.open({ baudRate: BAUD_RATE });
    } catch (error) {
      const replacement = await this.findPortAgain();
      if (!replacement) throw error;
      this.port = replacement;
      await this.port.open({ baudRate: BAUD_RATE });
    }
    this.opened = true;
    void this.readLoop();
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    this.closing = true;
    this.opened = false;
    try {
      await this.reader?.cancel();
    } catch {
      // The device may already have disappeared.
    }
    try {
      await this.port.close();
    } catch {
      // Closing a port whose device is gone rejects; the port is released either way.
    }
    this.events.emitClose("requested");
  }

  async write(data: Uint8Array): Promise<void> {
    const writable = this.port.writable;
    if (!writable) throw new Error("Serial port is not writable");
    const writer = writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  onData(listener: (chunk: Uint8Array) => void): Unsubscribe {
    return this.events.onData(listener);
  }

  onClose(listener: (reason: CloseReason) => void): Unsubscribe {
    return this.events.onClose(listener);
  }

  private async findPortAgain(): Promise<SerialPort | undefined> {
    const ports = await navigator.serial.getPorts();
    return ports.find((candidate) => {
      const info = candidate.getInfo();
      return info.usbVendorId === this.usbInfo.usbVendorId && info.usbProductId === this.usbInfo.usbProductId;
    });
  }

  private async readLoop(): Promise<void> {
    while (this.port.readable && this.opened) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.events.emitData(value);
        }
      } catch {
        // A read error means the device went away; handled below.
        break;
      } finally {
        this.reader.releaseLock();
      }
      if (this.closing) return;
    }
    if (!this.closing && this.opened) {
      this.opened = false;
      try {
        await this.port.close();
      } catch {
        // Already gone.
      }
      this.events.emitClose("lost");
    }
  }
}
