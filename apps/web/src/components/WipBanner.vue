<script setup lang="ts">
import { Construction, X } from "lucide-vue-next";
import { ref } from "vue";

// Change the version when the message changes, so visitors who dismissed the old one see it again.
const DISMISSED_KEY = "bfm.wip-dismissed.v1";

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

const visible = ref(!wasDismissed());

function dismiss(): void {
  visible.value = false;
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Without storage the notice comes back on the next visit.
  }
}
</script>

<template>
  <aside v-if="visible" class="wip notice notice-warn" aria-label="Site status">
    <Construction :size="18" />
    <p><strong>Work in progress.</strong> This site is still being built. Proceed at your own risk.</p>
    <button type="button" class="dismiss" aria-label="Dismiss this notice" title="Dismiss" @click="dismiss">
      <X :size="16" />
    </button>
  </aside>
</template>

<style scoped>
.wip {
  align-items: center;
  border-width: 0 0 1px;
  padding: 0.55rem 1rem 0.55rem 1.25rem;
}

.wip p {
  flex: 1;
  margin: 0;
}

.wip > svg {
  margin-top: 0;
}

.dismiss {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 1.9rem;
  height: 1.9rem;
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.dismiss svg {
  margin: 0;
}

.dismiss:hover {
  background: var(--warn-soft);
}

.dismiss:focus-visible {
  outline: 2px solid var(--warn);
  outline-offset: 1px;
}
</style>
