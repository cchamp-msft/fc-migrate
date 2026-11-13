<template>
  <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
    <g class="frame" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M9 9 23 23M23 9 9 23" />
    </g>
    <g class="rotors" stroke="currentColor" stroke-width="2">
      <circle cx="8" cy="8" r="3.4" />
      <circle cx="24" cy="8" r="3.4" />
      <circle cx="8" cy="24" r="3.4" />
      <circle cx="24" cy="24" r="3.4" />
    </g>
    <circle class="hub" cx="16" cy="16" r="6.6" />
    <path class="arrow" d="M16 20.4v-8.2m-3.4 3.3 3.4-3.4 3.4 3.4" />
  </svg>
</template>

<style scoped>
.mark {
  width: 34px;
  height: 34px;
  flex: none;
  color: var(--on-sidebar);
}

.rotors {
  fill: none;
}

.hub {
  fill: var(--brand);
}

.arrow {
  fill: none;
  stroke: var(--accent-on-brand, var(--sidebar-mark, #17171a));
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

:root[data-theme="betaflight"][data-mode="light"] .arrow {
  stroke: #ffbb00;
}

:root[data-theme="sunset"] .arrow {
  stroke: #d43d72;
}

:root[data-theme="purple"][data-mode="light"] .arrow,
:root[data-theme="red"][data-mode="light"] .arrow,
:root[data-theme="teal"][data-mode="light"] .arrow {
  stroke: #ffffff;
}
</style>
