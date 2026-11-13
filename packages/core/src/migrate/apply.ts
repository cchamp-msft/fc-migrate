import type { CliSession } from "../cli/session.js";
import { scopeKey, type ConfigDocument, type ConfigScope } from "../config/document.js";
import type { MigrationPlan } from "./types.js";

export interface AppliedLine {
  line: string;
  ok: boolean;
  message?: string;
}

export interface ApplyResult {
  lines: AppliedLine[];
  failures: AppliedLine[];
}

export interface ValueMismatch {
  name: string;
  scope: string;
  expected: string;
  actual: string | undefined;
}

export interface ApplyProgress {
  done: number;
  total: number;
  line: string;
}

/**
 * Sends a migration script to the board and records each line's result.
 * Nothing is saved: on failure, a reboot returns the board to its previous state.
 */
export async function applyScript(cli: CliSession, script: readonly string[], onProgress?: (progress: ApplyProgress) => void): Promise<ApplyResult> {
  const lines: AppliedLine[] = [];
  for (const [index, line] of script.entries()) {
    onProgress?.({ done: index, total: script.length, line });
    const result = await cli.runQuietly(line, 10_000);
    const message = result.errors[0];
    lines.push(message ? { line, ok: false, message } : { line, ok: true });
  }
  onProgress?.({ done: script.length, total: script.length, line: "" });
  return { lines, failures: lines.filter((entry) => !entry.ok) };
}

export interface ExpectedValue {
  scope: ConfigScope;
  name: string;
  value: string;
}

/** Lists every expected value the board does not report, compared without regard to case. */
export function compareValues(expected: readonly ExpectedValue[], boardDump: ConfigDocument): ValueMismatch[] {
  const board = new Map<string, string>();
  for (const entry of boardDump.entries) {
    if (entry.kind === "set") board.set(`${scopeKey(entry.scope)}|${entry.name}`, entry.value);
  }

  const mismatches: ValueMismatch[] = [];
  for (const { scope, name, value } of expected) {
    const key = scopeKey(scope);
    const actual = board.get(`${key}|${name}`);
    if (actual === undefined || actual.toLowerCase() !== value.toLowerCase()) mismatches.push({ name, scope: key, expected: value, actual });
  }
  return mismatches;
}

/** Checks that every value the plan set is what the board now reports. */
export function verifyApplied(plan: MigrationPlan, boardDump: ConfigDocument): ValueMismatch[] {
  const expected = plan.items.flatMap((item) =>
    item.line?.startsWith("set ") && item.targetName !== undefined && item.targetValue !== undefined ? [{ scope: item.scope, name: item.targetName, value: item.targetValue }] : [],
  );
  return compareValues(expected, boardDump);
}
