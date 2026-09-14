const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 10;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface Entry {
  count: number;
  windowStart: number;
}

/** In-memory fixed-window failure limiter. Restart clears it — acceptable for
 *  a private app (documented in .env.example). */
export class RateLimiter {
  private entries = new Map<string, Entry>();
  private lastSweep = Date.now();

  constructor(
    private maxFailures = DEFAULT_MAX_FAILURES,
    private windowMs = DEFAULT_WINDOW_MS,
  ) {}

  /** True when the key has exceeded the failure budget in the current window. */
  isBlocked(key: string): boolean {
    this.sweep();
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (Date.now() - entry.windowStart >= this.windowMs) {
      this.entries.delete(key);
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  recordFailure(key: string): void {
    this.sweep();
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.entries.set(key, { count: 1, windowStart: now });
    } else {
      entry.count += 1;
    }
  }

  /** Ms remaining until the key's window resets (for Retry-After). */
  retryAfterMs(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    const elapsed = Date.now() - entry.windowStart;
    return Math.max(0, this.windowMs - elapsed);
  }

  private sweep(): void {
    if (Date.now() - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = Date.now();
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart >= this.windowMs) this.entries.delete(key);
    }
  }
}