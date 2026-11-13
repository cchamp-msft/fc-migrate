/**
 * Runs the real proposal flow against a live provider, using sample failures.
 * Direct:   STRATA_BASE_URL=... STRATA_API_KEY=... ANTHROPIC_API_KEY=... pnpm --filter @bf-migrate/worker run try [strata|haiku|sonnet|opus]
 * Deployed: PROXY_TOKEN=... pnpm --filter @bf-migrate/worker run try [haiku|sonnet|opus] --url https://fc-migrate.com/api
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProposalPrompt, checkProposals, parseGetOutput, parseProposals, selectCandidates, type FailedLine, type FirmwareSchema, type Proposal } from "@bf-migrate/core";
import { cleanCapturedCli } from "@bf-migrate/core/testing";
import { availableProviders } from "../src/providers.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const getOutput = cleanCapturedCli(readFileSync(resolve(root, "fixtures/RRIOT_F722-4.5.4/get_all.txt"), "utf8"));
const target: FirmwareSchema = { firmwareVersion: "2026.6.2", source: "live-board", settings: parseGetOutput(getOutput), commands: {} };

const failures: FailedLine[] = [
  { line: "set vbat_scael = 101", reason: "Unknown setting on the target firmware." },
  { line: "set gyro_lpf1_statc_hz = 300", reason: "Unknown setting on the target firmware." },
  { line: "set extra_armed_warning = LETS GO", reason: "Unknown setting on the target firmware." },
  { line: "set flux_capacitor_gain = 88", reason: "Unknown setting on the target firmware." },
];

const name = process.argv[2] ?? "strata";
const urlFlag = process.argv.indexOf("--url");
const deployedUrl = urlFlag === -1 ? undefined : process.argv[urlFlag + 1];
const request = { sourceVersion: "4.5.4", targetVersion: "2026.6.2", failures, candidates: selectCandidates(failures, target) };

/** Goes through the deployed Worker, so its token, secrets and bundling are all exercised. */
async function askDeployed(url: string): Promise<Proposal[]> {
  const response = await fetch(`${url}/v1/propose?provider=${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.PROXY_TOKEN}` },
    body: JSON.stringify(request),
  });
  const body = (await response.json()) as { proposals?: Proposal[]; error?: string };
  if (!body.proposals) throw new Error(`Worker returned HTTP ${response.status}: ${body.error ?? "no proposals"}`);
  return body.proposals;
}

async function askDirectly(): Promise<Proposal[]> {
  const providers = availableProviders({ STRATA_BASE_URL: process.env.STRATA_BASE_URL, STRATA_API_KEY: process.env.STRATA_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY });
  const provider = providers[name];
  if (!provider) throw new Error(`Provider ${name} is not configured. Available: ${Object.keys(providers).join(", ")}`);
  return parseProposals(await provider(buildProposalPrompt(request)));
}

const started = Date.now();
const proposals = await (deployedUrl ? askDeployed(deployedUrl) : askDirectly());
console.log(`${name} answered in ${Date.now() - started} ms`);
for (const entry of checkProposals(proposals, failures, target)) {
  console.log(`${entry.valid ? "valid  " : "INVALID"} ${entry.confidence.padEnd(6)} ${entry.action.padEnd(7)} ${entry.line} -> ${entry.replacement ?? "(drop)"}\n         ${entry.reason}${entry.problem ? ` [${entry.problem}]` : ""}`);
}
