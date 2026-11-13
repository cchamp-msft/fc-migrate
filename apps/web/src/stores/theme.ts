import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

export const THEMES = [
  { id: "mono", name: "Mono", description: "Near monochrome. Colour only where it means something.", swatch: ["#18181b", "#8d8d96", "#ffbb00"] },
  { id: "purple", name: "Deep purple", description: "Rich violet with a dark sidebar.", swatch: ["#2e1065", "#7c3aed", "#c4b5fd"] },
  { id: "red", name: "Deep red", description: "Warm crimson, built for the workbench.", swatch: ["#5f0f13", "#dc2626", "#fca5a5"] },
  { id: "teal", name: "Blue teal", description: "Cool blues running into teal.", swatch: ["#0c3a4a", "#0e7490", "#2dd4bf"] },
  { id: "betaflight", name: "Betaflight", description: "The classic Configurator yellow.", swatch: ["#2b2b2b", "#ffbb00", "#ffdc7a"] },
  { id: "sunset", name: "Betaflight sunset", description: "Betaflight yellow washed into dusk.", swatch: ["#ffb100", "#e0357a", "#6a2fb5"] },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export type ThemeMode = "system" | "light" | "dark";

const THEME_KEY = "bfm.theme";
const MODE_KEY = "bfm.mode";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are a convenience; the app works without storage.
  }
}

function isTheme(value: string | null): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export const useThemeStore = defineStore("theme", () => {
  const storedTheme = read(THEME_KEY);
  const storedMode = read(MODE_KEY);
  const theme = ref<ThemeId>(isTheme(storedTheme) ? storedTheme : "mono");
  const mode = ref<ThemeMode>(storedMode === "light" || storedMode === "dark" ? storedMode : "system");

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const systemDark = ref(media.matches);
  media.addEventListener("change", (event) => {
    systemDark.value = event.matches;
  });

  const resolvedMode = computed<"light" | "dark">(() => (mode.value === "system" ? (systemDark.value ? "dark" : "light") : mode.value));

  watch(
    [theme, resolvedMode],
    () => {
      document.documentElement.dataset.theme = theme.value;
      document.documentElement.dataset.mode = resolvedMode.value;
    },
    { immediate: true },
  );

  watch(theme, (value) => write(THEME_KEY, value));
  watch(mode, (value) => write(MODE_KEY, value));

  return { theme, mode, resolvedMode };
});
