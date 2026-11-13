<script setup lang="ts">
import { ExternalLink } from "lucide-vue-next";
import { ALPHA_HD_FIRMWARE } from "../data/hosted-firmware";

const REPO = "https://github.com/cchamp-msft/fc-migrate";
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>About</h1>
        <p>An independent, community tool for moving Betaflight quads between firmware versions.</p>
      </div>
    </header>

    <section class="grid">
      <div class="card">
        <h2>Not an official Betaflight project</h2>
        <p class="muted">Betaflight Migrator is not affiliated with or endorsed by the Betaflight project. Firmware and board definitions come from Betaflight's public build service, except for boards it does not build yet (see below).</p>
      </div>
      <div class="card">
        <h2>Open source</h2>
        <p class="muted">Licensed under GPL-3.0-or-later. It includes code derived from Betaflight Configurator, also GPL-3.0. The complete source of this site is public:</p>
        <ul class="links">
          <li><a :href="REPO" target="_blank" rel="noopener">github.com/cchamp-msft/fc-migrate <ExternalLink :size="13" /></a></li>
          <li><a :href="`${REPO}/blob/main/LICENSE`" target="_blank" rel="noopener">The license (GNU GPL v3) <ExternalLink :size="13" /></a></li>
        </ul>
      </div>
      <div class="card">
        <h2>Firmware this site serves</h2>
        <p class="muted">For boards Betaflight's cloud build does not carry yet, this site serves unofficial Betaflight builds. They are GPL-3.0, built in public from the Betaflight release plus published patches.</p>
        <ul class="links">
          <li><a href="https://github.com/cchamp-msft/fc-migrate-firmware" target="_blank" rel="noopener">github.com/cchamp-msft/fc-migrate-firmware <ExternalLink :size="13" /></a></li>
          <li>
            T-Motor Pacer G4 Alpha HD: <a :href="ALPHA_HD_FIRMWARE.releaseUrl" target="_blank" rel="noopener">{{ ALPHA_HD_FIRMWARE.release }}</a>, from
            <a :href="ALPHA_HD_FIRMWARE.sourceUrl" target="_blank" rel="noopener">its source</a> and
            <a :href="ALPHA_HD_FIRMWARE.betaflightSourceUrl" target="_blank" rel="noopener">Betaflight {{ ALPHA_HD_FIRMWARE.betaflight }}</a>
          </li>
        </ul>
      </div>
      <div class="card">
        <h2>Use at your own risk</h2>
        <p class="muted">This program comes with ABSOLUTELY NO WARRANTY, to the extent permitted by law. Flashing can leave a board unresponsive until it is recovered over DFU. Remove propellers before connecting a battery, and check your setup before flying.</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.links {
  margin: 0.5rem 0 0;
  padding-left: 1.1rem;
}

.links li + li {
  margin-top: 0.3rem;
}

.links a {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
</style>
