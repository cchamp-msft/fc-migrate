<script setup lang="ts">
import { BuildApi, parseConfig, planMigration, releaseLineOf, upgradeTargets, type Domain, type FirmwareRelease, type FirmwareSchema, type MigrationPlan, type Outcome, type PlanItem } from "@bf-migrate/core";
import { CircleAlert, CircleCheck, Download, X } from "lucide-vue-next";
import { computed, ref, shallowRef, watch } from "vue";
import AiSuggestions from "../components/AiSuggestions.vue";
import NotConnected from "../components/NotConnected.vue";
import UpgradePanel from "../components/UpgradePanel.vue";
import { loadSchema } from "../data/schemas";
import { useConnectionStore } from "../stores/connection";
import { useStandardsStore } from "../stores/standards";
import { useUpgradeStore } from "../stores/upgrade";
import { saveFile } from "../utils/save-file";

const connection = useConnectionStore();
const standards = useStandardsStore();
const upgrade = useUpgradeStore();

/** Once flashing starts the board changes version, so the page follows the running upgrade. */
const upgradeActive = computed(() => upgrade.step !== "idle");

const releases = ref<FirmwareRelease[]>([]);
const releasesError = ref("");
const showUnstable = ref(false);
const targetVersion = ref("");
const targetSchema = shallowRef<FirmwareSchema>();
const keepOld = ref(new Set<string>());
const accepted = ref(new Map<string, string>());
const newName = ref("");
const newValue = ref("");

const DOMAIN_ORDER: { id: Domain; label: string }[] = [
  { id: "serial", label: "Serial ports" },
  { id: "orientation", label: "Gyro and board orientation" },
  { id: "motors", label: "Motors" },
  { id: "modes", label: "Modes" },
  { id: "vtx", label: "VTX" },
  { id: "osd", label: "OSD" },
  { id: "rates", label: "Rates" },
  { id: "tuning", label: "Tuning" },
  { id: "filters", label: "Filters" },
  { id: "receiver", label: "Receiver" },
  { id: "failsafe", label: "Failsafe" },
  { id: "board", label: "Board and features" },
  { id: "other", label: "Other" },
];

const OUTCOME_LABELS: Record<Outcome, string> = {
  carried: "Carried",
  renamed: "Renamed",
  converted: "Converted",
  derived: "From sliders",
  dropped: "Dropped",
  attention: "Check this",
  "default-changed": "New default",
  standard: "Your standard",
  suggested: "AI suggested",
};

const OUTCOME_CLASS: Record<Outcome, string> = {
  carried: "badge-neutral",
  renamed: "badge-ok",
  converted: "badge-ok",
  derived: "badge-neutral",
  dropped: "badge-warn",
  attention: "badge-danger",
  "default-changed": "badge-neutral",
  standard: "badge-ok",
  suggested: "badge-ok",
};

const SUMMARY: Outcome[] = ["carried", "renamed", "converted", "derived", "dropped", "attention"];
const summary = computed<Outcome[]>(() => (plan.value?.counts.suggested ? [...SUMMARY, "suggested"] : SUMMARY));

const sourceLine = computed(() => (connection.identity ? releaseLineOf(connection.identity.firmwareVersion) : undefined));

const targets = computed(() => {
  const identity = connection.identity;
  if (!identity || !sourceLine.value) return [];
  return upgradeTargets(identity.firmwareVersion, releases.value, showUnstable.value);
});

watch(
  () => connection.identity?.board.boardName,
  async (board) => {
    releases.value = [];
    releasesError.value = "";
    if (!board) return;
    try {
      releases.value = await new BuildApi().listReleases(board);
    } catch (error) {
      releasesError.value = error instanceof Error ? error.message : String(error);
    }
  },
  { immediate: true },
);

watch(
  targets,
  (list) => {
    if (!list.some((release) => release.release === targetVersion.value)) targetVersion.value = list[0]?.release ?? "";
  },
  { immediate: true },
);

watch(
  targetVersion,
  async (version) => {
    targetSchema.value = undefined;
    keepOld.value = new Set();
    accepted.value = new Map();
    if (version) targetSchema.value = await loadSchema(version);
  },
  { immediate: true },
);

const plan = computed<MigrationPlan | undefined>(() => {
  const snapshot = connection.snapshot;
  const identity = connection.identity;
  if (!snapshot || !identity || !targetVersion.value || !sourceLine.value) return undefined;
  return planMigration({
    sourceVersion: identity.firmwareVersion,
    targetVersion: targetVersion.value,
    boardName: identity.board.boardName,
    diff: parseConfig(snapshot.diffAll),
    dump: parseConfig(snapshot.dumpAll),
    sourceSchema: connection.completion?.schema,
    targetSchema: targetSchema.value,
    standards: standards.standards,
    keepOldDefaults: keepOld.value,
    suggestions: accepted.value,
  });
});

const attention = computed(() => plan.value?.items.filter((item) => item.outcome === "attention") ?? []);
const defaultChanges = computed(() => plan.value?.items.filter((item) => item.outcome === "default-changed") ?? []);

const groups = computed(() => {
  const items = (plan.value?.items ?? []).filter((item) => item.outcome !== "default-changed");
  return DOMAIN_ORDER.map((domain) => ({ ...domain, items: items.filter((item) => item.domain === domain.id) })).filter((group) => group.items.length > 0);
});

function scopeLabel(item: PlanItem): string {
  if (item.scope.kind === "master") return "";
  const name = item.scope.kind === "rateprofile" ? "Rates" : "PID";
  return `${name} ${item.scope.index + 1}`;
}

function changed(item: PlanItem): boolean {
  return item.targetName !== undefined && (item.targetName !== item.sourceName || item.targetValue !== item.sourceValue);
}

function toggleKeep(id: string): void {
  const next = new Set(keepOld.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  keepOld.value = next;
}

function addStandard(): void {
  if (!newName.value.trim() || !newValue.value.trim()) return;
  standards.add(newName.value, newValue.value);
  newName.value = "";
  newValue.value = "";
}

function downloadScript(): void {
  const current = plan.value;
  if (!current) return;
  saveFile(`migration_${current.sourceVersion}_to_${current.targetVersion}.txt`, `${current.script.join("\n")}\n`);
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>Migrate</h1>
        <p>Review how this board's configuration moves to a newer firmware, then upgrade when you are ready.</p>
      </div>
      <button v-if="plan && !upgradeActive" class="btn" @click="downloadScript()"><Download :size="15" /> Save script</button>
    </header>

    <template v-if="upgradeActive && upgrade.plan">
      <section class="card target">
        <span class="target-field"><span class="muted">From</span> <strong>{{ upgrade.plan.sourceVersion }}</strong></span>
        <span class="target-field"><span class="muted">To</span> <strong>{{ upgrade.plan.targetVersion }}</strong></span>
      </section>
      <UpgradePanel :plan="upgrade.plan" />
    </template>

    <NotConnected v-else-if="!connection.identity" what="its migration options" />

    <template v-else>
      <div v-if="!sourceLine" class="notice notice-warn">
        <CircleAlert :size="18" />
        <span>Betaflight {{ connection.identity.firmwareVersion }} is not supported yet. Migration starts from 4.5.</span>
      </div>

      <section v-else class="card target">
        <label class="target-field">
          <span class="muted">From</span>
          <strong>{{ connection.identity.firmwareVersion }}</strong>
        </label>
        <label class="target-field">
          <span class="muted">To</span>
          <select v-model="targetVersion" class="input" :disabled="targets.length === 0">
            <option v-for="release in targets" :key="release.release" :value="release.release">{{ release.release }}{{ release.type === "Stable" ? "" : " (unstable)" }}</option>
          </select>
        </label>
        <label class="unstable"><input v-model="showUnstable" type="checkbox" /> Include unstable releases</label>
        <span v-if="plan" class="muted steps">{{ plan.steps.length ? plan.steps.join(", then ") : "Same release line, no conversions" }}</span>
      </section>

      <div v-if="sourceLine && releases.length && targets.length === 0" class="notice">
        <CircleCheck :size="18" />
        <span>This board is already on the newest {{ showUnstable ? "" : "stable " }}release.</span>
      </div>

      <div v-if="releasesError" class="notice notice-danger">
        <CircleAlert :size="18" />
        <span>Could not reach the firmware list: {{ releasesError }}</span>
      </div>

      <div v-if="plan && !targetSchema" class="notice notice-warn">
        <CircleAlert :size="18" />
        <span>No captured settings list for {{ targetVersion }} yet, so values are not checked against it and changed defaults are not listed.</span>
      </div>

      <template v-if="plan">
        <section class="summary">
          <div v-for="outcome in summary" :key="outcome" class="stat" :data-attention="outcome === 'attention' && plan.counts.attention > 0">
            <strong>{{ plan.counts[outcome] }}</strong>
            <span class="muted">{{ OUTCOME_LABELS[outcome] }}</span>
          </div>
        </section>

        <section v-if="attention.length" class="card attention">
          <h2>Check these first</h2>
          <ul class="rows">
            <li v-for="item in attention" :key="item.id" class="row">
              <div class="row-head">
                <code>{{ item.sourceName }}<template v-if="item.sourceValue"> = {{ item.sourceValue }}</template></code>
                <span v-if="scopeLabel(item)" class="chip">{{ scopeLabel(item) }}</span>
              </div>
              <p class="muted">{{ item.note }}</p>
            </li>
          </ul>
        </section>

        <AiSuggestions v-if="targetSchema" v-model:accepted="accepted" :plan="plan" :target-schema="targetSchema" />

        <section v-if="plan.tuning.length" class="card">
          <h2>Tuning</h2>
          <ul class="rows">
            <li v-for="profile in plan.tuning" :key="profile.profile" class="row">
              <div class="row-head">
                <strong>PID profile {{ profile.profile + 1 }}</strong>
                <span class="badge" :class="profile.mode === 'sliders' ? 'badge-ok' : 'badge-neutral'">{{ profile.mode === "sliders" ? "Sliders" : "Custom PIDs" }}</span>
              </div>
              <p class="muted">{{ profile.summary }}</p>
            </li>
          </ul>
        </section>

        <section class="card">
          <h2>Your standards</h2>
          <p class="muted lead">Settings you always want, whatever the firmware. Applied last, to every profile.</p>
          <div v-if="standards.standards.length" class="chips standards">
            <span v-for="entry in standards.standards" :key="entry.name" class="chip mono">
              {{ entry.name }} = {{ entry.value }}
              <button class="chip-x" :aria-label="`Remove ${entry.name}`" @click="standards.remove(entry.name)"><X :size="12" /></button>
            </span>
          </div>
          <form class="standard-form" @submit.prevent="addStandard()">
            <input v-model="newName" class="input mono" placeholder="throttle_boost" aria-label="Setting name" list="standard-names" />
            <input v-model="newValue" class="input mono value-input" placeholder="0" aria-label="Value" />
            <button class="btn" type="submit">Add</button>
            <datalist id="standard-names">
              <option v-for="name in Object.keys(connection.completion?.schema.settings ?? {})" :key="name" :value="name" />
            </datalist>
          </form>
        </section>

        <section v-if="defaultChanges.length" class="card">
          <h2>New defaults on {{ targetVersion }}</h2>
          <p class="muted lead">You never changed these, so the new firmware's values apply unless you keep the old one.</p>
          <ul class="rows">
            <li v-for="item in defaultChanges" :key="item.id" class="row">
              <label class="default-row">
                <input type="checkbox" :checked="keepOld.has(item.id)" @change="toggleKeep(item.id)" />
                <code>{{ item.targetName }}</code>
                <span class="muted">{{ item.note }}</span>
              </label>
            </li>
          </ul>
        </section>

        <details v-for="group in groups" :key="group.id" class="card group" :open="group.id === 'serial' || group.id === 'tuning'">
          <summary>
            <h2>{{ group.label }}</h2>
            <span class="muted">{{ group.items.length }}</span>
          </summary>
          <ul class="rows">
            <li v-for="item in group.items" :key="item.id" class="row">
              <div class="row-head">
                <span class="badge" :class="OUTCOME_CLASS[item.outcome]">{{ OUTCOME_LABELS[item.outcome] }}</span>
                <code class="change">
                  <span>{{ item.sourceName }}<template v-if="item.sourceValue"> {{ item.scope.kind === "master" && !item.targetName ? "" : "=" }} {{ item.sourceValue }}</template></span>
                  <template v-if="changed(item)"><span class="arrow" aria-hidden="true">→</span><span>{{ item.targetName }} = {{ item.targetValue }}</span></template>
                </code>
                <span v-if="scopeLabel(item)" class="chip">{{ scopeLabel(item) }}</span>
              </div>
              <p v-if="item.note" class="muted">{{ item.note }}</p>
            </li>
          </ul>
        </details>

        <UpgradePanel :plan="plan" />

        <details class="card group">
          <summary>
            <h2>Commands that will be sent</h2>
            <span class="muted">{{ plan.script.length }}</span>
          </summary>
          <pre class="script">{{ plan.script.join("\n") }}</pre>
        </details>
      </template>
    </template>
  </div>
</template>

<style scoped>
.target {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1.5rem;
}

.target-field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.unstable {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.steps {
  margin-left: auto;
}

.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
  gap: 0.6rem;
}

.stat {
  display: flex;
  flex-direction: column;
  padding: 0.6rem 0.9rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
}

.stat strong {
  font-size: 1.35rem;
  line-height: 1.2;
}

.stat[data-attention="true"] {
  border-color: var(--danger);
}

.attention {
  border-color: var(--danger);
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.row p {
  margin-top: 0.1rem;
  font-size: 0.9rem;
}

.row-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.55rem;
}

code {
  font-size: 0.86rem;
  overflow-wrap: anywhere;
}

.change {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.5rem;
}

.arrow {
  color: var(--muted);
}

.lead {
  margin-bottom: 0.65rem;
}

.standards {
  margin-bottom: 0.65rem;
}

.chip-x {
  display: inline-flex;
  margin-left: 0.3rem;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
}

.standard-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.value-input {
  width: 7rem;
}

.default-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.6rem;
}

.group summary {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  cursor: pointer;
}

.group summary h2 {
  margin: 0;
}

.group[open] summary {
  margin-bottom: 0.65rem;
}

.script {
  margin: 0;
  overflow-x: auto;
  font-size: 0.84rem;
}
</style>
