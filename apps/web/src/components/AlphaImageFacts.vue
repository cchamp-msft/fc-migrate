<script setup lang="ts">
import { CircleAlert } from "lucide-vue-next";
import type { ChosenImage } from "../stores/alpha";

defineProps<{ image: ChosenImage }>();

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`;
}
</script>

<template>
  <dl class="facts">
    <dt>File</dt>
    <dd>{{ image.name }}</dd>
    <dt>Size</dt>
    <dd>{{ kb(image.check.bytes) }}</dd>
    <dt>Board</dt>
    <dd>{{ image.check.boardName ?? "not named" }}</dd>
    <dt>SHA-256</dt>
    <dd class="mono hash">{{ image.sha256 }}<template v-if="image.hosted"> (matches the release)</template></dd>
    <template v-if="image.hosted">
      <dt>Release</dt>
      <dd>
        fc-migrate-firmware <a :href="image.hosted.releaseUrl" target="_blank" rel="noopener">{{ image.hosted.release }}</a>: Betaflight {{ image.hosted.betaflight }}, revision {{ image.hosted.revision }}.
        <a :href="image.hosted.sourceUrl" target="_blank" rel="noopener">Source</a> (GPL-3.0)
      </dd>
    </template>
  </dl>
  <div v-for="text in image.check.errors" :key="text" class="notice notice-danger"><CircleAlert :size="18" /><span>{{ text }}</span></div>
  <div v-for="text in image.check.warnings" :key="text" class="notice notice-warn"><CircleAlert :size="18" /><span>{{ text }}</span></div>
</template>

<style scoped>
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.3rem 1rem;
  margin: 0.6rem 0;
}

.facts dt {
  color: var(--muted);
}

.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.hash {
  font-size: 0.8rem;
}
</style>
