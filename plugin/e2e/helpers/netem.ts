import { execFileSync } from 'node:child_process';

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

const CONTAINER = 'obsidian-remote-ssh-test-sshd';
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

function dockerExec(args: string[]): string {
  return execFileSync('docker', ['exec', CONTAINER, ...args], { encoding: 'utf8' }).trim();
}

export function applyNetProfile(p: NetProfile): void {
  // `del` fails when no qdisc is set; that's the state we want anyway.
  try { dockerExec(['tc', 'qdisc', 'del', 'dev', IFACE, 'root']); } catch { /* none set */ }
  if (p.delayMs === null && p.rateMbit === null) return;
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
