import * as path from 'node:path';

/**
 * Where the test suites point.
 *
 * The suites used to carry a copy of `127.0.0.1` / `2222` each — six of them,
 * across `tests/integration/` and `e2e/`. This module is the single place
 * that answers "which sshd am I talking to", so the same tests can be aimed
 * at a different environment without editing a test.
 *
 * ## The environments
 *
 * `local` (default) — `docker-compose.yml`: sshd published straight onto
 * `127.0.0.1:2222`. Fast, and what `npm run test:integration` has always
 * used.
 *
 * `tailnet` — `docker-compose.tailnet.yml`: the *same* sshd image and the
 * *same* keypair, but the container publishes nothing. The only route to
 * port 22 is through a private WireGuard mesh built by a self-hosted
 * headscale control plane, reached from here through a SOCKS5
 * `ProxyCommand`, addressed by its MagicDNS name.
 *
 * Why that second environment exists: `docs/en/cookbook/share-via-tailscale.md`
 * tells users to run their vault over Tailscale, on the argument that the
 * plugin needs no special handling because the host is just an SSH host on a
 * different path. That is a claim about every read, write, watch and
 * reconnect in the suite — not about one connection — so the way to check it
 * is to run the whole suite over that path, which is what
 * `ORSSH_TEST_ENV=tailnet` does.
 *
 * Neither environment needs a Tailscale account, an auth key, or any network
 * beyond pulling images.
 */

export type TestEnvName = 'local' | 'tailnet';

const requested = process.env.ORSSH_TEST_ENV ?? 'local';
if (requested !== 'local' && requested !== 'tailnet') {
  throw new Error(
    `Unknown ORSSH_TEST_ENV "${requested}". Expected "local" or "tailnet".`,
  );
}

export const TEST_ENV: TestEnvName = requested;

/** Repo root: this file lives at `<repo>/plugin/test-env/target.ts`. */
const repoRoot = path.resolve(__dirname, '..', '..');

/** Both environments authenticate with the keypair `sshd:start` generates. */
export const TEST_PRIVATE_KEY = path.join(repoRoot, 'docker', 'keys', 'id_test');
export const TEST_USER = 'tester';
export const TEST_VAULT = `/home/${TEST_USER}/vault`;

/**
 * The `ProxyCommand` that reaches the tailnet, or `undefined` in the local
 * environment. Quoted because the command line is handed to `sh -c` and the
 * repo may live under a path with spaces.
 */
const TAILNET_PROXY_COMMAND =
  `node "${path.join(repoRoot, 'plugin', 'scripts', 'socks5-connect.mjs')}" %h %p`;

interface TestTarget {
  host: string;
  port: number;
  /** Set only where the host is not directly reachable. */
  proxyCommand?: string;
  /**
   * The container running sshd. Tests that reach past the SSH connection —
   * `certificate-auth` rewrites sshd_config, `netem` shapes the link — need
   * to name it, and the two environments name it differently.
   */
  sshdContainer: string;
}

const TARGETS: Record<TestEnvName, TestTarget> = {
  local: {
    host: '127.0.0.1',
    port: 2222,
    sshdContainer: 'obsidian-remote-ssh-test-sshd',
  },
  tailnet: {
    // A MagicDNS name, not a `100.x` address: headscale allocates addresses
    // in registration order, so pinning one would make the suite depend on
    // container start order, and would skip name resolution entirely — the
    // part a Tailscale user actually relies on.
    host: 'vault.tailnet.test',
    port: 22,
    proxyCommand: TAILNET_PROXY_COMMAND,
    // sshd shares the tailnet node's network namespace, so `tc` and
    // `sshd_config` edits both land in the right place through this name.
    sshdContainer: 'orst-tailnet-sshd',
  },
};

const target = TARGETS[TEST_ENV];

export const TEST_HOST = target.host;
export const TEST_PORT = target.port;
export const TEST_PROXY_COMMAND = target.proxyCommand;
export const SSHD_CONTAINER = target.sshdContainer;

/**
 * The connection fields of an `SshProfile` for the current environment.
 * Spread into a profile so a caller never has to know whether this
 * environment needs a proxy.
 */
export function targetConnection(): { host: string; port: number; proxyCommand?: string } {
  return {
    host: TEST_HOST,
    port: TEST_PORT,
    ...(TEST_PROXY_COMMAND ? { proxyCommand: TEST_PROXY_COMMAND } : {}),
  };
}

/** For log lines and skip messages. */
export function describeTarget(): string {
  return TEST_ENV === 'tailnet'
    ? `${TEST_HOST}:${TEST_PORT} over the test tailnet`
    : `${TEST_HOST}:${TEST_PORT}`;
}
