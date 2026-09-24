/**
 * A read that lands while the SSH session is reconnecting waits for it,
 * instead of failing (#513).
 *
 * ## What this is for
 *
 * While `SftpDataAdapter` is reconnecting, a read that misses the cache
 * throws "reconnecting — try again once the connection is back". Obsidian's
 * metadata indexer does not try again: the note simply has no metadata, and
 * nothing tells the user. On a 50,000-note vault (`e2e/scale.spec.ts`, run
 * 35856332799) that was **9,756 reads** lost to a single reconnect.
 *
 * Waiting costs the indexer time; failing costs it the note. The wait is
 * bounded, so a session that never comes back still fails rather than
 * hanging forever — the caller's own reconnecting check decides that, which
 * is why this returns normally either way.
 *
 * ## What this deliberately does NOT do
 *
 * An earlier version also capped how many reads could be in flight, on the
 * theory that indexing a large vault burst hard enough to take the session
 * down. Measurement said otherwise. Both surviving figures are reproducible
 * from `tests/integration/cache-overflow.test.ts` (40 ms link, 720 reads):
 *
 *     sequential           226.5 ms/read
 *     all at once            2.2 ms/read    <- no failures, session alive
 *
 * The cap itself was measured at 28.1 ms/read before being removed; that
 * scenario no longer exists in the test, so take the number as history
 * rather than something you can re-run.
 *
 * Nothing failed in any of the three, so the cap protected against nothing
 * measurable — and it cost an order of magnitude if the read path ever does
 * go parallel. Obsidian's indexer is sequential today (`inflightMax: 1`), so
 * the cap would not even engage. If a prefetcher lands later it can carry
 * its own bound, chosen against numbers rather than fear.
 */

export interface ReconnectWaitOptions {
  /** How long a read may wait for the session before giving up. */
  timeoutMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

export class ReconnectWait {
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ReconnectWaitOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Block while `isReconnecting()` holds, up to the budget. Returns as soon
   * as the session is back — and also when the budget runs out, because what
   * to do about a session that never returns belongs to the caller, not here.
   *
   * `isReconnecting` is polled rather than subscribed to so this object has
   * no lifecycle of its own: the adapter owns the flag, and one of these that
   * outlives a session simply sees `false`.
   */
  async wait(isReconnecting: () => boolean): Promise<void> {
    if (!isReconnecting()) return;
    const deadline = this.now() + this.timeoutMs;
    while (isReconnecting() && this.now() < deadline) {
      await this.sleep(POLL_MS);
    }
  }
}
