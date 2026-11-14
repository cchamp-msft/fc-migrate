# Betaflight Migrator

Unofficial browser tool for upgrading Betaflight firmware and carrying a quad's configuration across versions. Not affiliated with the Betaflight project. Licensed GPL-3.0-or-later.

See [docs/SPEC.md](docs/SPEC.md) for what it does, [docs/PLAN.md](docs/PLAN.md) for progress, and [docs/DEPLOY.md](docs/DEPLOY.md) for hosting.

## Development

Needs Node 24 and pnpm 10. WebSerial and WebUSB need Chrome or Edge.

```
pnpm install
pnpm dev         # app at http://localhost:5173, with a demo board that needs no hardware
pnpm dev:api     # optional: the /api Worker on :8787, which pnpm dev proxies to
pnpm test
pnpm typecheck
pnpm hil COM6    # read-only check against a real board
```

AI suggestions on the review screen need `pnpm dev:api` and an `apps/worker/.dev.vars` with `LLM_ENABLED=true`, a `PROXY_TOKEN` passphrase of your choice, and `ANTHROPIC_API_KEY`. The file is git-ignored. Local runs get the same per-minute and daily limits as the deployed site.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

## Project statement

The Betaflight Migrator will allow a user connect their flight controller, see the firmware installed, and upgrade to a new firmware version and migrate their configuration. It should support reading build options (this may be harder for locally built firmwares), viewing and saving the configuration, a CLI for entering commands with an improved auto-completesystem over the configurator. Fully featured the app should vet running configurations for options that change going forward -- we can accomplish this by using one or more of: 1) writing a dry-run system that maps the commands and set variables to betaflight firmware versions. 2) create a firmware emulator so we can actually dry-run in those emulator firmware targets. 3) use a local Qwen model OR Grok to help migrate configs based on config attempt failures -- this would be much better with #2 that the model could target versus live resolution.

Use ../betaflight-configurator for the actual Betaflight Configurator app to understand the expected UI feel and re-use any code as necessary.

../betaflight contain the firmware (oem configs may need a fresh pull, but also probably have not bearing on this project).

Color schemes
- Normal light/dark modes, nearly mono-tone but logos/buttons can have color
- Deep purple, red, blue/teal centric themes
- Betaflight Config color match (they had more of this yellow they used to use)
- Betaflight sunset -- modernize the betaflight color with a sunset wash
