<script setup lang="ts">
import { checkBootstrapReady, parseConfig, planBootstrap, type BootstrapChange, type BootstrapChoices, type BootstrapInput, type Feel, type QuadSize } from "@bf-migrate/core";
import { CircleAlert, CircleCheck, Download, RotateCcw, Trash2 } from "lucide-vue-next";
import { computed, ref } from "vue";
import NotConnected from "../components/NotConnected.vue";
import { useBootstrapStore, type TuneBackup } from "../stores/bootstrap";
import { useConnectionStore } from "../stores/connection";
import { saveFile } from "../utils/save-file";

const connection = useConnectionStore();
const bootstrap = useBootstrapStore();

const size = ref<QuadSize>("large");
const feel = ref<Feel>("default");
const windResistant = ref(false);
const confirmingRestore = ref("");

const SIZES: { id: QuadSize; label: string; detail: string }[] = [
  { id: "small", label: "2 to 3.5 inch", detail: "Dynamic idle 3,500 rpm" },
  { id: "large", label: "4 to 5 inch", detail: "Dynamic idle 3,000 rpm" },
];

const FEELS: { id: Feel; label: string; detail: string }[] = [
  { id: "default", label: "Default", detail: "Betaflight's default PIDs" },
  { id: "smooth", label: "Smooth", detail: "More damping and D-term filtering" },
];

/** A preview from the connect-time capture. The run reads the board again before sending. */
const input = computed<BootstrapInput | undefined>(() => {
  const identity = connection.identity;
  const snapshot = connection.snapshot;
  const schema = connection.completion?.schema;
  if (!identity || !snapshot || !schema) return undefined;
  return { firmwareVersion: identity.firmwareVersion, dump: parseConfig(snapshot.dumpAll), schema };
});

const readiness = computed(() => (input.value ? checkBootstrapReady(input.value) : undefined));
const protocol = computed(() => input.value?.dump.entries.find((entry) => entry.kind === "set" && entry.name === "motor_pwm_protocol" && entry.scope.kind === "master"));

const choices = computed<BootstrapChoices>(() => ({ size: size.value, feel: feel.value, windResistant: windResistant.value }));
const plan = computed(() => (input.value && readiness.value?.ready ? planBootstrap(input.value, choices.value) : undefined));

const groups = computed(() => {
  const current = plan.value;
  if (!current) return [];
  const indexes = [...new Set(current.changes.map((change) => (change.scope.kind === "profile" ? change.scope.index : -1)))];
  return indexes.map((index) => {
    const changes = current.changes.filter((change) => (change.scope.kind === "profile" ? change.scope.index : -1) === index);
    return { index, active: index === current.activeProfile, changed: changes.filter((change) => change.changed), unchanged: changes.filter((change) => !change.changed).length };
  });
});

function shown(change: BootstrapChange): string {
  return change.name === "dyn_idle_min_rpm" ? `${change.to} (${(Number(change.to) * 100).toLocaleString("en-US")} rpm)` : change.to;
}

function when(backup: TuneBackup): string {
  return new Date(backup.savedAt).toLocaleString();
}

function download(backup: TuneBackup): void {
  const text = [`# Tune backup from Betaflight Migrator`, `# ${backup.boardName} ${backup.craftName} ${backup.firmwareVersion}, ${backup.savedAt}`, "", "# Restore script", ...backup.restoreScript, "save", "", "# Full configuration (diff all)", backup.diffAll, ""].join("\n");
  saveFile(`tune_backup_${backup.boardName}_${backup.savedAt.replace(/[:.]/g, "-")}.txt`, text);
}

async function restore(backup: TuneBackup): Promise<void> {
  confirmingRestore.value = "";
  await bootstrap.restore(backup);
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>Bootstrap</h1>
        <p>Set a quad that already flies to a known starting point: no throttle boost, idle held by motor rpm, and default PIDs with a choice of feel. The current tune is kept in this browser first.</p>
      </div>
    </header>

    <!-- Outside every condition, so a result survives a dropped board or a failed check. -->
    <section v-if="bootstrap.step !== 'idle'" class="card run" aria-live="polite">
      <h2>{{ bootstrap.action === "restore" ? "Restore" : "Bootstrap" }}</h2>
      <p v-if="bootstrap.running" class="muted">{{ bootstrap.message }}…</p>

      <div v-if="bootstrap.step === 'done'" class="notice">
        <CircleCheck :size="18" />
        <span v-if="!bootstrap.savedToBoard">Sent to the demo board. A real board would now save and restart.</span>
        <span v-else-if="bootstrap.action === 'restore'">Your previous tune is back and saved.</span>
        <span v-else-if="bootstrap.mismatches.length === 0">Saved. The board reports every value as set. Hover and test gently before a full pack.</span>
        <span v-else>Saved, but {{ bootstrap.mismatches.length }} {{ bootstrap.mismatches.length === 1 ? "value differs" : "values differ" }} from what was sent.</span>
      </div>
      <ul v-if="bootstrap.mismatches.length" class="rows">
        <li v-for="entry in bootstrap.mismatches" :key="`${entry.scope}|${entry.name}`"><code>{{ entry.name }}</code> <span class="muted">({{ entry.scope }})</span>: expected {{ entry.expected }}, board has {{ entry.actual ?? "nothing" }}</li>
      </ul>

      <div v-if="bootstrap.step === 'failed'" class="notice notice-danger">
        <CircleAlert :size="18" />
        <span>{{ bootstrap.error }}</span>
      </div>
      <ul v-if="bootstrap.rejected.length" class="rows">
        <li v-for="entry in bootstrap.rejected" :key="entry.line"><code>{{ entry.line }}</code> <span class="muted">{{ entry.message }}</span></li>
      </ul>
      <button v-if="!bootstrap.running" class="btn btn-s dismiss" @click="bootstrap.reset()">Dismiss</button>
    </section>

    <NotConnected v-if="!connection.identity" what="its tune" />

    <template v-else-if="readiness">
      <div v-if="!readiness.ready" class="notice notice-warn">
        <CircleAlert :size="18" />
        <div>
          <strong>This quad is not ready for the bootstrapper.</strong>
          <p v-for="problem in readiness.problems" :key="problem">{{ problem }}</p>
        </div>
      </div>

      <template v-else-if="plan">
        <div class="notice">
          <CircleCheck :size="18" />
          <span>Bidirectional DShot is on<template v-if="protocol?.kind === 'set'"> ({{ protocol.value }})</template>, so dynamic idle can use motor rpm.</span>
        </div>

        <section class="card">
          <h2>Your quad</h2>
          <fieldset class="choice">
            <legend class="muted">Size</legend>
            <label v-for="option in SIZES" :key="option.id" class="option" :data-selected="size === option.id">
              <input v-model="size" type="radio" name="size" :value="option.id" />
              <span><strong>{{ option.label }}</strong><span class="muted">{{ option.detail }}</span></span>
            </label>
          </fieldset>
          <fieldset class="choice">
            <legend class="muted">Feel</legend>
            <label v-for="option in FEELS" :key="option.id" class="option" :data-selected="feel === option.id">
              <input v-model="feel" type="radio" name="feel" :value="option.id" />
              <span><strong>{{ option.label }}</strong><span class="muted">{{ option.detail }}</span></span>
            </label>
          </fieldset>
          <label class="option wind" :data-selected="windResistant">
            <input v-model="windResistant" type="checkbox" />
            <span><strong>Wind resistant</strong><span class="muted">More I, steady D, and thrust linearization for gusts</span></span>
          </label>
        </section>

        <section class="card">
          <h2>What changes</h2>
          <div v-for="group in groups" :key="group.index" class="profile">
            <h3>
              PID profile {{ group.index + 1 }}
              <span v-if="group.active" class="badge badge-ok">Active</span>
            </h3>
            <ul v-if="group.changed.length" class="rows">
              <li v-for="change in group.changed" :key="change.name" class="row">
                <code class="change">
                  {{ change.name }} <span class="muted">{{ change.from ?? "unset" }}</span> <span class="arrow" aria-hidden="true">→</span> {{ shown(change) }}
                </code>
                <p class="muted">{{ change.reason }}</p>
              </li>
            </ul>
            <p v-if="group.unchanged" class="muted small">{{ group.unchanged }} {{ group.unchanged === 1 ? "setting is" : "settings are" }} already right.</p>
          </div>
          <p class="muted lead recompute-lead">Then <code>simplified_tuning apply</code> has the firmware recompute:</p>
          <ul class="recomputed">
            <li v-for="note in plan.recomputed" :key="note" class="muted">{{ note }}</li>
          </ul>
          <div v-for="entry in plan.skipped" :key="entry.name" class="notice notice-warn">
            <CircleAlert :size="18" />
            <span><code>{{ entry.name }}</code> is skipped: {{ entry.reason }}</span>
          </div>
        </section>

        <section class="card">
          <div class="actions">
            <button class="btn btn-primary" :disabled="bootstrap.running || connection.isBusy" @click="bootstrap.run(choices)">Back up and apply</button>
            <span class="muted small">The board is read again first, so the backup matches what it has right now.</span>
          </div>
          <p v-if="connection.isDemo" class="muted small">The demo board accepts the commands but cannot save them.</p>
        </section>
      </template>

      <section v-if="bootstrap.forThisBoard.length" class="card">
        <h2>Tunes kept in this browser</h2>
        <p class="muted lead">Each restore puts back the PIDs, sliders, filters, throttle boost, dynamic idle and thrust linearization of every profile, then saves.</p>
        <ul class="rows">
          <li v-for="backup in bootstrap.forThisBoard" :key="backup.id" class="backup">
            <span>
              <strong>{{ when(backup) }}</strong>
              <span class="muted"> · {{ backup.craftName || backup.boardName }} · {{ backup.firmwareVersion }}</span>
            </span>
            <span class="backup-actions">
              <button
                v-if="confirmingRestore !== backup.id"
                class="btn btn-s"
                :disabled="bootstrap.running || connection.isBusy || !!bootstrap.restoreProblem(backup)"
                @click="confirmingRestore = backup.id"
              >
                <RotateCcw :size="14" /> Restore
              </button>
              <template v-else>
                <button class="btn btn-s btn-danger" :disabled="bootstrap.running || connection.isBusy" @click="restore(backup)">Restore and save</button>
                <button class="btn btn-s" @click="confirmingRestore = ''">Cancel</button>
              </template>
              <button class="btn btn-s" :aria-label="`Download backup from ${when(backup)}`" @click="download(backup)"><Download :size="14" /></button>
              <button class="btn btn-s" :aria-label="`Delete backup from ${when(backup)}`" :disabled="bootstrap.running" @click="bootstrap.remove(backup.id)"><Trash2 :size="14" /></button>
            </span>
            <p v-if="bootstrap.restoreProblem(backup)" class="muted small full">{{ bootstrap.restoreProblem(backup) }}</p>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.notice p {
  margin: 0.2rem 0 0;
}

.choice {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin: 0 0 0.9rem;
  padding: 0;
  border: 0;
}

.choice legend {
  margin-bottom: 0.4rem;
  padding: 0;
  font-size: 0.86rem;
}

.option {
  display: flex;
  flex: 1 1 13rem;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.65rem 0.8rem;
  border: 1px solid var(--control-border);
  border-radius: var(--radius-box);
  cursor: pointer;
}

.option[data-selected="true"] {
  border-color: var(--accent);
}

.option > span {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.option input {
  margin-top: 0.2rem;
}

.wind {
  max-width: 28rem;
}

.lead {
  margin-bottom: 0.75rem;
}

.recompute-lead {
  margin: 0.9rem 0 0.3rem;
}

.recomputed {
  margin: 0 0 0.9rem;
  padding-left: 1.2rem;
  font-size: 0.9rem;
}

.profile + .profile {
  margin-top: 0.9rem;
}

.profile h3 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.4rem;
  font-size: 0.95rem;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.row p {
  margin-top: 0.1rem;
  font-size: 0.88rem;
}

code {
  font-size: 0.86rem;
  overflow-wrap: anywhere;
}

.arrow {
  color: var(--muted);
}

.small {
  font-size: 0.86rem;
}

.run h2 {
  margin-bottom: 0.4rem;
}

.run .notice,
.run .rows,
.dismiss {
  margin-top: 0.75rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
}

.backup {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem 0.75rem;
}

.backup-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.full {
  flex-basis: 100%;
  margin: 0;
}
</style>
