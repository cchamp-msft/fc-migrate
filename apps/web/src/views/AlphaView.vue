<script setup lang="ts">
import { ALPHA_BOARDS, ALPHA_TEXTS, type AlphaText } from "@bf-migrate/core";
import { ChevronDown, ChevronRight, CircleAlert, CircleCheck, Cpu, FlaskConical, LoaderCircle, PackageCheck, TriangleAlert, Upload } from "lucide-vue-next";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import AlphaImageFacts from "../components/AlphaImageFacts.vue";
import { ALPHA_PHOTOS } from "../data/alpha-photos";
import { ALPHA_HD_FIRMWARE } from "../data/hosted-firmware";
import { DEMO_SCENARIOS, createDemoSource, type DemoScenarioId } from "../demo/alpha-probe";
import { demoAlphaFirmware } from "../demo/alpha-firmware";
import { useAlphaStore, type AlphaStep } from "../stores/alpha";
import { chooseStlink, isWebUsbAvailable } from "../transport/web-usb-stlink";

const alpha = useAlphaStore();

// Only the HD board can be chosen today, so its photos are the ones shown.
const photos = ALPHA_PHOTOS.hd;

// Leaving the page must not keep the ST-Link claimed or a chip halted under reset.
onBeforeUnmount(() => alpha.release());

const STAGES: { label: string; steps: AlphaStep[] }[] = [
  { label: "Before you start", steps: ["intro", "variant"] },
  { label: "Wiring", steps: ["wiring"] },
  { label: "ST-Link", steps: ["probe", "connecting", "hold-reset"] },
  { label: "Chip", steps: ["confirm-chip", "stopped"] },
  { label: "Report", steps: ["report"] },
  { label: "Firmware", steps: ["firmware"] },
  { label: "Unlock", steps: ["unlock"] },
  { label: "Write", steps: ["write", "working"] },
  { label: "Done", steps: ["done"] },
];

const stageIndex = computed(() => STAGES.findIndex((stage) => stage.steps.includes(alpha.step)));
/** Steps that must finish before the pilot can go anywhere else. */
const BUSY: readonly AlphaStep[] = ["connecting", "working"];

const introChecked = ref(false);
// The ticks are the pilot's own checklist: kept when moving between steps, and never required.
const wiringChecks = ref<boolean[]>(ALPHA_TEXTS.wiring.checks.map(() => false));
const typed = ref("");
const scenario = ref<DemoScenarioId>(DEMO_SCENARIOS[0]!.id);
const resetHeld = ref(false);
const probeError = ref("");
const fileInput = ref<HTMLInputElement>();
// The USB rewrite has its own file: it always goes to real hardware, so it never shares the ST-Link flow's choice.
const usbFileInput = ref<HTMLInputElement>();

watch(
  () => alpha.step,
  (step) => {
    if (step === "unlock") typed.value = "";
    if (step !== "hold-reset" && step !== "connecting") resetHeld.value = false;
  },
  { immediate: true },
);

/**
 * Every stage opens at any time, done or not, except while the chip is being connected
 * or written. Inside a stage, a button whose action needs something not yet done stays
 * grey and says what is missing; the store checks the same things again.
 */
function canOpen(index: number): boolean {
  return index !== stageIndex.value && !BUSY.includes(alpha.step);
}

function openStage(index: number): void {
  const first = STAGES[index]?.steps[0];
  if (first && canOpen(index)) alpha.goTo(first);
}

function stageState(index: number): "current" | "open" | "closed" {
  if (index === stageIndex.value) return "current";
  return canOpen(index) ? "open" : "closed";
}

const wiringDone = computed(() => wiringChecks.value.every(Boolean));

/** Continue never waits for the ticks. A confirmation is recorded only when they were ticked. */
function leaveIntro(): void {
  if (introChecked.value) alpha.confirm("intro");
  alpha.goTo("variant");
}

function leaveWiring(): void {
  if (wiringDone.value) alpha.confirm("wiring");
  alpha.goTo("probe");
}
const percent = computed(() => (alpha.progress && alpha.progress.total ? Math.round((alpha.progress.done / alpha.progress.total) * 100) : undefined));
const usbBusy = computed(() => alpha.usbStep === "working" || alpha.usbStep === "permission");
const usbPercent = computed(() => (alpha.usbProgress?.total ? Math.round((alpha.usbProgress.done / alpha.usbProgress.total) * 100) : undefined));
const locked = computed(() => alpha.classification?.kind === "locked");
const atLevel0WithFirmware = computed(() => alpha.classification?.kind === "programmed" || alpha.classification?.kind === "unknown");

const NEED_PROBE = "Connect the ST-Link to the board (stage 3).";
const NEED_FIRMWARE = "Choose the firmware (stage 6).";

/** What the one-way step still needs. Its button stays grey until this is empty. */
const unlockNeeds = computed(() => {
  const needs: string[] = [];
  if (!alpha.session || !alpha.classification) needs.push(NEED_PROBE);
  else if (!locked.value) needs.push("This chip is not locked, so there is nothing to unlock. Go to Write.");
  if (!alpha.reportSaved) needs.push("Save the board report (stage 5).");
  if (!alpha.chosen?.check.ok) needs.push(NEED_FIRMWARE);
  return needs;
});

/** What writing still needs. */
const writeNeeds = computed(() => {
  const needs: string[] = [];
  const found = alpha.classification;
  if (!alpha.session || !found) needs.push(NEED_PROBE);
  else if (found.kind === "locked") needs.push("Unlock the chip first (stage 7).");
  else if (found.kind === "wrong-chip" || found.kind === "protected") needs.push(`This board cannot be written: ${found.title.toLowerCase()}.`);
  if (!alpha.chosen?.check.ok) needs.push(NEED_FIRMWARE);
  return needs;
});

/**
 * A migrated board on USB needs only the card at the top, so the ST-Link steps fold away.
 * They stay open while an ST-Link session is in use.
 */
const showMigration = ref(false);
const migrationFoldable = computed(() => alpha.migratedOverUsb && !alpha.session && !BUSY.includes(alpha.step));
const migrationHidden = computed(() => migrationFoldable.value && !showMigration.value);

function paragraphs(text: AlphaText): readonly string[] {
  return text.paragraphs;
}

async function selectStlink(): Promise<void> {
  probeError.value = "";
  try {
    alpha.useSource(await chooseStlink());
  } catch (reason) {
    probeError.value = reason instanceof DOMException && reason.name === "NotFoundError" ? "No ST-Link was chosen. If the list was empty, install ST's STSW-LINK009 driver and plug the ST-Link in again." : String(reason);
  }
}

function startDemo(): void {
  alpha.useSource(createDemoSource(scenario.value));
}

function pressReset(): void {
  alpha.source?.pressReset?.();
  resetHeld.value = true;
}

function releaseReset(): void {
  alpha.source?.releaseReset?.();
  resetHeld.value = false;
}

async function pickFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) await alpha.chooseImage(file.name, await file.text());
  if (fileInput.value) fileInput.value.value = "";
}

async function pickUsbFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) await alpha.chooseUsbImage(file.name, await file.text());
  if (usbFileInput.value) usbFileInput.value.value = "";
}

async function useDemoFirmware(): Promise<void> {
  const { name, text } = demoAlphaFirmware();
  await alpha.chooseImage(name, text);
}

function hex(value: number | undefined): string {
  return value === undefined ? "unknown" : `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`;
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>Alpha Migrate</h1>
        <p>Replace the closed Alpha firmware on a T-Motor Pacer G4 Alpha HD with Betaflight, through an ST-Link wired to the board.</p>
      </div>
    </header>

    <section v-if="alpha.migratedOverUsb" class="card">
      <h2>This board is already migrated</h2>
      <p class="muted lead">
        It runs Betaflight as TMOTORG4ALPHAHD. Betaflight's own firmware list does not carry this board yet, so new firmware is fc-migrate's build or a file, written over USB with no ST-Link. The settings area is left alone, so a build of the same Betaflight version keeps your settings. A different version may reset them on first start: to move settings to a new version, use
        <RouterLink to="/migrate">Migrate</RouterLink>, which sends them back and checks them.
      </p>
      <AlphaImageFacts v-if="alpha.usbChosen" :image="alpha.usbChosen" />
      <div class="actions">
        <button class="btn" :disabled="usbBusy || alpha.hostedLoading" @click="alpha.chooseHosted('usb')"><PackageCheck :size="15" /> Use fc-migrate's build ({{ ALPHA_HD_FIRMWARE.release }})</button>
        <button class="btn" :disabled="usbBusy || alpha.hostedLoading" @click="usbFileInput?.click()"><Upload :size="15" /> Choose a .hex file</button>
        <button v-if="alpha.usbStep === 'permission'" class="btn btn-primary" @click="alpha.grantDfuPermission()">Allow access to the bootloader</button>
        <button v-else class="btn btn-primary" :disabled="!alpha.usbChosen?.check.ok || usbBusy" @click="alpha.flashOverUsb()">Flash over USB</button>
      </div>
      <div v-if="usbBusy" class="notice notice-danger"><TriangleAlert :size="18" /><span>Writing firmware. Do not close or change this browser tab, and keep the USB cable plugged in until it says the new firmware is running.</span></div>
      <p v-if="alpha.usbMessage && alpha.usbStep !== 'failed'" class="muted">{{ alpha.usbMessage }}<template v-if="usbPercent !== undefined"> ({{ usbPercent }}%)</template></p>
      <div v-if="alpha.usbStep === 'done'" class="notice"><CircleCheck :size="18" /><span>The new firmware is running.</span></div>
      <div v-if="alpha.usbStep === 'failed'" class="notice notice-danger"><CircleAlert :size="18" /><span>{{ alpha.usbMessage }}</span></div>
    </section>

    <button v-if="migrationFoldable" class="btn fold" :aria-expanded="showMigration" @click="showMigration = !showMigration">
      <component :is="showMigration ? ChevronDown : ChevronRight" :size="16" />
      {{ showMigration ? "Hide the ST-Link migration steps" : "Migrating another Alpha still on its original firmware? Show the ST-Link steps" }}
    </button>

    <template v-if="!migrationHidden">
    <div v-if="alpha.simulated" class="notice notice-warn simulated">
      <FlaskConical :size="18" />
      <span><strong>SIMULATED.</strong> No hardware is involved. This walks through the real procedure against a simulated ST-Link and chip.</span>
    </div>

    <ol class="stages" aria-label="Progress">
      <li v-for="(stage, index) in STAGES" :key="stage.label">
        <button type="button" class="stage" :data-state="stageState(index)" :aria-current="index === stageIndex ? 'step' : undefined" :disabled="!canOpen(index)" @click="openStage(index)">{{ stage.label }}</button>
      </li>
    </ol>

    <!-- 1. Before you start -->
    <section v-if="alpha.step === 'intro'" class="card step">
      <h2>{{ ALPHA_TEXTS.intro.title }}</h2>
      <p v-for="text in paragraphs(ALPHA_TEXTS.intro)" :key="text">{{ text }}</p>
      <h3 class="gives-up">{{ ALPHA_TEXTS.givesUp.title }}</h3>
      <p>{{ ALPHA_TEXTS.givesUp.paragraphs[0] }}</p>
      <ul>
        <li v-for="text in ALPHA_TEXTS.givesUp.paragraphs.slice(1)" :key="text">{{ text }}</li>
      </ul>
      <label class="check"><input v-model="introChecked" type="checkbox" /> {{ ALPHA_TEXTS.intro.checks[0] }}</label>
      <div class="actions">
        <button class="btn btn-primary" @click="leaveIntro()">Continue</button>
      </div>
    </section>

    <section v-else-if="alpha.step === 'variant'" class="card step">
      <h2>Which board is it?</h2>
      <div class="boards">
        <button v-for="board in ALPHA_BOARDS" :key="board.id" class="board" :disabled="!board.supported" @click="alpha.goTo('wiring')">
          <Cpu :size="20" />
          <strong>{{ board.label }}</strong>
          <span class="muted">{{ board.note }}</span>
        </button>
      </div>
    </section>

    <!-- 2. Wiring -->
    <section v-else-if="alpha.step === 'wiring'" class="card step">
      <h2>{{ ALPHA_TEXTS.wiring.title }}</h2>
      <p v-for="text in paragraphs(ALPHA_TEXTS.wiring)" :key="text" class="muted">{{ text }}</p>
      <div v-if="photos" class="photos">
        <figure v-for="photo in photos.wiring" :key="photo.src" class="photo">
          <a :href="photo.src" target="_blank" rel="noopener"><img :src="photo.src" :alt="photo.alt" loading="lazy" /></a>
          <figcaption class="muted small">{{ photo.caption }}</figcaption>
        </figure>
      </div>
      <label v-for="(text, index) in ALPHA_TEXTS.wiring.checks" :key="text" class="check"><input v-model="wiringChecks[index]" type="checkbox" /> {{ text }}</label>
      <div class="actions">
        <button class="btn btn-primary" @click="leaveWiring()">Continue</button>
      </div>
    </section>

    <!-- 3. ST-Link -->
    <section v-else-if="alpha.step === 'probe'" class="card step">
      <h2>{{ ALPHA_TEXTS.probe.title }}</h2>
      <div class="notice notice-warn power">
        <CircleAlert :size="18" />
        <span><strong>{{ ALPHA_TEXTS.usbPower.title }}</strong> {{ ALPHA_TEXTS.usbPower.paragraphs[0] }}</span>
      </div>
      <p v-for="text in paragraphs(ALPHA_TEXTS.probe)" :key="text">{{ text }}</p>
      <div class="actions">
        <button class="btn btn-primary" :disabled="!isWebUsbAvailable()" @click="selectStlink()">Select ST-Link</button>
        <span v-if="!isWebUsbAvailable()" class="muted small">This browser has no WebUSB. Use Chrome or Edge.</span>
      </div>
      <div v-if="probeError" class="notice notice-warn"><CircleAlert :size="18" /><span>{{ probeError }}</span></div>
      <div class="demo">
        <h3><FlaskConical :size="16" /> No ST-Link? Try a simulated board</h3>
        <div class="actions">
          <select v-model="scenario" class="input" aria-label="Simulated board">
            <option v-for="option in DEMO_SCENARIOS" :key="option.id" :value="option.id">{{ option.label }}</option>
          </select>
          <button class="btn" @click="startDemo()">Use the simulated board</button>
        </div>
      </div>
    </section>

    <section v-else-if="alpha.step === 'connecting'" class="card step">
      <h2><LoaderCircle :size="18" class="spin" /> {{ alpha.message || "Connecting" }}</h2>
      <button v-if="alpha.simulated && resetHeld && alpha.awaitingRelease" class="btn btn-primary" @click="releaseReset()">Release the reset button (simulated)</button>
    </section>

    <section v-else-if="alpha.step === 'hold-reset'" class="card step">
      <h2>{{ ALPHA_TEXTS.holdReset.title }}</h2>
      <p v-for="text in paragraphs(ALPHA_TEXTS.holdReset)" :key="text">{{ text }}</p>
      <figure v-if="photos?.reset" class="photo photo-single">
        <img :src="photos.reset.src" :alt="photos.reset.alt" loading="lazy" />
        <figcaption class="muted small">{{ photos.reset.caption }}</figcaption>
      </figure>
      <div class="actions">
        <button v-if="alpha.simulated" class="btn" :disabled="resetHeld" @click="pressReset()">{{ resetHeld ? "Holding the reset button" : "Press and hold reset (simulated)" }}</button>
        <button class="btn btn-primary" :disabled="alpha.simulated && !resetHeld" @click="alpha.connect('holdReset')">Connect</button>
        <button class="btn" :disabled="resetHeld" @click="alpha.connect('hotplug')">Try again without reset</button>
      </div>
    </section>

    <!-- 4. Chip -->
    <section v-else-if="alpha.step === 'confirm-chip' && alpha.readings && alpha.classification" class="card step">
      <h2>{{ ALPHA_TEXTS.confirmChip.title }}</h2>
      <p v-for="text in paragraphs(ALPHA_TEXTS.confirmChip)" :key="text" class="muted">{{ text }}</p>
      <dl class="facts">
        <dt>ST-Link</dt>
        <dd>{{ alpha.probeInfo?.model }}, firmware {{ alpha.probeInfo?.firmware }}</dd>
        <dt>Chip</dt>
        <dd>ID 0x{{ alpha.readings.devId.toString(16) }}<template v-if="alpha.readings.devId === 0x469"> (STM32G47x)</template>, {{ alpha.readings.flashSizeKb ?? "unknown" }} KB flash</dd>
        <dt>Unique ID</dt>
        <dd class="mono">{{ alpha.readings.uid ?? "unknown" }}</dd>
        <dt>Read protection</dt>
        <dd>Level {{ alpha.classification.rdp }} <span class="muted mono">(OPTR {{ hex(alpha.readings.optr) }})</span></dd>
        <dt>BOOT0 pin</dt>
        <dd>{{ alpha.classification.bootPinHonoured ? "Honoured" : "Ignored" }}</dd>
      </dl>
      <div class="notice" :class="{ 'notice-danger': ['wrong-chip', 'protected'].includes(alpha.classification.kind) }">
        <CircleAlert :size="18" />
        <span><strong>{{ alpha.classification.title }}.</strong> {{ alpha.classification.detail }}</span>
      </div>
      <div class="actions">
        <button class="btn btn-primary" @click="alpha.chipConfirmed()">Yes, this is the board</button>
        <button class="btn" @click="alpha.reset()">Stop</button>
      </div>
    </section>

    <section v-else-if="alpha.step === 'confirm-chip'" class="card step">
      <h2>{{ ALPHA_TEXTS.confirmChip.title }}</h2>
      <p class="muted">No chip has been read yet. Connect the ST-Link in stage 3, and the chip's details appear here.</p>
      <div class="actions">
        <button class="btn btn-primary" disabled>Yes, this is the board</button>
        <button class="btn" @click="alpha.goTo('probe')">Go to stage 3</button>
      </div>
    </section>

    <section v-else-if="alpha.step === 'stopped' && alpha.classification" class="card step">
      <h2>{{ alpha.classification.title }}</h2>
      <p>{{ alpha.classification.detail }}</p>
      <div class="actions">
        <button class="btn" @click="alpha.saveReport()">Save the board report</button>
        <button class="btn" @click="alpha.reset()">Start over</button>
      </div>
    </section>

    <!-- 5. Report -->
    <section v-else-if="alpha.step === 'report'" class="card step">
      <h2>{{ ALPHA_TEXTS.report.title }}</h2>
      <p v-for="text in paragraphs(ALPHA_TEXTS.report)" :key="text">{{ text }}</p>
      <div class="actions">
        <button class="btn" :disabled="!alpha.readings" @click="alpha.saveReport()">Save the board report</button>
        <button class="btn btn-primary" @click="alpha.reportSaved && alpha.confirm('report'), alpha.goTo('firmware')">Continue</button>
      </div>
      <p v-if="!alpha.readings" class="muted small">Saving needs a chip that has been read: {{ NEED_PROBE }}</p>
      <div v-else-if="!alpha.reportSaved" class="notice notice-warn"><CircleAlert :size="18" /><span>Not saved yet. Unlocking stays closed until the report is saved.</span></div>
    </section>

    <!-- 6. Firmware -->
    <section v-else-if="alpha.step === 'firmware'" class="card step">
      <h2>{{ ALPHA_TEXTS.firmware.title }}</h2>
      <p v-for="text in paragraphs(ALPHA_TEXTS.firmware)" :key="text">{{ text }}</p>
      <div class="actions">
        <button class="btn" :disabled="alpha.hostedLoading" @click="alpha.chooseHosted('stlink')"><PackageCheck :size="15" /> Use fc-migrate's build ({{ ALPHA_HD_FIRMWARE.release }})</button>
        <button class="btn" @click="fileInput?.click()"><Upload :size="15" /> Choose a .hex file</button>
        <button v-if="alpha.simulated" class="btn" @click="useDemoFirmware()">Use the demo firmware</button>
      </div>
      <AlphaImageFacts v-if="alpha.chosen" :image="alpha.chosen" />
      <div v-if="alpha.error" class="notice notice-danger"><CircleAlert :size="18" /><span>{{ alpha.error }}</span></div>
      <label v-if="alpha.classification?.bootPinHonoured" class="check">
        <input v-model="alpha.clearBootPin" type="checkbox" />
        <span><strong>{{ ALPHA_TEXTS.bootPin.title }}</strong> {{ ALPHA_TEXTS.bootPin.paragraphs[0] }}</span>
      </label>
      <label v-if="atLevel0WithFirmware" class="check">
        <input v-model="alpha.keepSettings" type="checkbox" />
        <span><strong>Keep my settings.</strong> {{ ALPHA_TEXTS.rewrite.paragraphs[0] }}</span>
      </label>
      <div class="actions">
        <button class="btn btn-primary" :disabled="!alpha.chosen?.check.ok" @click="alpha.firmwareConfirmed()">Use this firmware</button>
      </div>
    </section>

    <!-- 7. Unlock: the one-way step -->
    <section v-else-if="alpha.step === 'unlock'" class="card step danger">
      <h2>{{ ALPHA_TEXTS.unlock.title }}</h2>
      <p class="strong">{{ ALPHA_TEXTS.unlock.paragraphs[0] }}</p>
      <ul>
        <li v-for="text in ALPHA_TEXTS.unlock.paragraphs.slice(1)" :key="text">{{ text }}</li>
      </ul>
      <label class="typed">
        Type <strong>{{ ALPHA_TEXTS.unlock.typed }}</strong> to continue
        <input v-model="typed" class="input mono" autocomplete="off" spellcheck="false" :aria-label="`Type ${ALPHA_TEXTS.unlock.typed}`" />
      </label>
      <div class="actions">
        <button class="btn btn-danger" :disabled="unlockNeeds.length > 0 || typed.trim() !== ALPHA_TEXTS.unlock.typed" @click="alpha.unlock(typed)">Erase and unlock</button>
        <button class="btn" @click="alpha.reset()">Stop here</button>
      </div>
      <div v-if="unlockNeeds.length" class="needs muted small">
        <strong>Still needed</strong>
        <ul>
          <li v-for="text in unlockNeeds" :key="text">{{ text }}</li>
        </ul>
      </div>
    </section>

    <!-- 8. Write -->
    <section v-else-if="alpha.step === 'write'" class="card step">
      <h2>{{ locked || alpha.classification?.kind === "blank" ? ALPHA_TEXTS.write.title : ALPHA_TEXTS.rewrite.title }}</h2>
      <p v-for="text in paragraphs(alpha.classification?.kind === 'blank' ? ALPHA_TEXTS.write : ALPHA_TEXTS.rewrite)" :key="text">{{ text }}</p>
      <p v-if="alpha.chosen" class="muted">{{ alpha.chosen.name }}, {{ kb(alpha.chosen.check.bytes) }}.</p>
      <div class="actions">
        <button class="btn btn-primary" :disabled="writeNeeds.length > 0" @click="alpha.write()">Write Betaflight</button>
      </div>
      <div v-if="writeNeeds.length" class="needs muted small">
        <strong>Still needed</strong>
        <ul>
          <li v-for="text in writeNeeds" :key="text">{{ text }}</li>
        </ul>
      </div>
    </section>

    <section v-else-if="alpha.step === 'working'" class="card step">
      <h2><LoaderCircle :size="18" class="spin" /> {{ alpha.message }}</h2>
      <progress v-if="percent !== undefined" :value="percent" max="100" class="bar">{{ percent }}%</progress>
      <div class="notice notice-danger"><TriangleAlert :size="18" /><span>Do not close or change this browser tab. Keep the USB cable and the ST-Link connected. This step cannot be cancelled.</span></div>
    </section>

    <!-- 9. Done -->
    <section v-else-if="alpha.step === 'done'" class="card step">
      <h2><CircleCheck :size="18" /> {{ ALPHA_TEXTS.done.title }}</h2>
      <p v-for="text in paragraphs(ALPHA_TEXTS.done)" :key="text">{{ text }}</p>
      <figure v-if="photos?.receiver" class="photo photo-single">
        <img :src="photos.receiver.src" :alt="photos.receiver.alt" loading="lazy" />
        <figcaption class="muted small">{{ photos.receiver.caption }}</figcaption>
      </figure>
      <div class="actions">
        <button class="btn" @click="alpha.reset()">Start over</button>
      </div>
    </section>

    <section v-else-if="alpha.step === 'failed'" class="card step">
      <h2><CircleAlert :size="18" /> Stopped</h2>
      <div class="notice notice-danger"><CircleAlert :size="18" /><span>{{ alpha.error }}</span></div>
      <p class="muted">Nothing runs until you choose. The ST-Link can always reach an unlocked board, so a write can be retried.</p>
      <div class="actions">
        <button class="btn btn-primary" @click="alpha.retry()">Try again</button>
        <button v-if="alpha.readings" class="btn" @click="alpha.saveReport()">Save the board report</button>
        <button class="btn" @click="alpha.reset()">Start over</button>
      </div>
    </section>
    </template>

    <input ref="fileInput" type="file" accept=".hex" hidden @change="pickFile" />
    <input ref="usbFileInput" type="file" accept=".hex" hidden @change="pickUsbFile" />
  </div>
</template>

<style scoped>
.lead {
  margin-bottom: 0.75rem;
}

.simulated {
  border-style: dashed;
}

.stages {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: stage;
  font-size: 0.82rem;
}

.stages li {
  counter-increment: stage;
}

.stage {
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: none;
  color: var(--muted);
  font: inherit;
  cursor: default;
}

.stage::before {
  content: counter(stage) ". ";
}

.stage[data-state="current"] {
  border-color: var(--accent);
  color: var(--text);
  font-weight: 600;
}

.stage[data-state="open"] {
  color: var(--text);
  cursor: pointer;
}

.stage[data-state="open"]:hover {
  border-color: var(--accent);
}

.gives-up {
  margin: 0.9rem 0 0.4rem;
  font-size: 1rem;
}

.power {
  margin: 0 0 0.75rem;
}

.step h2 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.step p,
.step ul {
  margin: 0 0 0.6rem;
}

.step.danger {
  border: 2px solid var(--danger);
}

.step.danger h2 {
  color: var(--danger);
}

.fold {
  align-self: flex-start;
}

.needs {
  margin-top: 0.6rem;
}

.needs ul {
  margin: 0.2rem 0 0;
  padding-left: 1.1rem;
}

.strong {
  font-weight: 600;
}

.check {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  margin: 0.45rem 0;
}

.check input {
  margin-top: 0.25rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  margin-top: 0.85rem;
}

.small {
  font-size: 0.86rem;
}

.notice {
  margin-top: 0.6rem;
}

.boards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.6rem;
}

.board {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.3rem;
  padding: 0.8rem 0.9rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.board:hover:not(:disabled) {
  border-color: var(--accent);
}

.board:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.photos {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.75rem;
  margin: 0.6rem 0 0.9rem;
}

.photo {
  margin: 0;
}

.photo-single {
  max-width: 26rem;
  margin: 0.6rem 0 0.9rem;
}

.photo img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
}

.photo figcaption {
  margin-top: 0.3rem;
}

.demo {
  margin-top: 1.1rem;
  padding-top: 0.9rem;
  border-top: 1px solid var(--border);
}

.demo h3 {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  font-size: 0.95rem;
}

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

.typed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
}

.typed .input {
  width: 9rem;
}

.bar {
  width: 100%;
  height: 0.6rem;
  margin: 0.4rem 0 0.6rem;
  accent-color: var(--accent);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
