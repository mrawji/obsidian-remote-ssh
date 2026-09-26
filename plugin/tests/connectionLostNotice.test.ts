import { describe, it, expect } from 'vitest';
import { connectionLostNotice } from '../src/transport/connectionLostNotice';

/**
 * The wording shipped untested, in `main.ts`: the suite passed with the reason
 * stripped back out of the message. It is what the user reads when a session
 * dies, so it is pinned here — and that the plugin says it once, at the right
 * moments, is pinned in `tests/startReconnect.wiring.test.ts`.
 */

describe('connectionLostNotice', () => {
  it('names what died', () => {
    expect(connectionLostNotice(new Error('socket hang up'), true))
      .toBe('Remote SSH: connection lost (socket hang up) — reconnecting…');
  });

  it('still says something when nothing knew why', () => {
    // A clean EOF carries no error.
    expect(connectionLostNotice(undefined, true))
      .toBe('Remote SSH: connection lost — reconnecting…');
  });

  it('treats a blank reason as no reason', () => {
    // Otherwise it reads as "connection lost ()".
    expect(connectionLostNotice(new Error(''), true))
      .toBe('Remote SSH: connection lost — reconnecting…');
  });

  it('says so plainly when auto-reconnect is off, rather than promising a retry', () => {
    expect(connectionLostNotice(new Error('host unreachable'), false))
      .toBe('Remote SSH: connection lost (host unreachable). Auto-reconnect is off.');
  });
});
