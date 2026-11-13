/** Removes a listener registered on a transport. */
export type Unsubscribe = () => void;

export type CloseReason = "requested" | "lost";

/**
 * A bidirectional byte stream to a flight controller.
 *
 * Everything above this interface is platform independent: the browser uses
 * WebSerial, the hardware test harness uses node-serialport, and tests and demo
 * mode use a simulated flight controller.
 */
export interface ByteTransport {
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): Unsubscribe;
  onClose(listener: (reason: CloseReason) => void): Unsubscribe;
}

/** Shared listener bookkeeping for transport implementations. */
export class TransportEvents {
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly closeListeners = new Set<(reason: CloseReason) => void>();

  onData(listener: (chunk: Uint8Array) => void): Unsubscribe {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener: (reason: CloseReason) => void): Unsubscribe {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  emitData(chunk: Uint8Array): void {
    for (const listener of [...this.dataListeners]) listener(chunk);
  }

  emitClose(reason: CloseReason): void {
    for (const listener of [...this.closeListeners]) listener(reason);
  }
}
