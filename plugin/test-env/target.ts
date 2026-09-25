import * as path from 'node:path';

/**
 * The single answer to "which sshd am I talking to". `ORSSH_TEST_ENV`
 * picks; `tests/integration/` and `e2e/` both read it rather than naming a
 * host, so the same tests can be aimed elsewhere without editing a test.
 *
 *   local (default)  docker-compose.yml          published on 127.0.0.1:2222
 *   tailnet          docker-compose.tailnet.yml  MagicDNS over WireGuard,
 *                                                via a SOCKS5 ProxyCommand
 *
 * Rationale and setup: docs/en/contributing/testing-strategy.md.
 *
 * Spread `targetConnection()` into any profile you add here, even one you
 * believe nothing dials — two such profiles kept working copies of
 * `127.0.0.1` alive through the first pass of this refactor.
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

/** Quoted: the line goes to `sh -c`, and the repo path may contain spaces. */
const TAILNET_PROXY_COMMAND =
  `node "${path.join(repoRoot, 'plugin', 'scripts', 'socks5-connect.mjs')}" %h %p`;

/**
 * Capabilities and budgets, deliberately not a name: a caller that asks
 * "can this link be shaped?" keeps working when a third environment
 * appears, and `Record<TestEnvName, …>` makes the compiler demand every
 * field for it. A caller that asks "is this the tailnet?" does not.
 */
interface TestTarget {
  host: string;
  port: number;
  /** Set only where the host is not directly reachable. */
  proxyCommand?: string;
  /** Named differently per environment; `netem` and `certificate-auth` need it. */
  sshdContainer: string;
  /** A proxy process plus a WireGuard path does not fit a local port's budget. */
  connectTimeoutMs: number;
  /** Whether `tc` can shape this link — i.e. whether its sshd has NET_ADMIN. */
  canShapeLink: boolean;
  /** The npm script that brings this environment up, for "run X first" errors. */
  startCommand: string;
  /**
   * Just sshd, for the reconnect spec — never the whole environment. Taking
   * the tailnet down would take headscale with it, and a node that loses
   * its control connection never comes back (testing-strategy.md).
   */
  sshdStopCommand: string;
  sshdStartCommand: string;
}

const TARGETS: Record<TestEnvName, TestTarget> = {
  local: {
    host: '127.0.0.1',
    port: 2222,
    sshdContainer: 'obsidian-remote-ssh-test-sshd',
    connectTimeoutMs: 10_000,
    canShapeLink: true,
    startCommand: 'npm run sshd:start',
    // Unchanged from what the reconnect spec has always run here, so its
    // behaviour in this environment stays exactly what it was.
    sshdStopCommand: 'npm run sshd:stop',
    sshdStartCommand: 'npm run sshd:start',
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
    // Just this container. `tailnet:stop` would take headscale with it, and
    // a node that loses its control connection over plain HTTP retries on
    // 443 and never comes back — the tailnet would not survive the drop the
    // spec is trying to simulate. Stopping sshd leaves the node, the mesh
    // and the network namespace it listens in untouched.
    sshdStopCommand: 'docker stop orst-tailnet-sshd',
    sshdStartCommand: 'docker start orst-tailnet-sshd',
  },
};

const target = TARGETS[TEST_ENV];

export const TEST_HOST = target.host;
export const TEST_PORT = target.port;
export const TEST_PROXY_COMMAND = target.proxyCommand;
export const SSHD_CONTAINER = target.sshdContainer;
export const CAN_SHAPE_LINK = target.canShapeLink;
export const START_COMMAND = target.startCommand;
export const SSHD_STOP_COMMAND = target.sshdStopCommand;
export const SSHD_START_COMMAND = target.sshdStartCommand;

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
