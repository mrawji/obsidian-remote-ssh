import { describe, it, expect, vi } from 'vitest';
import { ConnectionManager } from '../src/ConnectionManager';
import { SftpDataAdapter } from '../src/adapter/SftpDataAdapter';
import { ReadCache } from '../src/cache/ReadCache';
import { DirCache } from '../src/cache/DirCache';
import type { RemoteFsClient } from '../src/adapter/RemoteFsClient';

/**
 * Which client to talk through, and what to join vault-relative paths with,
 * are two halves of one decision — the daemon knows the vault root from its
 * `--vault-root` flag and wants paths relative to it, while SFTP needs the
 * prefix to anchor at the vault.
 *
 * They used to be decided in different places, and only the client was
 * rebound on reconnect. A reconnect CAN change transport: `reconnectAttempt`
 * downgrades to SFTP when the daemon turns out to be unavailable. The
 * adapter then kept the RPC session's empty prefix and addressed the remote
 * home instead of the vault inside it — reads missing, writes landing beside
 * the vault. The reverse direction doubled the prefix.
 *
 * Nothing reported this. It is the same shape as the five silent failures
 * fixed today: the boxes were right, the contract between them was not.
 */

const VAULT = '/home/tester/vault';

function fakeFsClient(label: string): RemoteFsClient {
  return { label } as unknown as RemoteFsClient;
}

/** A ConnectionManager with just enough shape to answer `buildBinding()`. */
function manager(opts: { rpc: boolean; base: string | null }) {
  const mgr = new ConnectionManager(
    {} as unknown as ConstructorParameters<typeof ConnectionManager>[0],
    {
      locateDaemonBinary: () => null,
      ensureDaemonBinary: vi.fn(),
      onRpcClose: vi.fn(),
    },
  );
  mgr.activeRemoteBasePath = opts.base;
  // `rpcConnection` is read-only from outside — closing it has to go through
  // the manager. Reaching the backing field is the test's business, not a
  // reason to reopen it.
  (mgr as unknown as { _rpcConnection: unknown })._rpcConnection = opts.rpc
    ? { rpc: {}, info: { capabilities: [] } }
    : null;
  return mgr;
}

/** The adapter's own path join, reached the way production reaches it. */
function remotePathFor(adapter: SftpDataAdapter, vaultRelative: string): string {
  return (adapter as unknown as { toRemote(p: string): string }).toRemote(vaultRelative);
}

function adapterWith(remoteBase: string): SftpDataAdapter {
  return new SftpDataAdapter(
    fakeFsClient('initial'), remoteBase, new ReadCache(), new DirCache(), 'vault',
  );
}

describe('what a reconnect is allowed to change', () => {
  it('gives RPC an empty prefix and SFTP the vault prefix', () => {
    expect(manager({ rpc: true, base: VAULT }).buildBinding().remoteBase).toBe('');
    expect(manager({ rpc: false, base: VAULT }).buildBinding().remoteBase).toBe(VAULT);
  });

  it('moves the prefix back when a reconnect downgrades RPC to SFTP', () => {
    // The live path: `reconnectAttempt` catches DaemonUnavailableError,
    // leaves `rpcConnection` null, and carries on over SFTP.
    const adapter = adapterWith('');           // as an RPC session left it
    expect(remotePathFor(adapter, 'notes/a.md')).toBe('notes/a.md');

    adapter.rebind(manager({ rpc: false, base: VAULT }).buildBinding());

    expect(remotePathFor(adapter, 'notes/a.md'),
      'without the prefix this writes beside the vault, not into it')
      .toBe(`${VAULT}/notes/a.md`);
  });

  it('drops the prefix when the daemon comes back', () => {
    // The other direction, which doubles paths instead of shortening them:
    // the daemon resolves against its own vault root, so sending the prefix
    // as well yields `<root>/home/tester/vault/notes/a.md`.
    const adapter = adapterWith(VAULT);        // as an SFTP session left it

    adapter.rebind(manager({ rpc: true, base: VAULT }).buildBinding());

    expect(remotePathFor(adapter, 'notes/a.md')).toBe('notes/a.md');
  });

  it('rebinds the client along with the prefix', () => {
    const adapter = adapterWith('');
    const binding = manager({ rpc: false, base: VAULT }).buildBinding();

    adapter.rebind(binding);

    expect((adapter as unknown as { client: RemoteFsClient }).client).toBe(binding.client);
  });

  it('tolerates a session with no base path recorded yet', () => {
    // `activeRemoteBasePath` is null before the first successful connect;
    // an empty prefix is the honest answer, not a crash or "undefined/".
    const adapter = adapterWith(VAULT);

    adapter.rebind(manager({ rpc: false, base: null }).buildBinding());

    expect(remotePathFor(adapter, 'notes/a.md')).toBe('notes/a.md');
  });
});
