<script setup lang="ts">
import { TriangleAlert } from "lucide-vue-next";
import { computed, onBeforeUnmount, watch } from "vue";
import { useRouter } from "vue-router";
import { useAlphaStore } from "../stores/alpha";
import { useUpgradeStore } from "../stores/upgrade";

const alpha = useAlphaStore();
const upgrade = useUpgradeStore();
const router = useRouter();

/**
 * A real board is mid-write, or waiting in its bootloader for the write to start. Closing,
 * reloading or leaving the page now can leave it unable to start.
 */
const hardware = computed(
  () => upgrade.running || upgrade.step === "permission" || alpha.usbStep === "working" || alpha.usbStep === "permission" || (alpha.step === "working" && !alpha.simulated),
);
const simulated = computed(() => !hardware.value && alpha.step === "working" && alpha.simulated);

function holdTab(event: BeforeUnloadEvent): void {
  // The browser shows its own "Leave site?" dialog; the text cannot be set.
  event.preventDefault();
  event.returnValue = "";
}

watch(
  hardware,
  (writing) => {
    if (writing) window.addEventListener("beforeunload", holdTab);
    else window.removeEventListener("beforeunload", holdTab);
  },
  { immediate: true },
);

// Moving to another page in the app mid-write would hide the progress; it is refused until done.
const removeGuard = router.beforeEach(() => !hardware.value);

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", holdTab);
  removeGuard();
});
</script>

<template>
  <div v-if="hardware || simulated" class="flash-banner" role="alert">
    <TriangleAlert :size="30" class="icon" />
    <div>
      <strong>Do not close or change this browser tab</strong>
      <span v-if="hardware">Firmware is being written. Closing, reloading or leaving this tab now can leave the board unable to start. Keep every cable plugged in until this banner goes away.</span>
      <span v-else>Simulated: nothing is being written. A real write shows this banner until it is done.</span>
    </div>
  </div>
</template>

<style scoped>
.flash-banner {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 0.9rem;
  padding: 0.9rem 1.2rem;
  background: #b91c1c;
  color: #fff;
  border-bottom: 3px solid #7f1d1d;
  animation: pulse 1.6s ease-in-out infinite;
}

.flash-banner strong {
  display: block;
  font-size: 1.3rem;
  font-weight: 800;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.flash-banner span {
  display: block;
  margin-top: 0.15rem;
  font-weight: 560;
}

.icon {
  flex: none;
}

@keyframes pulse {
  50% {
    background: #dc2626;
  }
}

@media (prefers-reduced-motion: reduce) {
  .flash-banner {
    animation: none;
  }
}
</style>
