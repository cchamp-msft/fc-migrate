/**
 * Where the SWD and flash code gets the time from. Polling loops (flash BSY, the
 * hold-reset halt) use this so tests and the simulator can run on a virtual clock.
 * Per-transfer USB timeouts deliberately use real timers instead.
 */
export interface TimeSource {
  /** Milliseconds since an arbitrary origin. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Wall-clock time: `Date.now()` and `setTimeout`. */
export const realTime: TimeSource = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/** Poll intervals grow so quick operations finish fast and long ones do not flood the probe. */
const POLL_STEPS_MS = [0, 1, 2, 5, 10, 20, 50];

/**
 * Calls `read` until `done` accepts its value, or `timeoutMs` passes.
 * Resolves with the accepted value, or with undefined on timeout so the caller can
 * report the failure in its own terms. The first read happens without a delay.
 */
export async function pollUntil<T>(
  time: TimeSource,
  timeoutMs: number,
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T | undefined> {
  const started = time.now();
  for (let attempt = 0; ; attempt++) {
    const value = await read();
    if (done(value)) return value;
    if (time.now() - started >= timeoutMs) return undefined;
    await time.sleep(POLL_STEPS_MS[Math.min(attempt, POLL_STEPS_MS.length - 1)]!);
  }
}
