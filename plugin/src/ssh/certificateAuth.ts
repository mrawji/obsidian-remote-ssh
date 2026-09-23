import type { Client } from 'ssh2';
import { sshString } from './AgentIdentities';
import { baseKeyType, isCertificateType, type AgentPublicKey } from './CertificateAgent';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/**
 * The one thing ssh2 gets wrong about OpenSSH certificates (#536).
 *
 * A `publickey` request carries two algorithm names, and RFC 4252 lets them
 * differ: the *public key* algorithm, and the algorithm of the signature
 * inside it. For a certificate they MUST differ — the key is
 * `ssh-ed25519-cert-v01@openssh.com`, the signature is plain `ssh-ed25519`.
 * ssh2 writes one name into both fields (`Protocol.authPK`), so OpenSSH's
 * `sshkey_check_sigtype` rejects a signature that is otherwise perfect.
 * Measured: the server accepts the certificate (USERAUTH_PK_OK) and then
 * fails the signed request that follows.
 *
 * Rather than patching ssh2 on disk, this replaces that one method on the
 * live protocol object, and only for certificate keys. Everything else — and
 * every unsigned "would you accept this key" probe — goes to ssh2 untouched.
 *
 * It reaches into ssh2 internals (`_protocol`, `_kex.sessionID`, `_packetRW`,
 * `_authsQueue`, `_kexinit`, `_cipher`), which is the price of not forking.
 * The integration test authenticates a real certificate against a real sshd,
 * so an ssh2 bump that moves any of them fails CI rather than a connection.
 */

/** RFC 4253 message number for SSH_MSG_USERAUTH_REQUEST. */
const USERAUTH_REQUEST = 50;

type SignRequest = (data: Buffer, cb: (signature: Buffer) => void) => void;

interface PacketWriter {
  alloc(size: number): Buffer;
  allocStart: number;
  finalize(packet: Buffer): Buffer;
}

export interface Ssh2Protocol {
  authPK(user: string, pubKey: unknown, keyAlgo?: unknown, cbSign?: SignRequest): void;
  _kex?: { sessionID?: Buffer };
  _packetRW?: { write?: PacketWriter };
  _authsQueue?: string[];
  _cipher?: { encrypt(packet: Buffer): void };
  _kexinit?: unknown;
  _queue?: Buffer[];
  _debug?: (msg: string) => void;
}

type ClientWithProtocol = Client & { _protocol?: Ssh2Protocol };

/**
 * Make `client` able to finish certificate authentication. Wraps `connect`,
 * because the protocol object only exists once a connection starts.
 *
 * Safe on any client: without a certificate identity nothing here runs, and
 * if ssh2's internals are not where we expect, the stock method stays in
 * place and the connection behaves exactly as it does today.
 */
export function enableCertificateAuth(client: Client): void {
  const target = client as ClientWithProtocol;
  const originalConnect = target.connect.bind(target);

  target.connect = (config: Parameters<Client['connect']>[0]) => {
    const result = originalConnect(config);
    try {
      if (target._protocol) patchAuthPK(target._protocol);
    } catch (e) {
      // Never let this wiring break a connection that would have worked
      // without certificates.
      logger.warn(`certificateAuth: leaving ssh2 as-is (${errorMessage(e)})`);
    }
    return result;
  };
}

export function patchAuthPK(proto: Ssh2Protocol): void {
  const original = proto.authPK.bind(proto);

  proto.authPK = (user: string, pubKey: unknown, keyAlgo?: unknown, cbSign?: SignRequest) => {
    // ssh2 allows the callback in the third position.
    if (typeof keyAlgo === 'function') {
      cbSign = keyAlgo as SignRequest;
      keyAlgo = undefined;
    }
    const key = pubKey as AgentPublicKey | null;
    const certType = key?.type;

    // Only the SIGNED request for a certificate needs different treatment.
    // The probe ssh2 sends first already carries the certificate correctly.
    if (!cbSign || !certType || !isCertificateType(certType) || !canWrite(proto)) {
      return original(user, pubKey, keyAlgo, cbSign);
    }

    const blob = key.getPublicSSH();
    const sessionID = proto._kex!.sessionID!;
    const request = Buffer.concat([
      Buffer.from([USERAUTH_REQUEST]),
      sshString(user),
      sshString('ssh-connection'),
      sshString('publickey'),
      Buffer.from([1]),        // "this request is signed"
      sshString(certType),     // public key algorithm: the certificate type
      sshString(blob),
    ]);

    cbSign(Buffer.concat([sshString(sessionID), request]), (signature) => {
      // `signature` is a complete SSH signature blob — string(algorithm)
      // string(signature) — and its algorithm is the base type, which is
      // exactly what the certificate requires and what ssh2 overwrites.
      proto._debug?.(
        `Outbound: Sending USERAUTH_REQUEST (publickey, ${certType}, ` +
        `signature ${baseKeyType(certType)})`,
      );
      sendPacket(proto, Buffer.concat([request, sshString(signature)]));
    });
  };
}

/** Everything the packet path needs, present and of the right shape. */
function canWrite(proto: Ssh2Protocol): boolean {
  const ok = !!proto._kex?.sessionID
    && typeof proto._packetRW?.write?.alloc === 'function'
    && typeof proto._packetRW?.write?.finalize === 'function'
    && typeof proto._packetRW?.write?.allocStart === 'number'
    && Array.isArray(proto._authsQueue)
    && typeof proto._cipher?.encrypt === 'function';
  if (!ok) {
    logger.warn(
      'certificateAuth: ssh2 internals are not where this expects; falling back ' +
      'to stock behaviour (certificate authentication will fail)',
    );
  }
  return ok;
}

/**
 * Mirror of ssh2's own `sendPacket`: a packet produced while a key
 * re-exchange is in flight has to wait in ssh2's queue, or it would be
 * encrypted with the wrong keys.
 */
function sendPacket(proto: Ssh2Protocol, payload: Buffer): void {
  const writer = proto._packetRW!.write!;
  const packet = writer.alloc(payload.length);
  payload.copy(packet, writer.allocStart);
  proto._authsQueue!.push('publickey');
  const finalized = writer.finalize(packet);

  if (proto._kexinit !== undefined) {
    if (proto._queue === undefined) proto._queue = [];
    proto._queue.push(finalized);
    proto._debug?.('Outbound: ... certificate auth packet queued');
    return;
  }
  proto._cipher!.encrypt(finalized);
}
