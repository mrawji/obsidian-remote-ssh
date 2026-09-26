import { describe, it, expect } from 'vitest';
import { decideReconnect } from '../src/transport/reconnectDecision';

/**
 * These two behaviours shipped untested, in `main.ts`: the suite passed with
 * the dedup guard deleted and with the reason stripped back out of the
 * message. They are what the user sees when a session dies.
 *
 * What is pinned HERE is only the decision itself. Whether `main.ts` asks the
 * question and acts on the answer is a separate matter, and one this file
 * cannot see — `tests/startReconnect.wiring.test.ts` covers that, because
 * without it every one of those wirings could still be broken with this suite
 * green.
 */

const base = { hasActiveProfile: true, alreadyReconnecting: false, maxRetries: 3 };

describe('decideReconnect', () => {
  it('has nothing to reconnect to without a profile', () => {
    expect(decideReconnect({ ...base, hasActiveProfile: false }).kind).toBe('no-profile');
  });

  it('announces a drop once, and says what died', () => {
    const d = decideReconnect({ ...base, cause: new Error('socket hang up') });

    expect(d.kind).toBe('start');
    expect(d.kind === 'start' && d.notice)
      .toBe('Remote SSH: connection lost (socket hang up) — reconnecting…');
  });

  it('stays quiet on the second report of the same drop', () => {
    // On the RPC transport a dropped SSH connection takes the tunnel with it,
    // so the wire close and the client close both arrive for one event. Both
    // announcing stacked two toasts on the most ordinary disconnect there is.
    const d = decideReconnect({
      ...base, alreadyReconnecting: true, cause: new Error('socket hang up'),
    });

    expect(d.kind).toBe('already-reconnecting');
    expect(d.kind === 'already-reconnecting' && d.log, 'the reason still belongs in the log')
      .toContain('socket hang up');
  });

  it('still says something when nothing knew why', () => {
    // A clean EOF carries no error. It must not read as `connection lost
    // (undefined)`.
    const d = decideReconnect(base);

    expect(d.kind === 'start' && d.notice).toBe('Remote SSH: connection lost — reconnecting…');
  });

  it('treats a blank reason as no reason', () => {
    const d = decideReconnect({ ...base, cause: new Error('') });

    expect(d.kind === 'start' && d.notice).toBe('Remote SSH: connection lost — reconnecting…');
  });

  it('tells the user when auto-reconnect is off rather than silently giving up', () => {
    const d = decideReconnect({ ...base, maxRetries: 0, cause: new Error('host unreachable') });

    expect(d.kind).toBe('disabled');
    expect(d.kind === 'disabled' && d.notice)
      .toBe('Remote SSH: connection lost (host unreachable). Auto-reconnect is off.');
  });

  it('carries the retry budget through so the caller cannot invent one', () => {
    const d = decideReconnect({ ...base, maxRetries: 7 });

    expect(d.kind === 'start' && d.maxRetries).toBe(7);
  });
});
