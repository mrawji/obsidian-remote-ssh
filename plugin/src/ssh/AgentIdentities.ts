import * as net from 'net';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/**
 * Why this exists (#536)
 * ---------------------
 * A user whose organisation issues short-lived OpenSSH certificates reported
 * that `ssh` connects and the plugin does not — with nothing to go on but
 * "All configured authentication methods failed".
 *
 * The cause is upstream: ssh2 runs every identity the agent offers through
 * `parseKey()` and, for the ones it cannot parse, does
 *
 *     // TODO: add debug output
 *     continue;
 *
 * (`ssh2/lib/agent.js`). `parseKey` handles exactly the six types in
 * `SSH2_SUPPORTED_KEY_TYPES` below, so an `ssh-ed25519-cert-v01@openssh.com`
 * certificate — or an `sk-ssh-ed25519@openssh.com` FIDO key — is dropped
 * before the server ever hears about it. From the outside the agent simply
 * appears to hold nothing usable.
 *
 * This module does not fix that (see #536 for the candidate fixes). It asks
 * the agent what it holds and turns the silence into a sentence, so a user
 * who cannot connect at least learns why, and that `ssh` is not lying to
 * them. It only ever sends REQUEST_IDENTITIES — never a signature request —
 * so it reads public key types and comments and nothing else.
 */

export interface AgentIdentity {
  /** Public key algorithm name, e.g. `ssh-ed25519-cert-v01@openssh.com`. */
  type: string;
  /** The agent's own label for the key, e.g. a file path or a comment. */
  comment: string;
}

/**
 * The key types ssh2 can parse — `isSupportedKeyType` in
 * `ssh2/lib/protocol/keyParser.js`. Anything else is skipped silently.
 * If an ssh2 bump widens that set, `AgentIdentities.test.ts` says so.
 */
export const SSH2_SUPPORTED_KEY_TYPES: ReadonlySet<string> = new Set([
  'ssh-rsa',
  'ssh-dss',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-ed25519',
]);

const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENT_FAILURE = 5;
const SSH_AGENT_IDENTITIES_ANSWER = 12;

const DEFAULT_TIMEOUT_MS = 2_000;
/** A sane ceiling; a real agent holds a handful, not thousands. */
const MAX_IDENTITIES = 1024;

export interface AgentQueryOptions {
  timeoutMs?: number;
}

/**
 * Ask the agent for its identities. Works against a unix socket and, on
 * Windows, against the `\\.\pipe\openssh-ssh-agent` named pipe — `net`
 * treats both as a path.
 *
 * Rejects on anything unexpected: this runs while the user is already
 * looking at a failure, so a half-parsed answer must not become advice.
 */
export function listAgentIdentities(
  socketPath: string,
  opts: AgentQueryOptions = {},
): Promise<AgentIdentity[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<AgentIdentity[]>((resolve, reject) => {
    const socket = net.connect(socketPath);
    // No encoding is set on the socket, so every chunk arrives as a Buffer.
    const chunks: Uint8Array[] = [];
    let length = -1;
    let settled = false;

    const finish = (err: Error | null, ids?: AgentIdentity[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err); else resolve(ids!);
    };

    const timer = setTimeout(
      () => finish(new Error(`SSH agent at ${socketPath} did not answer in ${timeoutMs} ms`)),
      timeoutMs,
    );

    socket.on('error', (e) => finish(new Error(`SSH agent at ${socketPath}: ${errorMessage(e)}`)));
    socket.on('end', () => finish(new Error('SSH agent closed the connection mid-reply')));

    socket.on('connect', () => {
      const frame = Buffer.alloc(5);
      frame.writeUInt32BE(1, 0);
      frame[4] = SSH_AGENTC_REQUEST_IDENTITIES;
      socket.write(frame);
    });

    socket.on('data', (chunk: Uint8Array) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (length < 0) {
        if (buf.length < 4) return;
        length = buf.readUInt32BE(0);
      }
      if (buf.length < 4 + length) return;
      try {
        finish(null, parseIdentitiesAnswer(buf.subarray(4, 4 + length)));
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

/** Read a length-prefixed string, refusing to run off the end of the buffer. */
function readString(buf: Buffer, pos: number): { value: Buffer; next: number } {
  if (pos + 4 > buf.length) throw new Error('malformed agent reply (truncated length)');
  const len = buf.readUInt32BE(pos);
  const start = pos + 4;
  if (start + len > buf.length) throw new Error('malformed agent reply (truncated string)');
  return { value: buf.subarray(start, start + len), next: start + len };
}

function parseIdentitiesAnswer(body: Buffer): AgentIdentity[] {
  if (body.length < 1) throw new Error('empty agent reply');
  if (body[0] === SSH_AGENT_FAILURE) throw new Error('the SSH agent refused the identities request');
  if (body[0] !== SSH_AGENT_IDENTITIES_ANSWER) {
    throw new Error(`unexpected SSH agent reply type ${body[0]}`);
  }
  if (body.length < 5) throw new Error('malformed agent reply (no identity count)');

  const count = body.readUInt32BE(1);
  if (count > MAX_IDENTITIES) throw new Error(`implausible identity count ${count}`);

  const identities: AgentIdentity[] = [];
  let p = 5;
  for (let i = 0; i < count; i++) {
    const blob = readString(body, p);
    const comment = readString(body, blob.next);
    p = comment.next;
    // The public key blob starts with its own algorithm name.
    const algo = readString(blob.value, 0);
    identities.push({
      type: algo.value.toString('utf8'),
      comment: comment.value.toString('utf8'),
    });
  }
  return identities;
}

/** How to describe a key type the plugin cannot offer. */
function kindOf(type: string): string {
  if (type.includes('-cert-v01@openssh.com')) return 'OpenSSH certificate';
  if (type.startsWith('sk-')) return 'FIDO security key';
  return 'unsupported key type';
}

/**
 * Turn an identity list into the sentence a stuck user needs, or `null` when
 * the agent is not the problem.
 */
export function describeAgentIdentities(identities: AgentIdentity[]): string | null {
  if (identities.length === 0) {
    return 'The SSH agent holds no identities — check with `ssh-add -l`, and add a key with `ssh-add`.';
  }

  const unusable = identities.filter((i) => !SSH2_SUPPORTED_KEY_TYPES.has(i.type));
  if (unusable.length === 0) return null;

  const listed = unusable.map((i) => `${i.type} (${kindOf(i.type)})`).join(', ');
  const usable = identities.length - unusable.length;
  return (
    `The SSH agent offers ${unusable.length} of ${identities.length} identities the plugin cannot use: ` +
    `${listed}. Its SSH library handles only ssh-rsa, ssh-dss, ecdsa-sha2-nistp256/384/521 and ` +
    `ssh-ed25519, so OpenSSH certificates and FIDO security keys are dropped before the server sees ` +
    `them (#536) — which is why \`ssh\` connects and this does not. ` +
    (usable === 0
      ? 'No usable identity is left, so agent authentication cannot succeed as things stand.'
      : usable === 1
        ? 'The remaining identity was offered and rejected by the server.'
        : `The remaining ${usable} were offered and rejected by the server.`)
  );
}

/**
 * Best-effort diagnosis for a failed agent authentication. Never throws and
 * never invents advice: a socket that will not answer is not itself the
 * explanation, and the caller already has a real error to show.
 */
export async function diagnoseAgentAuth(
  socketPath: string | undefined,
  opts: AgentQueryOptions = {},
): Promise<string | null> {
  if (!socketPath) return null;
  try {
    const identities = await listAgentIdentities(socketPath, opts);
    logger.info(
      `Agent identities at ${socketPath}: ` +
      (identities.length
        ? identities.map((i) => `${i.type} "${i.comment}"`).join(', ')
        : '(none)'),
    );
    return describeAgentIdentities(identities);
  } catch (e) {
    logger.warn(`Could not read SSH agent identities: ${errorMessage(e)}`);
    return null;
  }
}
