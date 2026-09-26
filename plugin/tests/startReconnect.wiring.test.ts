import { describe, it, expect, beforeEach, vi } from 'vitest';

// Importing main.ts pulls in RemoteTerminalView (extends the obsidian ItemView,
// which the unit-test obsidian mock doesn't model). Stub the leaf so the import
// graph resolves — the same shim connectProfile.daemon-downgrade.test.ts uses.
vi.mock('../src/ui/RemoteTerminalView', () => ({
  RemoteTerminalView: class {},
  VIEW_TYPE_REMOTE_TERMINAL: 'remote-terminal',
}));

import { App, recordedNotices, clearNotices } from 'obsidian';
import RemoteSshPlugin from '../src/main';
import type { SshProfile } from '../src/types';
import type { RemoteBinding } from '../src/ConnectionManager';

/**
 * The plugin end of the reconnect, which nothing reached.
 *
 * `decideReconnect` and `buildReconnectHooks` were pulled out of `main.ts` so
 * they could be tested, and they are — in isolation. Asking them correctly is a
 * separate matter, and every one of these wirings could be broken with the
 * whole suite green: the dedup guard deleted, the computed notice replaced with
 * the old contentless string, the retry budget invented on the spot, the
 * adapter getter replaced with `() => null` so `rebind` became the no-op it had
 * been before. Those are the exact bugs the extraction claimed to close, so the
 * extraction had moved the hole up a level rather than filling it.
 *
 * `main.ts` is excluded from the coverage scope, which is why this went
 * unmeasured. It is not unreachable: the plugin class constructs fine under the
 * obsidian mock, five other suites already do it, and `recordedNotices()`
 * exists so a test can read the toasts.
 */

const profile = {
  id: 'p1', name: 'Prod', host: 'h', port: 22, username: 'u',
  remotePath: '~/v', transport: 'rpc', authMethod: 'agent',
} as unknown as SshProfile;

interface ReconnectOpts {
  maxRetries: number;
  setAdapterReconnecting: (on: boolean) => void;
  hooks: {
    rebind(b: RemoteBinding): void;
    prepareListenerForReconnect(): void;
    resumeListenerAfterReconnect(rpc: unknown): Promise<void>;
  };
}

function makePlugin(settings: Record<string, unknown> = {}) {
  const plugin = new RemoteSshPlugin(new App() as never);
  const startReconnect = vi.fn().mockResolvedValue(undefined);
  const teardownRpcSession = vi.fn().mockResolvedValue(undefined);
  const startRpcSession = vi.fn().mockResolvedValue(undefined);
  const restore = vi.fn();
  const dataAdapter = { rebind: vi.fn(), setReconnecting: vi.fn() };

  const p = plugin as unknown as Record<string, unknown>;
  p.settings = {
    profiles: [profile], activeProfileId: 'p1', reconnectMaxRetries: 3, ...settings,
  };
  p.conn = {
    activeProfile: profile,
    activeRemoteBasePath: '/home/u/v',
    startReconnect,
    teardownRpcSession,
    startRpcSession,
    buildBinding: () => ({ client: {}, remoteBase: 'v' }) as unknown as RemoteBinding,
  };
  p.adapterMgr = { dataAdapter, restore };
  p.fsChangeListener = {
    prepareForReconnect: vi.fn(),
    resumeAfterReconnect: vi.fn().mockResolvedValue(undefined),
  };

  const drop = (cause?: Error) =>
    (plugin as unknown as { startReconnect(c?: Error): Promise<void> }).startReconnect(cause);

  return {
    plugin, p, drop, startReconnect, teardownRpcSession, startRpcSession, restore, dataAdapter,
  };
}

/** Only the toasts about a lost connection; ignore anything else. */
function lostNotices(): readonly string[] {
  return recordedNotices().filter((n) => /connection lost/i.test(n));
}

beforeEach(() => clearNotices());

describe('RemoteSshPlugin.startReconnect — what the user is told', () => {
  it('says what died, not just that something did', async () => {
    const { drop } = makePlugin();

    await drop(new Error('socket hang up'));

    expect(lostNotices())
      .toEqual(['Remote SSH: connection lost (socket hang up) — reconnecting…']);
  });

  it('announces one drop once, however many layers report it', async () => {
    // On the RPC transport a dropped SSH connection takes the tunnel with it,
    // so `client.onClose` and `onRpcClose` both fire for one event. Both
    // announcing stacked two toasts on the most ordinary disconnect there is.
    const { drop } = makePlugin();

    await drop(new Error('socket hang up'));
    await drop(new Error('socket hang up'));

    expect(lostNotices(), 'the second report is the same failure').toHaveLength(1);
  });

  it('passes the retry budget through rather than inventing one', async () => {
    const { drop, startReconnect } = makePlugin({ reconnectMaxRetries: 7 });

    await drop();

    expect(startReconnect).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 7 }) as unknown as ReconnectOpts,
    );
  });

  it('stands down, and says so, when auto-reconnect is switched off', async () => {
    const { drop, startReconnect, restore } = makePlugin({ reconnectMaxRetries: 0 });

    await drop(new Error('host unreachable'));

    expect(lostNotices())
      .toEqual(['Remote SSH: connection lost (host unreachable). Auto-reconnect is off.']);
    expect(startReconnect, 'and no loop is started').not.toHaveBeenCalled();
    expect(restore, 'the adapter is handed back so reads fall through to disk')
      .toHaveBeenCalled();
  });

  it('does nothing at all with no profile to reconnect to', async () => {
    const { p, drop, startReconnect } = makePlugin();
    (p.conn as { activeProfile: unknown }).activeProfile = null;

    await drop(new Error('socket hang up'));

    expect(lostNotices()).toEqual([]);
    expect(startReconnect).not.toHaveBeenCalled();
  });
});

describe('RemoteSshPlugin.startReconnect — what the manager is handed', () => {
  it('gives the hooks a live adapter, not one captured at wiring time', async () => {
    // `rebind` carries the vault prefix. Replacing this getter with
    // `() => null` makes it the silent no-op it was before, and a transport
    // downgrade then writes beside the vault instead of in it.
    const { drop, startReconnect, dataAdapter } = makePlugin();
    await drop();

    const opts = startReconnect.mock.calls[0][0] as ReconnectOpts;
    const binding = { client: {}, remoteBase: 'work/Vault' } as unknown as RemoteBinding;
    opts.hooks.rebind(binding);

    expect(dataAdapter.rebind).toHaveBeenCalledWith(binding);
  });

  it('routes the reconnecting flag to the adapter that queues writes', async () => {
    const { drop, startReconnect, dataAdapter } = makePlugin();
    await drop();

    const opts = startReconnect.mock.calls[0][0] as ReconnectOpts;
    opts.setAdapterReconnecting(true);

    expect(dataAdapter.setReconnecting).toHaveBeenCalledWith(true);
  });
});

describe('RemoteSshPlugin.restartDaemon', () => {
  it('tears the session down through the manager before bringing it back', async () => {
    // Closing the wire from here instead left the manager's own reasoning about
    // who hung up out of the loop, so the restart announced itself as a lost
    // connection and started a reconnect that raced it.
    const { plugin, teardownRpcSession, startRpcSession } = makePlugin();
    const order: string[] = [];
    teardownRpcSession.mockImplementation(() => {
      order.push('teardown'); return Promise.resolve();
    });
    startRpcSession.mockImplementation(() => {
      order.push('start'); return Promise.resolve();
    });

    await plugin.restartDaemon();

    expect(order).toEqual(['teardown', 'start']);
    expect(lostNotices(), 'a restart the user asked for is not a lost connection').toEqual([]);
  });

  it('rebinds the adapter to the daemon that came back', async () => {
    const { plugin, dataAdapter } = makePlugin();

    await plugin.restartDaemon();

    expect(dataAdapter.rebind).toHaveBeenCalledWith(
      expect.objectContaining({ remoteBase: 'v' }) as unknown as RemoteBinding,
    );
  });
});
