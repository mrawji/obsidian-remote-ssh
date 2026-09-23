/**
 * A bound on how many reads are in flight against the remote at once, and a
 * place for them to wait while the session is reconnecting.
 *
 * ## Why a large vault needs this
 *
 * Measured on a 50,000-note vault (`e2e/scale.spec.ts`, run 35856332799):
 * Obsidian's own indexing reads every note, the 64 MiB `ReadCache` cannot hold
 * a 5 GB vault, and the evicted entries are fetched again. That alone is
 * wasteful; what makes it fatal is that the resulting burst takes the SSH
 * session down. The run shows `evictions: 2,625` at 171 s, the session in
 * `reconnecting` by 370 s, **9,756 reads failed** with "reconnecting — try
 * again once the connection is back", and the renderer wedged for good at
 * 698 s. Every one of those failures is a note Obsidian then has no metadata
 * for.
 *
 * Two rules fix the shape of that:
 *
 *  - **At most `maxInFlight` reads at once.** The work is the same; it stops
 *    arriving as a burst the transport cannot survive.
 *  - **A read that arrives while reconnecting waits** instead of failing.
 *    Obsidian's indexer is sequential, so waiting costs it time, while an
 *    error costs it the note. The wait is bounded, so a session that never
 *    comes back still fails rather than hanging forever.
 */

export interface ReadGateOptions {
  /** Reads allowed to be in flight at once. */
  maxInFlight?: number;
  /** How long a read may wait for a reconnect before giving up. */
  reconnectWaitMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_IN_FLIGHT = 8;
const DEFAULT_RECONNECT_WAIT_MS = 30_000;
const RECONNECT_POLL_MS = 100;

export class ReadGate {
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly maxInFlight: number;
  private readonly reconnectWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ReadGateOptions = {}) {
    this.maxInFlight = Math.max(1, opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
    this.reconnectWaitMs = opts.reconnectWaitMs ?? DEFAULT_RECONNECT_WAIT_MS;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Reads in flight right now, and reads queued behind the limit. */
  stats(): { inFlight: number; queued: number } {
    return { inFlight: this.inFlight, queued: this.waiting.length };
  }

  /**
   * Run `fn` under the limit. `isReconnecting` is polled rather than
   * subscribed to so the gate has no lifecycle of its own: the adapter owns
   * the flag, and a gate that outlives a session simply sees `false`.
   */
  async run<T>(fn: () => Promise<T>, isReconnecting: () => boolean): Promise<T> {
    await this.waitForSlot();
    try {
      await this.waitForConnection(isReconnecting);
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Wait while the session is reconnecting, up to the budget. Returns
   * normally when connected; the caller's own reconnecting check then decides
   * what to do if it is still down.
   */
  private async waitForConnection(isReconnecting: () => boolean): Promise<void> {
    if (!isReconnecting()) return;
    const deadline = this.now() + this.reconnectWaitMs;
    while (isReconnecting() && this.now() < deadline) {
      await this.sleep(RECONNECT_POLL_MS);
    }
  }

  private waitForSlot(): Promise<void> {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  private release(): void {
    this.inFlight--;
    const next = this.waiting.shift();
    if (next) next();
  }
}
