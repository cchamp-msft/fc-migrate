<script setup lang="ts">
import { Check, Copy, Download } from "lucide-vue-next";
import { computed, ref } from "vue";
import NotConnected from "../components/NotConnected.vue";
import { useConnectionStore } from "../stores/connection";
import { saveFile } from "../utils/save-file";

type Source = "diff" | "dump";

const connection = useConnectionStore();
const source = ref<Source>("diff");
const filter = ref("");
const copied = ref(false);

const text = computed(() => {
  const snapshot = connection.snapshot;
  if (!snapshot) return "";
  return source.value === "diff" ? snapshot.diffAll : snapshot.dumpAll;
});

interface Line {
  id: number;
  kind: "comment" | "set" | "scope" | "command";
  text: string;
  name?: string;
  value?: string;
}

function classify(raw: string, id: number): Line {
  const set = /^set (\S+) = (.*)$/.exec(raw);
  if (set) return { id, kind: "set", text: raw, name: set[1], value: set[2] };
  if (raw.startsWith("#")) return { id, kind: "comment", text: raw };
  if (/^(profile|rateprofile|battery_profile) \d+$/.test(raw)) return { id, kind: "scope", text: raw };
  return { id, kind: "command", text: raw };
}

const lines = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  const all = text.value.split("\n").map(classify);
  if (!needle) return all;
  return all.filter((line) => line.text.toLowerCase().includes(needle));
});

const filename = computed(() => {
  const identity = connection.identity;
  if (!identity) return "betaflight-config.txt";
  const name = (identity.craftName || identity.board.boardName).replace(/[^A-Za-z0-9_-]+/g, "_");
  const date = new Date().toISOString().slice(0, 10);
  return `BTFL_${name}_${identity.board.boardName}_${identity.firmwareVersion}_${source.value}_${date}.txt`;
});

function download(): void {
  saveFile(filename.value, `${text.value}\n`);
}

async function copy(): Promise<void> {
  await navigator.clipboard.writeText(text.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>Configuration</h1>
        <p>Read from the board when it connected. Save a copy before you change anything.</p>
      </div>
      <div v-if="connection.snapshot" class="actions">
        <button class="btn" @click="copy()">
          <component :is="copied ? Check : Copy" :size="15" /> {{ copied ? "Copied" : "Copy" }}
        </button>
        <button class="btn btn-primary" @click="download()"><Download :size="15" /> Save to file</button>
      </div>
    </header>

    <NotConnected v-if="!connection.snapshot" what="its configuration" />

    <template v-else>
      <div class="toolbar card">
        <div class="segmented" role="group" aria-label="Configuration view">
          <button :aria-pressed="source === 'diff'" @click="source = 'diff'">Changes only</button>
          <button :aria-pressed="source === 'dump'" @click="source = 'dump'">Everything</button>
        </div>
        <input v-model="filter" class="input filter" type="search" placeholder="Filter lines" aria-label="Filter configuration lines" />
        <span class="muted count">{{ lines.length }} lines</span>
      </div>

      <div class="card listing">
        <div v-for="line in lines" :key="line.id" class="line" :data-kind="line.kind">
          <template v-if="line.kind === 'set'">
            <span class="kw">set</span> <span class="name">{{ line.name }}</span> <span class="op">=</span> <span class="value">{{ line.value }}</span>
          </template>
          <template v-else>{{ line.text || "\u00a0" }}</template>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.actions,
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.filter {
  flex: 1 1 14rem;
  max-width: 24rem;
}

.count {
  font-size: 0.85rem;
}

.listing {
  padding: 0.75rem 1rem;
  font-family: var(--font-mono);
  font-size: 0.84rem;
  line-height: 1.55;
  overflow-x: auto;
}

.line {
  white-space: pre;
}

.line[data-kind="comment"] {
  color: var(--muted);
}

.line[data-kind="scope"] {
  font-weight: 700;
  color: var(--accent);
}

:root[data-theme="betaflight"][data-mode="light"] .line[data-kind="scope"] {
  color: inherit;
}

.kw,
.op {
  color: var(--muted);
}

.value {
  font-weight: 620;
}
</style>
