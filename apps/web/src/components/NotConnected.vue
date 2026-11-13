<script setup lang="ts">
import { Plug } from "lucide-vue-next";
import { useConnectionStore } from "../stores/connection";

defineProps<{ what: string }>();
const connection = useConnectionStore();
</script>

<template>
  <div class="card empty">
    <Plug :size="22" class="muted" />
    <p>Connect a flight controller to see {{ what }}.</p>
    <div class="actions">
      <button class="btn btn-primary" :disabled="connection.isBusy" @click="connection.connectSerial()">Connect</button>
      <button class="btn" :disabled="connection.isBusy" @click="connection.connectDemo()">Try the demo board</button>
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.7rem;
  padding: 2.5rem 1rem;
  text-align: center;
}

.actions {
  display: flex;
  gap: 0.5rem;
}
</style>
