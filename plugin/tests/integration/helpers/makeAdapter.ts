import {
  TEST_USER, TEST_VAULT, TEST_PRIVATE_KEY, targetConnection,
} from '../../../test-env/target';
import { SftpClient } from '../../../src/ssh/SftpClient';
import { AuthResolver } from '../../../src/ssh/AuthResolver';
import { SecretStore } from '../../../src/ssh/SecretStore';
import { HostKeyStore } from '../../../src/ssh/HostKeyStore';
import { ReadCache } from '../../../src/cache/ReadCache';
import { DirCache } from '../../../src/cache/DirCache';
import { SftpRemoteFsClient } from '../../../src/adapter/SftpRemoteFsClient';
import { SftpDataAdapter } from '../../../src/adapter/SftpDataAdapter';
import { PathMapper } from '../../../src/path/PathMapper';
import type { SshProfile } from '../../../src/types';

/**
 * Connection coordinates for the test sshd. Re-exported from
 * `test-env/target.ts`, which decides between the directly-published
 * container and the one that is only reachable across the test tailnet —
 * see that file for what the environments are and why.
 */
export {
  TEST_HOST, TEST_PORT, TEST_USER, TEST_VAULT, TEST_PRIVATE_KEY,
} from '../../../test-env/target';

/**
 * Build an SSH profile pointed at the test sshd. Each call gets a
 * unique `id` so callers wiring multiple clients don't accidentally
 * share profile-keyed state (host key TOFU bookkeeping, secret refs).
 *
 * `targetConnection()` supplies host/port and, where the environment
 * needs one, a `proxyCommand` — so a test never has to know which
 * environment it is running against.
 */
export function buildTestProfile(label: string): SshProfile {
  return {
    id:                  `integration-${label}`,
    name:                `Docker test sshd (${label})`,
    ...targetConnection(),
    username:            TEST_USER,
    authMethod:          'privateKey',
    privateKeyPath:      TEST_PRIVATE_KEY,
    remotePath:          TEST_VAULT,
    keepaliveIntervalMs: 0,
    keepaliveCountMax:   0,
  };
}

/**
 * One client-side stack: a connected SftpClient, its caches, the
 * PathMapper carrying its clientId, and the SftpDataAdapter wired on
 * top. Bundled together so the test can hold both clients side by
 * side and tear them down cleanly.
 *
 * `vaultRoot` is the per-test-file subdir created in `setupClientPair`;
 * the adapter's `remoteBasePath` is set to this so vault-relative
 * paths the test writes line up under the subdir, not the whole
 * shared `/home/tester/vault/`.
 */
export interface TestClient {
  clientId: string;
  ssh: SftpClient;
  pathMapper: PathMapper;
  adapter: SftpDataAdapter;
  /** Exposed so a test can read hit/eviction counters off the live stack. */
  readCache: ReadCache;
  vaultRoot: string;
  disconnect(): Promise<void>;
}

/**
 * Build a single client stack. Caller is responsible for `disconnect`
 * (the bundled helper makes that a one-liner per client).
 */
export async function makeTestClient(opts: {
  clientId: string;
  /** Absolute remote path the adapter should treat as the vault root. */
  vaultRoot: string;
  /** Label folded into the SshProfile id; just for logging clarity. */
  label?: string;
  /**
   * Read-cache budget. Production uses 64 MiB; a test that wants the
   * cache-overflow regime (more content touched than the cache holds)
   * passes something small rather than seeding gigabytes.
   */
  readCacheBytes?: number;
}): Promise<TestClient> {
  const auth = new AuthResolver(new SecretStore());
  const hostKeys = new HostKeyStore();
  const ssh = new SftpClient(auth, hostKeys);
  await ssh.connect(buildTestProfile(opts.label ?? opts.clientId));

  const fsClient = new SftpRemoteFsClient(ssh);
  const pathMapper = new PathMapper(opts.clientId);

  const readCache = new ReadCache(
    opts.readCacheBytes === undefined ? {} : { maxBytes: opts.readCacheBytes },
  );
  const adapter = new SftpDataAdapter(
    fsClient,
    opts.vaultRoot,
    readCache,
    new DirCache(),
    'integration-vault',
    pathMapper,
    null,  // no ResourceBridge in integration tests
    null,  // no write-conflict prompt
    null,  // no AncestorTracker
    null,  // no OfflineQueue
    '',    // no shadow vault
    null,  // no TransferTracker
  );

  return {
    clientId: opts.clientId,
    ssh,
    pathMapper,
    adapter,
    readCache,
    vaultRoot: opts.vaultRoot,
    async disconnect() {
      try { await ssh.disconnect(); } catch { /* best effort */ }
    },
  };
}

/**
 * Create a unique per-test-file subdir under the shared docker vault,
 * spin up two clients pointed at it with different clientIds, and
 * return them along with a cleanup hook the test's `afterAll` must
 * call. Subdir name folds in a timestamp + random suffix so parallel
 * test files don't trample each other.
 *
 * Both clients connect through a shared `SftpClient` for setup
 * (mkdirp on the subdir + cleanup) plus their own dedicated session
 * for the test itself.
 */
export async function setupClientPair(opts: {
  testLabel: string;
  clientIdA?: string;
  clientIdB?: string;
}): Promise<{
  a: TestClient;
  b: TestClient;
  vaultRoot: string;
  cleanup: () => Promise<void>;
}> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const subdir = `${TEST_VAULT}/multiclient-${opts.testLabel}-${stamp}`;

  // Bootstrap session: just to mkdirp the subdir and (later) tear it
  // down. Kept separate from the per-client sessions so teardown
  // works even if a client's adapter is mid-call.
  const bootAuth = new AuthResolver(new SecretStore());
  const bootSsh  = new SftpClient(bootAuth, new HostKeyStore());
  await bootSsh.connect(buildTestProfile(`${opts.testLabel}-boot`));
  await bootSsh.mkdirp(subdir);

  const a = await makeTestClient({
    clientId:  opts.clientIdA ?? 'alpha',
    vaultRoot: subdir,
    label:     `${opts.testLabel}-a`,
  });
  const b = await makeTestClient({
    clientId:  opts.clientIdB ?? 'beta',
    vaultRoot: subdir,
    label:     `${opts.testLabel}-b`,
  });

  return {
    a, b,
    vaultRoot: subdir,
    async cleanup() {
      await a.disconnect();
      await b.disconnect();
      // Recursive delete via the bootstrap session — the per-test
      // subdir is fully owned by this run, so a coarse rm is fine.
      try { await rmRecursive(bootSsh, subdir); } catch { /* best effort */ }
      try { await bootSsh.disconnect();         } catch { /* best effort */ }
    },
  };
}

/**
 * Walk-and-delete a remote subtree using the SftpClient's primitives.
 * SftpClient doesn't expose a recursive delete, so we DIY it. Order:
 * descend into folders, delete files inside, rmdir on the way out.
 */
async function rmRecursive(ssh: SftpClient, dir: string): Promise<void> {
  let entries;
  try {
    entries = await ssh.list(dir);
  } catch {
    // Already gone, or never existed — nothing to do.
    return;
  }
  for (const e of entries) {
    const child = `${dir}/${e.name}`;
    if (e.isDirectory) {
      await rmRecursive(ssh, child);
    } else {
      try { await ssh.remove(child); } catch { /* keep going */ }
    }
  }
  try { await ssh.rmdir(dir); } catch { /* keep going */ }
}
