import { describe, it, expect, vi } from 'vitest';
import { RpcHeartbeat, type RpcHeartbeatOptions } from '../src/transport/RpcHeartbeat';
import { RpcClient } from '../src/transport/RpcClient';
import { FakeFramed } from './helpers/fakeFramed';

/**
 * What this pins is the pair of failures on either side of the heartbeat.
 *
 * Miss the dead daemon and the plugin sits there believing it is connected,
 * which is the bug this exists for. Declare a *working* one dead and a large
 * transfer is torn down mid-flight, which is worse — so most of these cases
 * are about the probe staying quiet when it should.
 *
 * Timers are injected, so nothing here waits on real time.
 */

/** A hand-cranked scheduler: nothing fires until `run()` is called. */
function fakeTimers() {
  let next = 1;
  const queued = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void) => { const id = next++; queued.set(id, fn); return id; },
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

function make(overrides: Partial<RpcHeartbeatOptions> = {}) {
  const timers = fakeTimers();
  // Resolved before the options are built, and returned below, so a case
  // that supplies its own probe asserts against the one actually used —
  // handing back the default instead reports zero calls on a spy nothing
  // ever touched.
  const probe = overrides.probe ?? vi.fn().mockResolvedValue({ ok: true });
  const onDead = overrides.onDead ?? vi.fn();
  const hb = new RpcHeartbeat({
    msSinceLastMessage: () => 60_000,   // quiet by default
    pendingCount: () => 0,              // and idle
    idleMs: 30_000,
    maxMisses: 2,
    ...overrides,
    probe,
    onDead,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { hb, timers, probe: probe as ReturnType<typeof vi.fn>, onDead: onDead as ReturnType<typeof vi.fn> };
}

describe('RpcHeartbeat', () => {
  it('asks the daemon whether it is there once the line has gone quiet', async () => {
    const { hb, timers, probe } = make();
    hb.start();
    await timers.run();

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('says nothing while a call is in flight', async () => {
    // The daemon serves one request at a time, so a probe sent now would
    // queue behind that call and time out for reasons of our own making.
    const { hb, timers, probe } = make({ pendingCount: () => 1 });
    hb.start();
    await timers.run(3);

    expect(probe, 'a busy line is a live line').not.toHaveBeenCalled();
  });

  it('says nothing while the daemon is still talking', async () => {
    // A large read arrives as a stream of frames; recent traffic is proof
    // of life and needs no confirming.
    const { hb, timers, probe } = make({ msSinceLastMessage: () => 1_000 });
    hb.start();
    await timers.run(3);

    expect(probe).not.toHaveBeenCalled();
  });

  it('declares the daemon gone only after repeated silence', async () => {
    const { hb, timers, probe, onDead } = make({
      probe: vi.fn().mockRejectedValue(new Error('no answer')),
    });
    hb.start();

    await timers.run();
    expect(onDead, 'one miss is not an outage').not.toHaveBeenCalled();

    await timers.run();
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(String((onDead.mock.calls[0][0] as Error).message)).toMatch(/stopped answering/);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('forgives a miss when the daemon answers again', async () => {
    // A single hiccup — a slow disk, a paused VM — must not accumulate
    // towards an outage across an otherwise healthy hour.
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error('hiccup'))
      .mockResolvedValue({ ok: true });
    const { hb, timers, onDead } = make({ probe });
    hb.start();

    await timers.run(4);
    expect(onDead).not.toHaveBeenCalled();
  });

  it('counts a probe that never answers as a miss', async () => {
    // The wedged case: the connection is open, the request goes out, and
    // nothing comes back. Without its own timeout the heartbeat would wait
    // exactly as long as the caller it was meant to rescue.
    const { hb, timers, onDead } = make({
      probe: () => new Promise(() => { /* never settles */ }),
      probeTimeoutMs: 15_000,
    });
    hb.start();
    await timers.run(6);

    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it('stops for good, and reports the daemon gone only once', async () => {
    const { hb, timers, onDead } = make({
      probe: vi.fn().mockRejectedValue(new Error('no answer')),
    });
    hb.start();
    await timers.run(6);

    expect(onDead).toHaveBeenCalledTimes(1);
    expect(timers.size, 'nothing left scheduled after it gives up').toBe(0);

    hb.start(); // must not resurrect
    await timers.run(3);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it('stop() leaves nothing scheduled', async () => {
    const { hb, timers, probe } = make();
    hb.start();
    hb.stop();
    await timers.run(3);

    expect(probe).not.toHaveBeenCalled();
    expect(timers.size).toBe(0);
  });

  it('says nothing once it has been retired mid-probe', async () => {
    // `stop()` is documented as final, and `disconnectTransport` /
    // `reconnectAttempt` both call it with a probe possibly in flight. The
    // stopped check was only at the top of `tick()`, so a probe that failed
    // after the heartbeat was retired still counted its miss — and on the
    // last one, reported a dead daemon for a wire nobody owned any more,
    // restarting a reconnect on a session that had just recovered.
    const { hb, timers, onDead } = make({
      probe: () => new Promise(() => { /* never settles */ }),
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
  // Every case above injects `pendingCount`. That is what let the bug this
  // suite exists to prevent ship: `withTimeout` rejected its own wrapper and
  // left the probe in the client's pending map, so from the second tick
  // onwards `pendingCount() > 0` reset `misses` and `maxMisses` became
  // unreachable. The stub said 0 forever, which no real client does.
  //
  // So this one wires the real thing up and lets the daemon go silent.

  it('declares a silent daemon dead, and leaves no probe behind', async () => {
    const framed = new FakeFramed();
    const client = new RpcClient(framed.asFramed());
    const timers = fakeTimers();
    const onDead = vi.fn();
    const hb = new RpcHeartbeat({
      probe: (signal) => client.call('server.info', {}, signal),
      msSinceLastMessage: () => 60_000,        // quiet
      pendingCount: () => client.pendingCount(),   // the real count, not a stub
      onDead,
      idleMs: 30_000,
      maxMisses: 2,
      probeTimeoutMs: 15_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    hb.start();
    await timers.run(8);

    expect(framed.sent.length, 'a second probe has to be sent for a miss to count')
      .toBeGreaterThanOrEqual(2);
    expect(onDead, 'a daemon that never answers is dead').toHaveBeenCalledTimes(1);
    expect(client.pendingCount(), 'an abandoned probe must not look like a live line')
      .toBe(0);
  });

  it('stays quiet when the daemon is merely busy', async () => {
    // The other half, and the reason `pendingCount` is consulted at all: a
    // real call in flight is proof of life, and tearing down a session
    // mid-transfer is worse than missing a dead one.
    const framed = new FakeFramed();
    const client = new RpcClient(framed.asFramed());
    const timers = fakeTimers();
    const onDead = vi.fn();
    void client.call('fs.readBinary', { path: 'big.bin' });   // never answered

    const hb = new RpcHeartbeat({
      probe: (signal) => client.call('server.info', {}, signal),
      msSinceLastMessage: () => 60_000,
      pendingCount: () => client.pendingCount(),
      onDead,
      idleMs: 30_000,
      maxMisses: 2,
      probeTimeoutMs: 15_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    hb.start();
    await timers.run(8);

    expect(framed.sent.length, 'no probe goes out while the line is busy').toBe(1);
    expect(onDead).not.toHaveBeenCalled();
  });
});
