import { describe, it, expect, vi } from 'vitest';
import { PassThrough, Duplex } from 'stream';
import { FramedDuplex } from '../src/transport/framing';

/**
 * A pair of PassThrough streams wired crossways gives us an in-process
 * Duplex — writes to `local` read from `remote.peer`, and vice versa.
 * Matches the semantics of a TCP socket pair with zero OS overhead.
 */
function duplexPair() {
  const a = new PassThrough();
  const b = new PassThrough();
  // Each side's writes should appear as the other side's reads.
  // A `PassThrough` is a single-channel stream; to get a true duplex
  // we expose one PassThrough per direction.
  return {
    a: combine(a, b),
    b: combine(b, a),
  };
}

/** Cobbled-together Duplex: reads from `inStream`, writes to `outStream`. */
function combine(inStream: PassThrough, outStream: PassThrough) {
  return {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'data' || event === 'end' || event === 'close' || event === 'error') {
        inStream.on(event, listener);
      }
      return this;
    },
    write: (chunk: Buffer) => outStream.write(chunk),
    end: () => { outStream.end(); inStream.end(); },
  } as unknown as import('stream').Duplex;
}

function collectMessages(framed: FramedDuplex): { messages: Buffer[]; closed: boolean; errors: Error[] } {
  const messages: Buffer[] = [];
  const errors: Error[] = [];
  let closed = false;
  framed.on('message', (m: Buffer) => messages.push(m));
  framed.on('close', () => { closed = true; });
  framed.on('error', (e: Error) => errors.push(e));
  return { messages, closed, errors } as { messages: Buffer[]; closed: boolean; errors: Error[] };
}

describe('FramedDuplex', () => {
  it('writes header and body in ONE write (a split frame stalls on Nagle + delayed ACK)', () => {
    const writes: Buffer[] = [];
    const stream = {
      on: () => stream,
      write: (chunk: Buffer) => { writes.push(chunk); return true; },
      end: () => { /* noop */ },
    } as unknown as import('stream').Duplex;
    new FramedDuplex(stream).writeMessage(Buffer.from('{"x":1}', 'utf8'));
    expect(writes).toHaveLength(1);
    expect(writes[0].toString('utf8')).toBe('Content-Length: 7\r\n\r\n{"x":1}');
  });

  it('round-trips a single message across a duplex pair', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const client = new FramedDuplex(pair.b);
    const received: Buffer[] = [];
    server.on('message', (m: Buffer) => received.push(m));

    client.writeMessage(Buffer.from('{"hello":"world"}', 'utf8'));
    await new Promise(r => setImmediate(r));

    expect(received.length).toBe(1);
    expect(received[0].toString('utf8')).toBe('{"hello":"world"}');
  });

  it('parses multiple back-to-back messages off the same stream', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const client = new FramedDuplex(pair.b);
    const received: string[] = [];
    server.on('message', (m: Buffer) => received.push(m.toString('utf8')));

    client.writeMessage(Buffer.from('A', 'utf8'));
    client.writeMessage(Buffer.from('BB', 'utf8'));
    client.writeMessage(Buffer.from('CCC', 'utf8'));
    await new Promise(r => setImmediate(r));

    expect(received).toEqual(['A', 'BB', 'CCC']);
  });

  it('reassembles a message delivered in several small chunks', async () => {
    // Mock a stream where bytes arrive one at a time to hammer the
    // parser's "not enough bytes yet" path.
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const received: Buffer[] = [];
    server.on('message', (m: Buffer) => received.push(m));

    const body = Buffer.from('{"a":1,"b":2}', 'utf8');
    const wire = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
      body,
    ]);
    // Hand-feed the server's input stream one byte at a time.
    const rawIn = (pair.a as unknown as { peer?: never });
    void rawIn;
    for (const byte of wire) {
      (pair.b as unknown as { write(b: Buffer): void }).write(Buffer.from([byte]));
      await new Promise(r => setImmediate(r));
    }
    expect(received.length).toBe(1);
    expect(received[0].equals(body)).toBe(true);
  });

  it('emits an error when Content-Length is missing', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const errors: Error[] = [];
    server.on('error', (e: Error) => errors.push(e));
    (pair.b as unknown as { write(b: Buffer): void }).write(
      Buffer.from('X-Foo: bar\r\n\r\nhi', 'ascii'),
    );
    await new Promise(r => setImmediate(r));
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/Content-Length/);
  });

  it('emits an error when the message exceeds maxMessageBytes', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a, { maxMessageBytes: 10 });
    const errors: Error[] = [];
    server.on('error', (e: Error) => errors.push(e));
    (pair.b as unknown as { write(b: Buffer): void }).write(
      Buffer.from('Content-Length: 500\r\n\r\n', 'ascii'),
    );
    await new Promise(r => setImmediate(r));
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/too large/);
  });

  it('tolerates bare-LF framing (for lenient senders)', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const received: Buffer[] = [];
    server.on('message', (m: Buffer) => received.push(m));
    (pair.b as unknown as { write(b: Buffer): void }).write(
      Buffer.from('Content-Length: 2\n\nok', 'ascii'),
    );
    await new Promise(r => setImmediate(r));
    expect(received.length).toBe(1);
    expect(received[0].toString('utf8')).toBe('ok');
  });

  it('close() refuses subsequent writes', () => {
    const pair = duplexPair();
    const client = new FramedDuplex(pair.b);
    client.close();
    expect(() => client.writeMessage(Buffer.from('x'))).toThrow(/closed/);
  });

  it('close() still tells its listeners, so callers are not left waiting', async () => {
    // `close` is the only way `RpcClient` learns the wire is gone: it is what
    // rejects every in-flight call and fires its own `onClose` handlers.
    //
    // This used to be swallowed. `close()` set the `closed` flag before
    // ending the stream, and the stream's own `end`/`close` then arrived to
    // find that flag already set and bailed — so the event never reached
    // anyone. A disconnect with a request in flight left that promise
    // pending forever: no resolve, no reject, no timeout, nothing.
    const pair = duplexPair();
    const client = new FramedDuplex(pair.b);

    const closed = new Promise<void>((resolve) => client.once('close', resolve));
    client.close();

    await expect(Promise.race([
      closed.then(() => 'told'),
      new Promise((r) => setTimeout(() => r('silent'), 500)),
    ])).resolves.toBe('told');
  });

  it('says so once, however the wire goes down', async () => {
    // Belt and braces on the fix: `close()` followed by the stream's own end
    // must still be one event. A second would have `RpcClient` reject
    // already-rejected calls and re-fire `onClose`, which upstream turns
    // into a second reconnect loop.
    const pair = duplexPair();
    const client = new FramedDuplex(pair.b);

    let count = 0;
    client.on('close', () => { count++; });
    client.close();
    (pair.b as unknown as { end(): void }).end();
    await new Promise((r) => setTimeout(r, 50));

    expect(count).toBe(1);
  });

  it('emits close when stream ends mid-message (partial frame)', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const messages: Buffer[] = [];
    let closed = false;
    const errors: Error[] = [];
    server.on('message', (m: Buffer) => messages.push(m));
    server.on('close', () => { closed = true; });
    server.on('error', (e: Error) => errors.push(e));

    (pair.b as unknown as { write(b: Buffer): void; end(): void }).write(
      Buffer.from('Content-Length: 100\r\n\r\nABC', 'ascii'),
    );
    (pair.b as unknown as { end(): void }).end();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    expect(messages).toHaveLength(0);
    expect(closed).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('handles a zero-length body correctly', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const received: Buffer[] = [];
    server.on('message', (m: Buffer) => received.push(m));

    (pair.b as unknown as { write(b: Buffer): void }).write(
      Buffer.from('Content-Length: 0\r\n\r\n', 'ascii'),
    );
    await new Promise(r => setImmediate(r));

    expect(received).toHaveLength(1);
    expect(received[0].length).toBe(0);
  });

  it('does not emit close twice when stream fires both end and close', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    let closeCount = 0;
    server.on('close', () => { closeCount++; });

    (pair.b as unknown as { end(): void }).end();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    expect(closeCount).toBe(1);
  });
});

describe('FramedDuplex — the progress signals the heartbeat reads', () => {
  // These exist because a pending-call count cannot tell a large transfer from
  // a daemon that has stopped answering: `fs.readBinary` and `fs.writeBinary`
  // carry the whole file in one call. Bytes can tell them apart.

  it('counts from the last inbound byte, not the last whole message', async () => {
    // The property that matters: a partial frame is traffic. A big read is ONE
    // message arriving over many chunks, so anything measuring completed
    // messages would call a working transfer silent.
    // Only Date: faking the whole timer set would stop `setImmediate` too, and
    // the stream's 'data' delivery rides on it.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const stream = new PassThrough();
      const framed = new FramedDuplex(stream);

      vi.advanceTimersByTime(5 * 60_000);
      expect(framed.msSinceLastByte(), 'nothing has arrived yet')
        .toBeGreaterThanOrEqual(5 * 60_000);

      // A header promising more than follows: bytes, but no message.
      const body = Buffer.from('{"jsonrpc":"2.0"', 'utf8');
      stream.write(Buffer.concat([
        Buffer.from(`Content-Length: ${body.length + 100}\r\n\r\n`, 'ascii'),
        body,
      ]));
      await new Promise((resolve) => { setImmediate(resolve); });

      expect(framed.msSinceLastByte(), 'a partial frame still counts as traffic')
        .toBeLessThan(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports what the socket has not flushed yet', async () => {
    // The mirror signal: while this is shrinking we are still uploading, even
    // though the daemon says nothing for the whole of a large write.
    //
    // A Duplex that never completes a write, which is what an SSH channel looks
    // like when its window is full. Not a PassThrough: that is a Transform, so
    // what you write lands on its *readable* side and the writable buffer stays
    // empty — the wrong shape for the question being asked.
    let release: (() => void) | null = null;
    const stalled = new Duplex({
      read() { /* nothing to read */ },
      write(_chunk, _enc, cb) { release = () => cb(); },
    });
    const framed = new FramedDuplex(stalled);

    framed.writeMessage(Buffer.alloc(8 * 1024, 'x'));   // handed straight to _write
    framed.writeMessage(Buffer.alloc(8 * 1024, 'y'));   // has to wait behind it

    const queued = framed.outboundBacklogBytes();
    expect(queued, 'the second frame is still queued').toBeGreaterThan(0);

    release?.();
    await new Promise((resolve) => { setImmediate(resolve); });

    // A decrease is the signal the heartbeat actually consumes, and it is what
    // can be observed here: Node keeps counting a chunk until its write
    // callback returns, so letting one through shrinks the backlog rather than
    // emptying it.
    expect(framed.outboundBacklogBytes(), 'letting one through shrinks it')
      .toBeLessThan(queued);
  });

  it('reports no backlog for a stream that cannot say', () => {
    // ssh2 channels are Duplexes, but the plugin also wraps hand-rolled ones;
    // a missing `writableLength` must read as "nothing queued" rather than NaN,
    // which would make the comparison in the heartbeat always false.
    const { a } = duplexPair();
    const framed = new FramedDuplex(a as never);

    expect(framed.outboundBacklogBytes()).toBe(0);
  });
});
