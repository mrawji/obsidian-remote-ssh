import { describe, it, expect, vi } from 'vitest';
import { ReadGate } from '../src/util/ReadGate';

/**
 * What this pins is the failure it was written for (#513): indexing a
 * 50,000-note vault burst hard enough to take the SSH session down, and the
 * ~9,000 reads that landed while it was reconnecting failed outright — each
 * one a note Obsidian then had no metadata for.
 */

/** Let every already-queued microtask run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** A deferred, so a test can decide when an in-flight read finishes. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('ReadGate', () => {
  it('runs a read and returns its value', async () => {
    const gate = new ReadGate();
    await expect(gate.run(() => Promise.resolve('ok'), () => false)).resolves.toBe('ok');
    expect(gate.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  it('never has more than maxInFlight reads on the wire at once', async () => {
    const gate = new ReadGate({ maxInFlight: 2 });
    const blockers = [deferred(), deferred(), deferred()];
    let started = 0;
    let peak = 0;

    const runs = blockers.map((b) => gate.run(async () => {
      started++;
      peak = Math.max(peak, gate.stats().inFlight);
      await b.promise;
    }, () => false));

    await settle();
    expect(started, 'the third read waits for a slot').toBe(2);

    blockers[0].resolve();
    await settle();
    expect(started, 'and starts as soon as one frees up').toBe(3);

    blockers[1].resolve();
    blockers[2].resolve();
    await Promise.all(runs);
    expect(peak).toBeLessThanOrEqual(2);
    expect(gate.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  it('holds a read while the session reconnects, then runs it', async () => {
    let reconnecting = true;
    const sleep = vi.fn(async () => { reconnecting = false; });
    const gate = new ReadGate({ sleep });
    const fn = vi.fn(async () => 'late');

    const result = await gate.run(fn, () => reconnecting);

    expect(sleep, 'it waited rather than failing').toHaveBeenCalled();
    expect(result).toBe('late');
  });

  it('gives up waiting once the budget is spent, and still runs the read', async () => {
    // A session that never comes back must fail through the caller's own
    // reconnecting check, not hang here forever.
    let clock = 0;
    const gate = new ReadGate({
      reconnectWaitMs: 500,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    const fn = vi.fn(async () => 'ran anyway');

    await expect(gate.run(fn, () => true)).resolves.toBe('ran anyway');
    expect(clock, 'waited its budget and no longer').toBeGreaterThanOrEqual(500);
    expect(clock).toBeLessThan(1_000);
  });

  it('frees the slot when a read throws', async () => {
    const gate = new ReadGate({ maxInFlight: 1 });
    await expect(gate.run(() => Promise.reject(new Error('boom')), () => false))
      .rejects.toThrow('boom');
    expect(gate.stats()).toEqual({ inFlight: 0, queued: 0 });
    await expect(gate.run(() => Promise.resolve(1), () => false)).resolves.toBe(1);
  });

  it('serves queued reads in the order they arrived', async () => {
    const gate = new ReadGate({ maxInFlight: 1 });
    const order: number[] = [];
    const first = deferred();

    const a = gate.run(async () => { order.push(1); await first.promise; }, () => false);
    const b = gate.run(async () => { order.push(2); }, () => false);
    const c = gate.run(async () => { order.push(3); }, () => false);

    await settle();
    first.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
  });
});
