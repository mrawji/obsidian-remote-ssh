import { describe, it, expect, vi } from 'vitest';
import { ReconnectWait } from '../src/util/ReconnectWait';

/**
 * What this pins is the failure it was written for (#513): a reconnect on a
 * 50,000-note vault failed 9,756 reads outright, and Obsidian's indexer does
 * not retry — so each one is a note left with no metadata and nothing said
 * about it.
 */

describe('ReconnectWait', () => {
  it('does not wait at all when the session is up', async () => {
    const sleep = vi.fn(async () => { /* never */ });
    await new ReconnectWait({ sleep }).wait(() => false);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits while the session is reconnecting, and returns once it is back', async () => {
    let reconnecting = true;
    const sleep = vi.fn(async () => { reconnecting = false; });

    await new ReconnectWait({ sleep }).wait(() => reconnecting);

    expect(sleep, 'it waited rather than letting the read fail').toHaveBeenCalledOnce();
    expect(reconnecting).toBe(false);
  });

  it('polls until the session comes back, not just once', async () => {
    let ticks = 0;
    const sleep = vi.fn(async () => { ticks++; });

    await new ReconnectWait({ sleep }).wait(() => ticks < 3);

    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('gives up once the budget is spent, and lets the caller decide', async () => {
    // A session that never returns must not hang here forever: the read then
    // fails through the adapter's own reconnecting check, as it always did.
    let clock = 0;
    const wait = new ReconnectWait({
      timeoutMs: 500,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });

    await expect(wait.wait(() => true)).resolves.toBeUndefined();
    expect(clock, 'waited its budget and no longer').toBeGreaterThanOrEqual(500);
    expect(clock).toBeLessThan(1_000);
  });
});
