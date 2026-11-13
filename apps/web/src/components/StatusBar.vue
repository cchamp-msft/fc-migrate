<script setup lang="ts">
import { computed } from "vue";
import { useConnectionStore } from "../stores/connection";

const connection = useConnectionStore();

const label = computed(() => {
  switch (connection.status) {
    case "connected":
      return connection.isDemo ? "Demo board" : "Connected";
    case "connecting":
      return "Connecting";
    case "rebooting":
      return "Restarting board";
    case "lost":
      return "Connection lost";
    default:
      return "Not connected";
  }
});

const summary = computed(() => {
  const identity = connection.identity;
  if (!identity) return "";
  return `${identity.board.boardName} · Betaflight ${identity.firmwareVersion} · MSP ${identity.api.major}.${identity.api.minor}`;
});
</script>

<template>
  <footer class="status">
    <span class="state" :data-status="connection.status"><i class="dot" /> {{ label }}</span>
    <span v-if="summary" class="summary mono">{{ summary }}</span>
    <span v-if="connection.error" class="error">{{ connection.error }}</span>
    <span class="spacer" />
    <span class="muted">v0.1.0</span>
  </footer>
</template>

<style scoped>
.status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  padding: 0.3rem 0.9rem;
  border-top: 1px solid var(--border);
  background: var(--surface);
  font-size: 0.82rem;
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 600;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}

.state[data-status="connected"] .dot {
  background: var(--ok);
}

.state[data-status="connecting"] .dot,
.state[data-status="rebooting"] .dot {
  background: var(--warn);
}

.state[data-status="lost"] .dot {
  background: var(--danger);
}

.summary {
  color: var(--muted);
}

.error {
  color: var(--danger);
}

.spacer {
  flex: 1;
}
</style>
