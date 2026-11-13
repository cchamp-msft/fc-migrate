<script setup lang="ts">
import { THEMES, useThemeStore, type ThemeMode } from "../stores/theme";

const theme = useThemeStore();

const MODES: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "Match system" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>Appearance</h1>
        <p>Every theme comes in light and dark. Your choice is remembered on this browser.</p>
      </div>
      <div class="segmented" role="group" aria-label="Colour mode">
        <button v-for="mode in MODES" :key="mode.id" :aria-pressed="theme.mode === mode.id" @click="theme.mode = mode.id">{{ mode.label }}</button>
      </div>
    </header>

    <section class="themes">
      <button v-for="option in THEMES" :key="option.id" class="theme" :aria-pressed="theme.theme === option.id" @click="theme.theme = option.id">
        <span class="swatch" :style="{ background: `linear-gradient(120deg, ${option.swatch.join(', ')})` }" />
        <strong>{{ option.name }}</strong>
        <span class="muted">{{ option.description }}</span>
      </button>
    </section>
  </div>
</template>

<style scoped>
.themes {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
}

.theme {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.9rem;
  border-radius: var(--radius-l);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.theme[aria-pressed="true"] {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.swatch {
  display: block;
  height: 4.2rem;
  border-radius: var(--radius-m);
  margin-bottom: 0.4rem;
}
</style>
