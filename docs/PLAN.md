# Betaflight Migrator: Plan

What we are building is in [SPEC.md](SPEC.md). Milestones are in build order.

"Hardware" below means verified on the RRIOT F722 test board through `tools/hil`, which runs the same `packages/core` code the browser uses.

## Next

1. Finish a full Upgrade in the browser on a real board, through the review panel and Save. The first run reached 2026.6.1, but its review panel vanished before Save, a bug now fixed.
2. Deployment: one Worker, `bf-migrate`, serves the site at https://fc-migrate.com and its API under `/api` from the same origin. `www.fc-migrate.com` is attached too, and a redirect rule on the zone (Rules > Redirect Rules, "www to fc-migrate.com") sends it to the bare domain with the path and query kept. The old https://bf-migrate.oeb.workers.dev address still works until visitors have moved. `pnpm --filter @bf-migrate/worker run deploy` builds the site and deploys both. It was deployed on 2026-11-12 with AI suggestions on; the old `bf-migrate-api` Worker is deleted. `LLM_ENABLED` switches suggestions in the dashboard (Workers > bf-migrate > Settings > Variables and Secrets), and `keep_vars` keeps it across deploys. To set it from the command line, run `wrangler deploy --var LLM_ENABLED:true` from `apps/worker`; `pnpm run deploy -- --var` passes the flag in a form wrangler ignores. The API takes a passphrase and has per-minute and daily limits. Still to do: decide whether to put Cloudflare Access on `/api/*` (the workers.dev address would then have to be turned off, since Access cannot cover it).
3. Record which build options each schema was captured with. A setting missing from another board's capture is now sent and left to the firmware, but a same-board build with extra options can still have settings dropped.
4. Test a custom-PID tune and varied configs on hardware, and compare `feature`, `serial` and `aux` lines after apply.
5. Build the emulator: SITL with OSD, VTX and motor settings re-enabled, in Docker, behind `DryRunEngine`.
6. Capture a 2026.12 schema.

Before the site link is shared beyond the demo, publish the source, as GPL-3 requires. Before the repo goes public, remove LAN addresses from the docs and `wrangler.toml`, and consider scrubbing the chip ID from the fixtures.

## M1. Foundation

- [x] pnpm workspace, TypeScript, Vitest, GPL-3.0 license
- [x] Baseline captures from the RRIOT F722 committed as fixtures
- [x] Six themes in light and dark, app shell

## M2. Connect and inspect

- [x] MSP v1 and v2 codec and client (hardware)
- [x] CLI session with deterministic command completion (hardware)
- [x] Identity and build options, including builds with no build key (hardware)
- [x] Config parser and schema extraction from `get` and `help` (hardware)
- [x] Node hardware harness
- [x] WebSerial transport and demo board
- [x] Overview, Configuration and Appearance pages
- [x] CLI page with schema-driven autocomplete
- [ ] Run WebSerial against a real board in Chrome (needs a person to click the port chooser)

## M3. Flashing

- [x] DFU flasher ported from the Configurator, with firmware readout added
- [x] Node harness for DFU, using the same flasher code
- [x] Hardware: read out firmware, flash 4.5.5, 2025.12.5 and 2026.6.2, each verified
- [x] Hardware: restore the original firmware from the readout, `diff all` identical
- [x] Schemas captured from real builds of 4.5.5, 2025.12.5 and 2026.6.2
- [x] Build service client, requesting builds that match the board's options
- [x] Upgrade flow in the web app: back up, build, flash, apply, review, save
- [ ] Run the upgrade flow in Chrome against a real board (needs a person to click the USB chooser)
- [ ] Capture a schema for 2026.12

## M4. Migration

- [x] Rule packs: 4.5 to 2025.12, 2025.12 to 2026.6, 2026.6 to 2026.12
- [x] Tuning: sliders, D swap, conversions, tiers, pilot standards
- [x] Default-change detection, comparing in the target's units
- [x] Review screen
- [x] Apply and compare, no save until reviewed
- [x] Hardware: this board's 4.5.4 config onto 2026.6.2, none rejected, all values match after reboot
- [x] Hardware: firmware recomputes changed sliders to within 1 PID unit of the converted 4.5 values
- [ ] Hardware: a custom-PID tune, and boards with more varied configs
- [ ] Compare `feature`, `serial` and `aux` lines after apply, not only `set` values

## M4a. Bootstrapper

- [x] Readiness gate on bidirectional DShot, simplified tuning and dynamic idle
- [x] Size, feel and wind choices carried through the rule packs to each release
- [x] Backup in the browser before apply, restore without recomputing PIDs
- [x] Bootstrap page, walked through on the demo board
- [ ] Hardware: bootstrap and restore on the RRIOT F722, values checked after reboot
- [ ] Test bidirectional DShot and offer to enable it, instead of only gating on it

## M4b. Alpha Migrate

- [x] Research and design from the owner's notes ([research/alpha-migrate-design.md](research/alpha-migrate-design.md))
- [x] Classification, image checks, report and confirmation texts
- [x] ST-Link V2 protocol, STM32G4 option bytes and flash, simulated probe and chip
- [x] Alpha Migrate page, walked through against the simulator
- [x] Hardware, read-only first: connect and read the good board (`pnpm --filter @bf-migrate/hil run stlink`). Hot-plug works on a migrated board, running or locked up, with no reset held; a stock Alpha is still untested
- [x] Hardware: rewrite a migrated board over SWD with the session code (`stlink-write`), keeping its settings, then check it over MSP (`stlink-dump` reads the whole flash for comparison)
- [ ] Hardware: the bad board as a fixture (set RDP to 0xBB, then run the full migration)
- [ ] Hardware: G474 DFU flashing through the app for migrated boards. Erase, write and verify are proven; leaving DFU and reconnecting to the new firmware are not yet
- [ ] Decide the firmware source: a CI-built TMOTORG4ALPHAHD image served from the site, with its GPL source linked
- [ ] Settle the manufacturer ID (COMM or TMTR) with the config submission
- [ ] Analog board, once it is mapped



- [x] Stock SITL builds and runs in Docker for 4.5.5 and master, answering over TCP
- [ ] SITL build with OSD, VTX and motor settings re-enabled (stock checks only 18 of this board's 42 changed settings)
- [ ] `DryRunEngine` service in Docker
- [ ] Per-version images built by CI, deployable to RKE2

## M6. LLM-assisted fixes

- [x] Proposal prompt, candidate selection, validation against the target schema
- [x] Worker with a provider shim for Strata, Haiku, Sonnet, Grok and DeepSeek
- [x] Live tests against Strata and Claude Opus 5.5 (the deployed default)
- [ ] Test the Sonnet, Haiku, Grok and DeepSeek paths with real keys
- [x] Deploy the Worker with hosted providers only, requiring a bearer token
- [ ] Put `/api/*` behind Cloudflare Access on the new domain
- [x] Suggestions on the review screen, behind the `LLM_ENABLED` switch
- [x] Site and API served by one Worker, same origin

## Later

- 4.3 and 4.4 sources through added rule packs
- Hosted dry-run engine, then a WASM investigation
- PWA install and offline support
