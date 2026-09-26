import { describe, it, expect, vi } from 'vitest';
import { RpcHeartbeat, type RpcHeartbeatOptions } from '../src/transport/RpcHeartbeat';
import { RpcClient } from '../src/transport/RpcClient';
import { FakeFramed } from './helpers/fakeFramed';

/**
 * What this pins is the pair of failures on either side of the heartbeat.
 *
 * Miss the dead daemon and the plugin sits there believing it is connected —
 * the bug this exists for, and one it could not actually catch for a release,
 * because any outstanding call counted as proof of life and so a save that
 * would never return reset the miss counter on every tick forever.
 *
 * Declare a *working* daemon dead and a large transfer is torn down
 * mid-flight, which is worse. `fs.readBinary` and `fs.writeBinary` carry the
 * whole file in one call, so "this call has taken minutes" is normal, and most
 * of these cases are about staying quiet when it should.
 *
 * Timers are injected, so nothing here waits on real time.
 */

/** A hand-cranked scheduler: nothing fires until `run()` is called. */
function fakeTimers() {
  let next = 1;
  const queued = new Map<number, () => void>();
  const delays: number[] = [];
  return {
    /**
     * Every `ms` asked for, in order. Recorded because the parameter used not
     * even to be declared here, so `probeTimeoutMs` and `tickMs` were inputs
     * no test could observe, and either could be 0 with the suite green.
     */
    delays,
    setTimer: (fn: () => void, ms: number) => {
      delays.push(ms);
      const id = next++; queued.set(id, fn); return id;
    },
    clearTimer: (h: unknown) => { queued.delete(h as number); },
    /** Fire everything currently queued, then let microtasks settle. */
    async run(times = 1) {
      for (let i = 0; i < times; i++) {
        for (const [id, fn] of [...queued]) { queued.delete(id); fn(); }
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    get size() { return queued.size; },
  };
}

interface Progress {
  call: ReturnType<typeof vi.fn>;
  msSinceLastByte: () => number;
  outboundBacklogBytes: () => number;
  oldestPending: () => { ageMs: number; requestBytes: number } | null;
}

/** A client that is, by default, silent and idle — so a probe is due. */
function fakeRpc(over: Partial<Progress> = {}): Progress {
  return {
    call: over.call ?? vi.fn().mockResolvedValue({ ok: true }),
    msSinceLastByte: over.msSinceLastByte ?? (() => 60_000),
    outboundBacklogBytes: over.outboundBacklogBytes ?? (() => 0),
    oldestPending: over.oldestPending ?? (() => null),
  };
}

function make(overrides: Partial<RpcHeartbeatOptions> & { rpc?: Progress } = {}) {
  const timers = fakeTimers();
  const rpc = overrides.rpc ?? fakeRpc();
  const onDead = overrides.onDead ?? vi.fn();
  const hb = new RpcHeartbeat({
    idleMs: 30_000,
    maxMisses: 2,
    ...overrides,
    rpc: rpc as unknown as RpcHeartbeatOptions['rpc'],
    onDead,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { hb, timers, rpc, onDead: onDead as ReturnType<typeof vi.fn> };
}

describe('RpcHeartbeat', () => {
  it('asks the daemon whether it is there once nothing is happening', async () => {
    const { hb, timers, rpc } = make();
    hb.start();
    await timers.run();

    expect(rpc.call).toHaveBeenCalledWith('server.info', {}, expect.any(AbortSignal));
  });

  it('says nothing while bytes are still arriving', async () => {
    // A large read is ONE message over many chunks. Judging by messages cannot
    // see inside it, and would tear down a transfer that is working.
    const { hb, timers, rpc, onDead } = make({
      rpc: fakeRpc({
        msSinceLastByte: () => 500,
        oldestPending: () => ({ ageMs: 10 * 60_000, requestBytes: 90 }),
      }),
    });
    hb.start();
    await timers.run(6);

    expect(rpc.call, 'traffic is traffic; do not probe').not.toHaveBeenCalled();
    expect(onDead).not.toHaveBeenCalled();
  });

  it('says nothing while our own upload is draining', async () => {
    // The mirror case: we are still handing a big write to the socket, and the
    // daemon is silent by design for the whole of it.
    let backlog = 1_000_000;
    const { hb, timers, rpc, onDead } = make({
      rpc: fakeRpc({
        msSinceLastByte: () => 10 * 60_000,
        outboundBacklogBytes: () => (backlog = Math.max(1, backlog - 100_000)),
        oldestPending: () => ({ ageMs: 10 * 60_000, requestBytes: 0 }),
      }),
    });
    hb.start();
    await timers.run(6);

    expect(rpc.call, 'a draining socket is progress').not.toHaveBeenCalled();
    expect(onDead).not.toHaveBeenCalled();
  });

  it('gives a big write time to be served once the upload has flushed', async () => {
    // 10 MB handed over and flushed: nothing inbound, no backlog left, and the
    // daemon quiet while it writes to disk. Age alone would call that dead.
    const { hb, timers, rpc, onDead } = make({
      rpc: fakeRpc({
        msSinceLastByte: () => 5 * 60_000,
        oldestPending: () => ({ ageMs: 4 * 60_000, requestBytes: 10_000_000 }),
      }),
      stallGraceMs: 60_000,
    });
    hb.start();
    await timers.run(8);

    // Asserting only that it was not declared dead would pass without the
    // size allowance too, because a probe that goes out and is answered also
    // leaves `onDead` alone. What has to hold is that no probe went out: the
    // daemon is busy with the write, and a probe would queue behind it.
    expect(rpc.call, 'a 10 MB write may legitimately still be running').not.toHaveBeenCalled();
    expect(onDead).not.toHaveBeenCalled();
  });

  it('declares the daemon dead when a small call has been stuck past its grace', async () => {
    // The case this class exists for, and the one it could not reach: a save
    // that will never return. Counting pending calls as proof of life reset the
    // miss counter on every tick for the rest of the session, while the status
    // bar said Connected and the edit was in neither the remote nor the queue.
    const { hb, timers, onDead } = make({
      rpc: fakeRpc({
        call: vi.fn(() => new Promise(() => { /* wedged, like the save */ })),
        msSinceLastByte: () => 10 * 60_000,
        oldestPending: () => ({ ageMs: 5 * 60_000, requestBytes: 120 }),
      }),
      stallGraceMs: 60_000,
      probeTimeoutMs: 15_000,
    });
    hb.start();
    await timers.run(8);

    expect(onDead, 'a stuck call is the symptom, not the proof').toHaveBeenCalledTimes(1);
  });

  it('declares the daemon gone only after repeated silence', async () => {
    const { hb, timers, onDead } = make({
      rpc: fakeRpc({ call: vi.fn().mockRejectedValue(new Error('no answer')) }),
      maxMisses: 2,
    });
    hb.start();
    await timers.run(1);
    expect(onDead, 'one miss is not a verdict').not.toHaveBeenCalled();
    await timers.run(3);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it('forgives a miss when the daemon answers again', async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(new Error('no answer'))
      .mockResolvedValue({ ok: true });
    const { hb, timers, onDead } = make({ rpc: fakeRpc({ call }), maxMisses: 2 });
    hb.start();
    await timers.run(6);

    expect(onDead, 'a single lost packet must not end a session').not.toHaveBeenCalled();
  });

  it('counts a probe that never answers as a miss', async () => {
    const { hb, timers, onDead } = make({
      rpc: fakeRpc({ call: vi.fn(() => new Promise(() => { /* never settles */ })) }),
      probeTimeoutMs: 15_000,
    });
    hb.start();
    await timers.run(6);

    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it('stops for good, and reports the daemon gone only once', async () => {
    const { hb, timers, onDead } = make({
      rpc: fakeRpc({ call: vi.fn().mockRejectedValue(new Error('no answer')) }),
      maxMisses: 2,
    });
    hb.start();
    await timers.run(8);

    expect(onDead).toHaveBeenCalledTimes(1);
    expect(timers.size, 'nothing left scheduled after the verdict').toBe(0);
  });

  it('stop() leaves nothing scheduled', async () => {
    const { hb, timers, rpc } = make();
    hb.start();
    hb.stop();
    await timers.run(3);

    expect(rpc.call).not.toHaveBeenCalled();
    expect(timers.size).toBe(0);
  });

  it('schedules on the intervals it documents', async () => {
    // Nothing pinned these. Both delays could be 0 — a probe every turn of the
    // event loop, each abandoned before it could be answered — suite green.
    const { hb, timers } = make({
      rpc: fakeRpc({ call: vi.fn(() => new Promise(() => { /* hangs */ })) }),
    });

    hb.start();
    expect(timers.delays, 'the tick comes first').toEqual([10_000]);

    await timers.run();
    expect(timers.delays, 'then the probe deadline').toEqual([10_000, 15_000]);
  });

  it('says nothing once it has been retired mid-probe', async () => {
    // `stop()` is documented as final, and `disconnectTransport` /
    // `reconnectAttempt` both call it with a probe possibly in flight. The
    // stopped check was only at the top of `tick()`, so a probe that failed
    // after the heartbeat was retired still counted its miss — and on the last
    // one, reported a dead daemon for a wire nobody owned, restarting a
    // reconnect on a session that had just recovered.
    const { hb, timers, onDead } = make({
      rpc: fakeRpc({ call: vi.fn(() => new Promise(() => { /* never settles */ })) }),
      maxMisses: 2,
      probeTimeoutMs: 15_000,
    });

    hb.start();
    await timers.run(2);   // first probe times out: one miss, one to go
    await timers.run(1);   // second probe goes out and is still in flight
    hb.stop();
    await timers.run(1);   // ...and only now does it fail

    expect(onDead, 'a retired heartbeat has no session to report on')
      .not.toHaveBeenCalled();
  });
});

describe('RpcHeartbeat, against a real RpcClient', () => {
  // Every case above hands over a fake, and that is what let the original bug
  // ship: a stub said the line was idle where a real client would not have, so
  // the suite pinned behaviour that could not occur. These wire the real thing
  // up and let the daemon go silent.

  it('declares a silent daemon dead, and leaves no probe behind', async () => {
    const framed = new FakeFramed();
    const client = new RpcClient(framed.asFramed());
    framed.silentFor(10 * 60_000);
    const timers = fakeTimers();
    const onDead = vi.fn();
    const hb = new RpcHeartbeat({
      rpc: client,
      onDead,
      idleMs: 30_000,
      maxMisses: 2,
      probeTimeoutMs: 15_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    hb.start();
    await timers.run(8);

    expect(framed.sent.length, 'a second probe is needed for a second miss')
      .toBeGreaterThanOrEqual(2);
    expect(onDead, 'a daemon that never answers is dead').toHaveBeenCalledTimes(1);
    expect(client.pendingCount(), 'an abandoned probe must not linger').toBe(0);
  });

  it('declares it dead even with a real call stuck in the pending map', async () => {
    // The shape of the bug, end to end: the user's save is outstanding and
    // will never return, and it used to make the daemon look busy forever.
    // The clock is faked so the call and the silence genuinely age.
    vi.useFakeTimers();
    try {
      const framed = new FakeFramed();
      const client = new RpcClient(framed.asFramed());
      void client.call('fs.writeBinary', { path: 'note.md', contentBase64: '' });

      vi.advanceTimersByTime(5 * 60_000);   // the save has been hanging this long

      const timers = fakeTimers();
      const onDead = vi.fn();
      const hb = new RpcHeartbeat({
        rpc: client,
        onDead,
        idleMs: 30_000,
        maxMisses: 2,
        probeTimeoutMs: 15_000,
        stallGraceMs: 60_000,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      });

      hb.start();
      await timers.run(8);

      expect(client.oldestPending()?.ageMs, 'the save really is old')
        .toBeGreaterThan(60_000);
      expect(onDead, 'a save that will never return must not mask the wedge')
        .toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
