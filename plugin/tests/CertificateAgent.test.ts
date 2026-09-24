import { describe, it, expect, afterEach } from 'vitest';
import { utils } from 'ssh2';
import {
  CertificateAgent,
  canSpeakToAgent,
  baseKeyType,
  certificateAlgorithm,
  isCertificateType,
  parsedKeySymbol,
  type AgentPublicKey,
} from '../src/ssh/CertificateAgent';
import {
  startFakeAgent,
  keyBlob,
  signatureBlob,
  type FakeAgent,
} from './helpers/fakeSshAgent';

/**
 * #536. ssh2's own agent client parses every identity and silently drops what
 * it cannot parse, which is every OpenSSH certificate. This one keeps them.
 *
 * The load-bearing property is the first test: ssh2 must accept the objects
 * this hands it *without* re-parsing, because a certificate is by definition
 * something its parser rejects.
 */

const CERT = 'ssh-ed25519-cert-v01@openssh.com';

let agent: FakeAgent | null = null;
afterEach(async () => { await agent?.close(); agent = null; });

/** Promise wrappers around the callback-style agent API. */
function identities(a: CertificateAgent): Promise<AgentPublicKey[]> {
  return new Promise((resolve, reject) => {
    a.getIdentities((err, keys) => err
      ? reject(err)
      : resolve(keys as unknown as AgentPublicKey[]));
  });
}
function sign(
  a: CertificateAgent, key: AgentPublicKey, data: Buffer, options: unknown = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    a.sign(key as never, data, options, (err: Error | null, sig?: Buffer) =>
      err ? reject(err) : resolve(sig!));
  });
}

describe('CertificateAgent identities', () => {
  it('offers the certificate, and ssh2 accepts the object as a parsed key', async () => {
    agent = await startFakeAgent({
      identities: [
        { type: 'ssh-ed25519', comment: 'laptop' },
        { type: CERT, comment: 'work-cert' },
      ],
    });
    const keys = await identities(new CertificateAgent(agent.socketPath));

    expect(keys.map((k) => k.type)).toEqual(['ssh-ed25519', CERT]);
    // The whole point: ssh2 hands anything carrying its marker straight back,
    // so the certificate survives a code path that would otherwise reject it.
    for (const key of keys) {
      expect(utils.parseKey(key as never)).toBe(key);
      expect(key.isPrivateKey()).toBe(false);
    }
    expect(keys[1].getPublicSSH().equals(keyBlob(CERT))).toBe(true);
    expect(keys[1].comment).toBe('work-cert');
  });

  it('recognises its own key object and not a stranger', async () => {
    agent = await startFakeAgent({ identities: [{ type: CERT, comment: 'c' }] });
    const [key] = await identities(new CertificateAgent(agent.socketPath));

    expect(key.equals({ getPublicSSH: () => keyBlob(CERT) })).toBe(true);
    expect(key.equals({ getPublicSSH: () => keyBlob('ssh-ed25519') })).toBe(false);
    expect(key.equals(null)).toBe(false);
  });

  it('does not offer an identity it cannot sign for', async () => {
    // Every offered identity costs one of the server's MaxAuthTries, so a
    // FIDO key we cannot use must not eat one — and the failure notice tells
    // the user these are never offered, which has to be true.
    agent = await startFakeAgent({
      identities: [
        { type: 'sk-ssh-ed25519@openssh.com', comment: 'yubikey' },
        { type: 'ssh-ed25519', comment: 'laptop' },
        { type: CERT, comment: 'work-cert' },
      ],
    });
    const keys = await identities(new CertificateAgent(agent.socketPath));
    expect(keys.map((k) => k.type)).toEqual(['ssh-ed25519', CERT]);
  });

  it('offers an RSA certificate under its SHA-2 name, not the agent\'s SHA-1 one', async () => {
    // An agent lists the identity as `ssh-rsa-cert-v01@openssh.com`, but that
    // name means SHA-1 and servers have refused SHA-1 since OpenSSH 8.8 — the
    // probe is rejected with "signature algorithm ssh-rsa-cert-v01@openssh.com
    // not in PubkeyAcceptedAlgorithms" before a signature is ever sent.
    // Measured against a real sshd; Ed25519 cannot catch this.
    agent = await startFakeAgent({
      identities: [{ type: 'ssh-rsa-cert-v01@openssh.com', comment: 'work-cert' }],
    });
    const [key] = await identities(new CertificateAgent(agent.socketPath));
    expect(key.type).toBe('rsa-sha2-512-cert-v01@openssh.com');
  });

  it('leaves every other certificate type named as the agent named it', () => {
    expect(certificateAlgorithm(CERT)).toBe(CERT);
    expect(certificateAlgorithm('ecdsa-sha2-nistp256-cert-v01@openssh.com'))
      .toBe('ecdsa-sha2-nistp256-cert-v01@openssh.com');
    expect(certificateAlgorithm('ssh-rsa-cert-v01@openssh.com'))
      .toBe('rsa-sha2-512-cert-v01@openssh.com');
  });

  it('reports an agent it cannot reach rather than offering nothing', async () => {
    const a = new CertificateAgent('/nonexistent/agent.sock', { timeoutMs: 200 });
    await expect(identities(a)).rejects.toThrow();
  });
});

describe('CertificateAgent signing', () => {
  it('asks the agent to sign, quoting the certificate blob, and returns the blob whole', async () => {
    // The returned signature names the BASE algorithm — the fact the whole
    // certificate fix rests on.
    agent = await startFakeAgent({
      identities: [{ type: CERT, comment: 'c' }],
      signature: signatureBlob('ssh-ed25519'),
    });
    const a = new CertificateAgent(agent.socketPath);
    const [key] = await identities(a);

    const data = Buffer.from('what the server will verify');
    const sig = await sign(a, key, data);

    expect(agent.signRequests).toHaveLength(1);
    expect(agent.signRequests[0].keyBlob.equals(keyBlob(CERT))).toBe(true);
    expect(agent.signRequests[0].data.equals(data)).toBe(true);
    expect(sig.equals(signatureBlob('ssh-ed25519'))).toBe(true);
  });

  it('hands ssh2 the RAW signature for a plain key, as ssh2\'s own agent does', async () => {
    // ssh2's stock authPK writes `string(algorithm) string(signature)` itself
    // and expects raw bytes for the second field, so returning the agent's
    // whole blob here glues a second algorithm name inside the signature and
    // every server rejects it. Found in review; this is the regression test.
    agent = await startFakeAgent({
      identities: [{ type: 'ssh-ed25519', comment: 'laptop' }],
      signature: signatureBlob('ssh-ed25519'),
    });
    const a = new CertificateAgent(agent.socketPath);
    const [key] = await identities(a);

    const sig = await sign(a, key, Buffer.from('x'));
    expect(sig.equals(Buffer.alloc(64, 9)), 'the signature bytes alone').toBe(true);
    expect(sig.equals(signatureBlob('ssh-ed25519')), 'not the tagged blob').toBe(false);
  });

  it('rejects a plain-key signature it cannot unwrap', async () => {
    agent = await startFakeAgent({
      identities: [{ type: 'ssh-ed25519', comment: 'laptop' }],
      signature: Buffer.from([0, 0, 0, 80, 1, 2, 3]),  // says 80 bytes, has 3
    });
    const a = new CertificateAgent(agent.socketPath);
    const [key] = await identities(a);
    await expect(sign(a, key, Buffer.from('x'))).rejects.toThrow(/malformed signature/i);
  });

  it('sets no signature flags for an Ed25519 certificate', async () => {
    agent = await startFakeAgent({
      identities: [{ type: CERT, comment: 'c' }],
      signature: signatureBlob('ssh-ed25519'),
    });
    const a = new CertificateAgent(agent.socketPath);
    const [key] = await identities(a);
    await sign(a, key, Buffer.from('x'));
    expect(agent.signRequests[0].flags).toBe(0);
  });

  it('asks for SHA-512 on an RSA certificate, where ssh2 requests no hash', async () => {
    const rsaCert = 'ssh-rsa-cert-v01@openssh.com';
    agent = await startFakeAgent({
      identities: [{ type: rsaCert, comment: 'c' }],
      signature: signatureBlob('rsa-sha2-512'),
    });
    const a = new CertificateAgent(agent.socketPath);
    const [key] = await identities(a);
    await sign(a, key, Buffer.from('x'));
    expect(agent.signRequests[0].flags).toBe(4);  // SSH_AGENT_RSA_SHA2_512
  });

  it('honours the hash ssh2 asks for on a plain RSA key', async () => {
    // Here ssh2 writes the algorithm name on the wire itself, so signing with
    // anything else would produce a signature the server rejects.
    agent = await startFakeAgent({
      identities: [{ type: 'ssh-rsa', comment: 'c' }],
      signature: signatureBlob('rsa-sha2-256'),
    });
    const a = new CertificateAgent(agent.socketPath);
    const [key] = await identities(a);

    await sign(a, key, Buffer.from('x'), { hash: 'sha256' });
    expect(agent.signRequests[0].flags).toBe(2);  // SSH_AGENT_RSA_SHA2_256

    await sign(a, key, Buffer.from('x'), { hash: 'sha512' });
    expect(agent.signRequests[1].flags).toBe(4);

    await sign(a, key, Buffer.from('x'), {});
    expect(agent.signRequests[2].flags, 'no hash asked for means legacy ssh-rsa').toBe(0);
  });

  it('waits for a signature that needs a human — a touch, a PIN, a biometric', async () => {
    // Listing identities has a 2 s budget; signing must not inherit it. A
    // YubiKey touch, Touch ID, 1Password or pinentry all take longer than that
    // on a cold connect, and OpenSSH itself waits indefinitely. Capping it
    // would break hardware-backed agents for people who never use a
    // certificate — which is most users.
    agent = await startFakeAgent({
      identities: [{ type: CERT, comment: 'yubikey' }],
      signature: signatureBlob('ssh-ed25519'),
      signDelayMs: 2_600,
    });
    const a = new CertificateAgent(agent.socketPath);
    const [key] = await identities(a);

    const sig = await sign(a, key, Buffer.from('x'));
    expect(sig.equals(signatureBlob('ssh-ed25519'))).toBe(true);
  }, 20_000);

  it('surfaces a refusal instead of returning an empty signature', async () => {
    agent = await startFakeAgent({ identities: [{ type: CERT, comment: 'c' }] });  // refuses
    const a = new CertificateAgent(agent.socketPath);
    const [key] = await identities(a);
    await expect(sign(a, key, Buffer.from('x'))).rejects.toThrow(/refused to sign/i);
  });

  it('accepts the callback in the third position, as ssh2 may pass it', async () => {
    agent = await startFakeAgent({
      identities: [{ type: CERT, comment: 'c' }],
      signature: signatureBlob('ssh-ed25519'),
    });
    const a = new CertificateAgent(agent.socketPath);
    const [key] = await identities(a);

    const sig = await new Promise<Buffer>((resolve, reject) => {
      a.sign(key as never, Buffer.from('x'), (err: Error | null, s?: Buffer) =>
        err ? reject(err) : resolve(s!));
    });
    expect(sig.equals(signatureBlob('ssh-ed25519'))).toBe(true);
  });
});

describe('key type helpers', () => {
  it('knows a certificate from a key', () => {
    expect(isCertificateType(CERT)).toBe(true);
    expect(isCertificateType('ssh-ed25519')).toBe(false);
    expect(isCertificateType('sk-ssh-ed25519@openssh.com')).toBe(false);
  });

  it('strips the certificate suffix to the algorithm that signs', () => {
    expect(baseKeyType(CERT)).toBe('ssh-ed25519');
    expect(baseKeyType('rsa-sha2-512-cert-v01@openssh.com')).toBe('rsa-sha2-512');
    expect(baseKeyType('ssh-ed25519')).toBe('ssh-ed25519');
  });

  it('leaves Pageant and Cygwin agents to ssh2, which knows their framing', () => {
    expect(canSpeakToAgent('/tmp/agent.sock', 'linux')).toBe(true);
    expect(canSpeakToAgent('\\\\.\\pipe\\openssh-ssh-agent', 'win32')).toBe(true);
    expect(canSpeakToAgent('pageant', 'win32')).toBe(false);
    expect(canSpeakToAgent('C:\\cygwin\\tmp\\ssh-agent.sock', 'win32')).toBe(false);
    expect(canSpeakToAgent('', 'linux')).toBe(false);
  });

  it('finds the marker ssh2 stamps on a parsed key', () => {
    // If a future ssh2 stops using it, this fails here rather than at a
    // user's connect, and the agent falls back to stock behaviour.
    expect(parsedKeySymbol()).toBeTypeOf('symbol');
  });
});
