import type { Duplex } from 'stream';
import type { SshProfile } from '../types';
import type { AuthResolver } from './AuthResolver';
import type { HostKeyStore, HostKeyMismatchHandler } from './HostKeyStore';
import { createJumpTunnel } from './JumpHostTunnel';
import { createProxyCommandTunnel } from './ProxyCommandTunnel';

/**
 * A route to the target host, as a stream ssh2 can speak SSH over.
 *
 * ## The contract
 *
 * ssh2 takes the returned Duplex as its `sock` and treats it as a socket.
 * `SftpClient` reconnects on the `Client`'s `close`, which ssh2 emits only
 * when the sock emits `close` — so an implementation that ends without
 * closing leaves a session looking healthy forever. Not hypothetical:
 * `ProxyCommandTunnel` pushed EOF and never destroyed itself, and a dropped
 * server went unnoticed behind a ProxyCommand for 87 days.
 *
 * An implementation MUST:
 *
 *   1. reject `open()` if the route cannot be established — never resolve a
 *      stream that is already dead;
 *   2. reach `'close'` when the far end goes away, for ANY reason;
 *   3. emit `'end'` before `'close'`, so bytes already delivered are still
 *      readable;
 *   4. emit `'error'` naming the cause when the end was abnormal AND the
 *      route can tell — a ProxyCommand sees its child's exit code and
 *      stderr; a bastion cannot, because `direct-tcpip` carries no reason,
 *      so it owes only the close. Stay silent when the peer merely hung up;
 *   5. own what it started — child process, jump client, socket — and reap
 *      it on `'close'`; the caller holds no second handle;
 *   6. tolerate `destroy()` twice, and emit `'close'` at most once;
 *   7. honour backpressure: stop reading when `push()` returns false.
 *
 * `tests/helpers/transportContract.ts` asserts these against every
 * implementation. Add one there when you add one here.
 */
export interface Transport {
  /** For log lines. */
  readonly name: string;
  open(target: TransportTarget): Promise<Duplex>;
}

export interface TransportTarget {
  host: string;
  port: number;
  user: string;
}

export interface TransportDeps {
  authResolver: AuthResolver;
  hostKeyStore: HostKeyStore;
  hostKeyMismatchHandler?: HostKeyMismatchHandler;
}

/**
 * Which route this profile asks for, or `null` for a direct connection.
 *
 * `null` rather than a `DirectTransport`: direct means ssh2 opening its own
 * socket from the host/port in its config, and wrapping that in a
 * `net.Socket` of ours would change behaviour — TCP options, DNS, timeouts
 * — to buy only uniformity. The two routes we actually build are the two
 * that are boxed.
 */
export function selectTransport(
  profile: SshProfile,
  deps: TransportDeps,
): Transport | null {
  // A bastion wins if both are somehow set: it is the more specific route,
  // and the one whose host key we verify.
  if (profile.jumpHost) return jumpHostTransport(profile, deps);
  if (profile.proxyCommand) return proxyCommandTransport(profile.proxyCommand);
  return null;
}

/**
 * Reach the target through a `direct-tcpip` channel on a bastion.
 *
 * Shares the target's host-key store and mismatch handler, so a compromised
 * bastion is caught the way a compromised target is (#132), and its
 * timings, so both tear down together.
 */
export function jumpHostTransport(profile: SshProfile, deps: TransportDeps): Transport {
  const jump = profile.jumpHost;
  if (!jump) throw new Error('jumpHostTransport: profile has no jumpHost');
  return {
    name: `jump host ${jump.host}`,
    open: (target) => createJumpTunnel(
      jump, target.host, target.port, deps.authResolver,
      {
        hostKeyStore:           deps.hostKeyStore,
        hostKeyMismatchHandler: deps.hostKeyMismatchHandler,
        connectTimeoutMs:       profile.connectTimeoutMs,
        keepaliveIntervalMs:    profile.keepaliveIntervalMs,
      },
    ),
  };
}

/**
 * Reach the target through a subprocess — OpenSSH's `ProxyCommand` (#430):
 * `cloudflared access ssh --hostname %h`, `tailscale nc %h %p`, and so on.
 */
export function proxyCommandTransport(command: string): Transport {
  return {
    name: 'ProxyCommand',
    open: (target) => Promise.resolve(createProxyCommandTunnel(command, {
      host: target.host,
      port: target.port,
      user: target.user,
    })),
  };
}
