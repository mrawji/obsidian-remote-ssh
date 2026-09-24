import { execFileSync } from 'node:child_process';
import { SSHD_CONTAINER as CONTAINER, TEST_ENV } from '../../test-env/target';

/**
 * Network shaping and byte counting for the test sshd container (#513 scale
 * runs). Needs `cap_add: NET_ADMIN` on the sshd service (docker-compose.yml);
 * `tc` comes from the image's iproute2.
 *
 * netem shapes EGRESS only, so the delay applies to server → client traffic.
 * That is the direction the vault's content travels, and a one-way delay of
 * `delayMs` yields a round trip of about `delayMs` because the reverse path is
 * unshaped.
 */

/**
 * The sshd container of whichever environment is selected
 * (`test-env/target.ts`). In the tailnet environment sshd shares the tailnet
 * node's network namespace, so shaping `eth0` there shapes the WireGuard
 * path itself — the link the test means to slow down.
 *
 * Shaping needs `NET_ADMIN`, which only the local environment's sshd has;
 * `applyNetProfile` therefore refuses rather than silently measuring an
 * unshaped link. The unshaped `lan` profile works in both.
 */
export { SSHD_CONTAINER as CONTAINER } from '../../test-env/target';
const IFACE = 'eth0';

export interface NetProfile {
  name: string;
  /** null = leave the link unshaped. */
  delayMs: number | null;
  rateMbit: number | null;
}

export const NET_PROFILES: Record<string, NetProfile> = {
  lan: { name: 'lan', delayMs: null, rateMbit: null },
  // A home connection to a VPS or a university server.
  wan: { name: 'wan', delayMs: 40, rateMbit: 100 },
};

export function dockerExec(args: string[]): string {
  return execFileSync('docker', ['exec', CONTAINER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function applyNetProfile(p: NetProfile): void {
  // `del` fails when no qdisc is set; that's the state we want anyway.
  try { dockerExec(['tc', 'qdisc', 'del', 'dev', IFACE, 'root']); } catch { /* none set */ }
  if (p.delayMs === null && p.rateMbit === null) return;
  if (TEST_ENV === 'tailnet') {
    // The tailnet node runs without NET_ADMIN, so `tc` cannot shape here.
    // Refusing beats continuing: a run that reported "wan" while measuring
    // an unshaped link would be worse than no measurement at all.
    throw new Error(
      `Cannot apply the "${p.name}" net profile in the tailnet environment: ` +
      'its sshd shares a network namespace with an unprivileged tailscale ' +
      'node. Run link-shaping measurements with ORSSH_TEST_ENV=local.',
    );
  }
  const args = ['tc', 'qdisc', 'add', 'dev', IFACE, 'root', 'netem'];
  if (p.delayMs !== null) args.push('delay', `${p.delayMs}ms`);
  if (p.rateMbit !== null) args.push('rate', `${p.rateMbit}mbit`);
  dockerExec(args);
}

export function clearNetProfile(): void {
  try { dockerExec(['tc', 'qdisc', 'del', 'dev', IFACE, 'root']); } catch { /* none set */ }
}

/**
 * Bytes the container has sent since its interface came up: everything the
 * client received, including SSH framing. Diff two readings for one window.
 */
export function containerTxBytes(): number {
  return Number(dockerExec(['cat', `/sys/class/net/${IFACE}/statistics/tx_bytes`]));
}
