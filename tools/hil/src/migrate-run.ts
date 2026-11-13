/**
 * Runs a full migration on a real board already running the target firmware:
 * plan, apply without saving, compare, then save and compare again.
 *
 * Usage: pnpm --filter @bf-migrate/hil run migrate [--no-save] [--port COM6]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyScript, parseConfig, planMigration, schemaFromCli, verifyApplied, type FirmwareSchema, type PlanItem } from "@bf-migrate/core";
import { cleanCapturedCli } from "@bf-migrate/core/testing";
import { connect, release } from "./connect.js";

const port = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1]! : "COM6";
const shouldSave = !process.argv.includes("--no-save");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE_BOARD = "RRIOT_F722-4.5.4";
const fixture = (name: string) => cleanCapturedCli(readFileSync(resolve(root, `fixtures/${SOURCE_BOARD}/${name}.txt`), "utf8"));

const connection = await connect(port);
const targetVersion = connection.identity.firmwareVersion;
console.log(`Board is running ${targetVersion}`);

const targetSchema = JSON.parse(readFileSync(resolve(root, `data/schemas/${targetVersion}.json`), "utf8")) as FirmwareSchema;
const sourceSchema = schemaFromCli({ firmwareVersion: "4.5.4", source: "live-board", getOutput: fixture("get_all"), helpOutput: fixture("help") });

const plan = planMigration({
  sourceVersion: "4.5.4",
  targetVersion,
  boardName: "RRIOT_F722",
  diff: parseConfig(fixture("diff_all")),
  dump: parseConfig(fixture("dump_all")),
  sourceSchema,
  targetSchema,
});

console.log(`Steps: ${plan.steps.join(", ")}`);
console.log(`Counts: ${JSON.stringify(plan.counts)}`);
console.log(`Tuning: ${plan.tuning.map((entry) => `${entry.profile}:${entry.mode}`).join(" ")}`);

const show = (items: PlanItem[], label: string) => {
  if (items.length === 0) return;
  console.log(`\n${label} (${items.length}):`);
  for (const item of items) console.log(`  ${item.sourceName}${item.sourceValue !== undefined ? ` = ${item.sourceValue}` : ""}${item.targetName && item.targetName !== item.sourceName ? ` -> ${item.targetName}` : ""}${item.targetValue !== undefined && item.outcome !== "dropped" ? ` = ${item.targetValue}` : ""}  [${item.note ?? ""}]`);
};
show(plan.items.filter((item) => item.outcome === "attention"), "Needs attention");
show(plan.items.filter((item) => item.outcome === "dropped"), "Dropped");
show(plan.items.filter((item) => item.outcome === "renamed" || item.outcome === "converted"), "Renamed or converted");
show(plan.items.filter((item) => item.outcome === "default-changed"), "Defaults that differ on the target");

await connection.link.cli.enter();
console.log(`\nApplying ${plan.script.length} lines, without saving...`);
const applied = await applyScript(connection.link.cli, plan.script);
console.log(`Rejected by the firmware: ${applied.failures.length}`);
for (const failure of applied.failures) console.log(`  ${failure.line}\n    ${failure.message}`);

const unsaved = await connection.link.cli.runQuietly("dump all", 45_000);
const unsavedMismatch = verifyApplied(plan, parseConfig(unsaved.output));
console.log(`Values that differ before saving: ${unsavedMismatch.length}`);
for (const entry of unsavedMismatch) console.log(`  ${entry.scope} ${entry.name}: expected ${entry.expected}, board has ${entry.actual}`);

const outDir = resolve(root, `.local/captures/migrated-${targetVersion}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "script.txt"), `${plan.script.join("\n")}\n`);

if (!shouldSave || applied.failures.length > 0 || unsavedMismatch.length > 0) {
  console.log(shouldSave ? "Not saving, because something did not match." : "Not saving, as requested.");
  await release(connection, true);
  process.exit(applied.failures.length > 0 || unsavedMismatch.length > 0 ? 2 : 0);
}

console.log("Everything matched. Saving.");
await connection.link.cli.sendFinal("save");
await release(connection, false);

await new Promise((done) => setTimeout(done, 2000));
const after = await connect(port, 25_000);
console.log(`Back after save: ${after.identity.firmwareVersion}, craft "${after.identity.craftName}"`);
await after.link.cli.enter();
const dump = await after.link.cli.runQuietly("dump all", 45_000);
const diff = await after.link.cli.runQuietly("diff all", 30_000);
const mismatch = verifyApplied(plan, parseConfig(dump.output));
console.log(`Values that differ after reboot: ${mismatch.length}`);
for (const entry of mismatch) console.log(`  ${entry.scope} ${entry.name}: expected ${entry.expected}, board has ${entry.actual}`);
writeFileSync(resolve(outDir, "diff_all.txt"), `${diff.output}\n`);
writeFileSync(resolve(outDir, "dump_all.txt"), `${dump.output}\n`);

const tune = parseConfig(dump.output).entries.filter((entry) => entry.kind === "set" && entry.scope.kind === "profile" && entry.scope.index === 0 && /^(p|i|d|f|d_max)_(roll|pitch|yaw)$/.test(entry.name));
console.log(`Profile 1 PIDs on ${targetVersion}: ${tune.map((entry) => (entry.kind === "set" ? `${entry.name}=${entry.value}` : "")).join(" ")}`);
const status = await after.link.cli.runQuietly("status");
console.log(status.output.split("\n").filter((line) => /GYRO=|OSD:|Arming disable/.test(line)).join("\n"));
await release(after, true);
