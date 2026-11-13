<script setup lang="ts">
import {
  checkProposals,
  isSendableLine,
  MAX_PROPOSAL_CANDIDATES,
  MAX_PROPOSAL_FAILURES,
  parseSetCommand,
  selectCandidates,
  type CheckedProposal,
  type FailedLine,
  type FirmwareSchema,
  type MigrationPlan,
  type PlanItem,
} from "@bf-migrate/core";
import { CircleAlert, Sparkles } from "lucide-vue-next";
import { computed, onMounted, ref, watch } from "vue";
import { useAssistantStore } from "../stores/assistant";

const props = defineProps<{ plan: MigrationPlan; targetSchema: FirmwareSchema }>();
/** Accepted replacements, keyed by the failed line. */
const accepted = defineModel<Map<string, string>>("accepted", { required: true });

const assistant = useAssistantStore();
const keyDraft = ref("");
const busy = ref(false);
const error = ref("");
const provider = ref("");
const results = ref<CheckedProposal[]>([]);

onMounted(() => void assistant.checkStatus());

/** Plan items for every repairable line, including repaired ones, so a choice can be undone. */
const itemsByLine = computed(() => {
  const byLine = new Map<string, PlanItem[]>();
  for (const item of props.plan.items) if (item.failedLine) byLine.set(item.failedLine, [...(byLine.get(item.failedLine) ?? []), item]);
  return byLine;
});
const repairable = computed(() => new Set(itemsByLine.value.keys()));

/**
 * Lines still waiting for a replacement, with the reason each could not be carried.
 * A line the server would refuse, such as a name with characters the CLI never
 * prints, is left out rather than failing the whole request.
 */
const failures = computed<FailedLine[]>(() => {
  const byLine = new Map<string, FailedLine>();
  for (const item of props.plan.items) {
    if (!item.failedLine || item.outcome === "suggested" || byLine.has(item.failedLine) || !isSendableLine(item.failedLine)) continue;
    byLine.set(item.failedLine, { line: item.failedLine, reason: item.note ?? `Not accepted by ${props.plan.targetVersion}.` });
  }
  return [...byLine.values()];
});

const sent = computed(() => failures.value.slice(0, MAX_PROPOSAL_FAILURES));
/** Lines the server would refuse. They are counted so the card can say why they are not sent. */
const unsendable = computed(() => [...repairable.value].filter((line) => !isSendableLine(line)).length);

watch(
  () => props.targetSchema,
  () => {
    results.value = [];
    error.value = "";
  },
);

function saveKey(): void {
  assistant.setAccessKey(keyDraft.value);
  keyDraft.value = "";
}

async function ask(): Promise<void> {
  if (busy.value || sent.value.length === 0) return;
  busy.value = true;
  error.value = "";
  const failuresSent = sent.value;
  try {
    const reply = await assistant.propose({
      sourceVersion: props.plan.sourceVersion,
      targetVersion: props.plan.targetVersion,
      failures: failuresSent,
      candidates: selectCandidates(failuresSent, props.targetSchema).slice(0, MAX_PROPOSAL_CANDIDATES),
    });
    provider.value = reply.provider;
    // A model's answer is only advice until it passes the target's own rules.
    const fresh = checkProposals(reply.proposals, failuresSent, props.targetSchema).map(checkSection);
    // Keep rows the pilot already accepted, so they can still be unticked.
    const asked = new Set(failuresSent.map((failure) => failure.line));
    results.value = [...results.value.filter((row) => !asked.has(row.line) && accepted.value.has(row.line)), ...fresh];
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}

/** A replacement must apply to the same part of the config as the line it replaces. */
function checkSection(proposal: CheckedProposal): CheckedProposal {
  if (!proposal.valid || proposal.action !== "replace") return proposal;
  const setting = props.targetSchema.settings[parseSetCommand(proposal.replacement ?? "")?.name ?? ""];
  const items = itemsByLine.value.get(proposal.line) ?? [];
  if (!setting || items.every((item) => item.scope.kind === setting.scope)) return proposal;
  return { ...proposal, valid: false, problem: `${setting.name} is set in a different section from the original line, so it would apply to something else.` };
}

/** Why the planner did not use a ticked replacement, if it did not. */
function unusedReason(proposal: CheckedProposal): string | undefined {
  if (accepted.value.get(proposal.line) !== proposal.replacement) return undefined;
  return itemsByLine.value.get(proposal.line)?.find((item) => item.suggestionProblem)?.suggestionProblem;
}

function toggle(proposal: CheckedProposal): void {
  const next = new Map(accepted.value);
  if (next.get(proposal.line) === proposal.replacement) next.delete(proposal.line);
  else if (proposal.replacement) next.set(proposal.line, proposal.replacement);
  accepted.value = next;
}

const CONFIDENCE_CLASS = { high: "badge-ok", medium: "badge-neutral", low: "badge-warn" } as const;
</script>

<template>
  <section v-if="assistant.enabled && repairable.size" class="card ai">
    <div class="ai-head">
      <Sparkles :size="18" />
      <h2>Suggested replacements</h2>
    </div>
    <p class="muted lead">
      {{ repairable.size }} {{ repairable.size === 1 ? "line" : "lines" }} cannot be carried to {{ plan.targetVersion }} as written. An AI model can suggest replacements. Each one is checked against
      {{ plan.targetVersion }}'s settings, and nothing changes unless you tick it.
    </p>

    <form v-if="!assistant.accessKey" class="key-form" @submit.prevent="saveKey()">
      <input v-model="keyDraft" class="input mono" type="password" autocomplete="off" placeholder="Passphrase" aria-label="Passphrase" />
      <button class="btn" type="submit" :disabled="!keyDraft.trim()">Save</button>
      <span class="muted">Ask whoever runs this site for the passphrase. It stays in this browser.</span>
    </form>

    <div v-else class="actions">
      <button class="btn btn-primary" :disabled="busy || sent.length === 0" @click="ask()">
        {{ busy ? "Asking the model…" : results.length ? "Ask again" : "Suggest replacements" }}
      </button>
      <span v-if="busy" class="muted">Usually 10 to 30 seconds.</span>
      <span v-else-if="failures.length > MAX_PROPOSAL_FAILURES" class="muted">Sends the first {{ MAX_PROPOSAL_FAILURES }} of {{ failures.length }} lines.</span>
      <span v-else-if="provider && results.length" class="muted">Answered by {{ provider }}.</span>
      <button class="btn btn-s forget" type="button" @click="assistant.setAccessKey('')">Forget passphrase</button>
    </div>

    <p v-if="unsendable" class="muted">
      {{ unsendable }} {{ unsendable === 1 ? "line has" : "lines have" }} characters that cannot be sent for suggestions, such as accented letters. Set
      {{ unsendable === 1 ? "it" : "them" }} by hand after the upgrade.
    </p>

    <div v-if="error" class="notice notice-danger">
      <CircleAlert :size="18" />
      <span>{{ error }}</span>
    </div>

    <ul v-if="results.length" class="rows">
      <li v-for="(proposal, index) in results" :key="`${index}:${proposal.line}`" class="row">
        <div class="row-head">
          <code>{{ proposal.line }}</code>
          <span class="arrow" aria-hidden="true">→</span>
          <code v-if="proposal.action === 'replace'">{{ proposal.replacement }}</code>
          <span v-else class="muted">leave it out</span>
          <span class="badge" :class="CONFIDENCE_CLASS[proposal.confidence]">{{ proposal.confidence }} confidence</span>
        </div>
        <p class="muted">{{ proposal.reason }}</p>
        <p v-if="!proposal.valid" class="problem">Not usable: {{ proposal.problem }}</p>
        <template v-else-if="proposal.action === 'replace' && repairable.has(proposal.line)">
          <label class="use">
            <input type="checkbox" :checked="accepted.get(proposal.line) === proposal.replacement" @change="toggle(proposal)" />
            Use this replacement
          </label>
          <p v-if="unusedReason(proposal)" class="problem">Not used: {{ unusedReason(proposal) }}</p>
        </template>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.ai-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}

.ai-head h2 {
  margin: 0;
}

.lead {
  margin-bottom: 0.75rem;
}

.key-form,
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
}

.forget {
  margin-left: auto;
}

.notice {
  margin-top: 0.75rem;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  margin: 0.9rem 0 0;
  padding: 0;
  list-style: none;
}

.row-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.55rem;
}

.row p {
  margin-top: 0.15rem;
  font-size: 0.9rem;
}

code {
  font-size: 0.86rem;
  overflow-wrap: anywhere;
}

.arrow {
  color: var(--muted);
}

.problem {
  color: var(--danger);
}

.use {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.3rem;
}
</style>
