import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanCapturedCli, type SimulatedFcProfile } from "../src/testing/index.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

export function fixtureText(path: string): string {
  return readFileSync(resolve(fixtures, path), "utf8");
}

export function capturedCli(board: string, name: string): string {
  return cleanCapturedCli(fixtureText(`${board}/${name}.txt`));
}

const CLI_CAPTURES: Record<string, string> = {
  version: "version",
  status: "status",
  help: "help",
  get: "get_all",
  "diff all": "diff_all",
  "dump all": "dump_all",
};

export function boardProfile(board: string): SimulatedFcProfile {
  const identity = JSON.parse(fixtureText(`${board}/identity.json`)) as Omit<SimulatedFcProfile, "cli">;
  const cli: Record<string, string> = {};
  for (const [command, file] of Object.entries(CLI_CAPTURES)) cli[command] = capturedCli(board, file);
  return { ...identity, cli };
}
