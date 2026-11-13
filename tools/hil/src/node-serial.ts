import { SerialPort } from "serialport";
import { TransportEvents, type ByteTransport, type CloseReason, type Unsubscribe } from "@bf-migrate/core";

/** node-serialport implementation of the transport, for testing against real hardware. */
export class NodeSerialTransport implements ByteTransport {
  private readonly events = new TransportEvents();
  private port: SerialPort | undefined;
  private closing = false;

  constructor(private readonly path: string) {}

  get isOpen(): boolean {
    return this.port?.isOpen ?? false;
  }

  async open(): Promise<void> {
    this.closing = false;
    const port = new SerialPort({ path: this.path, baudRate: 115200, autoOpen: false });
    await new Promise<void>((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())));
    port.on("data", (chunk: Buffer) => this.events.emitData(new Uint8Array(chunk)));
    port.on("close", () => this.events.emitClose(this.closing ? "requested" : "lost"));
    this.port = port;
  }

  async close(): Promise<void> {
    const port = this.port;
    if (!port?.isOpen) return;
    this.closing = true;
    await new Promise<void>((resolve, reject) => port.close((error) => (error ? reject(error) : resolve())));
  }

  async write(data: Uint8Array): Promise<void> {
    const port = this.port;
    if (!port?.isOpen) throw new Error("Serial port is closed");
    await new Promise<void>((resolve, reject) => port.write(Buffer.from(data), (error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => port.drain((error) => (error ? reject(error) : resolve())));
  }

  onData(listener: (chunk: Uint8Array) => void): Unsubscribe {
    return this.events.onData(listener);
  }

  onClose(listener: (reason: CloseReason) => void): Unsubscribe {
    return this.events.onClose(listener);
  }
}

/** Opens a port, retrying while the board re-enumerates after a reboot. */
export async function openWithRetry(transport: NodeSerialTransport, timeoutMs = 20_000): Promise<number> {
  const started = Date.now();
  for (;;) {
    try {
      await transport.open();
      return Date.now() - started;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
