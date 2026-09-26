import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RpcClient } from '../src/transport/RpcClient';
import { RpcError } from '../src/transport/RpcError';
import { FakeFramed } from './helpers/fakeFramed';

function setup() {
  const framed = new FakeFramed();
  return { framed, client: new RpcClient(framed.asFramed()) };
}

describe('RpcClient', () => {
  it('correlates a call with its response by id', async () => {
    const { framed, client } = setup();
    const pending = client.call('server.info', {});
    expect(framed.sent.length).toBe(1);
    const req = JSON.parse(framed.sent[0].toString('utf8')) as { id: number };
    framed.pushMessage({ jsonrpc: '2.0', id: req.id, result: { version: '1.0.0', protocolVersion: 1, capabilities: [], vaultRoot: '/v' } });
    const result = await pending;
    expect(result.version).toBe('1.0.0');
  });

  it('rejects with RpcError when the response is an error envelope', async () => {
    const { framed, client } = setup();
    const pending = client.call('fs.stat', { path: 'missing.md' });
    const req = JSON.parse(framed.sent[0].toString('utf8')) as { id: number };
    framed.pushMessage({ jsonrpc: '2.0', id: req.id, error: { code: -32010, message: 'no such file' } });

    await expect(pending).rejects.toBeInstanceOf(RpcError);
    try {
      await pending;
    } catch (e) {
      expect((e as RpcError).code).toBe(-32010);
      expect((e as RpcError).is(-32010 as never)).toBe(true);
    }
  });

  it('demultiplexes concurrent calls', async () => {
    const { framed, client } = setup();
    const p1 = client.call('fs.stat', { path: 'a.md' });
    const p2 = client.call('fs.stat', { path: 'b.md' });
    expect(framed.sent.length).toBe(2);
    const [id1, id2] = framed.sent.map(b => (JSON.parse(b.toString('utf8')) as { id: number }).id);
    // Deliver out of order.
    framed.pushMessage({ jsonrpc: '2.0', id: id2, result: null });
    framed.pushMessage({ jsonrpc: '2.0', id: id1, result: { type: 'file', mtime: 1, size: 0, mode: 0 } });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r2).toBeNull();
    expect(r1).not.toBeNull();
  });

  it('delivers notifications to registered handlers', () => {
    const { framed, client } = setup();
    const handler = vi.fn();
    client.onNotification('fs.changed', handler);
    framed.pushMessage({
      jsonrpc: '2.0',
      method: 'fs.changed',
      params: { subscriptionId: 's1', path: 'a.md', event: 'modified', mtime: 99 },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ path: 'a.md', event: 'modified' });
  });

  it('unregisters a notification handler via the returned disposer', () => {
    const { framed, client } = setup();
    const handler = vi.fn();
    const off = client.onNotification('fs.changed', handler);
    off();
    framed.pushMessage({
      jsonrpc: '2.0',
      method: 'fs.changed',
      params: { subscriptionId: 's1', path: 'a.md', event: 'modified' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects pending calls when the stream closes', async () => {
    const { framed, client } = setup();
    const pending = client.call('fs.stat', { path: 'a.md' });
    framed.close();
    await expect(pending).rejects.toBeInstanceOf(RpcError);
  });

  it('fires onClose handlers with no error on a clean close', () => {
    const { framed, client } = setup();
    const cb = vi.fn();
    client.onClose(cb);
    framed.close();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toBeUndefined();
  });

  it('fires onClose handlers with the error on an abort', () => {
    const { framed, client } = setup();
    const cb = vi.fn();
    client.onClose(cb);
    framed.emit('error', new Error('boom'));
    expect(cb).toHaveBeenCalledTimes(1);
    expect((cb.mock.calls[0][0] as Error).message).toBe('boom');
  });

  it('rejects call() after close()', async () => {
    const { client } = setup();
    client.close();
    await expect(client.call('server.info', {})).rejects.toBeInstanceOf(RpcError);
  });

  it('ignores malformed server responses without killing the session', async () => {
    const { framed, client } = setup();
    const pending = client.call('server.info', {});
    const req = JSON.parse(framed.sent[0].toString('utf8')) as { id: number };

    // Garbage message first — should be silently dropped.
    framed.emit('message', Buffer.from('not-json-at-all', 'utf8'));
    // Valid response afterwards — promise still resolves.
    framed.pushMessage({ jsonrpc: '2.0', id: req.id, result: { version: '1.0.0', protocolVersion: 1, capabilities: [], vaultRoot: '' } });
    await pending;
  });

  it('isClosed() returns false before close and true after', () => {
    const { client } = setup();
    expect(client.isClosed()).toBe(false);
    client.close();
    expect(client.isClosed()).toBe(true);
  });

  it('rejects the call when writeMessage throws', async () => {
    const { framed, client } = setup();
    vi.spyOn(framed, 'writeMessage').mockImplementationOnce(() => {
      throw new Error('write failed');
    });
    await expect(client.call('server.info', {})).rejects.toThrow('write failed');
    expect(client.isClosed()).toBe(false);
  });

  it('onClose disposer removes the handler so it is not called on close', () => {
    const { framed, client } = setup();
    const cb = vi.fn();
    const off = client.onClose(cb);
    off();
    framed.close();
    expect(cb).not.toHaveBeenCalled();
  });
});

// ─── the two signals the heartbeat decides on ────────────────────────────────
//
// `RpcHeartbeat` never probes while these say "busy" or "recently heard
// from". Its own tests hand it lambdas, so until now nothing had run the
// real implementations — and a wrong answer here either probes a healthy
// session to death or never notices a dead one.

describe('RpcClient — liveness signals', () => {
  it('counts a call while it is in flight, and stops when it is answered', () => {
    // A long read is quiet on the wire but NOT idle. This is what stops the
    // heartbeat probing underneath a transfer that is working fine.
    const { framed, client } = setup();
    expect(client.pendingCount()).toBe(0);

    const pending = client.call('fs.readBinary', { path: 'big.bin' });
    expect(client.pendingCount()).toBe(1);

    const req = JSON.parse(framed.sent[0].toString('utf8')) as { id: number };
    framed.pushMessage({ jsonrpc: '2.0', id: req.id, result: { data: '' } });

    return pending.then(() => {
      expect(client.pendingCount()).toBe(0);
    });
  });

  it('counts each outstanding call separately', () => {
    const { client } = setup();
    void client.call('fs.stat', { path: 'a.md' });
    void client.call('fs.stat', { path: 'b.md' });

    expect(client.pendingCount()).toBe(2);
  });

  it('measures silence from the last frame the daemon sent', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const { framed, client } = setup();

      vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
      expect(client.msSinceLastMessage()).toBe(30_000);

      framed.pushMessage({ jsonrpc: '2.0', id: 1, result: {} });
      expect(client.msSinceLastMessage()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a frame it cannot correlate as proof of life anyway', () => {
    // The clock is bumped before the envelope is even parsed, deliberately:
    // a response to a call we have forgotten, or a malformed one, still means
    // the daemon is there. Counting only matched replies would let a session
    // that is talking be declared dead.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const { framed, client } = setup();
      vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
      expect(client.msSinceLastMessage()).toBe(60_000);

      framed.pushMessage({ jsonrpc: '2.0', id: 987654, result: {} }); // no such call

      expect(client.msSinceLastMessage()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
