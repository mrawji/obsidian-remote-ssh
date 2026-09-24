import * as path from 'node:path';

/**
 * Where the test suites point.
 *
 * `tests/integration/` and `e2e/` used to carry their own copies of
 * `127.0.0.1` / `2222`. This module is the single place that answers "which
 * sshd am I talking to", so the same tests can be aimed at a different
 * environment without editing a test.
 *
 * Two of those copies (`config-consistency`, `restart-roundtrip`) were found
 * during review, having survived the first pass — they sat in profiles that
 * `ShadowVaultBootstrap` never dials, so pointing them at a port with
 * nothing behind it changed nothing and nothing failed. A constant that is
 * never used is not harmless: it reads as the address the test connects to,
 * and it is the first thing someone will trust when this file stops
 * matching reality. If you add a profile here, spread `targetConnection()`
 * into it even when you believe nothing will dial it.
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

/**
 * What a caller actually needs to know about an environment.
 *
 * These are capabilities and budgets, not a name. Callers that ask
 * "is this the tailnet?" instead of "can this link be shaped?" have to be
 * found and updated by hand when a third environment appears; callers that
 * read a field get the answer from here, and `Record<TestEnvName, …>` below
 * makes the compiler insist the new environment fills every one in.
 */
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
  /**
   * How long a connect may take. Not a preference: bringing up a proxy
   * process and a WireGuard path before the SSH handshake starts does not
   * fit in the budget a published local port needs.
   */
  connectTimeoutMs: number;
  /** Whether `tc` can shape this link — i.e. whether its sshd has NET_ADMIN. */
  canShapeLink: boolean;
  /** The npm script that brings this environment up, for "run X first" errors. */
  startCommand: string;
}

const TARGETS: Record<TestEnvName, TestTarget> = {
  local: {
    host: '127.0.0.1',
    port: 2222,
    sshdContainer: 'obsidian-remote-ssh-test-sshd',
    connectTimeoutMs: 10_000,
    canShapeLink: true,
    startCommand: 'npm run sshd:start',
  },
  tailnet: {
    // A MagicDNS name, not a `100.x` address: headscale allocates addresses
    // in registration order, so pinning one would make the suite depend on
    // container start order, and would skip name resolution entirely — the
    // part a Tailscale user actually relies on.
    host: 'vault.tailnet.test',
    port: 22,
    proxyCommand: TAILNET_PROXY_COMMAND,
    // sshd shares the tailnet node's network namespace, so `sshd_config`
    // edits land in the right place through this name.
    sshdContainer: 'orst-tailnet-sshd',
    connectTimeoutMs: 30_000,
    // That namespace belongs to an unprivileged tailscale node, so `tc` has
    // no NET_ADMIN to work with.
    canShapeLink: false,
    startCommand: 'npm run tailnet:start',
  },
};

const target = TARGETS[TEST_ENV];

export const TEST_HOST = target.host;
export const TEST_PORT = target.port;
export const TEST_PROXY_COMMAND = target.proxyCommand;
export const SSHD_CONTAINER = target.sshdContainer;
export const CAN_SHAPE_LINK = target.canShapeLink;
export const START_COMMAND = target.startCommand;

/**
 * The connection fields of an `SshProfile` for the current environment.
 * Spread into a profile so a caller never has to know whether this
 * environment needs a proxy, or what it costs to reach.
 *
 * Build profiles with this rather than by hand: a profile assembled from the
 * individual constants is a copy of this function that will not be updated
 * when this one is.
 */
export function targetConnection(): {
  host: string;
  port: number;
  proxyCommand?: string;
  connectTimeoutMs: number;
} {
  return {
    host: TEST_HOST,
    port: TEST_PORT,
    connectTimeoutMs: target.connectTimeoutMs,
    ...(TEST_PROXY_COMMAND ? { proxyCommand: TEST_PROXY_COMMAND } : {}),
  };
}

/** For log lines and skip messages. */
export function describeTarget(): string {
  return TEST_ENV === 'tailnet'
    ? `${TEST_HOST}:${TEST_PORT} over the test tailnet`
    : `${TEST_HOST}:${TEST_PORT}`;
}
