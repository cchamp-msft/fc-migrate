/**
 * Compares a connected board's `diff all` with a captured baseline, line by line.
 * Usage: tsx src/compare-baseline.ts <fixture dir name> [COM port]
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanCapturedCli } from "@bf-migrate/core/testing";
import { connect, release } from "./connect.js";

const fixture = process.argv[2] ?? "RRIOT_F722-4.5.4";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const baseline = cleanCapturedCli(readFileSync(resolve(root, `fixtures/${fixture}/diff_all.txt`), "utf8"));

const connection = await connect(process.argv[3] ?? "COM6");
console.log(`Board: ${connection.identity.firmwareVersion}, build ${connection.identity.build.date} ${connection.identity.build.time}, craft "${connection.identity.craftName}"`);
await connection.link.cli.enter();
const current = (await connection.link.cli.runQuietly("diff all", 30_000)).output;

const before = baseline.split("\n").map((line) => line.trim()).filter(Boolean);
const after = current.split("\n").map((line) => line.trim()).filter(Boolean);
const onlyBefore = before.filter((line) => !after.includes(line));
const onlyAfter = after.filter((line) => !before.includes(line));
console.log(`${before.length} baseline lines, ${after.length} current lines`);
console.log(onlyBefore.length === 0 && onlyAfter.length === 0 ? "Identical to the baseline." : `Only in baseline: ${JSON.stringify(onlyBefore)}\nOnly on board: ${JSON.stringify(onlyAfter)}`);
await release(connection, true);
