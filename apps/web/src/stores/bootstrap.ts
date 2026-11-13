import { applyScript, buildRestoreScript, checkBootstrapReady, compareValues, parseConfig, planBootstrap, releaseLineOf, type BootstrapChoices, type BootstrapPlan, type ValueMismatch } from "@bf-migrate/core";
import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";
import { useConnectionStore } from "./connection";

const STORAGE_KEY = "bfm.tuneBackups";
const MAX_BACKUPS = 20;

/** The tune as it was before a bootstrap, kept in this browser. */
export interface TuneBackup {
  id: string;
  savedAt: string;
  boardName: string;
  craftName: string;
  uid: string;
  firmwareVersion: string;
  /** Puts back every value the bootstrap can change, on every profile. */
  restoreScript: string[];
  /** The whole configuration, for a full restore by hand. */
  diffAll: string;
}

export type BootstrapStep = "idle" | "backup" | "apply" | "saving" | "done" | "failed";

function isBackup(value: unknown): value is TuneBackup {
  const entry = value as Partial<TuneBackup> | null;
  return typeof entry?.id === "string" && typeof entry.uid === "string" && typeof entry.firmwareVersion === "string" && Array.isArray(entry.restoreScript) && typeof entry.diffAll === "string";
}

function load(): TuneBackup[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isBackup) : [];
  } catch {
    return [];
  }
}

function describeError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Runs the bootstrapper: back up the tune, apply, save, and check what the board kept. */
export const useBootstrapStore = defineStore("bootstrap", () => {
  const connection = useConnectionStore();
  const backups = ref<TuneBackup[]>(load());
  const step = ref<BootstrapStep>("idle");
  const action = ref<"bootstrap" | "restore">("bootstrap");
  const message = ref("");
  const error = ref("");
  const rejected = ref<{ line: string; message?: string }[]>([]);
  const mismatches = ref<ValueMismatch[]>([]);
  const savedToBoard = ref(false);
  /** The plan that was actually sent, built from the board's values at that moment. */
  const sentPlan = shallowRef<BootstrapPlan>();

  const running = computed(() => step.value === "backup" || step.value === "apply" || step.value === "saving");
  const forThisBoard = computed(() => backups.value.filter((backup) => backup.uid === connection.identity?.uid));

  // A result stays visible through a dropped connection and a reconnect to the
  // same board, and is cleared only when a different board connects.
  let resultBoard: string | undefined;
  watch(
    () => connection.identity?.uid,
    (uid) => {
      if (!uid || running.value) return;
      if (resultBoard && uid !== resultBoard) reset();
    },
  );

  function persist(next: TuneBackup[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    backups.value = next;
  }

  function reset(): void {
    step.value = "idle";
    message.value = "";
    error.value = "";
    rejected.value = [];
    mismatches.value = [];
    savedToBoard.value = false;
    sentPlan.value = undefined;
    resultBoard = undefined;
  }

  function begin(kind: "bootstrap" | "restore"): void {
    reset();
    action.value = kind;
    resultBoard = connection.identity?.uid;
  }

  function fail(reason: string): void {
    step.value = "failed";
    error.value = reason;
    message.value = "";
  }

  /** Why a backup cannot be restored onto the connected board, or undefined when it can. */
  function restoreProblem(backup: TuneBackup): string | undefined {
    const identity = connection.identity;
    if (!identity) return "Connect the board first.";
    if (backup.uid !== identity.uid) return "This backup belongs to a different board.";
    // Names and scales change between release lines, so raw values only go back to the same line.
    if (releaseLineOf(backup.firmwareVersion) !== releaseLineOf(identity.firmwareVersion)) {
      return `Taken on ${backup.firmwareVersion}, and the board now runs ${identity.firmwareVersion}. Download it and carry it over with Migrate instead.`;
    }
    return undefined;
  }

  /** Sends a script, then saves unless the board rejected a line. Returns false when it stopped. */
  async function sendAndSave(script: readonly string[]): Promise<boolean> {
    const link = connection.link;
    if (!link) {
      fail("The board is not connected.");
      return false;
    }
    step.value = "apply";
    const result = await applyScript(link.cli, script, (update) => (message.value = `Sending settings (${update.done} of ${update.total})`));
    rejected.value = result.failures.map((entry) => ({ line: entry.line, message: entry.message }));
    if (rejected.value.length) {
      fail("The board rejected some lines, so nothing was saved. Disconnect to restart the board, which drops the unsaved changes.");
      return false;
    }
    if (connection.isDemo) {
      // The demo replays a capture: it accepts commands but has nothing to save them to.
      step.value = "done";
      message.value = "";
      return false;
    }
    step.value = "saving";
    message.value = "Saving and restarting";
    await connection.saveAndReconnect();
    if (!connection.link || !connection.snapshot) {
      fail("The board saved and restarted but did not reconnect. Re-plug it and connect again to check the result.");
      return false;
    }
    savedToBoard.value = true;
    return true;
  }

  async function run(choices: BootstrapChoices): Promise<void> {
    const identity = connection.identity;
    const link = connection.link;
    const schema = connection.completion?.schema;
    if (!identity || !link || !schema || connection.isBusy) return fail("The board is not connected.");
    begin("bootstrap");

    try {
      // Read the board now, not at connect time: CLI edits since then would be saved
      // by this run, so the backup and the plan must include them.
      step.value = "backup";
      message.value = "Reading the current tune";
      const dumpAll = (await link.cli.runQuietly("dump all", 45_000)).output;
      const diffAll = (await link.cli.runQuietly("diff all", 30_000)).output;
      const input = { firmwareVersion: identity.firmwareVersion, dump: parseConfig(dumpAll), schema };
      const readiness = checkBootstrapReady(input);
      if (!readiness.ready) return fail(readiness.problems.join(" "));
      const plan = planBootstrap(input, choices);
      sentPlan.value = plan;

      message.value = "Keeping a copy of the current tune";
      const backup: TuneBackup = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        savedAt: new Date().toISOString(),
        boardName: identity.board.boardName,
        craftName: identity.craftName,
        uid: identity.uid,
        firmwareVersion: identity.firmwareVersion,
        restoreScript: buildRestoreScript(input.dump),
        diffAll,
      };
      try {
        persist([backup, ...backups.value].slice(0, MAX_BACKUPS));
      } catch {
        return fail("This browser would not store the backup, so nothing was changed.");
      }

      if (!(await sendAndSave(plan.script))) return;

      // PIDs and filters are recomputed by the firmware, so only values set directly are compared.
      const expected = plan.changes.map((change) => ({ scope: change.scope, name: change.name, value: change.to }));
      mismatches.value = compareValues(expected, parseConfig(connection.snapshot!.dumpAll));
      step.value = "done";
      message.value = "";
    } catch (reason) {
      fail(describeError(reason));
    }
  }

  async function restore(backup: TuneBackup): Promise<void> {
    if (running.value || connection.isBusy) return;
    const problem = restoreProblem(backup);
    if (problem) return fail(problem);
    begin("restore");
    try {
      if (!(await sendAndSave(backup.restoreScript))) return;
      step.value = "done";
      message.value = "";
    } catch (reason) {
      fail(describeError(reason));
    }
  }

  function remove(id: string): void {
    try {
      persist(backups.value.filter((backup) => backup.id !== id));
    } catch {
      backups.value = backups.value.filter((backup) => backup.id !== id);
    }
  }

  return { backups, forThisBoard, step, action, message, error, rejected, mismatches, savedToBoard, sentPlan, running, restoreProblem, run, restore, remove, reset };
});
