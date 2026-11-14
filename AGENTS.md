# Agent guide

This file is for coding agents working in this repository. Agents follow the same rules as people. Read [CONTRIBUTING.md](CONTRIBUTING.md) and follow it for:
- issues;
- commit messages;
- pull requests;
- the checks to run before pushing.

This file adds what an agent needs on top.

## The project

Betaflight Migrator, served at https://fc-migrate.com. It's a browser app that upgrades Betaflight flight controllers and carries their configuration across versions. It also moves T-Motor Pacer G4 Alpha boards from FETtec Alpha to Betaflight.

| Read | For |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | What the app does, and the safety invariants S1 to S12 |
| [docs/PLAN.md](docs/PLAN.md) | Progress and open work |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Hosting, settings and the model API |
| [docs/research/](docs/research/) | Firmware facts behind the migration rules, and the Alpha Migrate design |
| [README.md](README.md) | Setup and local development |

| Path | Holds |
|---|---|
| `apps/web` | The Vue 3 app |
| `apps/worker` | The Cloudflare Worker that serves the site and the model API |
| `packages/core` | MSP, CLI, DFU, SWD, parsing, schemas and migration, with no DOM or framework |
| `tools/hil` | A Node harness that runs `packages/core` against real boards |
| `data/schemas` | Firmware schemas |

## Rules

- **Keep the safety invariants.** Some changes must keep S1 to S12 in docs/SPEC.md: any change to saving, flashing, option bytes, the unlock step, image checks or the model API.
  - Name the invariants a change touches in its pull request.
  - A change that has to weaken one says so, and updates the list in the same pull request.
- **Keep the docs current.** A change to what the app does updates docs/SPEC.md in the same pull request. Tick a finished milestone item in docs/PLAN.md.
- **Keep `packages/core` platform free.** Hardware goes through `ByteTransport` and `UsbDeviceLike` (SPEC.md section 4).
- **Never push to `main`, and never deploy.** Land work through a pull request, as CONTRIBUTING.md describes. Leave merging and deploying to the maintainer unless they ask.
- **Be careful with real hardware.**
  - These only read: `pnpm hil`, and the harness's `stlink` and `stlink-dump` scripts.
  - These write to a real flight controller: `flash`, `migrate`, `bootstrap` and `stlink-write`. Run them only when the maintainer asks for that run.
  - Without hardware, use the demo board and the simulated ST-Link in `pnpm dev`.
- **This repository is public.** Keep secrets, LAN addresses, home-network details and personal paths out of code, docs, fixtures and commit messages. Local secrets go in `apps/worker/.dev.vars`, which is git-ignored.
