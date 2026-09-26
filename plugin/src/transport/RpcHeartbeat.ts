import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';
import type { RpcClient } from './RpcClient';

/**
 * Notices a daemon that has stopped answering without the wire going down.
 *
 * Not a per-call timeout: `fs.readBinary` and `fs.writeBinary` carry the whole
 * file in one call, so a large transfer is legitimately a long call, and a
 * budget generous enough for it is useless as a budget. This asks whether the
 * daemon is there at all instead.
 *
 * A probe goes out only when nothing is happening, because the daemon serves
 * one request at a time per connection
 * (`server/internal/server/server.go`) — a probe sent mid-call queues behind
 * that work and then times out on our own account, which would tear down a
 * session that is working. Deciding what "nothing is happening" means is the
 * whole job; see {@link RpcHeartbeat.isMakingProgress}.
 */

/** What the heartbeat needs from the client it is watching. */
export type HeartbeatTarget = Pick<
  RpcClient, 'call' | 'msSinceLastByte' | 'outboundBacklogBytes' | 'oldestPending'
>;

export interface RpcHeartbeatOptions {
  /**
   * The client to watch — one object, not a handful of callbacks.
   *
   * The previous shape took `probe`, `msSinceLastMessage` and `pendingCount`
   * separately, which let a caller wire them to different things. A test
   * stubbed `pendingCount` to zero while the probe went to a real client,
   * modelling a client that cannot exist, and an inert heartbeat shipped with
   * a green suite. One connection is now structurally one connection.
   */
  rpc: HeartbeatTarget;
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
  /** How long a silent call keeps its benefit of the doubt. */
  stallGraceMs?: number;

  /** Injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Unhurried on purpose: a false positive tears down a working session. */
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_MISSES = 3;
const DEFAULT_TICK_MS = 10_000;
const DEFAULT_STALL_GRACE_MS = 60_000;

/**
 * Throughput assumed when judging whether a call could plausibly still be
 * running. 8 bytes/ms is 8 KB/s — slower than any link anyone syncs a vault
 * over. Pessimistic on purpose: a false positive tears down a working
 * transfer, while a late detection only delays a reconnect that was going to
 * happen anyway.
 */
const ASSUMED_MIN_BYTES_PER_MS = 8;

export class RpcHeartbeat {
  private readonly idleMs: number;
  private readonly probeTimeoutMs: number;
  private readonly maxMisses: number;
  private readonly tickMs: number;
  private readonly stallGraceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private timer: unknown = null;
  private probing = false;
  private misses = 0;
  private stopped = false;
  /**
   * Previous outbound backlog, so a decrease can be read as progress.
   *
   * Starts at infinity because the first tick has nothing to compare against,
   * and anything still queued that early was handed over moments ago. A socket
   * whose buffer is permanently full therefore gets exactly one tick of
   * benefit of the doubt, not a session's worth.
   */
  private lastBacklog = Number.POSITIVE_INFINITY;

  constructor(private readonly opts: RpcHeartbeatOptions) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.maxMisses = opts.maxMisses ?? DEFAULT_MAX_MISSES;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.stallGraceMs = opts.stallGraceMs ?? DEFAULT_STALL_GRACE_MS;
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

  /**
   * Whether anything is actually happening on this connection.
   *
   * Three signals, in the order they earn their keep:
   *
   *  - **Inbound bytes.** A large read is ONE message arriving over many
   *    chunks, so byte-level traffic is what keeps a working transfer from
   *    being declared dead. Message-level traffic cannot see inside it.
   *  - **A shrinking outbound backlog.** The mirror case: our own upload
   *    draining into the socket, while the daemon stays silent by design for
   *    the whole of a large write.
   *  - **A pending call still inside its grace.** Once an upload is flushed
   *    there is no signal at all while the daemon writes to disk, so a call
   *    gets time in proportion to how much it asked the daemon to swallow.
   *
   * What this deliberately does not do is treat a pending call as proof of
   * life indefinitely. That was the old rule — `pendingCount() > 0` — and it
   * meant one save that never returned reset the miss counter on every tick
   * for the rest of the session, so `maxMisses` was unreachable and the class
   * was inert in exactly the case it exists for.
   */
  private isMakingProgress(): boolean {
    const backlog = this.opts.rpc.outboundBacklogBytes();
    const draining = backlog > 0 && backlog < this.lastBacklog;
    this.lastBacklog = backlog;
    if (draining) return true;

    if (this.opts.rpc.msSinceLastByte() < this.idleMs) return true;

    const oldest = this.opts.rpc.oldestPending();
    if (oldest === null) return false;
    const grace = this.stallGraceMs + oldest.requestBytes / ASSUMED_MIN_BYTES_PER_MS;
    return oldest.ageMs < grace;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    // One probe at a time; a second would queue behind the first.
    if (this.probing) { this.schedule(); return; }

    if (this.isMakingProgress()) {
      this.misses = 0;
      this.schedule();
      return;
    }

    this.probing = true;
    try {
      await this.withTimeout((signal) => this.opts.rpc.call('server.info', {}, signal));
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
          // client's pending map would itself look like a call in progress on
          // the next tick, and used to reset `misses` for the whole session.
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
