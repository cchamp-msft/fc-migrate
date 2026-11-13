/**
 * Bootstraps a real board, checks the saved values, then restores the original
 * tune and checks every restored value against the first dump.
 *
 * Usage: pnpm --filter @bf-migrate/hil run bootstrap [--port COM6] [--small] [--smooth] [--wind] [--keep]
 *   --keep  leaves the bootstrapped tune on the board instead of restoring it
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyScript, buildRestoreScript, checkBootstrapReady, parseConfig, planBootstrap, schemaFromCli, scopeKey, type ConfigDocument } from "@bf-migrate/core";
import { connect, release, type Connection as HilConnection } from "./connect.js";

const flag = (name: string) => process.argv.includes(name);
const port = flag("--port") ? process.argv[process.argv.indexOf("--port") + 1]! : "COM6";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function values(document: ConfigDocument): Map<string, string> {
  const table = new Map<string, string>();
  for (const entry of document.entries) if (entry.kind === "set") table.set(`${scopeKey(entry.scope)}|${entry.name}`, entry.value);
  return table;
}

async function sendAndSave(connection: HilConnection, script: readonly string[]): Promise<HilConnection> {
  if (!connection.link.cli.isActive) await connection.link.cli.enter();
  const applied = await applyScript(connection.link.cli, script);
  for (const failure of applied.failures) console.log(`  rejected: ${failure.line}\n    ${failure.message}`);
  if (applied.failures.length > 0) {
    await release(connection, true);
    console.log("Not saving, because the board rejected lines. A restart drops the changes.");
    process.exit(2);
  }
  await connection.link.cli.sendFinal("save");
  await release(connection, false);
  await new Promise((done) => setTimeout(done, 2000));
  return connect(port, 25_000);
}

async function dumpOf(connection: HilConnection): Promise<string> {
  if (!connection.link.cli.isActive) await connection.link.cli.enter();
  return (await connection.link.cli.runQuietly("dump all", 45_000)).output;
}

const first = await connect(port);
const version = first.identity.firmwareVersion;

const snapshot = await first.link.readSnapshot();
const before = parseConfig(snapshot.dumpAll);
const schema = schemaFromCli({ firmwareVersion: version, source: "live-board", capturedFrom: first.identity.board.boardName, getOutput: snapshot.get, helpOutput: snapshot.help });
const input = { firmwareVersion: version, dump: before, schema };

console.log(`Board ${first.identity.board.boardName} on ${version}`);
const readiness = checkBootstrapReady(input);
if (!readiness.ready) {
  for (const problem of readiness.problems) console.log(`Not ready: ${problem}`);
  await release(first, true);
  process.exit(1);
}

const plan = planBootstrap(input, { size: flag("--small") ? "small" : "large", feel: flag("--smooth") ? "smooth" : "default", windResistant: flag("--wind") });
const restore = buildRestoreScript(before);
const outDir = resolve(root, `.local/captures/bootstrap-${version}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "before_dump.txt"), `${snapshot.dumpAll}\n`);
writeFileSync(resolve(outDir, "restore.txt"), `${restore.join("\n")}\nsave\n`);
writeFileSync(resolve(outDir, "bootstrap.txt"), `${plan.script.join("\n")}\n`);
console.log(`Backup and scripts written to ${outDir}`);
for (const entry of plan.skipped) console.log(`Skipped ${entry.name}: ${entry.reason}`);

console.log(`\nBootstrapping: ${plan.script.length} lines, then save.`);
const afterBootstrap = await sendAndSave(first, plan.script);
const bootstrapped = values(parseConfig(await dumpOf(afterBootstrap)));
const wrong = plan.changes.filter((change) => bootstrapped.get(`${scopeKey(change.scope)}|${change.name}`)?.toLowerCase() !== change.to.toLowerCase());
console.log(`Values that differ after reboot: ${wrong.length}`);
for (const change of wrong) console.log(`  ${scopeKey(change.scope)} ${change.name}: expected ${change.to}, board has ${bootstrapped.get(`${scopeKey(change.scope)}|${change.name}`)}`);
const active = plan.activeProfile;
const pids = [...bootstrapped].filter(([key]) => key.startsWith(`profile:${active}|`) && /\|(p|i|d|f|d_min|d_max)_(roll|pitch|yaw)$/.test(key));
console.log(`Active profile PIDs now: ${pids.map(([key, value]) => `${key.split("|")[1]}=${value}`).join(" ")}`);

if (flag("--keep")) {
  console.log(`\nKeeping the bootstrapped tune. To undo, send ${resolve(outDir, "restore.txt")} in the CLI.`);
  await release(afterBootstrap, true);
  process.exit(wrong.length > 0 ? 2 : 0);
}

console.log("\nRestoring the original tune, then save.");
const afterRestore = await sendAndSave(afterBootstrap, restore);
const restored = values(parseConfig(await dumpOf(afterRestore)));
const original = values(before);
const restoreKeys = restore.filter((line) => line.startsWith("set ")).length;
const differences = [...original].filter(([key]) => /\|((p|i|d|f|d_min|d_max)_(roll|pitch|yaw)|simplified_.*|(dterm|gyro)_lpf.*|throttle_boost|dyn_idle_min_rpm|thrust_linear)$/.test(key) && restored.get(key) !== original.get(key));
console.log(`Restore sent ${restoreKeys} values. Differences from the original: ${differences.length}`);
for (const [key, value] of differences) console.log(`  ${key}: original ${value}, board has ${restored.get(key)}`);
await release(afterRestore, true);
process.exit(wrong.length > 0 || differences.length > 0 ? 2 : 0);
