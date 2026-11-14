<script setup lang="ts">
import { complete, type CompletionResult } from "@bf-migrate/core";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import NotConnected from "../components/NotConnected.vue";
import { useConnectionStore } from "../stores/connection";

const HISTORY_KEY = "bfm.cli.history";
const MAX_HISTORY = 200;
const VISIBLE_SUGGESTIONS = 9;

/** Commands after which the board restarts, so the app must reconnect. */
const REBOOTING = new Set(["save", "exit", "reboot"]);
/** Commands that leave the normal firmware entirely. */
const BLOCKED = new Set(["bl", "dfu", "msc"]);

const connection = useConnectionStore();
const line = ref("");
const cursor = ref(0);
const selected = ref(0);
const popupOpen = ref(true);
const navigating = ref(false);
const historyIndex = ref(-1);
const input = ref<HTMLInputElement>();
const scroller = ref<HTMLElement>();
const history = ref<string[]>(loadHistory());

function loadHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory(): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value.slice(-MAX_HISTORY)));
  } catch {
    // History is a convenience; the terminal works without it.
  }
}

const result = computed<CompletionResult | undefined>(() => {
  const context = connection.completion;
  if (!context || !line.value.trim()) return undefined;
  return complete(line.value, cursor.value, context);
});

const suggestions = computed(() => (popupOpen.value ? (result.value?.suggestions ?? []).slice(0, VISIBLE_SUGGESTIONS) : []));

/** Typed characters are extended in grey when the top suggestion continues them. */
const ghost = computed(() => {
  const top = result.value?.suggestions[selected.value];
  if (!top || !popupOpen.value || cursor.value !== line.value.length) return "";
  const typed = line.value.slice(result.value!.from);
  return top.insert.toLowerCase().startsWith(typed.toLowerCase()) ? top.insert.slice(typed.length) : "";
});

const terminalText = computed(() => connection.terminal);

watch(result, () => {
  selected.value = 0;
  navigating.value = false;
});

watch(terminalText, async () => {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
});

onMounted(() => input.value?.focus());

function syncCursor(): void {
  cursor.value = input.value?.selectionStart ?? line.value.length;
}

function onInput(): void {
  popupOpen.value = true;
  historyIndex.value = -1;
  syncCursor();
}

async function accept(index: number): Promise<void> {
  const current = result.value;
  const choice = current?.suggestions[index];
  if (!current || !choice) return;
  line.value = line.value.slice(0, current.from) + choice.insert + line.value.slice(current.to);
  const position = current.from + choice.insert.length;
  cursor.value = position;
  popupOpen.value = true;
  await nextTick();
  input.value?.setSelectionRange(position, position);
  input.value?.focus();
}

function recallHistory(direction: -1 | 1): void {
  if (history.value.length === 0) return;
  const start = historyIndex.value === -1 ? history.value.length : historyIndex.value;
  const next = start + direction;
  if (next < 0) return;
  if (next >= history.value.length) {
    historyIndex.value = -1;
    line.value = "";
  } else {
    historyIndex.value = next;
    line.value = history.value[next]!;
  }
  popupOpen.value = false;
  cursor.value = line.value.length;
  nextTick(() => input.value?.setSelectionRange(cursor.value, cursor.value));
}

function moveSelection(direction: -1 | 1): void {
  const count = suggestions.value.length;
  navigating.value = true;
  selected.value = (selected.value + direction + count) % count;
}

async function send(text: string): Promise<void> {
  const session = connection.link?.cli;
  const command = text.trim();
  if (!session || !command) return;

  const word = (command.split(/\s+/)[0] ?? "").toLowerCase();
  if (BLOCKED.has(word)) {
    connection.appendTerminal(`\n# "${word}" would drop the connection. Use the firmware tools instead.\n`);
    return;
  }

  if (REBOOTING.has(word)) {
    await session.sendFinal(command);
    await connection.reconnectAfterReboot();
    return;
  }
  await session.run(command, 45_000);
}

async function submit(): Promise<void> {
  const text = line.value;
  line.value = "";
  cursor.value = 0;
  historyIndex.value = -1;
  popupOpen.value = true;
  if (!text.trim()) return;
  if (history.value[history.value.length - 1] !== text) {
    history.value.push(text);
    saveHistory();
  }
  await send(text);
}

/** Pasted multi-line text runs one line at a time so each gets its own result. */
async function onPaste(event: ClipboardEvent): Promise<void> {
  const text = event.clipboardData?.getData("text") ?? "";
  const lines = text.split(/\r?\n/).filter((entry) => entry.trim());
  if (lines.length < 2) return;
  event.preventDefault();
  for (const entry of lines) await send(entry);
}

function onKeydown(event: KeyboardEvent): void {
  const showing = suggestions.value.length > 0;

  if (event.key === "Tab") {
    event.preventDefault();
    if (showing) void accept(selected.value);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (showing && navigating.value) void accept(selected.value);
    else void submit();
    return;
  }
  if (event.key === "Escape") {
    popupOpen.value = false;
    return;
  }
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? -1 : 1;
    const browsingHistory = historyIndex.value !== -1 || !line.value.trim();
    if (showing && !browsingHistory) moveSelection(direction);
    else recallHistory(direction);
    return;
  }
  if (event.key === "l" && event.ctrlKey) {
    event.preventDefault();
    connection.terminal = "";
  }
}

function clear(): void {
  connection.terminal = "";
  input.value?.focus();
}
</script>

<template>
  <div class="page cli-page">
    <header class="page-header">
      <div>
        <h1>CLI</h1>
        <p>Search any setting by a few letters. Allowed values come from this board's own firmware.</p>
      </div>
      <button v-if="connection.isConnected" class="btn" @click="clear()">Clear</button>
    </header>

    <NotConnected v-if="!connection.identity" what="its command line" />

    <div v-else class="terminal">
      <pre ref="scroller" class="output" aria-live="polite">{{ terminalText || "Type a command. Tab accepts a suggestion, Up recalls history, Esc hides suggestions." }}</pre>

      <div class="composer">
        <ul v-if="suggestions.length" class="popup" role="listbox" aria-label="Suggestions">
          <li
            v-for="(entry, index) in suggestions"
            :key="entry.label"
            role="option"
            :aria-selected="index === selected"
            :data-selected="index === selected"
            @mousedown.prevent="accept(index)"
          >
            <span class="label">{{ entry.label }}</span>
            <span v-if="entry.detail" class="detail">{{ entry.detail }}</span>
          </li>
        </ul>

        <div class="prompt-row">
          <span class="prompt" aria-hidden="true">#</span>
          <div class="field">
            <div class="ghost" aria-hidden="true"><span class="hidden-text">{{ line }}</span>{{ ghost }}</div>
            <input
              ref="input"
              v-model="line"
              :disabled="!connection.isConnected"
              spellcheck="false"
              autocomplete="off"
              autocapitalize="off"
              aria-label="CLI command"
              @input="onInput"
              @click="syncCursor"
              @keyup="syncCursor"
              @keydown="onKeydown"
              @paste="onPaste"
            />
          </div>
        </div>

        <div v-if="result?.problem || result?.hint || result?.usage" class="hint">
          <span v-if="result?.problem" class="problem">{{ result.problem }}</span>
          <template v-else>
            <span v-if="result?.usage" class="usage">
              <span v-for="(arg, index) in result.usage.args" :key="index" :data-active="index === result.usage.active">{{ arg }}</span>
            </span>
            <span v-if="result?.hint" class="muted">{{ result.hint }}</span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cli-page {
  height: 100%;
  max-width: none;
}

.terminal {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  border-radius: var(--radius-panel);
  border: 1px solid var(--panel-border);
  background: var(--panel-bg);
  font-family: var(--font-mono);
  font-size: 0.86rem;
}

.output {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0.85rem 1rem;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.composer {
  position: relative;
  border-top: 1px solid var(--panel-border);
}

.prompt-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.6rem 1rem;
}

.prompt {
  color: var(--muted);
  font-weight: 700;
}

.field {
  position: relative;
  flex: 1;
  min-width: 0;
}

.field input,
.ghost {
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  line-height: 1.5;
}

.field input:focus {
  outline: none;
}

.ghost {
  position: absolute;
  inset: 0;
  color: var(--muted);
  opacity: 0.65;
  white-space: pre;
  overflow: hidden;
  pointer-events: none;
}

.hidden-text {
  visibility: hidden;
}

.popup {
  position: absolute;
  left: 2rem;
  right: 1rem;
  bottom: 100%;
  margin: 0 0 0.3rem;
  padding: 0.25rem;
  max-width: 46rem;
  list-style: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-box);
  box-shadow: var(--shadow);
}

.popup li {
  display: flex;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 0.2rem 0.55rem;
  border-radius: var(--radius-box);
  cursor: pointer;
}

.popup li[data-selected="true"] {
  background: var(--surface-2);
}

.label {
  font-weight: 620;
  white-space: nowrap;
}

.detail {
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hint {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 1rem;
  padding: 0 1rem 0.55rem 2.05rem;
  font-size: 0.8rem;
}

.problem {
  color: var(--danger);
  font-weight: 600;
}

.usage {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  color: var(--muted);
}

.usage [data-active="true"] {
  color: var(--text);
  font-weight: 700;
}
</style>
