# Betaflight Migrator: Specification

What the app does, and the guarantees it keeps. It is kept current with the app.

- Progress and open work: [PLAN.md](PLAN.md).
- Hosting and the model API: [DEPLOY.md](DEPLOY.md).
- Firmware facts behind the migration rules, checked against the Betaflight source: [research/migration-facts.md](research/migration-facts.md).
- The Alpha Migrate design: [research/alpha-migrate-design.md](research/alpha-migrate-design.md).

## 1. What it is

A browser app that connects to a Betaflight flight controller, shows what it runs, upgrades its firmware, and carries its configuration to the new version. Every change is reviewed before it is saved to the board. It also moves T-Motor Pacer G4 Alpha boards from FETtec's Alpha firmware to Betaflight (section 10).

Betaflight itself offers no real migration. The firmware resets settings when the config version changes, and the Configurator replays `diff all` and skips lines that fail. This app fills that gap.

It is served at https://fc-migrate.com from [github.com/cchamp-msft/fc-migrate](https://github.com/cchamp-msft/fc-migrate).

**Growth.** Built for a small group first and the public later. Decisions must not block that path, but nothing is built for scale before it is needed.

**Unofficial.** Not affiliated with or endorsed by the Betaflight project. The app says so in the sidebar and on the About page, and uses its own logo. It may offer a Betaflight-colored theme.

**License.** GPL-3.0-or-later, because it includes code derived from Betaflight Configurator. The About page links:
- the site's source;
- its license;
- the source of every firmware the site serves.

The GPL asks this of anyone who conveys the program.

## 2. Scope

| Item | Decision |
|---|---|
| Source firmware | Betaflight 4.5.x (4.5.3 is the floor if a 4.5 build proves awkward). A board can also be rebuilt on the release it already runs. |
| Target firmware | 2025.12.x and 2026.6.x. 2026.12 alpha behind an "unstable" toggle. |
| Older sources (4.3, 4.4) | Later, as added rule packs (section 7.4). |
| Other firmware | FETtec Alpha on the T-Motor Pacer G4 Alpha HD. The Analog board once it is mapped. |
| Browsers | Chrome and Edge (WebSerial and WebUSB). HTTPS or localhost only. |
| MCUs | STM32 F4, F7 and H7 over DFU first, since those are what the DFU port covers. STM32G474 for Alpha boards, over SWD and DFU. |

Not planned: flight tuning advice, blackbox analysis, re-creating the Configurator's setup tabs, or receiver or motor test screens.

## 3. Safety invariants

These hold everywhere in the app. Tests and pull requests cite them by number. A change that weakens one says so, and updates this list.

- **S1. Nothing is saved before review.** A migration applies its lines without saving, then compares the board's `diff all` with the plan. It saves only after the pilot has seen that comparison. If anything fails before `save`, the board has stored nothing (section 7.1).
- **S2. Back up first.** The configuration is backed up before any change. Before a first flash, the existing firmware is read out over DFU when the board allows it, because a build may not be available again.
- **S3. Verify after writing.**
- **S4. The DFU flasher never writes option bytes.** A failed DFU flash leaves the board in its ROM bootloader. That bootloader cannot be erased, so the flash can always be retried. Only Alpha Migrate writes option bytes, and it makes only two changes:
  - read protection to Level 0;
  - when the pilot accepts it, `nSWBOOT0` to 0.
- **S5. Level 2 is unreachable.** No code path can set read protection to Level 2, which locks a chip for good.
- **S6. The one-way step is gated.** Removing read protection erases the whole chip, FETtec's bootloader included. It needs all four of:
  - a connected, locked chip;
  - a saved board report;
  - a checked firmware image;
  - the typed word ERASE.

  The store checks these again, not only the buttons.
- **S7. Firmware is checked before it is written.**
  - Firmware the site serves is pinned by SHA-256. A download that does not match is refused before anything is written.
  - Every image written to an Alpha board passes the image check in section 10.
- **S8. The demo image never reaches real hardware.**
  - The demo's stand-in image carries a marker.
  - The image check refuses it for anything but the simulated board.
  - Both flashers refuse it again before erasing. The DFU flasher always does; the SWD session does unless it was opened on the simulated chip.
  - Choosing a probe clears the chosen image, so a simulated choice never carries over to a real chip.
- **S9. A model never writes to a board.**
  - Suggestions are checked against the target schema in the browser, then again by the planner.
  - They appear only as choices the pilot ticks.
  - A reply is accepted only as a single printable `set` line, so no reply can add another CLI command such as `save` or `bl`.
- **S10. The model API is closed by default.** It refuses calls without the passphrase. It stays shut when its usage limits are missing. It forwards only well-formed `set` lines and setting descriptions, never free text ([DEPLOY.md](DEPLOY.md)).
- **S11. A write holds the tab.** While any flow writes firmware, or a board waits in its bootloader:
  - a red banner says not to close or change the tab;
  - the browser asks before the tab is closed or reloaded;
  - moving to another page in the app is refused.
- **S12. The CLI keeps the session alive.** It blocks commands that would strand it, such as `dfu` and `bl`.

## 4. Architecture

```
Browser (static PWA)
  apps/web          Vue 3, Vite, TypeScript, Pinia
  packages/core     No DOM or framework. MSP, CLI, DFU, SWD, parsing, schemas, migration.
     |                       |                      |
  WebSerial, WebUSB     Static JSON data       Optional services
  (the board)           (schemas, rule packs)  (model API; dry-run engine, planned)
```

Rules that keep the deployment options open:

1. **Everything essential runs in the browser.** Connect, inspect, CLI, flash, Alpha Migrate and rule-based migration need no server, so hosting cost stays near zero at any audience size.
2. **`packages/core` stays platform free.** It talks to hardware through `ByteTransport` and `UsbDeviceLike`. The browser, the Node hardware harness and the simulator each plug in their own.
3. **Services are optional and sit behind interfaces.** The app must work with both absent. Each is a stateless HTTP API, so it can move hosts without app changes.
4. **No secrets in the browser.** API keys live only in the service layer.

One Cloudflare Worker serves the static site and the model API, from the same origin ([DEPLOY.md](DEPLOY.md)).

**Dry-run engine (planned).** A service that would apply config lines to an emulated firmware (SITL) and report which ones it accepts. It sits behind this interface:

```ts
interface DryRunEngine {
  run(request: { firmwareVersion: string; buildOptions: string[]; lines: string[] }): Promise<{
    results: { line: string; ok: boolean; message?: string }[];
    resultingDiff: string;
  }>;
}
```

Each run starts from a clean config and keeps no state, so instances are disposable.

Stock SITL compiles out OSD, VTX, DShot and resource management. It could check only 18 of the test board's 42 changed settings, so an engine needs one of two things:
- a build with those re-enabled;
- a merge with the data in section 6.

Stock SITL builds in `gcc:14` and answers its CLI over TCP for 4.5.5 and master (verified). Hosting options are in [DEPLOY.md](DEPLOY.md).

## 5. Connection behaviour

These come from testing on real hardware:

- A board left in CLI mode ignores MSP. The app detects this and reboots it back to normal.
- The firmware discards bytes received in the same read pass as the `#` that enters CLI mode, so `#` is sent alone.
- CLI command completion uses a comment sentinel rather than timing. Reading `diff all`, `dump all`, `get` and `help` takes under a second.
- The app stays in CLI mode while connected, and leaving it reboots the board. Disconnect makes that visible.
- Build options come from `MSP_BUILD_INFO` on API 1.46 and later, and work with no build key. Boards with neither must rely on `help` and `get`.

## 6. Firmware knowledge

**Schemas** describe each firmware. For every setting they give its name, profile scope, type, limits, allowed values and default. They also list the commands and their usage.

| Source | Trust | Coverage |
|---|---|---|
| `get` and `help` from a real board | Exact for that build | Only what that build includes |
| SITL `get` | Exact for shared logic | Missing hardware features |
| Parsing `settings.c` | Names only | Everything, but no defaults |

`get` prints a default only when the value differs from it, so one capture gives complete defaults.

Stored schemas are data in `data/schemas/<version>.json`. When connected, the live schema from the board takes priority for the source firmware.

## 7. Migration

### 7.1 Flow

1. Read `diff all`, `dump all`, and build options. Save a backup.
2. Run the rule chain from source to target and validate the result against the target schema.
3. Show the review screen, grouped by domain, and collect the user's choices.
4. Back up the current firmware over DFU when the board allows it, then flash the target.
5. Apply with `defaults nosave`, then `batch start`, the lines, and `batch end`, capturing every result.
6. Compare the board's `diff all` with what was expected. Nothing is saved until the user has seen that (S1).
7. `save`, then confirm the board comes back on the target version.

The backup and firmware dump stay available for rollback.

The target can be any newer release on a line migration understands. It can also be the release the board runs now: migrating to it rebuilds the board and sends its settings back. The firmware comes from Betaflight's cloud build, with build options ticked from what the board has now. The pilot can change them, and options the target does not offer are listed as left out.

**A G4 Alpha migrated to Betaflight** is called out on the Migrate page. The cloud build does not carry it, so its firmware comes from one of two places:
- this site's own release, pinned by SHA-256 as on the Alpha page;
- the pilot's .hex.

Either way it goes through the same image check. Its build options are fixed by the build. The pilot's file gets a warning when it does not name the target version the settings are planned for.

### 7.2 What each line becomes

| Outcome | Meaning |
|---|---|
| Carried | Same name, value still valid. |
| Renamed | New name, same meaning. |
| Converted | New name or meaning, with a value conversion. |
| Dropped | No equivalent exists. The reason is shown. |
| Needs attention | Cannot be safely decided. The user picks. |
| Default changed | Not in the user's config, but the factory value differs on the target. |

### 7.3 Domains

Priority follows how much pain a wrong migration causes.

| Domain | Approach |
|---|---|
| Serial ports | Carry `serial` lines. Function bits 0 to 17 are stable. From 2025.12 port identifiers are printed by name, but legacy numbers are still accepted. After 2026.6.2, per-feature `*_uart` settings replace the mask; legacy lines are still translated. |
| Gyro and board orientation | `align_board_*` carries. Per-gyro `gyro_*_sensor_align` and `gyro_*_align_*` no longer exist from 2025.12; the board definition now fixes them. Default values are dropped silently. A custom value needs attention. |
| Motors | Protocol, poles, bidirectional DShot, and reordering carry. `dshot_idle_value` becomes `motor_idle`. |
| Modes | `aux` lines carry. Permanent mode IDs have been stable, with new ones only added. |
| VTX table | Carries unchanged. Syntax and limits have not moved. |
| OSD | Positions and `osd_stat_bitmask` carry. `osd_warn_bitmask` is converted, because one bit was removed at 2025.12 and later bits shifted down. |
| Rates | Carry. |
| Tuning | Section 7.5. |
| Anything else | Validated against the schema, then carried, or flagged. |

Some settings exist only on a custom fork, such as the `extra_*` OSD text on Funny OSD builds. They are dropped with an explanation unless the target has them.

### 7.4 The rule chain

Rules are data, one pack per version step: 4.5 to 2025.12, 2025.12 to 2026.6, 2026.6 to 2026.12. A migration runs the packs in order **on the config text only**, so the board is flashed once, directly to the target.

This is the answer to older quads. Supporting 4.3 or 4.4 means adding two packs, 4.3 to 4.4 and 4.4 to 4.5, plus their schemas. Neither the engine nor the user's experience changes: one flash, however many steps. Those boards need `help` and `get` for build detection, since they predate build-option reporting.

### 7.5 Tuning

Tuning is the second most valuable domain and the most error-prone, so it is handled in tiers rather than as ordinary settings.

From 4.5 to 2026 only D changed meaning. At 2025.12 the base and peak moved:

| | D base | D peak |
|---|---|---|
| 4.5 | `d_min_*` | `d_*` |
| 2025.12 and later | `d_*` | `d_max_*` |

So a tune can move exactly, as long as D is swapped correctly. The findings and conversions are in [research/migration-facts.md](research/migration-facts.md). Both routes below give the same numbers on these versions.

**Tune with sliders on.** The sliders are the source of truth. Carry them, skip the raw numbers the firmware derived from them, and issue `simplified_tuning apply` on the target.

**Tune with custom PIDs.** Convert the numbers directly, using the D swap. The review screen also offers re-expressing them as sliders if they fit the slider model within rounding, and reports how closely they fit.

**Setting tiers**

| Tier | Settings | Treatment |
|---|---|---|
| Carry | `throttle_boost`, `anti_gravity_gain`, `tpa_*`, `dyn_idle_*`, `iterm_relax*` | Carried. |
| Convert | `thrust_linear` (curve changed at 2026.6, published formula), `d_max_advance` (decoupled from gain at 2025.12) | Converted, with old and new shown. |
| Changed meaning, no formula | `iterm_windup`, feedforward smoothing and jitter | Value carried if valid, and flagged for the user to re-check. |
| Removed | `iterm_limit`, `crashflip_expo`, `rc_smoothing_feedforward_cutoff`, `transient_throttle_limit`, `abs_control_*` | Dropped with an explanation. |

**Pilot standards.** A saved list of settings that should always have a chosen value on every migration, such as `throttle_boost = 0`. They apply last and are labeled as the pilot's own, so the user need not review them each time.

**Changed defaults.** The new default is adopted and listed on the review screen, with one click to keep the old value. Flight-affecting defaults are listed first.

## 8. Flashing

Firmware comes from three places:

- **Betaflight's cloud build** at `build.betaflight.com`, which accepts browser calls from other sites. A migration requests a build with the board's current options.
- **This site's own builds**, for boards the cloud build does not carry yet. They are releases of [fc-migrate-firmware](https://github.com/cchamp-msft/fc-migrate-firmware), built in public from a Betaflight release plus published patches. The site serves them pinned by SHA-256 (S7).
- **The pilot's own file.**

DFU rules, alongside S2 to S4:

- USB timeouts must outlast a sector erase. The ROM holds the status request until the erase finishes, and a 128K sector can take more than a second.
- With the firmware partly erased, a board that loses power needs BOOT held while plugging in.
- Tell the user plainly when a re-plug is needed. DFU reconnects are not always automatic, and browsers can require a fresh permission click.

## 9. Bootstrapper

A simple mode for a quad that already flies on Betaflight 4.5 or later. It sets a known starting point in one confirmed step.

It runs only when all of these hold:
- bidirectional DShot is on, with a DShot motor protocol;
- the build has simplified tuning;
- the build has dynamic idle.

It never turns bidirectional DShot on itself, because ESC firmware support cannot be confirmed from the flight controller. A later version may test it and enable it on the pilot's behalf.

| Choice | Settings |
|---|---|
| Every PID profile | `throttle_boost = 0`; `dyn_idle_min_rpm` 30 (3,000 rpm) for 2 to 3.5 inch, 20 (2,000 rpm) for 4 to 5 inch |
| Active PID profile | `simplified_pids_mode = RPY`, every PID slider and the D-term filter slider at the firmware default, `simplified_dterm_filter = ON` |
| Smooth feel | D slider 1.15, D-term filter slider 0.90 |
| Wind resistant | I slider 1.25, D max slider 0, `thrust_linear` 20% |

Values are written in 4.5 terms and carried to the board's release by the migration rules. Names change (`simplified_dmax_gain` becomes `simplified_d_max_gain`) and scales change (`thrust_linear` 20 on 4.5 is 17 on 2026.6). The script ends with `simplified_tuning apply`, which recomputes PIDs and D-term filters on every profile in slider mode.

Before anything is sent, the browser keeps a backup made of two parts:
- a restore script for every value the bootstrap or `simplified_tuning apply` can change on any profile: PIDs, sliders, gyro and D-term filters, throttle boost, dynamic idle, and thrust linearization;
- the full `diff all`.

A restore sends that script without `simplified_tuning apply`, so PID numbers come back exactly, then saves. If the board rejects a line, nothing is saved.

The slider values are starting points from the owner's flying, not computed results. Adjust them in the table above as experience suggests.

## 10. Alpha Migrate

Replaces the closed Alpha firmware on a T-Motor Pacer G4 Alpha with Betaflight. It works through an ST-Link V2 (or V2-1) driven from the browser over WebUSB. It follows the procedure that converted the first board. The research, citations and open questions are in [research/alpha-migrate-design.md](research/alpha-migrate-design.md).

**Steps and navigation**

- Only the HD board (`TMOTORG4ALPHAHD`) is supported. Analog is listed and disabled until it is mapped.
- The steps are:
  1. intro;
  2. board;
  3. wiring checklist;
  4. choose the ST-Link;
  5. connect;
  6. confirm the chip;
  7. save the report;
  8. choose the firmware;
  9. unlock (the one-way step);
  10. write;
  11. done.
- Every warning text has an id and a version. The board report records which ones the pilot confirmed.
- The intro and wiring ticks are a checklist, not a gate. Continue works without them, and a confirmation is recorded only when they were ticked.
- The stage numbers are buttons. Every stage opens at any time, except while the chip is being connected or written.
- A button whose action needs something not yet done stays grey and lists what is still needed (S6).
- On a migrated board connected over USB, the ST-Link steps fold away behind a toggle, unless an ST-Link session is in use.

**Connecting and classifying**

- Connecting tries hot-plug first. A stock Alpha uses the SWD clock pin as a UART, so hot-plug may fail. Then the pilot holds the board's reset button while the app attaches and arms a halt on the reset vector. The probe's RST pin is never relied on.
- The board is classified from what the chip reports:
  - locked: Level 1, stock or bricked;
  - blank: an interrupted migration;
  - programmed or unknown: Level 0;
  - wrong chip;
  - protected in a way the tested run never saw.
- Wrong-chip and protected boards stop with nothing changed.
- Classification is read from the chip each time, so an interrupted run resumes at the right step.

**The one-way step**

- Removing read protection mass-erases the chip, FETtec's unpublished bootloader included, so the board can never run Alpha again (S5, S6).
- Before it, the pilot must save a board report: option bytes, protection registers and unique ID. The report stays on the pilot's computer.

**Firmware and the image check**

- Firmware is this site's own build or the pilot's file. The page links the site's release and its source.
- Every image is checked before writing. It must stay inside main flash, start at 0x08000000 with a valid vector table, and look like Betaflight (design section 6.7).
- Alpha images are refused. Generic G474 builds and images for other boards get a warning.

**Rewriting a migrated board**

- A rewrite of an unlocked board erases only the pages the image uses. It keeps saved settings unless the pilot turns that off.
- If the BOOT0 pin is honoured, the app offers to switch it off (S4). A DJI air unit on R3 can hold it high.
- A board already migrated and connected over USB is flashed through its own DFU bootloader, with no ST-Link.
- That board's file is chosen separately from the ST-Link flow's. It is shown before writing: name, board, size and SHA-256.
- When the browser has no permission for the bootloader yet, the pilot grants it with a click, since the restart has used up the first one.

**Simulator**

- A simulated ST-Link and chip, with scenarios for each board state, lets anyone walk through the procedure with no hardware.
- A SIMULATED banner stays up, and saved reports are marked (S8).

## 11. AI suggestions

Optional, and last in priority: the deterministic layers should handle most cases.

A model only proposes fixes for lines the rules could not resolve, and never writes to the board (S9).

```ts
interface LlmProvider {
  id: string;
  propose(request: { failures: FailedLine[]; schema: SchemaExcerpt; context: MigrationContext }): Promise<Proposal[]>;
}
```

The web app calls only the model API under `/api`. The API holds the keys, applies limits and picks the provider; providers and limits are in [DEPLOY.md](DEPLOY.md). A public status call reports whether suggestions are switched on, and the review screen shows them only when they are. Each browser holds the passphrase, and the server checks it on every call (S10). The model has no tools, and its reply only ever reaches the browser that asked.

**Which lines can be sent.** Lines that cannot be sent as written can be sent for suggestions: those that were dropped, or that the target rejects. PID numbers, sliders and gyro alignment are excluded, because other steps own them.

**How a suggestion is checked.** Beyond S9:
- A replacement must stay in the same section as its line: main, PID profile or rate profile.
- It never overrides a setting the config already sends, or a pilot standard. When one is not used, the review screen says why.

Accepted replacements appear in the plan as "AI suggested".

## 12. Interface

Layout follows the Configurator: a left column with the logo, connect button and navigation, content on the right, and a status bar along the bottom.

Warning and danger notices carry a solid coloured edge, so they never read as decoration. Flashing behaviour is in S11.

Themes, each in light and dark: Mono, Deep Purple, Deep Red, Blue Teal, Betaflight, Betaflight Sunset.

The CLI:
- searches settings by fuzzy match;
- shows allowed values, ranges, defaults and current values as you type;
- flags invalid values before sending;
- keeps its data ready, so the session never pauses to rebuild it;
- runs pasted multi-line text line by line.

A demo board replays captures from a real board, so the app can be explored without hardware.
