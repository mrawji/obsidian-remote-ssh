import { execFileSync, spawnSync } from 'node:child_process';
import type { Duplex } from 'stream';
import { jumpHostTransport } from '../../src/ssh/Transport';
import { AuthResolver } from '../../src/ssh/AuthResolver';
import { SecretStore } from '../../src/ssh/SecretStore';
import { HostKeyStore } from '../../src/ssh/HostKeyStore';
import type { SshProfile } from '../../src/types';
import {
  TEST_HOST, TEST_PORT, TEST_USER, TEST_PRIVATE_KEY, TEST_PROXY_COMMAND, SSHD_CONTAINER,
} from '../../test-env/target';
import { describeTransportContract, type TransportHarness } from '../helpers/transportContract';

/**
 * The same contract, against the other implementation.
 *
 * `tests/Transport.contract.test.ts` runs it against ProxyCommand with a
 * subprocess and a local TCP peer. A bastion needs a real SSH server, so
 * this half lives here: the docker sshd is the jump host, and the far end
 * is a throwaway container running an echo listener on the same network —
 * something the test can hold open, hang up, or kill outright.
 *
 * Writing it found that this route broke the contract too, in the case no
 * test had tried: the target dying behind a HEALTHY bastion. The channel
 * gets EOF and stops there, because the bastion has no reason to close it —
 * so the session looked live indefinitely, exactly as the ProxyCommand one
 * did. The only previous test that dropped a jump session dropped the
 * bastion, which tears every channel down and hides this entirely.
 */

const networkOf = (container: string): string =>
  execFileSync('docker', [
    'inspect', container,
    '--format', '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}',
  ], { encoding: 'utf8' }).trim();

/** Echoes whatever it is sent, line by line, until the container stops. */
const ECHO_LISTENER =
  'use IO::Socket::INET; $|=1;'
  + 'my $s=IO::Socket::INET->new(LocalPort=>9999,Listen=>5,ReuseAddr=>1) or die $!;'
  + 'while(my $c=$s->accept){ $c->autoflush(1); while(my $l=<$c>){ print $c $l; } }';

/**
 * `JumpHostTunnel` dials the bastion directly, so this can only run where
 * the sshd is directly reachable. In the tailnet environment it is behind a
 * ProxyCommand, which this route has no way to use — the same reason
 * `certificate-auth` sits out there.
 */
const SKIP_REASON = TEST_PROXY_COMMAND
  ? 'the bastion is only reachable through a proxy here'
  : undefined;

if (!SKIP_REASON) {
  // Loud rather than silent where it SHOULD run: this file is what holds
  // the bastion route to the contract.
  const dockerUp = !spawnSync('docker', ['version'], { stdio: 'ignore' }).error;
  const sshdUp = dockerUp
    && spawnSync('docker', ['inspect', SSHD_CONTAINER], { stdio: 'ignore' }).status === 0;
  if (!sshdUp) {
    throw new Error(
      `Transport contract (jump host) needs ${SSHD_CONTAINER}. `
      + 'Run `npm run sshd:start` before `npm run test:integration`.',
    );
  }
}

function startPeer(name: string, network: string): void {
  execFileSync('docker', [
    'run', '-d', '--name', name, '--network', network,
    '--entrypoint', 'perl', 'obsidian-remote-ssh-test-sshd:latest',
    '-e', ECHO_LISTENER,
  ], { stdio: 'pipe' });
}

function removePeer(name: string): void {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}

/** Block without a timer; vitest owns the event loop in setup helpers. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Wait until the peer actually accepts a connection.
 *
 * This was a flat 1.5s sleep on the assumption that starting the container is
 * the slow half. That holds on an idle laptop and not on a loaded CI runner,
 * where it buys an intermittent ECONNREFUSED that looks like a transport bug.
 * perl is the container's entrypoint, so it is there to ask with.
 */
function awaitPeer(name: string): void {
  const probe = 'use IO::Socket::INET; exit(IO::Socket::INET->new("localhost:9999") ? 0 : 1)';
  for (let i = 0; i < 50; i++) {
    if (spawnSync('docker', ['exec', name, 'perl', '-e', probe], { stdio: 'ignore' }).status === 0) {
      return;
    }
    pause(200);
  }
  throw new Error(`peer ${name} never accepted a connection`);
}

function jumpProfile(peer: string): SshProfile {
  return {
    id: 'transport-contract',
    name: 'Transport contract (jump)',
    host: peer,
    port: 9999,
    username: TEST_USER,
    authMethod: 'privateKey',
    privateKeyPath: TEST_PRIVATE_KEY,
    remotePath: `/home/${TEST_USER}/vault`,
    connectTimeoutMs: 20_000,
    keepaliveIntervalMs: 0,
    keepaliveCountMax: 0,
    jumpHost: {
      host: TEST_HOST,
      port: TEST_PORT,
      username: TEST_USER,
      authMethod: 'privateKey',
      privateKeyPath: TEST_PRIVATE_KEY,
    },
  } as SshProfile;
}

let peerSeq = 0;

describeTransportContract('jump host', async (): Promise<TransportHarness> => {
  const name = `contract-peer-${process.pid}-${peerSeq++}`;
  const network = networkOf(SSHD_CONTAINER);
  removePeer(name);
  startPeer(name, network);
  awaitPeer(name);

  const inner = jumpHostTransport(jumpProfile(name), {
    authResolver: new AuthResolver(new SecretStore()),
    hostKeyStore: new HostKeyStore(),
  });

  /** Remembered so the harness can write into the live stream. */
  let stream: Duplex | null = null;

  return {
    transport: {
      name: inner.name,
      open: async (target) => { stream = await inner.open(target); return stream; },
    },
    target: { host: name, port: 9999, user: TEST_USER },

    // SSH's `direct-tcpip` carries no reason: the bastion closes the
    // channel whether the target exited or was killed, so this route owes
    // the close and cannot owe the cause.
    canNameAbnormalCause: false,

    async send(bytes: string) {
      // The peer echoes, so "bytes from the far end" is a round trip —
      // stronger than a banner, since it proves both directions carried.
      const echoed = new Promise<void>((resolve) => {
        const onData = (c: Buffer) => {
          if (c.toString('utf8').includes(bytes.trim())) {
            stream?.off('data', onData);
            resolve();
          }
        };
        stream?.on('data', onData);
      });
      stream?.write(bytes);
      await Promise.race([echoed, new Promise((r) => setTimeout(r, 2_000))]);
    },

    async hangUp() {
      // SIGTERM: perl exits, the peer's socket FINs, and the bastion closes
      // the forwarded channel.
      execFileSync('docker', ['stop', '-t', '2', name], { stdio: 'pipe' });
    },

    async killAbnormally() {
      execFileSync('docker', ['kill', '-s', 'KILL', name], { stdio: 'pipe' });
    },

    async cleanup() {
      try { stream?.destroy(); } catch { /* already gone */ }
      removePeer(name);
    },
  };
}, { skip: SKIP_REASON });
