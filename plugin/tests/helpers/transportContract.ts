import { describe, it, expect } from 'vitest';
import type { Duplex } from 'stream';
import type { Transport, TransportTarget } from '../../src/ssh/Transport';

/**
 * The `Transport` contract, asserted against an implementation.
 *
 * ssh2 takes the stream a transport returns and treats it as a socket, and
 * `SftpClient` reconnects on the `close` ssh2 relays from it. Before this
 * suite the contract was written down nowhere, and BOTH implementations
 * turned out to break it: `ProxyCommandTunnel` pushed EOF without closing
 * (87 days of silent disconnects), and `JumpHostTunnel` did the same
 * whenever the target died behind a healthy bastion — which no test had
 * ever tried, because the only one that dropped a jump session dropped the
 * bastion, and that tears every channel down and hides the case.
 *
 * Call this from a test file per implementation. `makeHarness` supplies a
 * transport already pointed at a far end the test can control.
 */
export interface TransportHarness {
  transport: Transport;
  target: TransportTarget;
  /** The peer hangs up the way a server exiting does. */
  hangUp(): Promise<void>;
  /** The peer dies abnormally — a crash, a kill. */
  killAbnormally(): Promise<void>;
  /**
   * Whether this route can tell an abnormal end from a clean one.
   *
   * A ProxyCommand can: it sees its child's exit code and stderr. A
   * bastion cannot: SSH's `direct-tcpip` carries no reason, so the channel
   * simply closes whether the target exited or was killed. Declaring that
   * here keeps the obligation strong for routes that can, and records the
   * limit for the one that cannot — rather than quietly weakening it for
   * everyone.
   */
  canNameAbnormalCause?: boolean;
  /** Send bytes from the far end, to check they arrive before `close`. */
  send(bytes: string): Promise<void>;
  cleanup(): Promise<void>;
}

/** Resolves on the first of the named events, or `'none'` after `ms`. */
function firstOf(stream: Duplex, events: string[], ms = 3_000): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('none'), ms);
    for (const e of events) {
      stream.once(e, () => { clearTimeout(timer); resolve(e); });
    }
  });
}

export function describeTransportContract(
  name: string,
  makeHarness: () => Promise<TransportHarness>,
  opts: {
    /**
     * Why this route cannot be exercised here. Visible in the test name
     * rather than absent from the run: a contract suite that quietly does
     * not run reads as coverage.
     */
    skip?: string;
  } = {},
): void {
  const suite = opts.skip ? describe.skip : describe;
  const title = opts.skip
    ? `${name} — Transport contract (skipped: ${opts.skip})`
    : `${name} — Transport contract`;
  suite(title, () => {
    it('reaches close when the far end hangs up', async () => {
      // The one that cost 87 days: `end` alone leaves ssh2 believing the
      // session is live, because only `close` reaches its `Client`.
      const h = await makeHarness();
      try {
        const stream = await h.transport.open(h.target);
        stream.on('error', () => { /* an abnormal end is a separate case */ });
        stream.resume();
        const closed = firstOf(stream, ['close']);
        await h.hangUp();
        await expect(closed).resolves.toBe('close');
      } finally {
        await h.cleanup();
      }
    });

    it('ends before it closes, so delivered bytes are still readable', async () => {
      const h = await makeHarness();
      try {
        const stream = await h.transport.open(h.target);
        stream.on('error', () => { /* as above */ });
        const order: string[] = [];
        stream.on('end', () => order.push('end'));
        stream.on('close', () => order.push('close'));
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.resume();

        await h.send('SSH-2.0-Contract\r\n');
        await h.hangUp();
        await firstOf(stream, ['close']);

        expect(Buffer.concat(chunks).toString('utf8'),
          'bytes sent before the hang-up must survive it')
          .toContain('SSH-2.0-Contract');
        expect(order, 'end must precede close').toEqual(['end', 'close']);
      } finally {
        await h.cleanup();
      }
    });

    it('reports an abnormal end as best this route can', async () => {
      // A silent close is reserved for "the peer hung up cleanly". Anything
      // else has a reason, and without it ssh2 can only say "connection
      // lost" — so a route that CAN name the cause must.
      //
      // A route that cannot still owes the close: reconnecting without
      // knowing why beats not reconnecting.
      const h = await makeHarness();
      const canName = h.canNameAbnormalCause !== false;
      try {
        const stream = await h.transport.open(h.target);
        stream.on('error', () => { /* asserted via firstOf below */ });
        stream.resume();
        const outcome = firstOf(stream, canName ? ['error'] : ['close']);
        await h.killAbnormally();
        await expect(outcome).resolves.toBe(canName ? 'error' : 'close');
      } finally {
        await h.cleanup();
      }
    });

    it('closes at most once, however many times it is destroyed', async () => {
      const h = await makeHarness();
      try {
        const stream = await h.transport.open(h.target);
        stream.on('error', () => { /* destroy() may surface one */ });
        stream.resume();
        let closes = 0;
        stream.on('close', () => { closes++; });

        stream.destroy();
        stream.destroy();
        await new Promise((r) => setTimeout(r, 200));

        expect(closes).toBe(1);
      } finally {
        await h.cleanup();
      }
    });

    it('reaps what it started, so nothing outlives the stream', async () => {
      // A transport owns its child process / jump client / socket, and the
      // caller holds no second handle — so if the stream does not reap it,
      // nobody will. `cleanup` is what notices.
      const h = await makeHarness();
      try {
        const stream = await h.transport.open(h.target);
        stream.on('error', () => { /* teardown may surface one */ });
        stream.resume();
        stream.destroy();
        await firstOf(stream, ['close']);
      } finally {
        await h.cleanup();
      }
    });
  });
}
