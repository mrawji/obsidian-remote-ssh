import { describe, it, expect, vi } from 'vitest';
import type { Client } from 'ssh2';
import {
  enableCertificateAuth,
  patchAuthPK,
  type Ssh2Protocol,
} from '../src/ssh/certificateAuth';
import { keyBlob, signatureBlob, u32 } from './helpers/fakeSshAgent';

/**
 * #536. A signed `publickey` request carries two algorithm names: the public
 * key's, and the signature's. For a certificate they differ —
 * `ssh-ed25519-cert-v01@openssh.com` and plain `ssh-ed25519` — and ssh2
 * writes one name into both, which OpenSSH rejects.
 *
 * These tests read the bytes that go on the wire, since that mismatch is
 * invisible anywhere else.
 */

const CERT = 'ssh-ed25519-cert-v01@openssh.com';
const USERAUTH_REQUEST = 50;
const SESSION_ID = Buffer.alloc(20, 3);
const ALLOC_START = 4;

/** A key object shaped like the ones `CertificateAgent` hands ssh2. */
function certKey(type = CERT) {
  const blob = keyBlob(type);
  return {
    type, comment: 'c',
    getPublicSSH: () => blob,
    isPrivateKey: () => false,
    equals: () => false,
  };
}

function harness(overrides: Partial<Ssh2Protocol> = {}) {
  const encrypted: Buffer[] = [];
  const original = vi.fn();
  const proto: Ssh2Protocol = {
    authPK: original as unknown as Ssh2Protocol['authPK'],
    _kex: { sessionID: SESSION_ID },
    _packetRW: {
      write: {
        allocStart: ALLOC_START,
        alloc: (size: number) => Buffer.alloc(ALLOC_START + size),
        finalize: (packet: Buffer) => packet,
      },
    },
    _authsQueue: [],
    _cipher: { encrypt: (p: Buffer) => { encrypted.push(p); } },
    ...overrides,
  };
  return { proto, original, encrypted };
}

/** Walk consecutive SSH `string` fields. */
function readStrings(body: Buffer, from: number, count: number): Buffer[] {
  const out: Buffer[] = [];
  let p = from;
  for (let i = 0; i < count; i++) {
    const len = body.readUInt32BE(p);
    out.push(body.subarray(p + 4, p + 4 + len));
    p += 4 + len;
  }
  return out;
}

describe('certificate publickey requests', () => {
  it('names the certificate as the key, and sends the agent\'s signature untouched', () => {
    const { proto, encrypted } = harness();
    patchAuthPK(proto);
    const key = certKey();
    const signature = signatureBlob('ssh-ed25519');
    let signedData: Buffer | undefined;

    proto.authPK('tester', key, undefined, (data, cb) => { signedData = data; cb(signature); });

    // What the server verifies: the session id, then the request.
    expect(signedData).toBeDefined();
    expect(signedData!.subarray(0, 4).equals(u32(SESSION_ID.length))).toBe(true);
    expect(signedData!.subarray(4, 4 + SESSION_ID.length).equals(SESSION_ID)).toBe(true);
    expect(signedData![4 + SESSION_ID.length]).toBe(USERAUTH_REQUEST);

    // And what went on the wire.
    expect(encrypted).toHaveLength(1);
    const body = encrypted[0].subarray(ALLOC_START);
    expect(body[0]).toBe(USERAUTH_REQUEST);
    const [user, service, method] = readStrings(body, 1, 3);
    expect(user.toString()).toBe('tester');
    expect(service.toString()).toBe('ssh-connection');
    expect(method.toString()).toBe('publickey');

    const afterMethod = 1 + 4 + user.length + 4 + service.length + 4 + method.length;
    expect(body[afterMethod], 'the "this is signed" flag').toBe(1);
    const [algo, blob, sig] = readStrings(body, afterMethod + 1, 3);
    expect(algo.toString(), 'the key algorithm is the certificate').toBe(CERT);
    expect(blob.equals(key.getPublicSSH())).toBe(true);
    expect(sig.equals(signature), 'the signature blob is passed through').toBe(true);

    // The signature's own algorithm — the field ssh2 overwrites — stays plain.
    const [sigAlgo] = readStrings(sig, 0, 1);
    expect(sigAlgo.toString()).toBe('ssh-ed25519');

    expect(proto._authsQueue).toEqual(['publickey']);
  });

  it('signs exactly the bytes it then sends', () => {
    const { proto, encrypted } = harness();
    patchAuthPK(proto);
    let signedData: Buffer | undefined;
    proto.authPK('tester', certKey(), undefined, (data, cb) => {
      signedData = data;
      cb(signatureBlob('ssh-ed25519'));
    });

    // Everything after string(sessionID) must be the request byte-for-byte,
    // or the server verifies a different message than the one it received.
    const request = signedData!.subarray(4 + SESSION_ID.length);
    const sent = encrypted[0].subarray(ALLOC_START);
    expect(sent.subarray(0, request.length).equals(request)).toBe(true);
  });

  it('queues the packet instead of encrypting it during a key re-exchange', () => {
    // ssh2 does the same: a packet encrypted mid-rekey would use stale keys.
    const { proto, encrypted } = harness({ _kexinit: Buffer.from('in flight') });
    patchAuthPK(proto);
    proto.authPK('tester', certKey(), undefined, (_d, cb) => cb(signatureBlob('ssh-ed25519')));

    expect(encrypted).toHaveLength(0);
    expect(proto._queue).toHaveLength(1);
  });
});

describe('requests that must stay with ssh2', () => {
  it('leaves the unsigned probe alone — ssh2 already sends it correctly', () => {
    const { proto, original, encrypted } = harness();
    patchAuthPK(proto);
    proto.authPK('tester', certKey());
    expect(original).toHaveBeenCalledOnce();
    expect(encrypted).toHaveLength(0);
  });

  it('leaves ordinary keys alone', () => {
    const { proto, original, encrypted } = harness();
    patchAuthPK(proto);
    proto.authPK('tester', certKey('ssh-ed25519'), undefined, (_d, cb) => cb(Buffer.alloc(4)));
    expect(original).toHaveBeenCalledOnce();
    expect(encrypted).toHaveLength(0);
  });

  it('accepts the callback in the third position, as ssh2 may pass it', () => {
    const { proto, encrypted } = harness();
    patchAuthPK(proto);
    (proto.authPK as unknown as (u: string, k: unknown, cb: unknown) => void)(
      'tester',
      certKey(),
      (_d: Buffer, cb: (s: Buffer) => void) => cb(signatureBlob('ssh-ed25519')),
    );
    expect(encrypted).toHaveLength(1);
  });

  it('falls back to ssh2 when its internals are not where we expect', () => {
    // A future ssh2 could move any of them. Better a failed certificate login
    // than a corrupt packet on a connection that would otherwise work.
    const { proto, original, encrypted } = harness({ _packetRW: {} });
    patchAuthPK(proto);
    proto.authPK('tester', certKey(), undefined, (_d, cb) => cb(signatureBlob('ssh-ed25519')));
    expect(original).toHaveBeenCalledOnce();
    expect(encrypted).toHaveLength(0);
  });
});

describe('enableCertificateAuth', () => {
  it('patches the protocol once the client has one, and still connects', () => {
    const { proto } = harness();
    const connect = vi.fn();
    const client = { connect, _protocol: undefined as Ssh2Protocol | undefined };
    const before = proto.authPK;

    enableCertificateAuth(client as unknown as Client);
    client._protocol = proto;                        // as ssh2 does inside connect()
    (client as unknown as Client).connect({ host: 'h' });

    expect(connect).toHaveBeenCalledOnce();
    expect(proto.authPK).not.toBe(before);
  });

  it('is harmless on a client that never gets a protocol', () => {
    const connect = vi.fn();
    const client = { connect };
    enableCertificateAuth(client as unknown as Client);
    expect(() => (client as unknown as Client).connect({ host: 'h' })).not.toThrow();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('connects anyway if patching throws', () => {
    const connect = vi.fn();
    const client = {
      connect,
      // A getter that throws stands in for internals that moved.
      get _protocol(): never { throw new Error('moved'); },
    };
    enableCertificateAuth(client as unknown as Client);
    expect(() => (client as unknown as Client).connect({ host: 'h' })).not.toThrow();
    expect(connect).toHaveBeenCalledOnce();
  });
});
