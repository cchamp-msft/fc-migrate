<script setup lang="ts">
import { Cpu, Info, LayoutDashboard, LoaderCircle, Palette, Plug, Rocket, SlidersHorizontal, SquareTerminal, Unplug, Wand } from "lucide-vue-next";
import { computed } from "vue";
import { useConnectionStore } from "../stores/connection";
import BrandMark from "./BrandMark.vue";

const connection = useConnectionStore();

const nav = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/configuration", label: "Configuration", icon: SlidersHorizontal },
  { to: "/cli", label: "CLI", icon: SquareTerminal },
  { to: "/migrate", label: "Migrate", icon: Wand },
  { to: "/bootstrap", label: "Bootstrap", icon: Rocket },
  { to: "/alpha", label: "Alpha Migrate", icon: Cpu },
];

const secondary = [
  { to: "/appearance", label: "Appearance", icon: Palette },
  { to: "/about", label: "About", icon: Info },
];

const busyLabel = computed(() => (connection.status === "rebooting" ? "Restarting…" : "Connecting…"));
</script>

<template>
  <aside class="sidebar">
    <RouterLink to="/" class="brand">
      <BrandMark />
      <span class="brand-text">
        <strong>Betaflight Migrator</strong>
        <small>Unofficial</small>
      </span>
    </RouterLink>

    <div class="connect">
      <button v-if="connection.isBusy" class="btn connect-btn" disabled>
        <LoaderCircle :size="16" class="spin" /> {{ busyLabel }}
      </button>
      <button v-else-if="connection.isConnected" class="btn connect-btn" @click="connection.disconnect()">
        <Unplug :size="16" /> Disconnect
      </button>
      <template v-else>
        <button class="btn connect-btn connect-primary" @click="connection.connectSerial()"><Plug :size="16" /> Connect</button>
        <button class="linkish" @click="connection.connectDemo()">Try the demo board</button>
      </template>
    </div>

    <nav class="nav" aria-label="Main">
      <RouterLink v-for="item in nav" :key="item.to" :to="item.to" class="nav-item">
        <component :is="item.icon" :size="17" /> {{ item.label }}
      </RouterLink>
    </nav>

    <nav class="nav nav-secondary" aria-label="Application">
      <RouterLink v-for="item in secondary" :key="item.to" :to="item.to" class="nav-item">
        <component :is="item.icon" :size="17" /> {{ item.label }}
      </RouterLink>
    </nav>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem 0.75rem;
  background: var(--sidebar);
  color: var(--on-sidebar);
  border-right: 1px solid var(--sidebar-border);
  min-height: 0;
  overflow-y: auto;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.1rem 0.4rem;
  color: inherit;
  text-decoration: none;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.brand-text strong {
  font-size: 0.98rem;
  font-weight: 680;
  letter-spacing: -0.01em;
}

.brand-text small {
  color: var(--sidebar-muted);
  font-size: 0.74rem;
}

.connect {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.connect-btn {
  width: 100%;
  background: rgb(127 127 127 / 0.14);
  border-color: var(--sidebar-border);
  color: var(--on-sidebar);
}

.connect-btn:hover:not(:disabled) {
  background: rgb(127 127 127 / 0.24);
}

.connect-primary,
.connect-primary:hover:not(:disabled) {
  background: #16a34a;
  border-color: transparent;
  color: #fff;
}

.connect-primary:hover:not(:disabled) {
  filter: brightness(1.08);
}

.linkish {
  background: none;
  border: 0;
  padding: 0.15rem;
  color: var(--sidebar-muted);
  font: inherit;
  font-size: 0.82rem;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.linkish:hover {
  color: var(--on-sidebar);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-secondary {
  margin-top: auto;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.6rem;
  border-radius: var(--radius-m);
  color: var(--on-sidebar);
  text-decoration: none;
  font-weight: 540;
}

.nav-item:hover {
  background: var(--sidebar-active);
}

.nav-item.router-link-exact-active {
  background: var(--sidebar-active);
  font-weight: 650;
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 800px) {
  .sidebar {
    flex-flow: row wrap;
    align-items: center;
    border-right: 0;
    border-bottom: 1px solid var(--sidebar-border);
    padding: 0.6rem 0.75rem;
    gap: 0.5rem;
    overflow: visible;
  }

  .connect {
    margin-left: auto;
    flex-direction: row;
    align-items: center;
  }

  .connect-btn {
    width: auto;
  }

  .nav,
  .nav-secondary {
    flex-direction: row;
    flex-wrap: wrap;
    margin: 0;
  }

  .nav-item {
    padding: 0.3rem 0.5rem;
  }
}
</style>
