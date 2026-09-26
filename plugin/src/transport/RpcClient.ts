import { FramedDuplex } from './framing';
import { RpcError } from './RpcError';
import type {
  MethodName,
  Params,
  Result,
  ServerNotificationMap,
  ServerNotificationName,
} from '../proto/types';

type NotificationHandler<N extends ServerNotificationName> =
  (params: ServerNotificationMap[N]) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  method: string;
}

/**
 * Correlates JSON-RPC calls to the daemon over a FramedDuplex.
 *
 * Each `call(method, params)` writes a Request with a fresh numeric
 * id and returns a Promise that resolves with the decoded `result`
 * when the matching reply arrives, or rejects with an RpcError when
 * the daemon returns an error envelope.
 *
 * Server-push notifications are delivered to handlers registered via
 * `onNotification`. When the underlying stream closes, every pending
 * call is rejected with an RpcError carrying ErrorCode.InternalError
 * so callers don't hang forever.
 */
export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly notificationHandlers = new Map<string, Array<(params: unknown) => void>>();
  private readonly closeHandlers: Array<(err?: Error) => void> = [];
  private closed = false;
  /** When the daemon last said anything at all. See `msSinceLastMessage`. */
  private lastMessageAt = Date.now();

  constructor(private readonly framed: FramedDuplex) {
    framed.on('message', (body: Buffer) => this.handleMessage(body));
    framed.on('close', () => this.handleClose());
    framed.on('error', (err: Error) => this.handleClose(err));
  }

  /**
   * Send a typed request and await its reply.
   *
   * Rejects with an RpcError if the daemon returned an error envelope,
   * or if the stream closed before the reply arrived.
   *
   * `signal` abandons the call: the entry is dropped from `pending` and the
   * promise rejects. Giving up on the promise alone is NOT enough — the entry
   * would stay until a reply or a close, and `pendingCount()` would keep
   * reporting a call in flight. The heartbeat reads that count as proof of
   * life, so an abandoned probe that stayed behind made the daemon look busy
   * forever and the miss counter reset on every tick.
   */
  async call<M extends MethodName>(
    method: M,
    params: Params<M>,
    signal?: AbortSignal,
  ): Promise<Result<M>> {
    if (this.closed) {
      throw new RpcError(-32603, 'RpcClient: stream is closed');
    }
    const id = this.nextId++;
    const request = { jsonrpc: '2.0' as const, id, method, params };
    const body = Buffer.from(JSON.stringify(request), 'utf8');

    return new Promise<Result<M>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
      });
      if (signal) {
        // `delete` returning false means the call already settled, so a late
        // abort is a no-op rather than a second rejection.
        const abandon = (): void => {
          if (!this.pending.delete(id)) return;
          reject(new RpcError(-32603, `RpcClient: ${method} abandoned by caller`));
        };
        if (signal.aborted) { abandon(); return; }
        signal.addEventListener('abort', abandon, { once: true });
      }
      try {
        this.framed.writeMessage(body);
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Register a handler for a server-push method. Returns a disposer. */
  onNotification<N extends ServerNotificationName>(
    method: N,
    handler: NotificationHandler<N>,
  ): () => void {
    const existing = this.notificationHandlers.get(method) ?? [];
    existing.push(handler as (params: unknown) => void);
    this.notificationHandlers.set(method, existing);
    return () => {
      const list = this.notificationHandlers.get(method);
      if (!list) return;
      const i = list.indexOf(handler as (params: unknown) => void);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Called once when the stream closes, whether cleanly or with an error. */
  onClose(handler: (err?: Error) => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      const i = this.closeHandlers.indexOf(handler);
      if (i >= 0) this.closeHandlers.splice(i, 1);
    };
  }

  /** Close the underlying stream; pending calls reject. */
  close(): void {
    if (this.closed) return;
    this.framed.close();
  }

  isClosed(): boolean {
    return this.closed;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  /**
   * How many calls are waiting for a reply.
   *
   * The daemon serves one request at a time per connection
   * (`server/internal/server/server.go`, a plain read-dispatch-write loop),
   * so anything sent while a call is outstanding queues behind it. A
   * liveness probe therefore has to know whether the line is actually free
   * before reading silence as trouble.
   */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Milliseconds since the daemon last sent anything.
   *
   * This is the honest liveness signal for a large *read*: the response
   * arrives as a stream of frames, so a working transfer keeps this small.
   * It says nothing during a large *write*, where the daemon is busy and
   * quiet by design — which is why `pendingCount()` exists alongside it.
   */
  msSinceLastMessage(): number {
    return Date.now() - this.lastMessageAt;
  }

  private handleMessage(body: Buffer): void {
    this.lastMessageAt = Date.now();
    let msg: unknown;
    try {
      msg = JSON.parse(body.toString('utf8'));
    } catch {
      // A malformed server message is ignored rather than killing the
      // session — the daemon is expected to never emit invalid JSON,
      // and if it does, every open request eventually fails on close.
      return;
    }
    if (!isEnvelope(msg)) return;

    // Response (matches a call we sent).
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if ('error' in msg && msg.error) {
        pending.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
        return;
      }
      pending.resolve('result' in msg ? msg.result : null);
      return;
    }

    // Notification (no id).
    if (typeof msg.method === 'string') {
      const list = this.notificationHandlers.get(msg.method);
      if (!list || list.length === 0) return;
      const params = 'params' in msg ? msg.params : undefined;
      for (const h of [...list]) {
        try { h(params); } catch { /* per-handler isolation */ }
      }
    }
  }

  private handleClose(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const reason = err ?? new RpcError(-32603, 'RpcClient: stream closed before reply');
    for (const p of this.pending.values()) {
      p.reject(reason);
    }
    this.pending.clear();
    for (const cb of [...this.closeHandlers]) {
      try { cb(err); } catch { /* ignore */ }
    }
  }
}

interface Envelope {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function isEnvelope(v: unknown): v is Envelope {
  return typeof v === 'object' && v !== null;
}
