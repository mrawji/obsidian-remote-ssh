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

  it('hands the bridge a fetcher wired to this manager', async () => {
    // The bridge serves Obsidian's <img> requests; if that callback does not
    // reach the patched adapter, every remote image renders broken.
    const { mgr } = makeManager();
    const fetchSpy = vi.fn(async () => new Uint8Array([1]));
    (mgr as unknown as Record<string, unknown>).fetchBinaryForBridge = fetchSpy;
    let fetcher: ((p: string) => Promise<Uint8Array>) | undefined;
    const bridge = { start: async (f: unknown) => { fetcher = f as typeof fetcher; } };

    await priv<(b: unknown) => Promise<unknown>>(mgr, 'startResourceBridge').call(mgr, bridge);
    await fetcher!('notes/diagram.png');

    expect(fetchSpy).toHaveBeenCalledWith('notes/diagram.png');
  });

  it('enables the daemon fast paths only when the daemon offers them', async () => {
    // Served from the daemon's resize path instead of pulling the full
    // original on every <img> — but only when it advertises the method.
    const { mgr } = makeManager();
    const internals = mgr as unknown as Record<string, unknown>;
    internals.makeThumbnailFetcherIfSupported = () => (() => Promise.resolve(new Uint8Array()));
    internals.makeBinaryRangeFetcherIfSupported = () => (() => Promise.resolve(new Uint8Array()));
    const passed: unknown[] = [];
    const bridge = { start: async (...a: unknown[]) => { passed.push(...a); } };

    const got = await priv<(b: unknown) => Promise<unknown>>(mgr, 'startResourceBridge')
      .call(mgr, bridge);

    expect(got).toBe(bridge);
    expect(passed.filter((x) => typeof x === 'function')).toHaveLength(3);
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

// ─── patch() itself ──────────────────────────────────────────────────────────
//
// Never executed by anything: not the unit suite, and — measured — not the
// integration suite either. Only the E2E run drives it, and that uploads no
// coverage. It is the step that puts this plugin in front of the vault.

describe('AdapterManager.patch()', () => {
  function patchableManager() {
    // Only `app.vault` is reached, so a literal says more than a real App.
    const hostAdapter: Record<string, unknown> = { read: () => 'original' };
    const app = {
      vault: {
        adapter: hostAdapter,
        configDir: '.obsidian',
        getName: () => 'test-vault',
      },
    };
    const subscribe = vi.fn();
    const mgr = new AdapterManager(
      app as unknown as App,
      { id: 'remote-ssh' } as unknown as PluginManifest,
      {
        activeRemoteBasePath: '/home/tester/vault',
        rpcConnection: null,
        buildBinding: () => ({ client: {}, remoteBase: '/home/tester/vault' }),
      } as unknown as ConnectionManager,
      { subscribe, unsubscribe: vi.fn() } as unknown as FsChangeListener,
      { startPolling: vi.fn() } as unknown as PendingEditsBar,
      () => ({ profiles: [] }) as unknown as PluginSettings,
      null,
    );
    // The bridge binds a port and the queue touches disk; neither is what this
    // test is about, and both have their own cases above.
    const internals = mgr as unknown as Record<string, unknown>;
    internals.startResourceBridge = () => Promise.resolve(null);
    internals.openOfflineQueue = () => Promise.resolve({
      stats: () => ({ entries: 0, bytes: 0 }),
      pending: () => [],
    });
    return { mgr, hostAdapter, subscribe };
  }

  it('refuses to patch before a remote base path is known', async () => {
    // Patching against no prefix would point every read and write at the
    // remote home instead of the vault inside it.
    const { mgr } = makeManager();

    expect(await mgr.patch()).toBe(false);
    expect(mgr.isPatched()).toBe(false);
  });

  it('replaces the host adapter\'s methods and reports success', async () => {
    const { mgr, hostAdapter } = patchableManager();
    const before = hostAdapter.read;

    expect(await mgr.patch()).toBe(true);

    expect(mgr.isPatched()).toBe(true);
    expect(mgr.dataAdapter).not.toBeNull();
    expect(hostAdapter.read).not.toBe(before);
    // Not all of them are functions — `basePath` is a value, which is the
    // whole point of #170: plugins read it and used to get `undefined`.
    for (const m of PATCHED_METHODS) expect(hostAdapter[m]).toBeDefined();
  });

  it('is idempotent — a second patch does not re-wrap an already-wrapped adapter', async () => {
    const { mgr, hostAdapter } = patchableManager();
    await mgr.patch();
    const afterFirst = hostAdapter.read;

    expect(await mgr.patch()).toBe(true);

    expect(hostAdapter.read).toBe(afterFirst);
  });

  it('gives the host adapter its own methods back on restore', async () => {
    const { mgr, hostAdapter } = patchableManager();
    const before = hostAdapter.read;
    await mgr.patch();

    mgr.restore();

    expect(hostAdapter.read).toBe(before);
    expect(mgr.isPatched()).toBe(false);
    expect(mgr.dataAdapter).toBeNull();
  });

  it('does not subscribe to fs changes on an SFTP session', async () => {
    const { mgr, subscribe } = patchableManager();

    await mgr.patch();

    expect(subscribe).not.toHaveBeenCalled();
  });
});
