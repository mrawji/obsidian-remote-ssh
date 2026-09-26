import { describe, it, expect, vi } from 'vitest';
import { buildReconnectHooks } from '../src/transport/reconnectHooks';
import type { SftpDataAdapter } from '../src/adapter/SftpDataAdapter';
import type { FsChangeListener } from '../src/vault/FsChangeListener';
import type { RemoteBinding, RpcConnectionHandle } from '../src/ConnectionManager';

/**
 * `rebind` was a one-line lambda inside `main.ts` that nothing executed —
 * replacing it with an empty function left the suite green. What it carries is
 * the vault prefix: lose it on a transport downgrade and writes land beside
 * the vault instead of in it, which is the bug the binding type exists for.
 */

function listener() {
  return {
    prepareForReconnect: vi.fn(),
    resumeAfterReconnect: vi.fn().mockResolvedValue(undefined),
  };
}

const binding = { client: {}, remoteBase: 'work/Vault' } as unknown as RemoteBinding;
const rpcConn = { info: { version: '1' } } as unknown as RpcConnectionHandle;

describe('buildReconnectHooks', () => {
  it('delivers the new binding to the adapter', () => {
    const rebind = vi.fn();
    const hooks = buildReconnectHooks({
      dataAdapter: () => ({ rebind }) as unknown as SftpDataAdapter,
      fsChangeListener: listener() as unknown as FsChangeListener,
    });

    hooks.rebind(binding);

    expect(rebind).toHaveBeenCalledWith(binding);
  });

  it('reads the adapter when called, not when built', () => {
    // `restore()` and a failed reconnect both replace it, and the hooks
    // outlive several attempts — a captured adapter would be stale exactly
    // when it is being used.
    let current: SftpDataAdapter | null = null;
    const hooks = buildReconnectHooks({
      dataAdapter: () => current,
      fsChangeListener: listener() as unknown as FsChangeListener,
    });

    const rebind = vi.fn();
    current = ({ rebind }) as unknown as SftpDataAdapter;
    hooks.rebind(binding);

    expect(rebind).toHaveBeenCalledWith(binding);
  });

  it('does nothing, rather than throwing, once the adapter is gone', () => {
    const hooks = buildReconnectHooks({
      dataAdapter: () => null,
      fsChangeListener: listener() as unknown as FsChangeListener,
    });

    expect(() => hooks.rebind(binding)).not.toThrow();
  });

  it('tells the listener a reconnect is starting', () => {
    const fs = listener();
    const hooks = buildReconnectHooks({
      dataAdapter: () => null,
      fsChangeListener: fs as unknown as FsChangeListener,
    });

    hooks.prepareListenerForReconnect();

    expect(fs.prepareForReconnect).toHaveBeenCalled();
  });

  it('resumes the watch against the new connection and the live adapter', () => {
    const fs = listener();
    const dataAdapter = {} as unknown as SftpDataAdapter;
    const hooks = buildReconnectHooks({
      dataAdapter: () => dataAdapter,
      fsChangeListener: fs as unknown as FsChangeListener,
    });

    return hooks.resumeListenerAfterReconnect(rpcConn).then(() => {
      expect(fs.resumeAfterReconnect).toHaveBeenCalledWith({
        rpcConnection: rpcConn,
        dataAdapter,
      });
    });
  });

  it('skips the watch when the reconnect has already given up', async () => {
    // `restore()` cleared the adapter; there is nothing to point a watch at,
    // and asking the listener anyway would hand it a null.
    const fs = listener();
    const hooks = buildReconnectHooks({
      dataAdapter: () => null,
      fsChangeListener: fs as unknown as FsChangeListener,
    });

    await hooks.resumeListenerAfterReconnect(rpcConn);

    expect(fs.resumeAfterReconnect).not.toHaveBeenCalled();
  });
});
