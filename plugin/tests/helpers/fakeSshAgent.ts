import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * A stand-in `ssh-agent`: enough of PROTOCOL.agent to answer an identity
 * listing and a signature request, and to record what was asked of it.
 *
 * It listens on a real socket — a unix socket, or a named pipe on Windows —
 * so the code under test exercises its actual transport on every CI runner.
 * No real keys are involved: blobs and signatures are fixed filler bytes.
 */

export const SSH_AGENTC_REQUEST_IDENTITIES = 11;
export const SSH_AGENTC_SIGN_REQUEST = 13;
export const SSH_AGENT_FAILURE = 5;
export const SSH_AGENT_IDENTITIES_ANSWER = 12;
export const SSH_AGENT_SIGN_RESPONSE = 14;

export const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
export const sshStr = (v: Buffer | string) => {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8');
  return Buffer.concat([u32(b.length), b]);
};
/** A public key blob: its algorithm name followed by fake key material. */
export const keyBlob = (type: string) => Buffer.concat([sshStr(type), sshStr(Buffer.alloc(32, 7))]);
/** A signature blob: the algorithm that signed, then the signature bytes. */
export const signatureBlob = (algo: string) =>
  Buffer.concat([sshStr(algo), sshStr(Buffer.alloc(64, 9))]);

export interface FakeIdentity {
  type: string;
  comment: string;
  blob?: Buffer;
}

export interface SignRequestSeen {
  keyBlob: Buffer;
  data: Buffer;
  flags: number;
}

export interface FakeAgent {
  socketPath: string;
  /** Every SIGN_REQUEST the agent received, in order. */
  signRequests: SignRequestSeen[];
  close(): Promise<void>;
}

export function agentSocketPath(): string {
  const id = `orst-fake-agent-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${id}`
    : path.join(os.tmpdir(), `${id}.sock`);
}

export async function startFakeAgent(opts: {
  identities: FakeIdentity[];
  /** What to answer a signature request with; omit to refuse. */
  signature?: Buffer;
  /** Stall this long before answering a signature — a human touching a key. */
  signDelayMs?: number;
}): Promise<FakeAgent> {
  const socketPath = agentSocketPath();
  if (process.platform !== 'win32' && fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

  const identitiesAnswer = Buffer.concat([
    Buffer.from([SSH_AGENT_IDENTITIES_ANSWER]),
    u32(opts.identities.length),
    ...opts.identities.flatMap((i) => [sshStr(i.blob ?? keyBlob(i.type)), sshStr(i.comment)]),
  ]);

  const signRequests: SignRequestSeen[] = [];
  const connections: net.Socket[] = [];

  const server = net.createServer((conn) => {
    connections.push(conn);
    const chunks: Buffer[] = [];
    conn.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);

      if (body[0] === SSH_AGENTC_REQUEST_IDENTITIES) {
        conn.end(Buffer.concat([u32(identitiesAnswer.length), identitiesAnswer]));
        return;
      }
      if (body[0] === SSH_AGENTC_SIGN_REQUEST) {
        let p = 1;
        const keyLen = body.readUInt32BE(p); p += 4;
        const key = body.subarray(p, p + keyLen); p += keyLen;
        const dataLen = body.readUInt32BE(p); p += 4;
        const data = body.subarray(p, p + dataLen); p += dataLen;
        signRequests.push({ keyBlob: key, data, flags: body.readUInt32BE(p) });

        const reply = opts.signature
          ? Buffer.concat([Buffer.from([SSH_AGENT_SIGN_RESPONSE]), sshStr(opts.signature)])
          : Buffer.from([SSH_AGENT_FAILURE]);
        const framed = Buffer.concat([u32(reply.length), reply]);
        if (opts.signDelayMs) setTimeout(() => conn.end(framed), opts.signDelayMs);
        else conn.end(framed);
        return;
      }
      const failure = Buffer.from([SSH_AGENT_FAILURE]);
      conn.end(Buffer.concat([u32(failure.length), failure]));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  return {
    socketPath,
    signRequests,
    async close() {
      for (const c of connections) c.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
