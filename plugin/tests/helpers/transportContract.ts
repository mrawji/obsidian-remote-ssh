import { describe, it, expect } from 'vitest';
import type { Duplex } from 'stream';
import type { Transport, TransportTarget } from '../../src/ssh/Transport';

/**
 * The `Transport` contract, asserted against an implementation.
 *
 * ssh2 takes the stream a transport returns and treats it as a socket, and
 * `SftpClient` reconnects on the `close` ssh2 relays from it. Before this
 * suite the contract lived in one implementation's head: `JumpHostTunnel`
 * returns a real ssh2 Channel and satisfied it for free, `ProxyCommandTunnel`
 * hand-rolled a Duplex and did not, and a dropped server went unnoticed
 * behind a ProxyCommand for 87 days.
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
): void {
  describe(`${name} — Transport contract`, () => {
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

    it('names the cause when the end was abnormal', async () => {
      // A silent close is reserved for "the peer hung up cleanly". Anything
      // else has a reason, and without it ssh2 can only say "connection
      // lost".
      const h = await makeHarness();
      try {
        const stream = await h.transport.open(h.target);
        stream.on('error', () => { /* asserted via firstOf below */ });
        stream.resume();
        const outcome = firstOf(stream, ['error']);
        await h.killAbnormally();
        await expect(outcome).resolves.toBe('error');
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
