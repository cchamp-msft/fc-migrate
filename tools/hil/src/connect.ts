import { FcLink, FcRebootingError, type FcIdentity } from "@bf-migrate/core";
import { NodeSerialTransport, openWithRetry } from "./node-serial.js";

export interface Connection {
  transport: NodeSerialTransport;
  link: FcLink;
  identity: FcIdentity;
}

/** Opens the port and identifies the board, recovering one left in CLI mode. */
export async function connect(portPath: string, openTimeoutMs = 20_000): Promise<Connection> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const transport = new NodeSerialTransport(portPath);
    await openWithRetry(transport, openTimeoutMs);
    const link = new FcLink(transport);
    try {
      return { transport, link, identity: await link.identify() };
    } catch (error) {
      link.dispose();
      await transport.close().catch(() => undefined);
      if (!(error instanceof FcRebootingError)) throw error;
      console.log("Board was in CLI mode; waiting for it to reboot.");
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw new Error("Could not identify the board");
}

export async function release({ link, transport }: Connection, reboot: boolean): Promise<void> {
  if (reboot && link.cli.isActive) await link.cli.exit();
  link.dispose();
  await transport.close().catch(() => undefined);
}
