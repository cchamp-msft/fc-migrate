# Deploying

How the site and its model API are hosted, configured and protected. What the app does is in [SPEC.md](SPEC.md).

## The Worker

One Cloudflare Worker, `bf-migrate`, serves the site at https://fc-migrate.com, and serves its API under `/api` from the same origin.

- **Static files:** everything outside `/api/*` comes from the web build (`apps/web/dist`). Only `/api/*` runs the script.
- **`www.fc-migrate.com`** is attached too. A redirect rule on the zone (Rules > Redirect Rules, "www to fc-migrate.com") sends it to the bare domain, keeping the path and query.
- **The old address,** https://bf-migrate.oeb.workers.dev, still works until visitors have moved.

The configuration is in `apps/worker/wrangler.toml`.

## Releasing

Merging to `main` does not deploy. From a clean, up-to-date `main`:

```
pnpm --filter @bf-migrate/worker run deploy
```

This builds the site and deploys the Worker with it. CI runs a `wrangler deploy --dry-run` on every pull request, so a change that breaks the bundle fails before it is merged.

## Settings

| Name | Kind | Purpose |
|---|---|---|
| `LLM_ENABLED` | Variable, set in the dashboard | `"true"` turns AI suggestions on; anything else turns them off. |
| `DEFAULT_PROVIDER` | Variable, in `wrangler.toml` | The provider used when a call names none. Deployed: `opus`. |
| `DAILY_LIMIT_PER_VISITOR`, `DAILY_LIMIT_TOTAL` | Variables, set in the dashboard, optional | Override the daily limits of 50 per visitor and 200 in total. |
| `ALLOWED_ORIGINS` | Variable, in `wrangler.toml` | Origins allowed to call the API cross-origin, for local development. The site calls it same-origin and needs no entry. |
| `PROXY_TOKEN` | Secret | The passphrase every API call must send. |
| `ANTHROPIC_API_KEY` | Secret | Claude Opus, Sonnet and Haiku. |
| `XAI_API_KEY` with `GROK_MODEL` | Secret and variable, optional | Grok. |
| `DEEPSEEK_API_KEY` with `DEEPSEEK_MODEL` | Secret and variable, optional | DeepSeek. |
| `API_LIMITER` | Rate-limit binding | 10 calls a minute per visitor. |
| `BUDGET` | Durable Object binding | Daily model-call counts. |

The dashboard path for the variables is Workers > bf-migrate > Settings > Variables and Secrets. `keep_vars` keeps dashboard variables across deploys, so suggestions can be switched on and off without a release.

To set `LLM_ENABLED` from the command line, run `wrangler deploy --var LLM_ENABLED:true` from `apps/worker`. Don't use `pnpm run deploy -- --var`, which passes the flag in a form wrangler ignores.

Secrets are set with `wrangler secret put`. `wrangler secret list` shows their names, never their values. Locally, all of these go in `apps/worker/.dev.vars`, which is git-ignored (see the README).

## The model API

| Call | Access |
|---|---|
| `GET /api/v1/status` | Public. Reports whether suggestions are switched on, so the app can hide the feature without a passphrase. |
| `GET /api/v1/providers` | Passphrase. Lists the configured providers and the default. |
| `POST /api/v1/propose?provider=` | Passphrase. Sends failed lines for suggestions. |

Scripts may leave out the `/api` prefix.

**Order of checks.** Every call except status goes through these, in order, and the first failure answers:

1. Suggestions are switched on.
2. Both limit bindings exist. Without them the API stays shut rather than unlimited.
3. The per-minute rate limit passes. It comes before the passphrase so that it also slows anyone guessing it.
4. The passphrase is correct.
5. The body is under 256 KB and well formed.
6. The provider exists.
7. The daily budget has room.

**Passphrase.** The server enforces it; it is not just hidden in the interface.
- It is sent as a bearer token.
- It is checked on the server against the `PROXY_TOKEN` secret.
- Both sides are hashed with SHA-256 and compared byte by byte, so the time taken does not reveal how much matched.
- Case and word separators are ignored, so a passphrase read aloud works however it is typed.
- With no `PROXY_TOKEN` set, every call is refused.

**Limits.** These stop a shared passphrase from running up the bill.
- Every call except status counts against a Cloudflare rate limit of 10 a minute per visitor address (per /64 for IPv6).
- Model calls also count against a daily budget held in a Durable Object: 50 per visitor and 200 in total per UTC day.
- Visitors are counted by a hash of their address and the day, and the counts reset daily. IPv6 visitors are counted per /64, since one client can usually choose any address in it.
- A call the provider refuses before any model runs is given back.

**What reaches a model.** The API forwards only well-formed requests:
- every failed line is one `set name = value` line of printable characters;
- every candidate describes a setting;
- versions look like versions;
- the body is under 256 KB, and the Worker stops reading past that.

Free text never reaches a model. Replies are checked in the browser (SPEC.md, S9).

**Providers.** Claude Opus 5.5 is the deployed default. Claude Sonnet 5.5 and Haiku 5.5 are selectable, and Grok and DeepSeek are lower-cost options when their keys are set. Any OpenAI-compatible local model server can be used in local development, through `STRATA_BASE_URL` and `STRATA_API_KEY` in `.dev.vars`. The deployed Worker calls hosted providers only, and has no route to a local server.

**Still open.** Whether to put Cloudflare Access on `/api/*`. The workers.dev address would then have to be turned off, since Access cannot cover it.

## Dry-run engine (planned)

The engine in SPEC.md section 4 runs SITL, a native Linux binary with threads and TCP sockets, one per firmware version. Where it could run:

| Option | Fit |
|---|---|
| Docker on a host we run | Works today. The right start. |
| Cloudflare Workers | Cannot run native binaries. Only viable with a WASM port. |
| Cloudflare Containers | Runs the same image behind a Worker, and keeps everything on one platform. Best hosted candidate if we stay on Cloudflare. |
| Google Cloud Run, Azure Container Apps | Run the same image and scale to zero. Good alternatives. |
| AWS Fargate | Runs the image, but doesn't scale to zero by itself, so it costs money while idle. |
| GitHub Actions runners | Good for building per-version images and generating schemas. Not for serving requests. |
| WASM in the browser | End state: no hosting cost, and it scales with users. It needs a per-version port, so it waits for proof that a dry run earns its place. |

A Worker cannot reach a private network directly. A self-hosted engine would need a tunnel; a hosted one is called straight from the Worker.
