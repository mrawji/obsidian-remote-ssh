import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { wireConnectionLifecycle } from '../src/ssh/SftpClient';

/**
 * What this pins is the account of why a session ended.
 *
 * ssh2 reports a keepalive timeout, an ECONNRESET or a mid-session protocol
 * failure by emitting `error` and then `close`. The reason used to stop
 * there: the only `error` handler existed to reject the connect promise, and
 * rejecting a promise that has already settled is a silent no-op. So every
 * post-handshake failure collapsed into one contentless line — "connection
 * closed" — in the log kept specifically for triaging support reports.
 *
 * It went unnoticed because it lives inside `connect()`, which needs a real
 * server; nothing could reach it until it was lifted out.
 */

function harness(overrides: Partial<Parameters<typeof wireConnectionLifecycle>[1]> = {}) {
  const client = new EventEmitter();
  const notify = vi.fn();
  const onError = vi.fn();
  const onTeardown = vi.fn();
  wireConnectionLifecycle(client as never, {
    host: 'example.test',
    onError,
    isCurrent: () => true,
    onTeardown,
    wasIntentional: () => false,
    notify,
    ...overrides,
  });
  return { client, notify, onError, onTeardown };
}

describe('wireConnectionLifecycle', () => {
  it('carries the error that preceded the close to whoever is listening', () => {
    const { client, notify } = harness();

    client.emit('error', new Error('Keepalive timeout'));
    client.emit('close');

    expect(notify).toHaveBeenCalledTimes(1);
    const info = notify.mock.calls[0][0] as { unexpected: boolean; reason?: Error };
    expect(info.reason, 'the reason is the whole point').toBeInstanceOf(Error);
    expect(info.reason?.message).toBe('Keepalive timeout');
  });

  it('reports no reason when the connection simply ended', () => {
    // A clean close is not a failure, and inventing a cause for it would be
    // its own kind of lie.
    const { client, notify } = harness();

    client.emit('close');

    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0][0] as { reason?: Error }).reason).toBeUndefined();
  });

  it('keeps reporting errors after the connect promise has settled', () => {
    // The handler's original job — rejecting that promise — stops mattering
    // the moment it settles, which is exactly when ssh2 starts using this
    // event for the things worth knowing about.
    const { client, onError } = harness();

    client.emit('error', new Error('first, during connect'));
    client.emit('error', new Error('later, mid-session'));

    expect(onError).toHaveBeenCalledTimes(2);
    expect((onError.mock.calls[1][0] as Error).message).toBe('later, mid-session');
  });

  it('keeps the last error, so the close names what actually killed it', () => {
    const { client, notify } = harness();

    client.emit('error', new Error('a transient blip'));
    client.emit('error', new Error('what finished it off'));
    client.emit('close');

    expect((notify.mock.calls[0][0] as { reason?: Error }).reason?.message)
      .toBe('what finished it off');
  });

  it('marks a disconnect we asked for as expected', () => {
    // Otherwise every manual Disconnect would start a reconnect loop.
    const { client, notify } = harness({ wasIntentional: () => true });

    client.emit('close');

    expect((notify.mock.calls[0][0] as { unexpected: boolean }).unexpected).toBe(false);
  });

  it('says nothing for a client the owner has already replaced', () => {
    // A reconnect leaves the old client to close on its own schedule. Taking
    // that as the live session dying would tear down the new one.
    const { client, notify, onTeardown } = harness({ isCurrent: () => false });

    client.emit('close');

    expect(notify).not.toHaveBeenCalled();
    expect(onTeardown, 'the stale client is still cleaned up').toHaveBeenCalledTimes(1);
  });

  it('turns a non-Error into an Error rather than passing it on raw', () => {
    // ssh2 is typed loosely enough that a string can arrive here, and
    // `reason.message` downstream would then be undefined.
    const { client, notify } = harness();

    client.emit('error', 'a bare string');
    client.emit('close');

    const reason = (notify.mock.calls[0][0] as { reason?: Error }).reason;
    expect(reason).toBeInstanceOf(Error);
    expect(reason?.message).toBe('a bare string');
  });
});
