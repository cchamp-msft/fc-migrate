# Betaflight Migrator: Specification

Status: v1 draft, 2026-11-08. Build order and progress are in [PLAN.md](PLAN.md). Firmware facts below were checked against the Betaflight source; see [research/migration-facts.md](research/migration-facts.md).

## 1. What it is

A browser app that connects to a Betaflight flight controller, shows what it runs, upgrades its firmware, and carries its configuration to the new version. Every change is reviewed before it is saved to the board.

Betaflight itself offers no real migration. The firmware resets settings when the config version changes, and the Configurator replays `diff all` and skips lines that fail. This app fills that gap.

**Audience, in order:** the author and one friend, then an FPV crew, then the public. Decisions must not block that path, but we do not build for scale before it is needed.

**Unofficial.** The app says so in the sidebar and the About page, and uses its own logo. It may offer a Betaflight-colored theme.

**License.** GPL-3.0-or-later, because it includes code derived from Betaflight Configurator.

## 2. Scope

| Item | Decision |
|---|---|
| Source firmware | 4.5.x for MVP. 4.5.3 is the floor if a 4.5 build proves awkward. |
| Target firmware | 2025.12.x and 2026.6.x. 2026.12 alpha behind an "unstable" toggle. |
| Older sources (4.3, 4.4) | Later. See section 6.4: the design makes these additive data work. |
| Browsers | Chrome and Edge (WebSerial and WebUSB). HTTPS or localhost only. |
| MCUs | STM32 F4, F7, H7 first, since those are what the DFU port covers and tests. |

Not planned: flight tuning advice, blackbox analysis, re-creating the Configurator's setup tabs, or receiver or motor test screens.

## 3. Architecture

```
Browser (static PWA)
  apps/web          Vue 3, Vite, TypeScript, Pinia
  packages/core     No DOM or framework. MSP, CLI, DFU, parsing, schemas, migration.
     |                       |                      |
  WebSerial, WebUSB     Static JSON data       Optional services
  (the board)           (schemas, rule packs)  (dry-run engine, LLM proxy)
```

Rules that keep the deployment options open:

1. **Everything essential runs in the browser.** Connect, inspect, CLI, flash, and rule-based migration need no server, so hosting cost stays near zero at any audience size.
2. **`packages/core` stays platform free.** It talks to hardware through `ByteTransport` and `UsbDeviceLike`. The browser, the Node hardware harness and the simulator each plug in their own.
3. **Services are optional and sit behind interfaces.** The app must work with both absent. Each is a stateless HTTP API, so it can move hosts without app changes.
4. **No secrets in the browser.** API keys live only in the service layer.

### Deployment ladder

| Stage | Web app | LLM proxy | Dry-run engine |
|---|---|---|---|
| Local dev | `localhost` | Local process calling Strata | Docker Desktop |
| Self and friend | Cloudflare Pages | Cloudflare Worker, gated by Cloudflare Access | RKE2 at `.248`, reached through a Cloudflare Tunnel |
| FPV crew | Same | Same, with per-user limits | Same |
| Public | Same | Same, hosted models only | Scale-to-zero containers, or WASM in the browser |

A Worker cannot reach the home network directly. Reaching Strata from a Worker needs a Cloudflare Tunnel, and hosted providers are called straight from the Worker.

### Where the emulator can run

The emulator is a native Linux binary (SITL) with threads and TCP sockets, one per firmware version.

| Option | Fit |
|---|---|
| Docker or RKE2 at `.248` | Works today. The right start. |
| Cloudflare Workers | Cannot run native binaries. Only viable with a WASM port. |
| Cloudflare Containers | Runs the same image behind a Worker, and keeps everything on one platform. Best hosted candidate if we stay on Cloudflare. |
| Google Cloud Run, Azure Container Apps | Run the same image and scale to zero. Good alternatives. |
| AWS Fargate | Runs the image but does not scale to zero by itself, so it costs money while idle. |
| GitHub Actions runners | Good for building per-version images and generating schemas. Not for serving requests. |
| WASM in the browser | End state: no hosting cost and scales with users. It needs a per-version port, so it waits for proof that a dry-run earns its place. |

The contract that makes these interchangeable:

```ts
interface DryRunEngine {
  run(request: { firmwareVersion: string; buildOptions: string[]; lines: string[] }): Promise<{
    results: { line: string; ok: boolean; message?: string }[];
    resultingDiff: string;
  }>;
}
```

Each run starts from a clean config and keeps no state, so instances are disposable.

Stock SITL compiles out OSD, VTX, DShot and resource management, and could check only 18 of the test board's 42 changed settings. An engine needs a build with those re-enabled, or a merge with the data in section 5. Stock SITL builds in `gcc:14` and answers its CLI over TCP for 4.5.5 and master (verified).

## 4. Connection behaviour

These come from testing on real hardware:

- A board left in CLI mode ignores MSP. The app detects this and reboots it back to normal.
- The firmware discards bytes received in the same read pass as the `#` that enters CLI mode, so `#` is sent alone.
- CLI command completion uses a comment sentinel rather than timing. Reading `diff all`, `dump all`, `get` and `help` takes under a second.
- The app stays in CLI mode while connected, and leaving it reboots the board. Disconnect makes that visible.
- Build options come from `MSP_BUILD_INFO` on API 1.46 and later, and work with no build key. Boards with neither must rely on `help` and `get`.

## 5. Firmware knowledge

**Schemas** describe each firmware: every setting's name, profile scope, type, limits, allowed values and default, plus commands and their usage.

| Source | Trust | Coverage |
|---|---|---|
| `get` and `help` from a real board | Exact for that build | Only what that build includes |
| SITL `get` | Exact for shared logic | Missing hardware features |
| Parsing `settings.c` | Names only | Everything, but no defaults |

`get` prints a default only when the value differs from it, so one capture gives complete defaults.

Stored schemas are data in `data/schemas/<version>.json`. When connected, the live schema from the board takes priority for the source firmware.

## 6. Migration

### 6.1 Flow

1. Read `diff all`, `dump all`, and build options. Save a backup.
2. Run the rule chain from source to target and validate the result against the target schema.
3. Show the review screen, grouped by domain, and collect the user's choices.
4. Back up the current firmware over DFU when the board allows it, then flash the target.
5. Apply with `defaults nosave`, then `batch start`, the lines, and `batch end`, capturing every result.
6. Compare the board's `diff all` with what was expected. Nothing is saved until the user has seen that.
7. `save`, then confirm the board comes back on the target version.

If anything fails before `save`, the board has not stored the result. The backup and firmware dump stay available for rollback.

### 6.2 What each line becomes

| Outcome | Meaning |
|---|---|
| Carried | Same name, value still valid. |
| Renamed | New name, same meaning. |
| Converted | New name or meaning, with a value conversion. |
| Dropped | No equivalent exists. The reason is shown. |
| Needs attention | Cannot be safely decided. The user picks. |
| Default changed | Not in the user's config, but the factory value differs on the target. |

### 6.3 Domains

Priority follows how much pain a wrong migration causes.

| Domain | Approach |
|---|---|
| Serial ports | Carry `serial` lines. Function bits 0 to 17 are stable. From 2025.12 port identifiers are printed by name but legacy numbers are still accepted. After 2026.6.2 per-feature `*_uart` settings replace the mask; legacy lines are still translated. |
| Gyro and board orientation | `align_board_*` carries. Per-gyro `gyro_*_sensor_align` and `gyro_*_align_*` no longer exist from 2025.12; the board definition now fixes them. Default values are dropped silently. A custom value needs attention. |
| Motors | Protocol, poles, bidirectional DShot, and reordering carry. `dshot_idle_value` becomes `motor_idle`. |
| Modes | `aux` lines carry. Permanent mode IDs have been stable, with new ones only added. |
| VTX table | Carries unchanged. Syntax and limits have not moved. |
| OSD | Positions and `osd_stat_bitmask` carry. `osd_warn_bitmask` is converted, because one bit was removed at 2025.12 and later bits shifted down. |
| Rates | Carry. |
| Tuning | See below. |
| Anything else | Validated against the schema, then carried, or flagged. |

Settings that exist only on a custom fork, such as the `extra_*` OSD text on Funny OSD builds, are dropped with an explanation unless the target has them.

### 6.4 The rule chain

Rules are data, one pack per version step: 4.5 to 2025.12, 2025.12 to 2026.6, 2026.6 to 2026.12. A migration runs the packs in order **on the config text only**, so the board is flashed once, directly to the target.

This is the answer to older quads. Supporting 4.3 or 4.4 means adding a 4.3 to 4.4 pack and a 4.4 to 4.5 pack and their schemas, with no change to the engine or to the user's experience: one flash, however many steps. Those boards need `help` and `get` for build detection, since they predate build-option reporting.

### 6.5 Tuning

Tuning is the second most valuable domain and the most error-prone, so it is handled in tiers rather than as ordinary settings.

**Findings for 4.5 to 2026.** P, I and F base values and the PID scaling constants have not changed, and neither have the filter base frequencies. The slider formula is the same apart from D. D changed meaning at 2025.12:

| | D base | D peak |
|---|---|---|
| 4.5 | `d_min_*` | `d_*` |
| 2025.12 and later | `d_*` | `d_max_*` |

So a tune can move exactly, as long as D is swapped correctly. Both routes below give the same numbers on these versions.

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

## 7. Flashing

Firmware comes from `build.betaflight.com`, which accepts browser calls from other sites. A migration requests a build with the same options the board reports.

Safety rules:

- Back up first, always.
- Dump the existing firmware over DFU before the first flash when possible, because a build may not be available again. This board's 4.5.4 is a custom build and is not offered.
- Verify after writing.
- Never write option bytes. On failure the board stays in the ROM bootloader, which cannot be erased, so a flash can always be retried. With the firmware partly erased, a board that loses power needs BOOT held while plugging in.
- USB timeouts must outlast a sector erase. The ROM holds the status request until the erase finishes, and a 128K sector can take more than a second.
- Tell the user plainly when a re-plug is needed. DFU reconnects are not always automatic, and browsers can require a fresh permission click.
- The CLI blocks commands that would strand the session, such as `dfu` and `bl`.

## 8. LLM assistance

Optional, and last in priority: the deterministic layers should handle most cases.

A model only proposes fixes for lines the rules could not resolve. Every proposal passes the validator and appears on the review screen as a suggestion. It never writes to the board on its own.

```ts
interface LlmProvider {
  id: string;
  propose(request: { failures: FailedLine[]; schema: SchemaExcerpt; context: MigrationContext }): Promise<Proposal[]>;
}
```

| Provider | Role |
|---|---|
| Claude Opus 5.5 | Default for deployed use. |
| Claude Sonnet 5.5 | Selectable alternative. |
| Claude Haiku 5.5, Grok, DeepSeek | Scalable, lower-cost alternatives. |
| Strata `qwen3.8-flash-next` | Local development only, on the home network. Not exposed through a tunnel. |

The web app calls only the proxy, which holds the keys, applies limits and picks the provider. Deployed use goes straight to hosted providers, so no path into the home network is exposed.

The proxy is served under `/api` by the same Worker as the site, so a Cloudflare Access policy on `/api/*` can protect it without cross-origin cookies. A public `/api/v1/status` reports the server-side `LLM_ENABLED` switch, and the review screen shows suggestions only when it is on. Until Access is in place, each browser holds a passphrase, which the proxy checks as a bearer token. Case and word separators are ignored, so a passphrase read aloud works however it is typed.

The proxy limits use so a shared passphrase cannot run up the bill:

- Every call except `/status` counts against a Cloudflare rate limit of 10 a minute per visitor address (per /64 for IPv6). It is checked before the passphrase, so it also slows guessing.
- Model calls count against a daily budget held in a Durable Object: 50 per visitor and 200 in total per UTC day. The dashboard variables `DAILY_LIMIT_PER_VISITOR` and `DAILY_LIMIT_TOTAL` override these. Visitors are counted by a hash of their address and the day, and the counts reset daily. IPv6 visitors are counted per /64, since one client can usually choose any address in it. A call the provider refuses before any model runs is given back.
- Without either binding the API stays shut rather than unlimited.

The proxy forwards only well-formed requests: every failed line must be one `set name = value` line of printable characters, every candidate must describe a setting, versions must look like versions, and the body must be under 256 KB, which the Worker stops reading past. Free text never reaches a model. In the other direction, a replacement must also be a single printable `set` line before the browser or the planner accepts it, so no reply can add a second CLI command such as `save` or `bl`. The model has no tools, and its reply only ever reaches the browser that asked.

On the review screen, lines that cannot be sent as written (dropped, or rejected by the target) can be sent for suggestions. PID numbers, sliders and gyro alignment are excluded because other steps own them. Each suggestion is checked against the target schema in the browser, and checked again by the planner when the pilot ticks it. A replacement must stay in the same section (main, PID profile or rate profile) as its line, and never overrides a setting the config already sends or a pilot standard; when one is not used, the review screen says why. Accepted replacements appear in the plan as "AI suggested".

## 8a. Bootstrapper

A simple mode for a quad that already flies on Betaflight 4.5 or later. It sets a known starting point in one confirmed step.

It runs only when bidirectional DShot is on with a DShot motor protocol, and the build has simplified tuning and dynamic idle. It never turns bidirectional DShot on itself, because ESC firmware support cannot be confirmed from the flight controller. A later version may test it and enable it on the pilot's behalf.

| Choice | Settings |
|---|---|
| Every PID profile | `throttle_boost = 0`; `dyn_idle_min_rpm` 30 (3,000 rpm) for 2 to 3.5 inch, 20 (2,000 rpm) for 4 to 5 inch |
| Active PID profile | `simplified_pids_mode = RPY`, every PID slider and the D-term filter slider at the firmware default, `simplified_dterm_filter = ON` |
| Smooth feel | D slider 1.15, D-term filter slider 0.90 |
| Wind resistant | I slider 1.25, D max slider 0, `thrust_linear` 20% |

Values are written in 4.5 terms and carried to the board's release by the migration rules. Names change (`simplified_dmax_gain` becomes `simplified_d_max_gain`) and scales change (`thrust_linear` 20 on 4.5 is 17 on 2026.6). The script ends with `simplified_tuning apply`, which recomputes PIDs and D-term filters on every profile in slider mode.

Before anything is sent, the browser keeps a backup: a restore script for every value the bootstrap or `simplified_tuning apply` can change on any profile (PIDs, sliders, gyro and D-term filters, throttle boost, dynamic idle, thrust linearization), plus the full `diff all`. A restore sends that script without `simplified_tuning apply`, so PID numbers come back exactly, then saves. If the board rejects a line, nothing is saved.

The slider values are starting points from the owner's flying, not computed results. Adjust them in the table above as experience suggests.

## 8b. Alpha Migrate

Replaces the closed Alpha firmware on a T-Motor Pacer G4 Alpha with Betaflight, through an ST-Link V2 (or V2-1) driven from the browser over WebUSB. It follows the owner's recorded procedure in `../fix-thobby-g4-alpha`. Research, citations and open questions are in [research/alpha-migrate-design.md](research/alpha-migrate-design.md).

- Only the HD board (`TMOTORG4ALPHAHD`) is supported. Analog is listed and disabled until it is mapped.
- The steps are: intro, board, wiring checklist, choose the ST-Link, connect, confirm the chip, save the report, choose the firmware, unlock (the one-way step), write, then done. Every warning text has an id and a version, and the board report records which ones the pilot confirmed.
- The intro and wiring ticks are a checklist, not a gate: Continue works without them, and a confirmation is recorded only when they were ticked. The stage numbers are buttons. The stages up to choosing the ST-Link always open; later ones open once reached on the connected chip, never ahead of it. The typed ERASE and the saved report still gate the one-way step.
- Connecting tries hot-plug first. A stock Alpha uses the SWD clock pin as a UART, so on failure the pilot holds the board's reset button while the app attaches and arms a halt on the reset vector. The probe's RST pin is never relied on.
- The board is classified from what the chip reports: locked (Level 1, stock or bricked), blank (an interrupted migration), programmed or unknown (Level 0), wrong chip, or protected in a way the tested run never saw. Wrong-chip and protected boards stop with nothing changed. Because classification is read from the chip each time, an interrupted run resumes at the right step.
- Removing read protection mass-erases the chip, FETtec's unpublished bootloader included, so the board can never run Alpha again. It needs the typed word ERASE. No code path can produce Level 2. The pilot must save a board report (option bytes, protection registers, unique ID) before it; the report stays on the pilot's computer.
- Firmware comes from a .hex file, checked before writing: it must stay inside main flash, start at 0x08000000 with a valid vector table whose reset, NMI and HardFault handlers are Thumb addresses inside the file, and look like Betaflight. Alpha images (starting at 0x08003800) are refused, and generic G474 builds or images for other boards are warned about.
- The demo's stand-in image carries a marker, and the check refuses it for anything but the simulated board. Choosing a probe clears the chosen image, so a simulated choice never carries over to a real chip.
- A rewrite of an unlocked board erases only the pages the image uses, keeping saved settings unless the pilot turns that off. Saved settings are found by the config header's magic, 0xBE, its second byte at 0x08004000 (the first is the config version). If the BOOT0 pin is honoured, the app offers to switch it off, since a DJI air unit on R3 can hold it high.
- A board already migrated and connected over USB is flashed through its own DFU bootloader, with no ST-Link. Its file is chosen separately from the ST-Link flow's and shown (name, board, size, SHA-256) before writing. When the browser has no permission for the bootloader yet, the pilot grants it with a click, since the restart has used up the first one.
- A simulated ST-Link and chip, with scenarios for each board state, lets anyone walk through the procedure with no hardware. A SIMULATED banner stays up, and saved reports are marked.



Layout follows the Configurator: a left column with the logo, connect button and navigation, content on the right, and a status bar along the bottom.

Themes, each in light and dark: Mono, Deep Purple, Deep Red, Blue Teal, Betaflight, Betaflight Sunset.

The CLI searches settings by fuzzy match, shows allowed values, ranges, defaults and current values as you type, flags invalid values before sending, keeps its data ready so the session never pauses to rebuild it, and runs pasted multi-line text line by line.

A demo board replays captures from a real board, so the app can be explored without hardware.
