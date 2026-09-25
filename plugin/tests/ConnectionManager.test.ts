import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the three transport collaborators startRpcSession touches.
// `resolveRemotePath` is kept REAL (pure) so the absolute-vault-root
// computation under test is exercised for real, not stubbed.
vi.mock('../src/transport/DaemonProbe', () => ({
  tryReuseExistingDaemon: vi.fn(),
}));
vi.mock('../src/transport/RpcConnection', () => ({
  establishRpcConnection: vi.fn(),
}));
const deployMock = vi.fn();
vi.mock('../src/transport/ServerDeployer', async (orig) => {
  const actual = await orig<typeof import('../src/transport/ServerDeployer')>();
  return {
    ...actual, // keep the real resolveRemotePath
    // A class (not an arrow) — ConnectionManager does `new ServerDeployer(client)`.
    ServerDeployer: class { deploy = deployMock; },
  };
});

import { ConnectionManager, DaemonUnavailableError, type ConnectionDeps } from '../src/ConnectionManager';
import { tryReuseExistingDaemon } from '../src/transport/DaemonProbe';
import { establishRpcConnection } from '../src/transport/RpcConnection';
import type { SshProfile } from '../src/types';

describe('ConnectionManager static helpers', () => {
  it('resolveClientId sanitizes explicit clientId overrides', () => {
    expect(ConnectionManager.resolveClientId({ clientId: '  laptop / dev  ' })).toBe('laptop-dev');
  });

  it('resolveClientId falls back to defaultClientId when clientId is blank or omitted', () => {
    const fromBlank = ConnectionManager.resolveClientId({ clientId: '   ' });
    const fromEmpty = ConnectionManager.resolveClientId({ clientId: '' });
    const fromOmitted = ConnectionManager.resolveClientId({});
    expect(fromBlank).toBe(fromEmpty);
    expect(fromEmpty).toBe(fromOmitted);
    expect(fromBlank).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(fromBlank).not.toMatch(/^-|-$/);
  });

  it('formatUserLabel uses trimmed userName + resolved clientId', () => {
    expect(ConnectionManager.formatUserLabel({
      userName: '  alice  ',
      clientId: 'desk 01',
    })).toBe('alice@desk-01');
  });

  it('formatUserLabel falls back when values are blank', () => {
    const label = ConnectionManager.formatUserLabel({ userName: '   ', clientId: '   ' });
    const [name, id] = label.split('@');
    expect(name).toBeTruthy();
    expect(id).toBeTruthy();
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(id).not.toMatch(/^-|-$/);
  });
});

// ─── startRpcSession: daemon-reuse vault-root validation (#355) ───────────────
// Pins the branch the connect e2e does NOT exercise (it always
// fresh-deploys): reuse-on-match, kill+redeploy-on-mismatch, and the
// `reused.info.vaultRoot ?? ''` guard against an old daemon omitting
// the field.

describe('ConnectionManager.startRpcSession — daemon-reuse vault-root guard', () => {
  const tryReuse = vi.mocked(tryReuseExistingDaemon);
  const estRpc = vi.mocked(establishRpcConnection);

  const HOME = '/home/souta';
  const profile = { id: 'p', name: 'P', remotePath: '~/work' } as unknown as SshProfile;

  function makeClient() {
    return {
      getRemoteHome: vi.fn().mockResolvedValue(HOME),
      openUnixStream: vi.fn().mockResolvedValue({}),
    } as unknown as ConstructorParameters<typeof ConnectionManager>[0];
  }
  function makeMgr(deps: Partial<ConnectionDeps> = {}) {
    return new ConnectionManager(makeClient(), {
      locateDaemonBinary: () => '/local/daemon',
      ensureDaemonBinary: vi.fn().mockResolvedValue(null),
      onRpcClose: vi.fn(),
      ...deps,
    });
  }
  /**
   * Shaped like a real `RpcConnectionHandle`, `rpc.onClose` included.
   *
   * It was missing once, and the omission was not neutral: subscribing to
   * that is how the manager notices a daemon dying under a healthy SSH
   * session, and a fake without it cannot tell whether the manager does.
   */
  function reusedConn(vaultRoot: string | undefined) {
    return {
      info: { version: '0', protocolVersion: 1, capabilities: [], vaultRoot },
      rpc: { onClose: vi.fn().mockReturnValue(() => { /* unsubscribe */ }) },
      close: vi.fn(),
    };
  }

  beforeEach(() => {
    tryReuse.mockReset();
    estRpc.mockReset();
    deployMock.mockReset();
    deployMock.mockResolvedValue({ token: 'tok', remoteSocketPath: 'sock' });
    estRpc.mockResolvedValue({
      info: { version: '0', protocolVersion: 1, capabilities: [], vaultRoot: `${HOME}/work` },
      // Real handles carry this, and the manager subscribes to it to notice
      // a daemon dying under a healthy SSH session.
      rpc: { onClose: vi.fn().mockReturnValue(() => { /* unsubscribe */ }) },
      close: vi.fn(),
    } as never);
  });

  it('reuses the daemon when its vaultRoot matches the profile root (no redeploy)', async () => {
    const reused = reusedConn(`${HOME}/work`); // resolveRemotePath('work', HOME) === /home/souta/work
    tryReuse.mockResolvedValue(reused as never);
    const mgr = makeMgr();

    await mgr.startRpcSession(profile, 'work');

    expect(mgr.rpcConnection).toBe(reused);
    expect(deployMock).not.toHaveBeenCalled();
    expect(reused.close).not.toHaveBeenCalled();
  });

  it('closes the stale daemon and redeploys at the correct root on mismatch', async () => {
    const reused = reusedConn(`${HOME}/work/OldVaultDev`); // different root
    tryReuse.mockResolvedValue(reused as never);
    const mgr = makeMgr();

    await mgr.startRpcSession(profile, 'work');

    expect(reused.close).toHaveBeenCalledTimes(1);
    expect(deployMock).toHaveBeenCalledTimes(1);
    // deploy() must get the ABSOLUTE resolved root, not the relative form.
    expect(deployMock.mock.calls[0][0]).toMatchObject({
      remoteVaultRoot: `${HOME}/work`,
    });
  });

  it('treats an absent vaultRoot (old/3rd-party daemon) as a mismatch — redeploys, no throw', async () => {
    const reused = reusedConn(undefined); // `?? ''` guard path
    tryReuse.mockResolvedValue(reused as never);
    const mgr = makeMgr();

    await expect(mgr.startRpcSession(profile, 'work')).resolves.toBeUndefined();
    expect(reused.close).toHaveBeenCalledTimes(1);
    expect(deployMock).toHaveBeenCalledTimes(1);
  });

  it('deploys fresh when there is no daemon to reuse', async () => {
    tryReuse.mockResolvedValue(null);
    const mgr = makeMgr();

    await mgr.startRpcSession(profile, 'work');

    expect(deployMock).toHaveBeenCalledTimes(1);
    expect(deployMock.mock.calls[0][0]).toMatchObject({ remoteVaultRoot: `${HOME}/work` });
  });
});

// ─── startRpcSession: daemon binary fallback (#397) ──────────────────────────
// The community-store path: no binary staged locally → download one via the
// injected `ensureDaemonBinary`. Pins `locateDaemonBinary() ?? ensureDaemonBinary()`
// and the DaemonUnavailableError → SFTP-downgrade signal, neither of which the
// existing reuse tests exercise (they always have a staged '/local/daemon').

describe('ConnectionManager.startRpcSession — daemon binary fallback (#397)', () => {
  const tryReuse = vi.mocked(tryReuseExistingDaemon);
  const estRpc = vi.mocked(establishRpcConnection);
  const HOME = '/home/souta';
  const profile = { id: 'p', name: 'P', remotePath: '~/work' } as unknown as SshProfile;

  function makeClient() {
    return {
      getRemoteHome: vi.fn().mockResolvedValue(HOME),
      openUnixStream: vi.fn().mockResolvedValue({}),
    } as unknown as ConstructorParameters<typeof ConnectionManager>[0];
  }

  beforeEach(() => {
    tryReuse.mockReset();
    estRpc.mockReset();
    deployMock.mockReset();
    deployMock.mockResolvedValue({ token: 'tok', remoteSocketPath: 'sock' });
    estRpc.mockResolvedValue({
      info: { version: '0', protocolVersion: 1, capabilities: [], vaultRoot: `${HOME}/work` },
      // Real handles carry this, and the manager subscribes to it to notice
      // a daemon dying under a healthy SSH session.
      rpc: { onClose: vi.fn().mockReturnValue(() => { /* unsubscribe */ }) },
      close: vi.fn(),
    } as never);
    tryReuse.mockResolvedValue(null); // always fresh-deploy
  });

  it('downloads via ensureDaemonBinary when no binary is staged, then deploys that path', async () => {
    const downloaded = '/cache/server-bin/obsidian-remote-server-linux-amd64';
    const ensureDaemonBinary = vi.fn().mockResolvedValue(downloaded);
    const mgr = new ConnectionManager(makeClient(), { locateDaemonBinary: () => null, ensureDaemonBinary, onRpcClose: vi.fn() });

    await mgr.startRpcSession(profile, 'work');

    expect(ensureDaemonBinary).toHaveBeenCalledTimes(1);
    expect(deployMock.mock.calls[0][0]).toMatchObject({ localBinaryPath: downloaded });
  });

  it('throws DaemonUnavailableError (→ SFTP downgrade) when neither staged nor downloaded binary exists', async () => {
    const ensureDaemonBinary = vi.fn().mockResolvedValue(null);
    const mgr = new ConnectionManager(makeClient(), { locateDaemonBinary: () => null, ensureDaemonBinary, onRpcClose: vi.fn() });

    await expect(mgr.startRpcSession(profile, 'work')).rejects.toBeInstanceOf(DaemonUnavailableError);
    expect(deployMock).not.toHaveBeenCalled();
  });

  it('does NOT call ensureDaemonBinary when a binary is staged locally (dev build)', async () => {
    const ensureDaemonBinary = vi.fn().mockResolvedValue(null);
    const mgr = new ConnectionManager(makeClient(), { locateDaemonBinary: () => '/local/daemon', ensureDaemonBinary, onRpcClose: vi.fn() });

    await mgr.startRpcSession(profile, 'work');

    expect(ensureDaemonBinary).not.toHaveBeenCalled();
    expect(deployMock.mock.calls[0][0]).toMatchObject({ localBinaryPath: '/local/daemon' });
  });

  it('#406 I-1: a reconnect downgrades to SFTP when the daemon is unavailable (does NOT throw into the retry loop)', async () => {
    const ensureDaemonBinary = vi.fn().mockResolvedValue(null);
    const client = { isAlive: vi.fn().mockReturnValue(true) } as unknown as ConstructorParameters<typeof ConnectionManager>[0];
    const mgr = new ConnectionManager(client, { locateDaemonBinary: () => null, ensureDaemonBinary, onRpcClose: vi.fn() });
    // reconnectAttempt reads activeProfile; seed an RPC one directly.
    (mgr as unknown as { activeProfile: SshProfile }).activeProfile = { ...profile, transport: 'rpc' } as SshProfile;
    const hooks = {
      rebind: vi.fn(),
      prepareListenerForReconnect: vi.fn(),
      resumeListenerAfterReconnect: vi.fn(),
    };

    // reconnectAttempt is private — invoke via cast. It must RESOLVE, not
    // reject: a DaemonUnavailableError on reconnect is caught and the session
    // continues on SFTP, rather than bubbling to ReconnectManager's retry loop
    // (which would burn maxRetries and surface a misleading "reconnect failed"
    // instead of switching to SFTP).
    await expect(
      (mgr as unknown as { reconnectAttempt(h: typeof hooks): Promise<void> }).reconnectAttempt(hooks),
    ).resolves.toBeUndefined();

    expect(ensureDaemonBinary).toHaveBeenCalledTimes(1);
    expect(mgr.rpcConnection).toBeNull();              // stayed on SFTP
    expect(hooks.rebind).toHaveBeenCalledTimes(1); // rebound to the SFTP fs client AND its prefix
  });
});

// ─── startRpcSession: the RPC wire's own death ───────────────────────────────
// Reconnect is driven off SftpClient's close, which only fires when SSH goes.
// A daemon killed under a healthy session took the RPC channel with it and
// nothing noticed: no reconnect, no notice, no log — while every later file
// operation failed on its own with "stream is closed" and the status bar
// still said connected.

describe('ConnectionManager — a daemon that dies under a healthy SSH session', () => {
  const tryReuse = vi.mocked(tryReuseExistingDaemon);
  const estRpc = vi.mocked(establishRpcConnection);
  const HOME = '/home/souta';
  const profile = { id: 'p', name: 'P', remotePath: '~/work' } as unknown as SshProfile;

  function makeClient() {
    return {
      getRemoteHome: vi.fn().mockResolvedValue(HOME),
      openUnixStream: vi.fn().mockResolvedValue({}),
      isAlive: vi.fn().mockReturnValue(true),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConstructorParameters<typeof ConnectionManager>[0];
  }

  /** Captures the handler the manager subscribes with, so we can fire it. */
  function handleWithCapturedCloseHandler() {
    let fire: ((err?: Error) => void) | undefined;
    const handle = {
      info: { version: '0', protocolVersion: 1, capabilities: [], vaultRoot: `${HOME}/work` },
      rpc: {
        onClose: vi.fn((h: (err?: Error) => void) => { fire = h; return () => { /* unsub */ }; }),
      },
      close: vi.fn(),
    };
    return { handle, fire: (err?: Error) => fire?.(err) };
  }

  beforeEach(() => {
    tryReuse.mockReset();
    estRpc.mockReset();
    deployMock.mockReset();
    deployMock.mockResolvedValue({ token: 'tok', remoteSocketPath: 'sock' });
  });

  it('tells its owner when the wire dies on a freshly deployed daemon', async () => {
    const onRpcClose = vi.fn();
    const { handle, fire } = handleWithCapturedCloseHandler();
    tryReuse.mockResolvedValue(null);
    estRpc.mockResolvedValue(handle as never);

    const mgr = new ConnectionManager(makeClient(), {
      locateDaemonBinary: () => '/local/daemon',
      ensureDaemonBinary: vi.fn().mockResolvedValue(null),
      onRpcClose,
    });
    await mgr.startRpcSession(profile, 'work');

    expect(handle.rpc.onClose, 'the manager must subscribe').toHaveBeenCalledTimes(1);
    fire(new Error('daemon went away'));
    expect(onRpcClose).toHaveBeenCalledTimes(1);
    // The owner turns this into what the user is told, so it has to arrive.
    expect(onRpcClose.mock.calls[0][0]).toMatchObject({ message: 'daemon went away' });
  });

  it('tells its owner just the same when the daemon was reused', async () => {
    // The commonest case in a long session — reconnecting to a daemon that
    // is already up takes an entirely different branch, and watching only
    // the fresh one would leave this as silent as before.
    const onRpcClose = vi.fn();
    const { handle, fire } = handleWithCapturedCloseHandler();
    tryReuse.mockResolvedValue(handle as never);

    const mgr = new ConnectionManager(makeClient(), {
      locateDaemonBinary: () => '/local/daemon',
      ensureDaemonBinary: vi.fn().mockResolvedValue(null),
      onRpcClose,
    });
    await mgr.startRpcSession(profile, 'work');

    expect(deployMock, 'this is the reuse branch').not.toHaveBeenCalled();
    fire();
    expect(onRpcClose).toHaveBeenCalledTimes(1);
  });

  it('starts a heartbeat, and stops it when we disconnect', async () => {
    // The wire closing is the loud case. The quiet one — a daemon that is
    // still there as far as TCP is concerned but has stopped answering —
    // only surfaces if something is asking. And a heartbeat still running
    // after a disconnect would probe a wire nobody owns any more.
    vi.useFakeTimers();
    try {
      const onRpcClose = vi.fn();
      const { handle } = handleWithCapturedCloseHandler();
      const call = vi.fn().mockResolvedValue({ ok: true });
      const rpc = {
        ...handle.rpc,
        call,
        msSinceLastMessage: () => 10 * 60_000, // long quiet
        pendingCount: () => 0,                 // and idle
      };
      const conn = { ...handle, rpc };
      tryReuse.mockResolvedValue(null);
      estRpc.mockResolvedValue(conn as never);

      const mgr = new ConnectionManager(makeClient(), {
        locateDaemonBinary: () => '/local/daemon',
        ensureDaemonBinary: vi.fn().mockResolvedValue(null),
        onRpcClose,
      });
      await mgr.startRpcSession(profile, 'work');

      await vi.advanceTimersByTimeAsync(60_000);
      expect(call, 'nothing would ever ask otherwise').toHaveBeenCalledWith('server.info', {});

      const before = call.mock.calls.length;
      await mgr.disconnectTransport();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(call.mock.calls.length, 'a disconnected wire must not be probed').toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the quiet death too, and says what it was', async () => {
    // The heartbeat test above proves a probe goes out. Nothing proved what
    // happens when the probes stop coming back: `onDead` reached the owner
    // through a line no test executed, so the quiet failure — the machine
    // that slept, the process the OOM killer took — was wired up on trust.
    vi.useFakeTimers();
    try {
      const onRpcClose = vi.fn();
      const { handle } = handleWithCapturedCloseHandler();
      const call = vi.fn().mockRejectedValue(new Error('no answer'));
      const conn = {
        ...handle,
        rpc: {
          ...handle.rpc,
          call,
          msSinceLastMessage: () => 10 * 60_000, // long quiet
          pendingCount: () => 0,                 // and idle
        },
      };
      tryReuse.mockResolvedValue(null);
      estRpc.mockResolvedValue(conn as never);

      const mgr = new ConnectionManager(makeClient(), {
        locateDaemonBinary: () => '/local/daemon',
        ensureDaemonBinary: vi.fn().mockResolvedValue(null),
        onRpcClose,
      });
      await mgr.startRpcSession(profile, 'work');

      // Three misses at a 10s tick; 60s leaves room without depending on
      // the exact schedule.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(onRpcClose, 'a daemon that stops answering is a lost connection')
        .toHaveBeenCalledTimes(1);
      expect(onRpcClose.mock.calls[0][0]).toMatchObject({
        message: expect.stringContaining('stopped answering') as unknown as string,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays quiet when WE are the ones hanging up', async () => {
    // Otherwise a manual Disconnect, and every pass of the reconnect loop,
    // would each kick off a reconnect of their own.
    const onRpcClose = vi.fn();
    const { handle } = handleWithCapturedCloseHandler();
    handle.close = vi.fn(() => {
      // A real close reaches the same handler, synchronously — that is the
      // point of the framing fix this guards.
      handle.rpc.onClose.mock.calls[0][0](undefined);
    });
    tryReuse.mockResolvedValue(null);
    estRpc.mockResolvedValue(handle as never);

    const mgr = new ConnectionManager(makeClient(), {
      locateDaemonBinary: () => '/local/daemon',
      ensureDaemonBinary: vi.fn().mockResolvedValue(null),
      onRpcClose,
    });
    await mgr.startRpcSession(profile, 'work');
    await mgr.disconnectTransport();

    expect(handle.close).toHaveBeenCalled();
    expect(onRpcClose, 'our own disconnect is not a lost connection').not.toHaveBeenCalled();
  });
});

// ─── the reconnect lifecycle ─────────────────────────────────────────────────
//
// `startReconnect` and `cancelReconnect` are reached only from `main.ts`,
// which is excluded from coverage — so measured across BOTH suites, neither
// had ever run. `main.ts` calls `startReconnect` from two places and
// `cancelReconnect` from three, which is exactly why its guards matter.

describe('ConnectionManager — starting and cancelling a reconnect', () => {
  const profile = { id: 'p', name: 'P', remotePath: '~/work' } as unknown as SshProfile;

  function aliveClient() {
    return {
      getRemoteHome: vi.fn().mockResolvedValue('/home/souta'),
      openUnixStream: vi.fn().mockResolvedValue({}),
      isAlive: () => true,
      connect: vi.fn(),
    } as unknown as ConstructorParameters<typeof ConnectionManager>[0];
  }

  function reconnectable(withProfile = true) {
    const mgr = new ConnectionManager(aliveClient(), {
      locateDaemonBinary: () => '/local/daemon',
      ensureDaemonBinary: vi.fn().mockResolvedValue(null),
      onRpcClose: vi.fn(),
    });
    if (withProfile) (mgr as unknown as { activeProfile: unknown }).activeProfile = profile;
    return mgr;
  }

  function opts(over: Record<string, unknown> = {}) {
    return {
      maxRetries: 3,
      setAdapterReconnecting: vi.fn(),
      onState: vi.fn(),
      hooks: {
        rebind: vi.fn(),
        prepareListenerForReconnect: vi.fn(),
        resumeListenerAfterReconnect: vi.fn().mockResolvedValue(undefined),
      },
      ...over,
    } as unknown as Parameters<ConnectionManager['startReconnect']>[0];
  }

  it('does not start without a profile to reconnect to', async () => {
    const mgr = reconnectable(false);
    const o = opts();

    await mgr.startReconnect(o);

    expect(o.setAdapterReconnecting).not.toHaveBeenCalled();
  });

  it('respects the user turning auto-reconnect off', async () => {
    // reconnectMaxRetries <= 0 is the setting for "leave it to me".
    const mgr = reconnectable();
    const o = opts({ maxRetries: 0 });

    await mgr.startReconnect(o);

    expect(o.setAdapterReconnecting).not.toHaveBeenCalled();
  });

  it('tells the adapter it is reconnecting before the loop runs', async () => {
    // This is what parks a read instead of failing it — without it, every
    // in-flight read during a drop surfaces as an error to the user.
    const mgr = reconnectable();
    const o = opts({ maxRetries: 1 });

    await mgr.startReconnect(o);

    expect(o.setAdapterReconnecting).toHaveBeenCalledWith(true);
  });

  it('ignores a second start while a loop is already running', async () => {
    // `main.ts` fires this from two places; two loops would race each other
    // through the same transport.
    const mgr = reconnectable();
    let release!: () => void;
    const hung = new Promise<void>((r) => { release = r; });
    const o = opts({
      hooks: {
        rebind: vi.fn(),
        prepareListenerForReconnect: () => hung,   // never settles until released
        resumeListenerAfterReconnect: vi.fn().mockResolvedValue(undefined),
      },
    });
    const first = mgr.startReconnect(o);
    await Promise.resolve();

    await mgr.startReconnect(o);   // returns at once

    expect(o.setAdapterReconnecting).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('reports liveness from the underlying client, not its own guesswork', () => {
    // `main.ts` gates the Reconnect command on this; a stale local flag would
    // either hide the command when it is needed or offer it when it is not.
    const client = aliveClient() as unknown as { isAlive: () => boolean };
    const mgr = new ConnectionManager(client as never, {
      locateDaemonBinary: () => '/local/daemon',
      ensureDaemonBinary: vi.fn().mockResolvedValue(null),
      onRpcClose: vi.fn(),
    });
    expect(mgr.isAlive()).toBe(true);

    client.isAlive = () => false;
    expect(mgr.isAlive()).toBe(false);
  });

  it('cancelling when nothing is running is harmless', () => {
    // `main.ts` calls this on every disconnect, reconnect and unload.
    const mgr = reconnectable();

    expect(() => mgr.cancelReconnect()).not.toThrow();
  });

  it('cancelling clears the loop so the next one can start', async () => {
    const mgr = reconnectable();
    let release!: () => void;
    const hung = new Promise<void>((r) => { release = r; });
    const o = opts({
      hooks: {
        rebind: vi.fn(),
        prepareListenerForReconnect: () => hung,
        resumeListenerAfterReconnect: vi.fn().mockResolvedValue(undefined),
      },
    });
    const first = mgr.startReconnect(o);
    void first.catch(() => { /* the cancelled loop's fate is not this test's */ });
    await Promise.resolve();

    mgr.cancelReconnect();

    // Deliberately not awaiting the cancelled loop: the claim is that
    // cancelling CLEARS the registration, so the next start is not blocked
    // by it — not that the in-flight attempt unwinds promptly.
    const second = opts({ maxRetries: 1 });
    await mgr.startReconnect(second);
    expect(second.setAdapterReconnecting).toHaveBeenCalledWith(true);
    release();
  });
});
