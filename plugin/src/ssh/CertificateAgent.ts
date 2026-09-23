import { BaseAgent, utils, type ParsedKey } from 'ssh2';
import {
  agentRoundTrip,
  baseKeyType,
  isCertificateType,
  isUsableIdentity,
  listAgentIdentityBlobs,
  sshString,
  type AgentQueryOptions,
} from './AgentIdentities';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/**
 * An `ssh-agent` client that does not throw away what it cannot parse (#536).
 *
 * ssh2's own agent support runs every identity through `parseKey()` and skips
 * the failures silently, which loses OpenSSH certificates — the credential an
 * organisation with a CA actually issues. This one keeps every identity the
 * agent offers and hands ssh2 a key-shaped object for each, so a certificate
 * reaches the server like any other public key.
 *
 * The private key never leaves the agent: signing is a SIGN_REQUEST quoting
 * the identity's blob, exactly as OpenSSH's own client does.
 *
 * A certificate additionally needs `enableCertificateAuth()` on the client —
 * ssh2 writes the wrong algorithm name into the signature otherwise. See
 * `certificateAuth.ts`.
 */

const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;
const SSH_AGENT_FAILURE = 5;
/** Signature flags from PROTOCOL.agent; only RSA has any. */
const SSH_AGENT_RSA_SHA2_256 = 2;
const SSH_AGENT_RSA_SHA2_512 = 4;

/** ssh2's `createAgent` handles Pageant and Cygwin sockets itself. */
const WINDOWS_PIPE = /^[/\\][/\\]\.[/\\]pipe[/\\].+/;

/**
 * True when we can speak to this agent ourselves. On Windows a path that is
 * not a named pipe means Pageant or a Cygwin socket, both of which have their
 * own framing — leave those to ssh2 rather than breaking them.
 */
export function canSpeakToAgent(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!socketPath) return false;
  if (platform !== 'win32') return true;
  return WINDOWS_PIPE.test(socketPath);
}

/**
 * The private symbol ssh2 stamps on a parsed key. `parseKey()` returns any
 * object carrying it untouched, which is how a certificate — unparseable by
 * definition — can still travel through ssh2's key handling.
 *
 * Read off a throwaway generated key rather than hardcoded, so it follows
 * ssh2 rather than a copy of its source. Null means ssh2's internals moved,
 * and every caller then falls back to stock behaviour.
 */
let cachedSymbol: symbol | null | undefined;
export function parsedKeySymbol(): symbol | null {
  if (cachedSymbol !== undefined) return cachedSymbol;
  cachedSymbol = null;
  try {
    const pair = utils.generateKeyPairSync('ed25519');
    const parsed = utils.parseKey(pair.public);
    if (!(parsed instanceof Error)) {
      const fields = parsed as unknown as Record<symbol, unknown>;
      cachedSymbol = Object.getOwnPropertySymbols(parsed)
        .find((s) => typeof fields[s] === 'boolean') ?? null;
    }
  } catch (e) {
    logger.warn(`CertificateAgent: cannot read ssh2's parsed-key marker: ${errorMessage(e)}`);
  }
  if (cachedSymbol === null) {
    logger.warn('CertificateAgent: ssh2 internals changed; certificate identities stay unavailable');
  }
  return cachedSymbol;
}

/** The subset of a parsed key that ssh2's publickey auth actually touches. */
export interface AgentPublicKey {
  type: string;
  comment: string;
  getPublicSSH(): Buffer;
  isPrivateKey(): boolean;
  equals(other: unknown): boolean;
}

// Re-exported so callers that think in terms of the agent keep one import.
export { baseKeyType, isCertificateType };

function makeAgentKey(
  type: string, comment: string, blob: Buffer, marker: symbol,
): AgentPublicKey {
  return {
    type,
    comment,
    [marker]: true,
    getPublicSSH: () => blob,
    isPrivateKey: () => false,
    equals: (other: unknown) => {
      const o = other as { getPublicSSH?: () => Buffer } | null;
      return !!o && typeof o.getPublicSSH === 'function' && o.getPublicSSH().equals(blob);
    },
  };
}

type SignCallback = (err: Error | null, signature?: Buffer) => void;

export class CertificateAgent extends BaseAgent<ParsedKey> {
  constructor(
    private readonly socketPath: string,
    private readonly opts: AgentQueryOptions = {},
  ) {
    super();
  }

  getIdentities(cb: (err: Error | undefined, keys?: ParsedKey[]) => void): void {
    const marker = parsedKeySymbol();
    if (!marker) {
      cb(new Error('Cannot offer agent identities: ssh2 internals changed'));
      return;
    }
    listAgentIdentityBlobs(this.socketPath, this.opts).then((all) => {
      // An identity we cannot sign for still costs a round trip and one of
      // the server's MaxAuthTries (commonly 6), so it must not be offered —
      // which is also what the failure diagnosis tells the user happens.
      const offered = all.filter((i) => isUsableIdentity(i.type));
      const skipped = all.filter((i) => !isUsableIdentity(i.type));
      logger.info(
        `CertificateAgent: offering ${offered.length} of ${all.length} identities — ` +
        `${offered.map((i) => i.type).join(', ') || '(none)'}` +
        (skipped.length ? `; skipped ${skipped.map((i) => i.type).join(', ')}` : ''),
      );
      cb(undefined, offered.map(
        (i) => makeAgentKey(i.type, i.comment, i.blob, marker) as unknown as ParsedKey,
      ));
    }).catch((e) => cb(e instanceof Error ? e : new Error(String(e))));
  }

  sign(pubKey: ParsedKey, data: Buffer, options: unknown, cb?: unknown): void {
    const callback = (typeof options === 'function' ? options : cb) as SignCallback | undefined;
    if (!callback) return;
    const hash = typeof options === 'object' && options !== null
      ? (options as { hash?: string }).hash
      : undefined;

    const key = pubKey as unknown as AgentPublicKey;
    const request = Buffer.concat([
      Buffer.from([SSH_AGENTC_SIGN_REQUEST]),
      sshString(key.getPublicSSH()),
      sshString(data),
      rsaFlags(key.type, hash),
    ]);

    agentRoundTrip(this.socketPath, request, this.opts)
      .then((body) => callback(null, signatureFor(key.type, parseSignResponse(body))))
      .catch((e) => callback(e instanceof Error ? e : new Error(String(e))));
  }
}

/**
 * RSA is the only type where the caller picks a hash. ssh2 asks for one on a
 * plain key and must get what it asked for, since it writes that name on the
 * wire. For a certificate it asks for nothing and modern servers want SHA-2,
 * so choose SHA-512 — `enableCertificateAuth` copies whatever the agent
 * answers with into the packet, so the two cannot disagree.
 */
function rsaFlags(type: string, hash: string | undefined): Buffer {
  const flags = Buffer.alloc(4);
  if (baseKeyType(type) !== 'ssh-rsa') return flags;
  if (hash === 'sha256') flags.writeUInt32BE(SSH_AGENT_RSA_SHA2_256, 0);
  else if (hash === 'sha512') flags.writeUInt32BE(SSH_AGENT_RSA_SHA2_512, 0);
  else if (isCertificateType(type)) flags.writeUInt32BE(SSH_AGENT_RSA_SHA2_512, 0);
  return flags;
}

/**
 * Which half of the agent's answer each consumer needs.
 *
 * ssh2's own agent client strips the algorithm name before handing a
 * signature back, because its `authPK` writes `string(algorithm)
 * string(signature)` itself and expects the raw bytes for the second field
 * (`ssh2/lib/agent.js`: "We strip the algorithm from OpenSSH's output").
 * Returning the whole blob there produces a signature field with a second
 * algorithm name glued inside it, which every server rejects — so plain keys
 * must be stripped exactly as ssh2 does.
 *
 * A certificate is the exception: `certificateAuth` builds that packet
 * itself, and the blob's algorithm is precisely the value ssh2 gets wrong,
 * so it needs the answer intact.
 */
function signatureFor(keyType: string, blob: Buffer): Buffer {
  if (isCertificateType(keyType)) return blob;
  if (blob.length < 4) throw new Error('malformed signature (no algorithm)');
  const algoLen = blob.readUInt32BE(0);
  if (4 + algoLen + 4 > blob.length) throw new Error('malformed signature (truncated algorithm)');
  const sigLen = blob.readUInt32BE(4 + algoLen);
  const start = 4 + algoLen + 4;
  if (start + sigLen > blob.length) throw new Error('malformed signature (truncated)');
  return blob.subarray(start, start + sigLen);
}

/**
 * The body of a SIGN_RESPONSE: one SSH signature blob, itself
 * `string(algorithm) string(signature)`.
 */
function parseSignResponse(body: Buffer): Buffer {
  if (body.length < 1) throw new Error('empty signature reply from the SSH agent');
  if (body[0] === SSH_AGENT_FAILURE) throw new Error('the SSH agent refused to sign');
  if (body[0] !== SSH_AGENT_SIGN_RESPONSE) {
    throw new Error(`unexpected SSH agent reply type ${body[0]} for a signature request`);
  }
  if (body.length < 5) throw new Error('malformed signature reply (no length)');
  const len = body.readUInt32BE(1);
  if (5 + len > body.length) throw new Error('malformed signature reply (truncated)');
  return body.subarray(5, 5 + len);
}
