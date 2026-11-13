import type { TimeSource } from "../swd/time.js";

/**
 * A clock that only moves when something sleeps on it. Share one instance between a
 * simulator and the session under test: a 60 s flash timeout then passes instantly,
 * while BSY durations and reset-button delays still happen in the right order.
 */
export class VirtualTime implements TimeSource {
  private ms = 0;

  now(): number {
    return this.ms;
  }

  async sleep(ms: number): Promise<void> {
    this.ms += Math.max(0, ms);
    await Promise.resolve();
  }

  /** Moves the clock forward without sleeping. */
  advance(ms: number): void {
    this.ms += Math.max(0, ms);
  }
}
