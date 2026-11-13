/**
 * Daily limits on model calls, so a shared passphrase cannot run up the bill.
 * One Durable Object instance holds today's counts; it is strongly consistent,
 * so two calls at once cannot both take the last one.
 */

export interface DailyLimits {
  perVisitor: number;
  total: number;
}

export const DEFAULT_DAILY_LIMITS: DailyLimits = { perVisitor: 50, total: 200 };

/** Today's counts. Visitors are keyed by a hash of their address and the day, not the address. */
export interface BudgetState {
  day: string;
  total: number;
  visitors: Record<string, number>;
}

export type BudgetVerdict = { ok: true } | { ok: false; limit: "visitor" | "total" };

export interface BudgetRequest {
  day: string;
  visitor: string;
  limits: DailyLimits;
}

/** Counts one call against today's limits. A new day starts from zero. */
export function spend(current: BudgetState | undefined, { day, visitor, limits }: BudgetRequest): { state: BudgetState; verdict: BudgetVerdict } {
  const state: BudgetState = current?.day === day ? current : { day, total: 0, visitors: {} };
  const used = state.visitors[visitor] ?? 0;
  if (state.total >= limits.total) return { state, verdict: { ok: false, limit: "total" } };
  if (used >= limits.perVisitor) return { state, verdict: { ok: false, limit: "visitor" } };
  return { state: { day, total: state.total + 1, visitors: { ...state.visitors, [visitor]: used + 1 } }, verdict: { ok: true } };
}

/** Gives back a call that never reached a paid model. Only today's counts change, and never below zero. */
export function refund(current: BudgetState | undefined, { day, visitor }: Pick<BudgetRequest, "day" | "visitor">): BudgetState | undefined {
  if (current?.day !== day) return current;
  const used = current.visitors[visitor] ?? 0;
  return { day, total: Math.max(0, current.total - 1), visitors: { ...current.visitors, [visitor]: Math.max(0, used - 1) } };
}

/** Reads a positive whole number from a dashboard variable, or uses the default. */
function limitFrom(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function dailyLimits(env: { DAILY_LIMIT_PER_VISITOR?: string; DAILY_LIMIT_TOTAL?: string }): DailyLimits {
  return {
    perVisitor: limitFrom(env.DAILY_LIMIT_PER_VISITOR, DEFAULT_DAILY_LIMITS.perVisitor),
    total: limitFrom(env.DAILY_LIMIT_TOTAL, DEFAULT_DAILY_LIMITS.total),
  };
}

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * The address limits apply to. An IPv6 client usually controls a whole /64 and can
 * pick a new address for every request, so IPv6 is counted per /64.
 */
export function visitorAddress(address: string): string {
  if (!address.includes(":")) return address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1]!;
  const [head = "", tail] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** A short one-way key for a visitor on one day. It changes daily, so days cannot be linked. */
export async function visitorKey(address: string, day: string): Promise<string> {
  const digest = await sha256(`bf-migrate:${day}:${address}`);
  return [...digest.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** The Durable Object. POST /take counts a call; POST /refund gives one back. */
export class DailyBudget {
  constructor(private readonly state: { storage: StorageLike }) {}

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as BudgetRequest;
    const current = await this.state.storage.get<BudgetState>("state");
    if (new URL(request.url).pathname === "/refund") {
      const next = refund(current, body);
      if (next !== current) await this.state.storage.put("state", next);
      return Response.json({ ok: true });
    }
    const { state, verdict } = spend(current, body);
    if (verdict.ok) await this.state.storage.put("state", state);
    return Response.json(verdict);
  }
}

/** The part of a Durable Object namespace binding this Worker uses. */
export interface BudgetNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

async function callBudget(namespace: BudgetNamespace, action: "take" | "refund", request: BudgetRequest): Promise<unknown> {
  const stub = namespace.get(namespace.idFromName("daily"));
  const response = await stub.fetch(new Request(`https://budget.internal/${action}`, { method: "POST", body: JSON.stringify(request) }));
  if (!response.ok) throw new Error(`The daily budget answered HTTP ${response.status}.`);
  return response.json();
}

export async function takeFromBudget(namespace: BudgetNamespace, request: BudgetRequest): Promise<BudgetVerdict> {
  return (await callBudget(namespace, "take", request)) as BudgetVerdict;
}

export async function refundToBudget(namespace: BudgetNamespace, request: BudgetRequest): Promise<void> {
  await callBudget(namespace, "refund", request);
}
