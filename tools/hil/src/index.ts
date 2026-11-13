/**
 * Read-only hardware check: identifies a real board and captures its configuration
 * through the same code the web app uses. Never sends `save`, `set` or `defaults`.
 *
 * Usage: pnpm hil [COM port]
 */
import { parseConfig, parseGetOutput, setEntries } from "@bf-migrate/core";
import { connect, release } from "./connect.js";

const portPath = process.argv[2] ?? "COM6";

const connection = await connect(portPath);
const { link, identity } = connection;
console.log(`Firmware : ${identity.variant} ${identity.firmwareVersion} (API ${identity.api.major}.${identity.api.minor})`);
console.log(`Board    : ${identity.board.manufacturerId} ${identity.board.boardName} (${identity.board.targetName})`);
console.log(`Build    : ${identity.build.date} ${identity.build.time} rev ${identity.build.gitRevision}, key ${identity.buildKey ?? "none"}`);
console.log(`Craft    : ${identity.craftName}`);
console.log(`Options  : ${identity.buildOptions.map((entry) => entry.option?.label ?? `#${entry.id}`).join(", ")}`);

const started = Date.now();
const snapshot = await link.readSnapshot();
const elapsed = Date.now() - started;
const diff = parseConfig(snapshot.diffAll);
const dump = parseConfig(snapshot.dumpAll);
const settings = parseGetOutput(snapshot.get);
console.log(`Snapshot : ${elapsed} ms; diff ${setEntries(diff).length} sets, dump ${setEntries(dump).length} sets, schema ${Object.keys(settings).length} settings`);
console.log(`Metadata : ${JSON.stringify(diff.metadata)}`);

await release(connection, true);

await new Promise((resolve) => setTimeout(resolve, 1200));
const after = await connect(portPath);
console.log(`Reboot   : firmware ${after.identity.firmwareVersion} answering`);
await release(after, false);
