import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/**
 * Notices a daemon that has stopped answering without the wire going down.
 *
 * Not a per-call timeout: a large `readBinary` over a slow link is
 * legitimately slow, and a budget generous enough for it is useless as a
 * budget. This asks whether the daemon is there at all instead.
 *
 * A probe goes out only when the line is quiet AND nothing is waiting on
 * it. The daemon serves one request at a time per connection
 * (`server/internal/server/server.go`), so a probe sent mid-call queues and
 * then times out on our own account — which would fire during a large
 * write, where the daemon is busy and silent by design.
 *
 * Does NOT catch a daemon wedged mid-call: it holds the line, so no probe
 * is sent. That needs a deadline on the call, at the cost above.
 */

export interface RpcHeartbeatOptions {
  /**
   * Round trip used as the probe. Cheap and side-effect free.
   *
   * Takes a signal because giving up on the promise is not the same as
   * giving up on the call; see `RpcClient.call`.
   */
  probe: (signal: AbortSignal) => Promise<unknown>;
  /** How long the line has been quiet. */
  msSinceLastMessage: () => number;
  /** How many calls are waiting; a probe only goes out at zero. */
  pendingCount: () => number;
  /** Called once, when the daemon has failed to answer often enough. */
  onDead: (reason: Error) => void;

  /** Silence after which a probe is sent. */
  idleMs?: number;
  /** How long a probe may take before it counts as a miss. */
  probeTimeoutMs?: number;
  /** Consecutive misses before the daemon is declared gone. */
  maxMisses?: number;
  /** How often to consider probing. */
  tickMs?: number;

  /** Injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Unhurried on purpose: a false positive tears down a working session. */
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_MISSES = 3;
const DEFAULT_TICK_MS = 10_000;

export class RpcHeartbeat {
  private readonly idleMs: number;
  private readonly probeTimeoutMs: number;
  private readonly maxMisses: number;
  private readonly tickMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private timer: unknown = null;
  private probing = false;
  private misses = 0;
  private stopped = false;

  constructor(private readonly opts: RpcHeartbeatOptions) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.maxMisses = opts.maxMisses ?? DEFAULT_MAX_MISSES;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    // `window.` so a popout window's teardown takes these with it.
    this.setTimer = opts.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => { window.clearTimeout(h as number); });
  }

  start(): void {
    if (this.timer !== null || this.stopped) return;
    this.schedule();
  }

  /** Idempotent, and final: a stopped heartbeat cannot be restarted. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, this.tickMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    // Busy or recently heard from: demonstrably alive, and a probe would queue.
    if (this.probing
      || this.opts.pendingCount() > 0
      || this.opts.msSinceLastMessage() < this.idleMs) {
      this.misses = 0;
      this.schedule();
      return;
    }

    this.probing = true;
    try {
      await this.withTimeout((signal) => this.opts.probe(signal));
      this.misses = 0;
    } catch (e) {
      // Retired while this probe was in flight. The connection it belonged to
      // is already being torn down, and reporting it dead here would start a
      // reconnect for a wire nobody owns.
      if (this.stopped) return;
      this.misses++;
      logger.warn(
        `RpcHeartbeat: daemon did not answer (${this.misses}/${this.maxMisses}): ${errorMessage(e)}`,
      );
      if (this.misses >= this.maxMisses) {
        this.probing = false;
        this.stop();
        this.opts.onDead(new Error(
          `daemon stopped answering (${this.maxMisses} probes unanswered)`,
        ));
        return;
      }
    } finally {
      this.probing = false;
    }
    this.schedule();
  }

  private withTimeout(send: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    const abandon = new AbortController();
    return new Promise((resolve, reject) => {
      const handle = this.setTimer(
        () => {
          // Abandon the call, not just our wait on it: a probe left in the
          // client's pending map counts as a live line on the next tick, and
          // the guard in `tick()` would reset `misses` for the rest of the
          // session — so `maxMisses` was unreachable and `onDead` never fired
          // in the one case this class exists for.
          abandon.abort();
          reject(new Error(`probe timed out after ${this.probeTimeoutMs}ms`));
        },
        this.probeTimeoutMs,
      );
      send(abandon.signal).then(
        (v) => { this.clearTimer(handle); resolve(v); },
        (e) => { this.clearTimer(handle); reject(e instanceof Error ? e : new Error(String(e))); },
      );
    });
  }
}
