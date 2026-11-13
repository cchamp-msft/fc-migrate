/**
 * Requests a cloud build matching the options of a captured board and saves the hex.
 *
 * Usage: pnpm --filter @bf-migrate/hil run firmware <release> [target]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BuildApi, BUILD_OPTIONS, selectBuildOptions } from "@bf-migrate/core";

const release = process.argv[2];
const target = process.argv[3] ?? "RRIOT_F722";
if (!release) throw new Error("Usage: fetch <release> [target]");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outputDir = resolve(repoRoot, ".local/firmware");

/** The option IDs the RRIOT F722 reports over MSP_BUILD_INFO. */
const BOARD_OPTION_IDS = [4097, 4098, 4099, 4100, 4102, 4103, 4104, 4105, 4108, 12301, 12306, 12307, 16404, 16407, 16416, 16417, 16418, 16419, 16420, 16421, 8231, 8235];
const boardDefines = BOARD_OPTION_IDS.map((id) => BUILD_OPTIONS.find((option) => option.id === id)!.define);

const api = new BuildApi();
const selection = selectBuildOptions(boardDefines, await api.getOptions(release));
console.log(`Options: ${selection.options.join(" ")}`);
if (selection.unavailable.length) console.log(`Not offered on ${release}: ${selection.unavailable.join(" ")}`);

const ticket = await api.requestBuild({ target, release, options: selection.options });
console.log(`Build key ${ticket.key}, file ${ticket.file}`);
await api.waitForBuild(ticket.key, (state) => console.log(`  status: ${state}`));

const hex = await api.downloadFirmware(ticket.url);
mkdirSync(outputDir, { recursive: true });
const path = resolve(outputDir, `${target}_${release}.hex`);
writeFileSync(path, hex);
console.log(`Saved ${hex.length} bytes to ${path}`);
