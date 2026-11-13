import type { Proposal, ProposalRequest } from "@bf-migrate/core";
import { defineStore } from "pinia";
import { ref } from "vue";

const KEY_STORAGE = "bfm.accessKey";
/** Same origin as the site, so a Cloudflare Access policy on /api/* covers it. */
const API = "/api/v1";

export class AssistantError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AssistantError";
  }
}

export interface ProposalReply {
  provider: string;
  proposals: Proposal[];
}

function loadKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function errorFor(status: number, body: unknown): AssistantError {
  const message = (body as { error?: unknown } | undefined)?.error;
  if (status === 401) return new AssistantError("The passphrase was not accepted.", status);
  if (status === 503 && message === "AI suggestions are turned off.") return new AssistantError("AI suggestions are turned off on the server.", status);
  // The server says which limit was reached: per minute, per day, or the model's own.
  if (status === 429 && typeof message !== "string") return new AssistantError("Too many requests. Try again in a minute.", status);
  return new AssistantError(typeof message === "string" ? message : `The suggestion service returned HTTP ${status}.`, status);
}

/** AI suggestions for lines a migration cannot carry. The server decides whether they exist. */
export const useAssistantStore = defineStore("assistant", () => {
  const enabled = ref(false);
  const accessKey = ref(loadKey());
  let statusRequest: Promise<void> | undefined;

  /** Asks the server whether suggestions are switched on. Fails closed. */
  function checkStatus(): Promise<void> {
    statusRequest ??= (async () => {
      try {
        const response = await fetch(`${API}/status`, { cache: "no-store" });
        const body = response.ok ? ((await response.json()) as { enabled?: unknown }) : undefined;
        enabled.value = body?.enabled === true;
      } catch {
        enabled.value = false;
      } finally {
        statusRequest = undefined;
      }
    })();
    return statusRequest;
  }

  function setAccessKey(key: string): void {
    accessKey.value = key.trim();
    try {
      if (accessKey.value) localStorage.setItem(KEY_STORAGE, accessKey.value);
      else localStorage.removeItem(KEY_STORAGE);
    } catch {
      // The key lasts for this visit when storage is unavailable.
    }
  }

  async function propose(request: ProposalRequest): Promise<ProposalReply> {
    const response = await fetch(`${API}/propose`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessKey.value}` },
      body: JSON.stringify(request),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      if (response.status === 401) setAccessKey("");
      if (response.status === 503) enabled.value = false;
      throw errorFor(response.status, body);
    }
    const reply = body as Partial<ProposalReply> | undefined;
    if (!Array.isArray(reply?.proposals)) throw new AssistantError("The suggestion service sent a reply that could not be read.", 502);
    return { provider: String(reply.provider ?? ""), proposals: reply.proposals };
  }

  return { enabled, accessKey, checkStatus, setAccessKey, propose };
});
