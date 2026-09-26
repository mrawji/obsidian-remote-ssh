import type { Duplex } from 'stream';
import { FramedDuplex } from './framing';
import { RpcClient } from './RpcClient';
import { RpcError } from './RpcError';
import { PROTOCOL_VERSION, ErrorCode } from '../proto/types';
import type { ServerInfo } from '../proto/types';
import { logger } from '../util/logger';
import { withTimeout } from '../util/withTimeout';

/**
 * Concrete transport the α path needs: a Duplex stream reaching the
 * daemon, plus the session token the daemon wrote to disk at startup.
 *
 * Typical construction uses `SftpClient.openUnixStream` +
 * `SftpClient.readRemoteFile`, but the shape is abstract so tests can
 * pass an in-memory duplex + a literal token.
 */
export interface RpcConnectionInputs {
  stream: Duplex;
  token: string;
  /** Override the handshake deadline; tests shorten it. */
  handshakeTimeoutMs?: number;
}

/**
 * How long the handshake may take before we give up on this socket.
 *
 * A connected socket proves nothing about the process behind it: the kernel
 * accepts into the listen backlog whether or not the daemon is scheduling, so
 * `openUnixStream` succeeds against a daemon that has wedged, slept or been
 * SIGSTOPped, and `auth` then never returns.
 *
 * That matters because this is where the heartbeat's own recovery lands. The
 * precondition for declaring a daemon dead — socket open, nothing answering —
 * is exactly the precondition for this handshake to hang, so making `onDead`
 * reachable made an unbounded wait reachable with it: the reconnect parks on
 * "Reconnecting (attempt 1/3)" forever, never reports failure, and so never
 * restores the adapter for Obsidian to fall back to local reads.
 *
 * Generous on purpose — a first handshake over a slow link is legitimately
 * slow, and a false failure costs a working session.
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * Full result of a successful RPC handshake: the authenticated client
 * plus the daemon's advertised capabilities.
 */
export interface RpcConnection {
  rpc: RpcClient;
  info: ServerInfo;
  close(): void;
}

/**
 * Open an authenticated RPC session on a stream already pointing at
 * the daemon's unix socket.
 *
 * Steps, in order:
 *   1. Wrap the stream in a FramedDuplex.
 *   2. Wrap that in an RpcClient.
 *   3. Call `auth { token }`.
 *   4. Call `server.info` and verify the protocol version.
 *   5. Return the client + info.
 *
 * If any step fails, the stream is closed before the error is
 * re-thrown so the caller never has to clean up partial state.
 */
export async function establishRpcConnection(inputs: RpcConnectionInputs): Promise<RpcConnection> {
  const framed = new FramedDuplex(inputs.stream);
  const rpc = new RpcClient(framed);
  const cleanupOnFailure = (e: unknown): never => {
    try { rpc.close(); } catch { /* ignore */ }
    throw e;
  };

  const deadline = inputs.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

  try {
    // `cleanupOnFailure` closes the client, which rejects the abandoned call
    // and ends the stream — so the deadline really does let the socket go,
    // rather than leaving a hung promise and a live channel behind.
    const authResult = await withTimeout(
      rpc.call('auth', { token: inputs.token }), deadline, 'auth',
    );
    if (!authResult.ok) {
      throw new RpcError(ErrorCode.AuthInvalid, 'daemon refused auth token');
    }
    logger.info('RpcConnection: auth accepted');
  } catch (e) {
    return cleanupOnFailure(e);
  }

  let info: ServerInfo;
  try {
    info = await withTimeout(rpc.call('server.info', {}), deadline, 'server.info');
  } catch (e) {
    return cleanupOnFailure(e);
  }

  if (info.protocolVersion !== PROTOCOL_VERSION) {
    cleanupOnFailure(
      new RpcError(
        ErrorCode.ProtocolVersionTooOld,
        `daemon speaks protocol v${info.protocolVersion}, client needs v${PROTOCOL_VERSION}`,
      ),
    );
  }
  logger.info(
    `RpcConnection: daemon ${info.version} (protocol v${info.protocolVersion}); ` +
    `capabilities=[${info.capabilities.join(', ')}]`,
  );

  return {
    rpc,
    info,
    close: () => rpc.close(),
  };
}
