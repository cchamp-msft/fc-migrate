<script setup lang="ts">
import { commandEntries, setEntries, type BuildOptionGroup } from "@bf-migrate/core";
import { CircleAlert, Cpu, FileCog, Package } from "lucide-vue-next";
import { computed } from "vue";
import { useConnectionStore } from "../stores/connection";
import { isWebSerialAvailable, isWebUsbAvailable } from "../transport/web-serial";

const connection = useConnectionStore();

const supported = isWebSerialAvailable() && window.isSecureContext;
const canFlash = isWebUsbAvailable();

const GROUP_LABELS: Record<BuildOptionGroup, string> = {
  radio: "Radio protocols",
  telemetry: "Telemetry",
  motor: "Motor protocols",
  general: "Features",
};

const optionGroups = computed(() => {
  const identity = connection.identity;
  if (!identity) return [];
  return (Object.keys(GROUP_LABELS) as BuildOptionGroup[])
    .map((group) => ({
      group,
      label: GROUP_LABELS[group],
      options: identity.buildOptions.filter((entry) => entry.option?.group === group).map((entry) => entry.option!.label),
    }))
    .filter((entry) => entry.options.length > 0);
});

const unknownOptions = computed(() => connection.identity?.buildOptions.filter((entry) => !entry.option).map((entry) => entry.id) ?? []);

const buildOrigin = computed(() => {
  const identity = connection.identity;
  if (!identity) return "";
  return identity.buildKey ? "Cloud build" : "Local or custom build (no build key)";
});

const configSummary = computed(() => {
  const diff = connection.diff;
  if (!diff) return undefined;
  return {
    settings: setEntries(diff).length,
    serial: commandEntries(diff, "serial").length,
    modes: commandEntries(diff, "aux").length,
    features: commandEntries(diff, "feature").length,
    vtxTable: commandEntries(diff, "vtxtable").length > 0,
  };
});
</script>

<template>
  <div class="page">
    <template v-if="!connection.identity">
      <header class="hero">
        <h1>Upgrade your firmware. Keep your quad.</h1>
        <p>
          Betaflight Migrator reads your flight controller, shows exactly what it runs, and carries your wiring, modes, VTX table, OSD and tune across firmware
          versions. Every change is reviewed before it reaches the board.
        </p>
        <div class="hero-actions">
          <button class="btn btn-primary" :disabled="connection.isBusy || !supported" @click="connection.connectSerial()">Connect flight controller</button>
          <button class="btn" :disabled="connection.isBusy" @click="connection.connectDemo()">Try the demo board</button>
        </div>
      </header>

      <div v-if="!supported" class="notice notice-warn">
        <CircleAlert :size="18" />
        <span>This browser cannot reach USB serial devices. Use a current version of Chrome or Edge, served over HTTPS or localhost. The demo board still works.</span>
      </div>
      <div v-else-if="!canFlash" class="notice notice-warn">
        <CircleAlert :size="18" />
        <span>This browser has no WebUSB, so firmware flashing will not be available.</span>
      </div>

      <section class="grid">
        <div class="card">
          <h2>See what you have</h2>
          <p class="muted">Firmware, board, build options and full configuration, including boards built locally with no cloud build key.</p>
        </div>
        <div class="card">
          <h2>Check before you flash</h2>
          <p class="muted">Settings that were renamed, removed or changed meaning are mapped against the target firmware first.</p>
        </div>
        <div class="card">
          <h2>A CLI that helps</h2>
          <p class="muted">Fuzzy search over every setting, allowed values and ranges as you type, and mistakes flagged before they are sent.</p>
        </div>
      </section>
    </template>

    <template v-else>
      <header class="page-header">
        <div>
          <h1>{{ connection.identity.craftName || connection.identity.board.boardName }}</h1>
          <p>{{ connection.identity.board.manufacturerId }} {{ connection.identity.board.boardName }} running Betaflight {{ connection.identity.firmwareVersion }}</p>
        </div>
        <span v-if="connection.isDemo" class="badge badge-warn">Demo board: replaying a real capture</span>
      </header>

      <section class="grid">
        <div class="card">
          <h2><Package :size="16" class="icon" /> Firmware</h2>
          <dl class="facts">
            <dt>Version</dt>
            <dd>{{ connection.identity.variant }} {{ connection.identity.firmwareVersion }}</dd>
            <dt>MSP API</dt>
            <dd>{{ connection.identity.api.major }}.{{ connection.identity.api.minor }}</dd>
            <dt>Built</dt>
            <dd>{{ connection.identity.build.date }} {{ connection.identity.build.time }}</dd>
            <dt>Revision</dt>
            <dd class="mono">{{ connection.identity.build.gitRevision }}</dd>
            <dt>Origin</dt>
            <dd>{{ buildOrigin }}</dd>
          </dl>
        </div>

        <div class="card">
          <h2><Cpu :size="16" class="icon" /> Board</h2>
          <dl class="facts">
            <dt>Target</dt>
            <dd>{{ connection.identity.board.boardName }}</dd>
            <dt>Maker</dt>
            <dd>{{ connection.identity.board.manufacturerId }}</dd>
            <dt>MCU</dt>
            <dd>{{ connection.identity.board.targetName }}</dd>
            <dt>Unique ID</dt>
            <dd class="mono">{{ connection.identity.uid }}</dd>
          </dl>
        </div>

        <div v-if="configSummary" class="card">
          <h2><FileCog :size="16" class="icon" /> Configuration</h2>
          <dl class="facts">
            <dt>Changed settings</dt>
            <dd>{{ configSummary.settings }}</dd>
            <dt>Serial ports set</dt>
            <dd>{{ configSummary.serial }}</dd>
            <dt>Mode ranges</dt>
            <dd>{{ configSummary.modes }}</dd>
            <dt>Features on</dt>
            <dd>{{ configSummary.features }}</dd>
            <dt>VTX table</dt>
            <dd>{{ configSummary.vtxTable ? "Present" : "None" }}</dd>
          </dl>
        </div>
      </section>

      <section class="card">
        <h2>Build options</h2>
        <p v-if="!connection.identity.buildOptionsKnown" class="muted">This firmware is too old to report its build options (needs MSP API 1.46 or later).</p>
        <div v-for="group in optionGroups" :key="group.group" class="option-group">
          <h3 class="muted">{{ group.label }}</h3>
          <div class="chips">
            <span v-for="option in group.options" :key="option" class="chip">{{ option }}</span>
          </div>
        </div>
        <p v-if="unknownOptions.length" class="muted unknown">Unrecognised option IDs: {{ unknownOptions.join(", ") }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding: 1.5rem 0 0.75rem;
}

.hero h1 {
  font-size: 2.1rem;
  max-width: 34rem;
}

.hero p {
  color: var(--muted);
  max-width: 42rem;
  font-size: 1.04rem;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.4rem;
}

.icon {
  vertical-align: -2px;
  margin-right: 0.15rem;
}

.option-group + .option-group {
  margin-top: 0.75rem;
}

.option-group h3 {
  font-size: 0.82rem;
  font-weight: 560;
  margin: 0 0 0.3rem;
}

.unknown {
  margin-top: 0.75rem;
}
</style>
