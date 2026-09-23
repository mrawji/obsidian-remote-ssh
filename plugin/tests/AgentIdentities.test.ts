import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  listAgentIdentities,
  describeAgentIdentities,
  diagnoseAgentAuth,
  SSH2_SUPPORTED_KEY_TYPES,
} from '../src/ssh/AgentIdentities';

/**
 * #536: an agent holding an OpenSSH certificate authenticates fine with
 * `ssh`, and fails here with nothing but "All configured authentication
 * methods failed" — because ssh2 runs every agent identity through
 * `parseKey()` and silently drops the ones it cannot parse
 * (`ssh2/lib/agent.js`, where the skip is marked `// TODO: add debug
 * output`). Certificates and FIDO keys both land there.
 *
 * These tests pin the diagnosis that turns that silence into a sentence.
 */

/** A socket path that works on all three CI runners. */
function agentSocketPath(): string {
  const id = `orst-agent-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${id}`
    : path.join(os.tmpdir(), `${id}.sock`);
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
const str = (b: Buffer | string) => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  return Buffer.concat([u32(buf.length), buf]);
};
/** A public-key blob: the type name followed by (here, fake) key material. */
const keyBlob = (type: string) => Buffer.concat([str(type), str(Buffer.alloc(32, 7))]);

const SSH_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENT_FAILURE = 5;

const servers: net.Server[] = [];
const connections: net.Socket[] = [];

/** Keep the server, and every socket it accepts, so teardown can force both. */
function track(server: net.Server): net.Server {
  server.on('connection', (c) => connections.push(c));
  servers.push(server);
  return server;
}

afterEach(async () => {
  // `close()` waits for open connections; the timeout test deliberately
  // leaves one half-open, so destroy them first or the hook hangs.
  while (connections.length) connections.pop()!.destroy();
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** Stand up a fake ssh-agent that answers one REQUEST_IDENTITIES. */
async function fakeAgent(
  reply: (Buffer | { type: string; comment: string }[]),
): Promise<string> {
  const sock = agentSocketPath();
  if (process.platform !== 'win32' && fs.existsSync(sock)) fs.unlinkSync(sock);

  const payload = Buffer.isBuffer(reply)
    ? reply
    : Buffer.concat([
      Buffer.from([SSH_AGENT_IDENTITIES_ANSWER]),
      u32(reply.length),
      ...reply.flatMap((k) => [str(keyBlob(k.type)), str(k.comment)]),
    ]);

  const server = track(net.createServer((conn) => {
    conn.once('data', () => conn.end(Buffer.concat([u32(payload.length), payload])));
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, resolve);
  });
  return sock;
}

describe('listAgentIdentities', () => {
  it('reads every identity the agent offers, certificates included', async () => {
    const sock = await fakeAgent([
      { type: 'ssh-ed25519', comment: 'laptop' },
      { type: 'ssh-ed25519-cert-v01@openssh.com', comment: 'work-cert' },
    ]);

    await expect(listAgentIdentities(sock)).resolves.toEqual([
      { type: 'ssh-ed25519', comment: 'laptop' },
      { type: 'ssh-ed25519-cert-v01@openssh.com', comment: 'work-cert' },
    ]);
  });

  it('reports an empty agent as empty, not as a failure', async () => {
    const sock = await fakeAgent([]);
    await expect(listAgentIdentities(sock)).resolves.toEqual([]);
  });

  it('rejects when the agent refuses', async () => {
    const sock = await fakeAgent(Buffer.from([SSH_AGENT_FAILURE]));
    await expect(listAgentIdentities(sock)).rejects.toThrow(/refused|failure/i);
  });

  it('rejects rather than hanging when nothing is listening', async () => {
    await expect(listAgentIdentities(agentSocketPath(), { timeoutMs: 200 }))
      .rejects.toThrow();
  });

  it('gives up on an agent that accepts the connection and never answers', async () => {
    const sock = agentSocketPath();
    if (process.platform !== 'win32' && fs.existsSync(sock)) fs.unlinkSync(sock);
    const server = track(net.createServer(() => { /* accept, then say nothing */ }));
    await new Promise<void>((resolve) => server.listen(sock, resolve));

    await expect(listAgentIdentities(sock, { timeoutMs: 150 }))
      .rejects.toThrow(/did not answer/i);
  });

  it('refuses to buffer a reply of implausible size', async () => {
    // The length field is the first thing a process on the socket path
    // controls; trusting it means allocating whatever it asks for.
    const sock = await fakeAgent(Buffer.alloc(1));
    // Announce 4 GiB, send almost nothing.
    const server = track(net.createServer((conn) => {
      conn.once('data', () => conn.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 12])));
    }));
    const huge = agentSocketPath();
    if (process.platform !== 'win32' && fs.existsSync(huge)) fs.unlinkSync(huge);
    await new Promise<void>((r) => server.listen(huge, r));
    void sock;

    await expect(listAgentIdentities(huge, { timeoutMs: 1_000 }))
      .rejects.toThrow(/implausible/i);
  });

  it('rejects an answer it does not recognise', async () => {
    const sock = await fakeAgent(Buffer.from([99]));
    await expect(listAgentIdentities(sock)).rejects.toThrow(/unexpected/i);
  });

  it('refuses an implausible identity count instead of looping on it', async () => {
    // A count field that does not match the payload would otherwise drive a
    // multi-million iteration parse before failing.
    const sock = await fakeAgent(Buffer.concat([Buffer.from([12]), u32(9_999_999)]));
    await expect(listAgentIdentities(sock)).rejects.toThrow(/implausible/i);
  });

  it('rejects a reply that is cut short mid-identity', async () => {
    const truncated = Buffer.concat([
      Buffer.from([12]), u32(1), str(keyBlob('ssh-ed25519')), u32(50),
    ]);
    const sock = await fakeAgent(truncated);
    await expect(listAgentIdentities(sock)).rejects.toThrow(/malformed/i);
  });
});

describe('describeAgentIdentities', () => {
  it('says nothing when every identity is usable', () => {
    expect(describeAgentIdentities([
      { type: 'ssh-ed25519', comment: 'a' },
      { type: 'ssh-rsa', comment: 'b' },
    ])).toBeNull();
  });

  it('says nothing about a certificate, which the plugin now authenticates with', () => {
    // Before CertificateAgent this was the headline complaint (#536). Calling
    // it unusable now would send a stuck user chasing the wrong thing.
    expect(describeAgentIdentities([
      { type: 'ssh-ed25519', comment: 'laptop' },
      { type: 'ssh-ed25519-cert-v01@openssh.com', comment: 'work-cert' },
    ])).toBeNull();
  });

  it('still flags a certificate over a key type nothing here can parse', () => {
    const msg = describeAgentIdentities([
      { type: 'sk-ssh-ed25519-cert-v01@openssh.com', comment: 'yubikey-cert' },
    ]);
    expect(msg).toContain('sk-ssh-ed25519-cert-v01@openssh.com');
    expect(msg).toContain('#536');
  });

  it('names a FIDO security key, which fails the same way', () => {
    const msg = describeAgentIdentities([
      { type: 'sk-ssh-ed25519@openssh.com', comment: 'yubikey' },
    ]);
    expect(msg).toContain('sk-ssh-ed25519@openssh.com');
    expect(msg).toMatch(/security key/i);
  });

  it('names a type it has no label for, rather than staying silent', () => {
    const msg = describeAgentIdentities([
      { type: 'ssh-ed25519', comment: 'laptop' },
      { type: 'ssh-xmss@openssh.com', comment: 'exotic' },
    ]);
    expect(msg).toContain('ssh-xmss@openssh.com');
    expect(msg).toContain('unsupported key type');
    // One usable identity is left, so it was the server that said no to it.
    expect(msg).toContain('The remaining identity was offered');
  });

  it('points at an empty agent, which fails for a different reason', () => {
    const msg = describeAgentIdentities([]);
    expect(msg).toMatch(/no identities/i);
    expect(msg).toContain('ssh-add');
  });

  it('lists the key types ssh2 can actually parse', () => {
    // Mirrors isSupportedKeyType in ssh2/lib/protocol/keyParser.js. If a
    // dependabot bump widens that set, this is the reminder to widen ours.
    expect([...SSH2_SUPPORTED_KEY_TYPES].sort()).toEqual([
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
      'ssh-dss',
      'ssh-ed25519',
      'ssh-rsa',
    ]);
  });
});

describe('diagnoseAgentAuth', () => {
  it('explains an auth failure when the agent holds only a FIDO key', async () => {
    const sock = await fakeAgent([
      { type: 'sk-ssh-ed25519@openssh.com', comment: 'yubikey' },
    ]);
    await expect(diagnoseAgentAuth(sock)).resolves.toMatch(/security key/i);
  });

  it('stays quiet when the agent looks fine — the failure is something else', async () => {
    const sock = await fakeAgent([
      { type: 'ssh-ed25519', comment: 'laptop' },
      { type: 'ssh-ed25519-cert-v01@openssh.com', comment: 'work-cert' },
    ]);
    await expect(diagnoseAgentAuth(sock)).resolves.toBeNull();
  });

  it('never throws, and never turns an error message into a worse one', async () => {
    // An unreachable agent is not itself the diagnosis — the caller already
    // has an auth error to show.
    await expect(diagnoseAgentAuth(agentSocketPath(), { timeoutMs: 200 }))
      .resolves.toBeNull();
  });

  it('returns null when no socket is configured at all', async () => {
    await expect(diagnoseAgentAuth(undefined)).resolves.toBeNull();
  });
});
