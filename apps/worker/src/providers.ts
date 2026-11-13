import Anthropic from "@anthropic-ai/sdk";
import { PROPOSAL_RESPONSE_SCHEMA, PROPOSAL_SYSTEM_PROMPT } from "@bf-migrate/core";
import type { BudgetNamespace } from "./budget.js";

export interface Env {
  /** "true" turns model calls on. Set in the Cloudflare dashboard, where deploys keep it. */
  LLM_ENABLED?: string;
  ALLOWED_ORIGINS?: string;
  DEFAULT_PROVIDER?: string;
  /** The passphrase every caller must send. Case and word separators are ignored. */
  PROXY_TOKEN?: string;
  /** Cloudflare rate limiter: calls per visitor per minute, for every route but /status. */
  API_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** Durable Object counting model calls per day. */
  BUDGET?: BudgetNamespace;
  /** Optional dashboard variables overriding the daily limits (whole numbers). */
  DAILY_LIMIT_PER_VISITOR?: string;
  DAILY_LIMIT_TOTAL?: string;
  STRATA_BASE_URL?: string;
  STRATA_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  XAI_API_KEY?: string;
  GROK_MODEL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    /** False when the provider refused the call before a model ran, so nothing was billed. */
    readonly charged = true,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Sends one prompt and returns the model's JSON text. */
export type ProviderCall = (prompt: string) => Promise<string>;

const MAX_OUTPUT_TOKENS = 16_000;

interface OpenAiCompatible {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Strata, Grok and DeepSeek all speak the OpenAI chat format. */
function openAiCompatible(config: OpenAiCompatible, fetchImpl: typeof fetch): ProviderCall {
  return async (prompt) => {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: PROPOSAL_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_schema", json_schema: { name: "proposals", strict: true, schema: PROPOSAL_RESPONSE_SCHEMA } },
      }),
    }).catch(() => {
      // A connection failure never reached a model.
      throw new ProviderError("Could not reach the provider.", 502, false);
    });
    // An error status means the provider refused the call before a model ran.
    if (!response.ok) throw new ProviderError(`Provider returned HTTP ${response.status}`, 502, false);
    const body = (await response.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
    const choice = body.choices?.[0];
    if (!choice?.message?.content) throw new ProviderError(`Provider returned no answer (finish reason: ${choice?.finish_reason ?? "unknown"})`);
    return choice.message.content;
  };
}

function claude(apiKey: string, model: "claude-haiku-5-5" | "claude-sonnet-5-5" | "claude-opus-5-5", effort: "medium" | "high"): ProviderCall {
  const client = new Anthropic({ apiKey });

  return async (prompt) => {
    const request = {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: { type: "adaptive" as const },
      output_config: { effort, format: { type: "json_schema" as const, schema: PROPOSAL_RESPONSE_SCHEMA as unknown as Record<string, unknown> } },
      system: PROPOSAL_SYSTEM_PROMPT,
      messages: [{ role: "user" as const, content: prompt }],
    };

    try {
      // Haiku has no server-side refusal fallback, so it alone uses the plain endpoint.
      const message =
        model === "claude-haiku-5-5"
          ? await client.messages.create(request)
          : await client.beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as Anthropic.Beta.MessageCreateParamsNonStreaming);

      if (message.stop_reason === "refusal") throw new ProviderError("The model declined this request.");
      if (message.stop_reason === "max_tokens") throw new ProviderError("The model ran out of room before finishing.");
      for (const block of message.content) if (block.type === "text") return block.text;
      throw new ProviderError("The model returned no text.");
    } catch (error) {
      // API errors and failed connections come back before a model has run. A timeout
      // may not, but it is rare and cannot be forced by a caller.
      if (error instanceof Anthropic.RateLimitError) throw new ProviderError("Rate limited. Try again shortly.", 429, false);
      if (error instanceof Anthropic.AuthenticationError) throw new ProviderError("The API proxy is misconfigured.", 500, false);
      if (error instanceof Anthropic.APIError) throw new ProviderError(`Claude API error ${error.status ?? "unknown"}.`, 502, false);
      throw error;
    }
  };
}

/** Builds only the providers that are configured, so a missing key simply hides one. */
export function availableProviders(env: Env, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Record<string, ProviderCall> {
  const providers: Record<string, ProviderCall> = {};
  if (env.STRATA_BASE_URL && env.STRATA_API_KEY) providers.strata = openAiCompatible({ baseUrl: env.STRATA_BASE_URL, apiKey: env.STRATA_API_KEY, model: "qwen3.8-flash-next" }, fetchImpl);
  if (env.ANTHROPIC_API_KEY) {
    providers.haiku = claude(env.ANTHROPIC_API_KEY, "claude-haiku-5-5", "medium");
    providers.sonnet = claude(env.ANTHROPIC_API_KEY, "claude-sonnet-5-5", "high");
    providers.opus = claude(env.ANTHROPIC_API_KEY, "claude-opus-5-5", "high");
  }
  if (env.XAI_API_KEY && env.GROK_MODEL) providers.grok = openAiCompatible({ baseUrl: "https://api.x.ai/v1", apiKey: env.XAI_API_KEY, model: env.GROK_MODEL }, fetchImpl);
  if (env.DEEPSEEK_API_KEY && env.DEEPSEEK_MODEL) providers.deepseek = openAiCompatible({ baseUrl: "https://api.deepseek.com/v1", apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL }, fetchImpl);
  return providers;
}
