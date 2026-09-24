import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/**
 * Notices a daemon that has stopped answering without the wire going down.
 *
 * ## Why this is not a per-call timeout
 *
 * The obvious fix for "a call that never returns" is a deadline on every
 * call. It is the wrong one here: a `vault.readBinary` of a large note over
 * a slow link is legitimately slow, and any deadline generous enough to
 * survive that is too generous to be useful. Worse, the failure it would
 * introduce — a working transfer cancelled at an arbitrary size — is more
 * damaging than the one it fixes.
 *
 * So this asks a different question. Not "is this call taking too long" but
 * "is the daemon still there at all", which a cheap round trip answers
 * without putting a clock on anyone's transfer.
 *
 * ## Why it waits for silence AND an idle line
 *
 * The daemon serves one request at a time per connection
 * (`server/internal/server/server.go` is a plain read-dispatch-write loop,
 * no goroutine per request). A probe sent while a call is outstanding does
 * not overtake it — it queues, and then times out for reasons that have
 * nothing to do with the daemon's health.
 *
 * That matters most for a large write, where the daemon is busy and silent
 * by design: it is taking bytes and has nothing to say until it is done.
 * Probing then would declare a perfectly healthy transfer dead.
 *
 * So a probe goes out only when the line has been quiet AND nothing is
 * waiting on it. What that buys is the common case — the laptop that slept,
 * the daemon the OOM killer took, the box that rebooted — where the plugin
 * used to sit believing it was still connected.
 *
 * ## What it deliberately does not catch
 *
 * A daemon wedged *mid-call* holds the line, so no probe is sent and this
 * says nothing. Catching that needs a deadline on the call itself, at the
 * cost above. If it ever becomes a real complaint, the answer is a progress
 * signal from the daemon, not a stopwatch on this side.
 */

export interface RpcHeartbeatOptions {
  /** Round trip used as the probe. Cheap and side-effect free. */
  probe: () => Promise<unknown>;
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

/**
 * Deliberately unhurried. This exists to catch a daemon that is gone, not
 * to measure latency: noticing 90 seconds late costs a stale status bar,
 * while a false positive tears down a working session.
 */
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
    // `window.` deliberately: Obsidian tears down a popout window's timers
    // with the window, and a bare `setTimeout` would outlive it.
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

    // Someone is waiting on the line, or it has spoken recently. Either way
    // the daemon is demonstrably there, and a probe would only queue.
    if (this.probing
      || this.opts.pendingCount() > 0
      || this.opts.msSinceLastMessage() < this.idleMs) {
      this.misses = 0;
      this.schedule();
      return;
    }

    this.probing = true;
    try {
      await this.withTimeout(this.opts.probe());
      this.misses = 0;
    } catch (e) {
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

  private withTimeout(p: Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const handle = this.setTimer(
        () => reject(new Error(`probe timed out after ${this.probeTimeoutMs}ms`)),
        this.probeTimeoutMs,
      );
      p.then(
        (v) => { this.clearTimer(handle); resolve(v); },
        (e) => { this.clearTimer(handle); reject(e instanceof Error ? e : new Error(String(e))); },
      );
    });
  }
}
