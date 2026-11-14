<script setup lang="ts">
import AppSidebar from "./components/AppSidebar.vue";
import FlashingBanner from "./components/FlashingBanner.vue";
import StatusBar from "./components/StatusBar.vue";
import WipBanner from "./components/WipBanner.vue";
</script>

<template>
  <div class="shell">
    <div class="backdrop" aria-hidden="true" />
    <AppSidebar class="shell-sidebar" />
    <main class="shell-main">
      <FlashingBanner />
      <WipBanner />
      <RouterView />
    </main>
    <StatusBar class="shell-status" />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  height: 100%;
}

.shell-sidebar {
  grid-row: 1 / 2;
}

.shell-main {
  overflow: auto;
}

.shell-status {
  grid-column: 1 / -1;
}

@media (max-width: 800px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto;
  }
}
</style>
