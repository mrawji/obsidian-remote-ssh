import { ErrorCode } from '../proto/types';

/**
 * RpcError is thrown from `RpcClient.call` when the daemon returned a
 * JSON-RPC error envelope, and from the client itself when the stream
 * closed before a call could be answered.
 *
 * Prefer comparing against `ErrorCode.*` values from `proto/types.ts`
 * rather than raw numbers; the code constants are the source of truth
 * for what the daemon emits.
 */
/**
 * A call the caller abandoned — not a failure of the daemon.
 *
 * Deliberately NOT an RpcError. The abandonment used to reject with
 * `ErrorCode.InternalError`, which `errorTaxonomy` renders as "Daemon internal
 * error", tells the user to go and read the server log, and reports to
 * telemetry as a server fault. Nothing in the types stopped that, because it
 * was a well-formed RpcError carrying a daemon code. Now `instanceof RpcError`
 * and every `switch (err.code)` structurally cannot classify it.
 */
export class RpcAbandonedError extends Error {
  constructor(method: string) {
    super(`RpcClient: ${method} abandoned by caller`);
    this.name = 'RpcAbandonedError';
  }
}

export class RpcError extends Error {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }

  /**
   * Matches one of the known error codes. Handy for `switch` blocks
   * that want to react to, e.g., `FileNotFound` without unwrapping
   * arbitrary integers.
   */
  is(code: (typeof ErrorCode)[keyof typeof ErrorCode]): boolean {
    return this.code === code;
  }
}
