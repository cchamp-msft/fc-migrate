import { buildProposalPrompt, MAX_PROPOSAL_REQUEST_BYTES, parseProposals, proposalRequestProblem, type ProposalRequest } from "@bf-migrate/core";
import { dailyLimits, refundToBudget, sha256, takeFromBudget, visitorAddress, visitorKey, type BudgetRequest, type BudgetVerdict } from "./budget.js";
import { availableProviders, ProviderError, type Env } from "./providers.js";

// The Durable Object class must be exported from the Worker's main module.
export { DailyBudget } from "./budget.js";

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((entry) => entry.trim());
  if (!allowed.includes(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", Vary: "Origin" };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** Case and word separators are ignored, so a passphrase said aloud works however it is typed. */
export function normalizePassphrase(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "-");
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const expected = normalizePassphrase(env.PROXY_TOKEN ?? "");
  const header = request.headers.get("Authorization") ?? "";
  if (!expected || !header.startsWith("Bearer ")) return false;
  const [given, wanted] = await Promise.all([sha256(normalizePassphrase(header.slice("Bearer ".length))), sha256(expected)]);
  // Every byte is compared, so the time taken does not reveal how much matched.
  let difference = 0;
  for (let index = 0; index < wanted.length; index++) difference |= given[index]! ^ wanted[index]!;
  return difference === 0;
}

/** Reads at most maxBytes of the body, stopping early instead of buffering a larger one. */
async function readLimited(request: Request, maxBytes: number): Promise<string | undefined> {
  if (Number(request.headers.get("Content-Length") ?? 0) > maxBytes) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function secondsToMidnightUtc(now: Date): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

/** The switch for every model call. Anything but "true" leaves suggestions off. */
function isEnabled(env: Env): boolean {
  return env.LLM_ENABLED?.trim().toLowerCase() === "true";
}

export async function handle(request: Request, env: Env, fetchImpl?: typeof fetch): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  // The site serves this API under /api; scripts may call it without the prefix.
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api(?=\/)/, "");
  // The site's static files fall through to this script when missing; they are not API calls.
  if (!path.startsWith("/v1/")) return json({ error: "Not found." }, 404, cors);

  // Public, so the app can hide the feature without anyone holding a key.
  if (request.method === "GET" && path === "/v1/status") return json({ enabled: isEnabled(env) }, 200, { ...cors, "Cache-Control": "no-store" });

  if (!isEnabled(env)) return json({ error: "AI suggestions are turned off." }, 503, cors);
  // Without its limits the API stays shut, rather than open to unlimited calls.
  if (!env.API_LIMITER || !env.BUDGET) return json({ error: "Usage limits are not configured on the server." }, 503, cors);

  // Before the passphrase check, so the limit also slows anyone guessing it.
  const address = visitorAddress(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const { success } = await env.API_LIMITER.limit({ key: address });
  if (!success) return json({ error: "Too many requests. Wait a minute and try again." }, 429, { ...cors, "Retry-After": "60" });

  if (!(await isAuthorized(request, env))) return json({ error: "Not authorized." }, 401, cors);
  const providers = availableProviders(env, fetchImpl);

  if (request.method === "GET" && path === "/v1/providers") {
    return json({ providers: Object.keys(providers), default: env.DEFAULT_PROVIDER }, 200, cors);
  }

  if (request.method !== "POST" || path !== "/v1/propose") return json({ error: "Not found." }, 404, cors);

  const text = await readLimited(request, MAX_PROPOSAL_REQUEST_BYTES);
  if (text === undefined) return json({ error: "The request is too large." }, 413, cors);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  // Only well-formed Betaflight set lines and setting descriptions reach a model.
  const problem = proposalRequestProblem(body);
  if (problem) return json({ error: problem }, 400, cors);

  const name = url.searchParams.get("provider") ?? env.DEFAULT_PROVIDER ?? "";
  const provider = providers[name];
  if (!provider) return json({ error: `Provider "${name}" is not available.` }, 400, cors);

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const charge: BudgetRequest = { day, visitor: await visitorKey(address, day), limits: dailyLimits(env) };
  let verdict: BudgetVerdict;
  try {
    verdict = await takeFromBudget(env.BUDGET, charge);
  } catch {
    // Unable to count means unable to limit, so no model call.
    return json({ error: "Usage limits are unavailable right now. Try again shortly." }, 503, cors);
  }
  if (!verdict.ok) {
    const who = verdict.limit === "visitor" ? "You have" : "This site has";
    return json({ error: `${who} reached today's limit for AI suggestions. It resets at midnight UTC.` }, 429, { ...cors, "Retry-After": String(secondsToMidnightUtc(now)) });
  }

  try {
    const reply = await provider(buildProposalPrompt(body as ProposalRequest));
    return json({ provider: name, proposals: parseProposals(reply) }, 200, cors);
  } catch (error) {
    if (error instanceof ProviderError) {
      // A call the provider refused before any model ran costs nothing, so it is given back.
      if (!error.charged) await refundToBudget(env.BUDGET, charge).catch(() => undefined);
      return json({ error: error.message }, error.status, cors);
    }
    return json({ error: "The model's reply could not be read." }, 502, cors);
  }
}

export default { fetch: (request: Request, env: Env) => handle(request, env) };
