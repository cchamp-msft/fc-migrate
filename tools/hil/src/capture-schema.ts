/**
 * Captures a firmware schema and raw CLI output from a connected board.
 * Read-only: it only runs query commands.
 *
 * Usage: pnpm --filter @bf-migrate/hil run capture [COM port]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schemaFromCli } from "@bf-migrate/core";
import { connect, release } from "./connect.js";

const portPath = process.argv[2] ?? "COM6";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const connection = await connect(portPath);
const { link, identity } = connection;
const version = identity.firmwareVersion;
const snapshot = await link.readSnapshot();

const schema = schemaFromCli({
  firmwareVersion: version,
  source: "live-board",
  capturedFrom: identity.board.boardName,
  getOutput: snapshot.get,
  helpOutput: snapshot.help,
});

const schemaDir = resolve(repoRoot, "data/schemas");
mkdirSync(schemaDir, { recursive: true });
writeFileSync(resolve(schemaDir, `${version}.json`), `${JSON.stringify(schema, null, 1)}\n`);

const captureDir = resolve(repoRoot, `.local/captures/${identity.board.boardName}-${version}`);
mkdirSync(captureDir, { recursive: true });
for (const [name, text] of Object.entries(snapshot)) writeFileSync(resolve(captureDir, `${name}.txt`), `${text}\n`);

console.log(`${version}: ${Object.keys(schema.settings).length} settings, ${Object.keys(schema.commands).length} commands`);
console.log(`Build key: ${identity.buildKey ?? "none"}; options: ${identity.buildOptions.length}`);
await release(connection, true);
