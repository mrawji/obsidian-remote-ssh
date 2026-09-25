import { describe, it, expect, vi } from 'vitest';
import type { SftpDataAdapter } from '../src/adapter/SftpDataAdapter';
import type { PathMapper } from '../src/path/PathMapper';
import { AdapterManager, PATCHED_METHODS } from '../src/adapter/AdapterManager';
import type { App, PluginManifest } from 'obsidian';
import type { ConnectionManager } from '../src/ConnectionManager';
import type { FsChangeListener } from '../src/vault/FsChangeListener';
import type { PendingEditsBar } from '../src/ui/PendingEditsBar';
import type { PluginSettings } from '../src/types';

/**
 * Build a minimal AdapterManager with all constructor deps mocked at
 * the typescript type boundary. The deps are only accessed when the
 * adapter is _patched_ — the tests below never call patch(), so the
 * mocks only need the methods that are called on a fresh (un-patched)
 * instance: FsChangeListener.unsubscribe() and ConnectionManager.rpcConnection.
 */
function makeManager(opts: { transferTracker?: { clear: () => void } } = {}) {
  const unsubscribeSpy = vi.fn();
  const mgr = new AdapterManager(
    {} as App,
    { id: 'remote-ssh' } as unknown as PluginManifest,
    { rpcConnection: null, activeRemoteBasePath: null } as unknown as ConnectionManager,
    { subscribe: vi.fn(), unsubscribe: unsubscribeSpy } as unknown as FsChangeListener,
    { startPolling: vi.fn() } as unknown as PendingEditsBar,
    () => ({}) as unknown as PluginSettings,
    opts.transferTracker ?? null,
  );
  return { mgr, unsubscribeSpy };
}

// ─── PATCHED_METHODS ─────────────────────────────────────────────────────────

describe('PATCHED_METHODS constant', () => {
  it('is a non-empty array', () => {
    expect(PATCHED_METHODS.length).toBeGreaterThan(0);
  });

  it('includes core read-side methods', () => {
    expect(PATCHED_METHODS).toContain('exists');
    expect(PATCHED_METHODS).toContain('stat');
    expect(PATCHED_METHODS).toContain('list');
    expect(PATCHED_METHODS).toContain('read');
    expect(PATCHED_METHODS).toContain('readBinary');
  });

  it('includes core write-side methods', () => {
    expect(PATCHED_METHODS).toContain('write');
    expect(PATCHED_METHODS).toContain('writeBinary');
    expect(PATCHED_METHODS).toContain('mkdir');
    expect(PATCHED_METHODS).toContain('remove');
    expect(PATCHED_METHODS).toContain('rename');
    expect(PATCHED_METHODS).toContain('copy');
  });

  it('includes getResourcePath for the binary bridge', () => {
    expect(PATCHED_METHODS).toContain('getResourcePath');
  });

  it('includes basePath / getBasePath for shadow-vault compatibility', () => {
    expect(PATCHED_METHODS).toContain('basePath');
    expect(PATCHED_METHODS).toContain('getBasePath');
  });
});

// ─── initial state ────────────────────────────────────────────────────────

describe('AdapterManager — initial state', () => {
  it('isPatched() returns false before patch() is called', () => {
    const { mgr } = makeManager();
    expect(mgr.isPatched()).toBe(false);
  });

  it('dataAdapter getter returns null before patch() is called', () => {
    const { mgr } = makeManager();
    expect(mgr.dataAdapter).toBeNull();
  });
});

// ─── replayOfflineQueue ────────────────────────────────────────────────────

describe('AdapterManager.replayOfflineQueue()', () => {
  it('returns without throwing when offlineQueue is null', async () => {
    const { mgr } = makeManager();
    await expect(mgr.replayOfflineQueue('after-connect')).resolves.toBeUndefined();
  });

  it('returns without throwing for the after-reconnect label', async () => {
    const { mgr } = makeManager();
    await expect(mgr.replayOfflineQueue('after-reconnect')).resolves.toBeUndefined();
  });
});

// ─── showPendingEditsModal ─────────────────────────────────────────────────

describe('AdapterManager.showPendingEditsModal()', () => {
  it('returns without throwing when no offline queue is open', async () => {
    const { mgr } = makeManager();
    await expect(mgr.showPendingEditsModal()).resolves.toBeUndefined();
  });
});

// ─── restore ──────────────────────────────────────────────────────────────

describe('AdapterManager.restore()', () => {
  it('does not throw when called before patch()', () => {
    const { mgr } = makeManager();
    expect(() => mgr.restore()).not.toThrow();
  });

  it('calls fsChangeListener.unsubscribe() once', () => {
    const { mgr, unsubscribeSpy } = makeManager();
    mgr.restore();
    expect(unsubscribeSpy).toHaveBeenCalledOnce();
  });

  it('wakes reads parked on the adapter it is about to discard', () => {
    // Those reads poll the adapter's own `reconnecting` flag (ReconnectWait).
    // Once `_dataAdapter` is null nothing can clear it — main.ts resets it via
    // `dataAdapter?.setReconnecting(false)` — so they would sit out the full
    // 30 s budget instead of failing promptly, which is what they did before
    // the wait existed. Reaching into the private field is deliberate: this is
    // teardown ordering, and there is no public seam for it.
    const { mgr } = makeManager();
    const dispose = vi.fn();
    const setReconnecting = vi.fn();
    (mgr as unknown as { _dataAdapter: unknown })._dataAdapter = { dispose, setReconnecting };

    mgr.restore();

    expect(dispose).toHaveBeenCalledOnce();
    // NOT setReconnecting(false): that would also tell the read path the
    // session is healthy, and it would hit a transport being abandoned.
    expect(setReconnecting).not.toHaveBeenCalled();
  });

  it('leaves isPatched() false after restore()', () => {
    const { mgr } = makeManager();
    mgr.restore();
    expect(mgr.isPatched()).toBe(false);
  });

  it('leaves dataAdapter null after restore()', () => {
    const { mgr } = makeManager();
    mgr.restore();
    expect(mgr.dataAdapter).toBeNull();
  });

  it('is idempotent — two calls do not throw', () => {
    const { mgr } = makeManager();
    expect(() => mgr.restore()).not.toThrow();
    expect(() => mgr.restore()).not.toThrow();
  });

  it('calls transferTracker.clear() when one is supplied', () => {
    const clearSpy = vi.fn();
    const { mgr } = makeManager({ transferTracker: { clear: clearSpy } });
    mgr.restore();
    expect(clearSpy).toHaveBeenCalledOnce();
  });
});

// ─── the pieces patch() is built from ────────────────────────────────────────
//
// `patch()` itself needs a real vault, a live transport and a bound port, so
// nothing had ever executed it — the helper above says as much. These three
// steps were lifted out of it precisely so they could be reached, in the same
// way `wireKeyboardInteractiveHandler` was lifted out of `SftpClient.connect`.

/** Reach a private method without widening the class's surface. */
function priv<T>(mgr: unknown, name: string): T {
  return (mgr as unknown as Record<string, T>)[name];
}

describe('AdapterManager.ensureOfflineQueue()', () => {
  function withQueue(mgr: unknown, queue: unknown, calls: { n: number }) {
    (mgr as Record<string, unknown>).openOfflineQueue = () => {
      calls.n++;
      return Promise.resolve(queue);
    };
  }

  it('opens the queue once and reuses it', async () => {
    // Reused across patches on purpose: re-opening would replay a queue that
    // has already been drained.
    const { mgr } = makeManager();
    const calls = { n: 0 };
    withQueue(mgr, { stats: () => ({ entries: 0, bytes: 0 }), pending: () => [] }, calls);

    await priv<() => Promise<void>>(mgr, 'ensureOfflineQueue').call(mgr);
    await priv<() => Promise<void>>(mgr, 'ensureOfflineQueue').call(mgr);

    expect(calls.n).toBe(1);
  });

  it('points the status bar at the queue it just opened', async () => {
    const startPolling = vi.fn();
    const mgr = new AdapterManager(
      {} as App,
      { id: 'remote-ssh' } as unknown as PluginManifest,
      { rpcConnection: null, activeRemoteBasePath: null } as unknown as ConnectionManager,
      { subscribe: vi.fn(), unsubscribe: vi.fn() } as unknown as FsChangeListener,
      { startPolling } as unknown as PendingEditsBar,
      () => ({}) as unknown as PluginSettings,
      null,
    );
    withQueue(mgr, {
      stats: () => ({ entries: 2, bytes: 10 }),
      pending: () => [{}, {}, {}],
    }, { n: 0 });

    await priv<() => Promise<void>>(mgr, 'ensureOfflineQueue').call(mgr);

    expect(startPolling).toHaveBeenCalledTimes(1);
    // The bar must read the live queue, not a count captured at wiring time.
    const read = startPolling.mock.calls[0][0] as () => number;
    expect(read()).toBe(3);
  });

  it('survives a queue that will not open, leaving offline writes to throw', async () => {
    // Louder than pretending: with no queue, an offline write raises instead
    // of being accepted and silently lost.
    const { mgr } = makeManager();
    (mgr as unknown as Record<string, unknown>).openOfflineQueue =
      () => Promise.reject(new Error('disk is full'));

    await expect(priv<() => Promise<void>>(mgr, 'ensureOfflineQueue').call(mgr))
      .resolves.toBeUndefined();
    expect((mgr as unknown as { offlineQueue: unknown }).offlineQueue).toBeNull();
  });
});

describe('AdapterManager.wireLiveUpdates()', () => {
  function fakeAdapter() {
    return {
      setWriterReflector: vi.fn(),
      setLocalOpRegistry: vi.fn(),
    } as unknown as SftpDataAdapter & {
      setWriterReflector: ReturnType<typeof vi.fn>;
      setLocalOpRegistry: ReturnType<typeof vi.fn>;
    };
  }
  const mapper = {} as PathMapper;

  it('wires the reflector so a write shows up without waiting for an echo', () => {
    const { mgr } = makeManager();
    const adapter = fakeAdapter();

    priv<(a: unknown, m: unknown) => void>(mgr, 'wireLiveUpdates').call(mgr, adapter, mapper);

    expect(adapter.setWriterReflector).toHaveBeenCalledTimes(1);
    expect(adapter.setLocalOpRegistry).toHaveBeenCalledTimes(1);
  });

  it('subscribes to fs changes only when the session is RPC', () => {
    // SFTP has no notification channel, so there is nothing to subscribe to.
    const subscribe = vi.fn();
    const mgr = new AdapterManager(
      {} as App,
      { id: 'remote-ssh' } as unknown as PluginManifest,
      { rpcConnection: null, activeRemoteBasePath: null } as unknown as ConnectionManager,
      { subscribe, unsubscribe: vi.fn() } as unknown as FsChangeListener,
      { startPolling: vi.fn() } as unknown as PendingEditsBar,
      () => ({}) as unknown as PluginSettings,
      null,
    );

    priv<(a: unknown, m: unknown) => void>(mgr, 'wireLiveUpdates').call(mgr, fakeAdapter(), mapper);

    expect(subscribe).not.toHaveBeenCalled();
  });

  it('gives the adapter and the listener the SAME registry', () => {
    // The whole echo-drop rests on this identity. Two registries and the
    // daemon's echo of our own write would no longer match anything the
    // reflector recorded, so every local write would fire twice.
    const subscribe = vi.fn();
    const mgr = new AdapterManager(
      {} as App,
      { id: 'remote-ssh' } as unknown as PluginManifest,
      { rpcConnection: {}, activeRemoteBasePath: '' } as unknown as ConnectionManager,
      { subscribe, unsubscribe: vi.fn() } as unknown as FsChangeListener,
      { startPolling: vi.fn() } as unknown as PendingEditsBar,
      () => ({}) as unknown as PluginSettings,
      null,
    );
    const adapter = fakeAdapter();

    priv<(a: unknown, m: unknown) => void>(mgr, 'wireLiveUpdates').call(mgr, adapter, mapper);

    expect(subscribe).toHaveBeenCalledTimes(1);
    const passedToAdapter = adapter.setLocalOpRegistry.mock.calls[0][0];
    const passedToListener = (subscribe.mock.calls[0][0] as { localOpRegistry: unknown }).localOpRegistry;
    expect(passedToListener).toBe(passedToAdapter);
  });
});

describe('AdapterManager.startResourceBridge()', () => {
  function fakeBridge(start: () => Promise<void>) {
    return { start: vi.fn(start) } as unknown as Parameters<
      (b: never) => void
    >[0];
  }

  it('returns the bridge once it is listening', async () => {
    const { mgr } = makeManager();
    const bridge = fakeBridge(() => Promise.resolve());

    const got = await priv<(b: unknown) => Promise<unknown>>(mgr, 'startResourceBridge')
      .call(mgr, bridge);

    expect(got).toBe(bridge);
  });

  it('gives up the bridge, not the session, when it cannot bind', async () => {
    // Losing the bridge costs image rendering. Letting the throw escape would
    // cost the connection, which is the worse trade.
    const { mgr } = makeManager();
    const bridge = fakeBridge(() => Promise.reject(new Error('EADDRINUSE')));

    const got = await priv<(b: unknown) => Promise<unknown>>(mgr, 'startResourceBridge')
      .call(mgr, bridge);

    expect(got).toBeNull();
  });
});
