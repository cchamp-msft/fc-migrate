<script setup lang="ts">
import type { MigrationPlan } from "@bf-migrate/core";
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useConnectionStore } from "../stores/connection";
import { useUpgradeStore, type FirmwareSource } from "../stores/upgrade";
import { isWebUsbAvailable } from "../transport/web-serial";

/** `source` is where the firmware comes from; without it the upgrade cannot start. */
const props = defineProps<{ plan: MigrationPlan; source?: FirmwareSource }>();

const connection = useConnectionStore();
const upgrade = useUpgradeStore();
const acknowledged = ref(false);

const canStart = computed(() => connection.isConnected && !connection.isDemo && isWebUsbAvailable() && acknowledged.value && !upgrade.running && !!props.source);

function begin(): void {
  if (props.source) void upgrade.start(props.plan, props.source);
}
const percent = computed(() => {
  const update = upgrade.progress;
  return update && update.total > 0 ? Math.round((update.done / update.total) * 100) : undefined;
});
const STAGE_LABELS = { erase: "Erasing", write: "Writing", verify: "Verifying", read: "Backing up firmware" } as const;
const clean = computed(() => upgrade.rejected.length === 0 && upgrade.mismatches.length === 0);
</script>

<template>
  <section class="card upgrade">
    <h2>Upgrade this board</h2>

    <template v-if="upgrade.step === 'idle'">
      <p class="muted">Backs up your configuration and firmware, flashes {{ props.plan.targetVersion }}, and sends the changes above. Nothing is saved until you have seen the result.</p>
      <div v-if="connection.isDemo" class="notice"><CircleAlert :size="18" /><span>The demo board cannot be flashed. Connect a real flight controller to upgrade.</span></div>
      <template v-else>
        <label class="ack"><input v-model="acknowledged" type="checkbox" /> Propellers are off, and I have read the items above.</label>
        <button class="btn btn-primary" :disabled="!canStart" @click="begin()">Back up and upgrade</button>
        <p v-if="!props.source" class="muted small">Choose the firmware above first.</p>
      </template>
    </template>

    <template v-else-if="upgrade.step === 'permission'">
      <p>{{ upgrade.message }}</p>
      <button class="btn btn-primary" @click="upgrade.grantDfuPermission()">Choose the STM32 bootloader</button>
      <div class="notice notice-danger"><CircleAlert :size="18" /><span>The board is waiting in its bootloader. Do not close or change this browser tab.</span></div>
      <p class="muted">If nothing is listed, re-plug the board while holding BOOT, then click again.</p>
    </template>

    <template v-else-if="upgrade.step === 'review'">
      <div v-if="clean" class="notice"><CircleCheck :size="18" class="ok" /><span>Every setting was accepted and reads back as planned. Nothing has been saved yet.</span></div>
      <div v-else class="notice notice-warn">
        <CircleAlert :size="18" />
        <span>{{ upgrade.rejected.length }} rejected, {{ upgrade.mismatches.length }} read back differently. Nothing has been saved. Discarding restores factory settings on the new firmware; your backup is in your downloads.</span>
      </div>
      <ul v-if="upgrade.rejected.length" class="problems">
        <li v-for="entry in upgrade.rejected" :key="entry.line"><code>{{ entry.line }}</code> <span class="muted">{{ entry.message }}</span></li>
      </ul>
      <ul v-if="upgrade.mismatches.length" class="problems">
        <li v-for="entry in upgrade.mismatches" :key="`${entry.scope}${entry.name}`"><code>{{ entry.name }}</code> <span class="muted">expected {{ entry.expected }}, board has {{ entry.actual ?? "nothing" }}</span></li>
      </ul>
      <div class="actions">
        <button class="btn btn-primary" @click="upgrade.confirmSave()">Save to the board</button>
        <button class="btn" @click="upgrade.discardApplied()">Discard</button>
      </div>
    </template>

    <template v-else-if="upgrade.step === 'done'">
      <div v-if="upgrade.mismatches.length === 0" class="notice"><CircleCheck :size="18" class="ok" /><span>Saved. The board restarted on {{ props.plan.targetVersion }} and every setting matches. Check motor order and direction with propellers off before flying.</span></div>
      <div v-else class="notice notice-warn"><CircleAlert :size="18" /><span>Saved, but {{ upgrade.mismatches.length }} settings read back differently after the restart. Check them before flying.</span></div>
      <button class="btn" @click="upgrade.reset()">Finish</button>
    </template>

    <template v-else-if="upgrade.step === 'failed'">
      <div class="notice notice-danger"><CircleAlert :size="18" /><span>{{ upgrade.error }}</span></div>
      <p class="muted">Your configuration backup is in your downloads. If the board no longer connects, re-plug it while holding BOOT and start again: the bootloader is always available.</p>
      <button class="btn" @click="upgrade.reset()">Start over</button>
    </template>

    <template v-else>
      <p class="working"><LoaderCircle :size="16" class="spin" /> {{ upgrade.message }}</p>
      <div v-if="upgrade.progress" class="meter" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100">
        <div class="meter-fill" :style="{ width: `${percent ?? 0}%` }" />
      </div>
      <p v-if="upgrade.progress" class="muted">{{ STAGE_LABELS[upgrade.progress.stage] }} {{ percent }}%</p>
      <div class="notice notice-danger"><CircleAlert :size="18" /><span>Do not close or change this browser tab, and keep the board plugged in until the upgrade finishes.</span></div>
    </template>

    <p v-if="upgrade.unavailableOptions.length" class="muted">Not offered on {{ props.plan.targetVersion }}, so not included: {{ upgrade.unavailableOptions.join(", ") }}</p>
  </section>
</template>

<style scoped>
.upgrade {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.6rem;
}

.upgrade h2 {
  margin-bottom: 0;
}

.notice {
  align-self: stretch;
}

.ok {
  color: var(--ok);
}

.ack {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
}

.problems {
  margin: 0;
  padding-left: 1.1rem;
  align-self: stretch;
}

.working {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.meter {
  align-self: stretch;
  height: 8px;
  border-radius: 999px;
  background: var(--surface-2);
  overflow: hidden;
}

.meter-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.15s linear;
}
</style>
