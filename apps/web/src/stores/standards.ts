import type { PilotStandard } from "@bf-migrate/core";
import { defineStore } from "pinia";
import { ref, watch } from "vue";

const STORAGE_KEY = "bfm.standards";

function load(): PilotStandard[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PilotStandard => typeof entry?.name === "string" && typeof entry?.value === "string");
  } catch {
    return [];
  }
}

/** Settings the pilot wants on every migration, such as `throttle_boost = 0`. */
export const useStandardsStore = defineStore("standards", () => {
  const standards = ref<PilotStandard[]>(load());

  watch(
    standards,
    (value) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        // Standards stay for this visit when storage is unavailable.
      }
    },
    { deep: true },
  );

  function add(name: string, value: string): void {
    const trimmed = name.trim().toLowerCase();
    standards.value = [...standards.value.filter((entry) => entry.name !== trimmed), { name: trimmed, value: value.trim() }];
  }

  function remove(name: string): void {
    standards.value = standards.value.filter((entry) => entry.name !== name);
  }

  return { standards, add, remove };
});
