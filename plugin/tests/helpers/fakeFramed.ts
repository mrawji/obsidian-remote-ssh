import { EventEmitter } from 'events';
import type { FramedDuplex } from '../../src/transport/framing';

/**
 * A FramedDuplex stand-in just rich enough for RpcClient: the same events
 * (`message`, `close`, `error`), and anything written via `writeMessage` is
 * captured so tests can assert the wire shape.
 *
 * Shared so a test can drive the *real* RpcClient. Where the daemon's
 * liveness is what is under test, a stubbed `pendingCount` models a client
 * that cannot exist — which is exactly how an unreachable `onDead` stayed
 * green for a release.
 */
export class FakeFramed extends EventEmitter {
  public sent: Buffer[] = [];
  public closed = false;

  writeMessage(body: Buffer): boolean {
    if (this.closed) throw new Error('closed');
    this.sent.push(body);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  /** Drive a response back to the client; for tests only. */
  pushMessage(envelope: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(envelope), 'utf8'));
  }

  /** The cast every caller would otherwise write out by hand. */
  asFramed(): FramedDuplex {
    return this as unknown as FramedDuplex;
  }
}
