import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import type { RemoteVerifier } from './remote-verifier';

/**
 * Binary fixtures for the E2E suite: real, decodable files rather than
 * placeholder blobs.
 *
 * Why this exists: `reflect.spec.ts` seeds its image with a hand-rolled
 * "PNG" that is a 1x1 header followed by zero padding. It is enough to
 * prove *bytes moved*, and nothing more — nothing can decode it, so no
 * spec built on it can ever assert what a user actually cares about
 * ("the image renders at 2048x1536", "the thumbnail resized"). Every
 * fixture here is the real format, so an assertion can be made against
 * the thing itself.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Standard PNG/zlib CRC-32 table (polynomial 0xEDB88320). */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, 4-byte ASCII type, payload, CRC of type+payload. */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBytes = Buffer.from(type, 'ascii');

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);

  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * A REAL PNG of exactly `width` x `height`: signature, IHDR (8-bit RGBA,
 * colour type 6), a single zlib-deflated IDAT of unfiltered scanlines,
 * IEND — every chunk CRC-correct. Any decoder (including Obsidian's
 * `<img>`) will render it, so a spec can assert on `naturalWidth` /
 * `naturalHeight`, not merely on byte count.
 *
 * Pixels are RANDOM on purpose. A solid-colour image of any size
 * deflates to a few hundred bytes, which quietly destroys the premise of
 * every "large image" test: the payload the transport actually carries
 * would be tiny. Random RGB is incompressible, so the file size tracks
 * the dimensions — a 2048x1536 lands in the multi-MB range (~12 MB), the
 * regime the streaming/chunking paths are supposed to handle.
 *
 * Alpha is forced opaque so the image is visible when rendered.
 */
export function makePng(width: number, height: number): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`makePng: width/height must be positive integers (got ${width}x${height})`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = truecolour + alpha (RGBA)
  ihdr[10] = 0; // compression: deflate (the only defined value)
  ihdr[11] = 0; // filter: adaptive (the only defined value)
  ihdr[12] = 0; // interlace: none

  // Raw scanlines: each row is a filter byte (0 = None) + width RGBA pixels.
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  const pixels = crypto.randomBytes(height * stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      raw[rowStart + 1 + x * 4 + 3] = 0xff;
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A minimal valid SVG of the given intrinsic size. Text, not bytes — SVG
 * is the case where the vault stores an *image* that is really a UTF-8
 * document, so it exercises the text path while still being an image to
 * the renderer.
 */
export function makeSvg(width: number, height: number): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">`,
    `  <rect width="${width}" height="${height}" fill="#2b3a55"/>`,
    `  <circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="#e8b04b"/>`,
    '</svg>',
    '',
  ].join('\n');
}

/**
 * A minimal but VALID single-page PDF: header, catalog, pages, page (with
 * a content stream and a Helvetica font), a byte-accurate xref table,
 * trailer, `%%EOF`. Offsets are computed from the assembled bytes rather
 * than hardcoded, so the file survives edits to the object bodies.
 *
 * Latin-1 throughout: PDF offsets are BYTE offsets, and the binary
 * marker comment in the header is above U+007F — encoding it as UTF-8
 * would shift every xref entry and produce a file strict readers reject.
 */
export function makePdf(): Buffer {
  const content = 'BT /F1 24 Tf 72 700 Td (remote-ssh e2e fixture) Tj ET\n';

  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
    '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  // `%âãÏÓ` — the conventional high-byte comment marking the file binary.
  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  for (let i = 0; i < bodies.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${bodies[i]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  const size = bodies.length + 1; // +1 for the free object 0
  pdf += `xref\n0 ${size}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

export interface FakePluginOptions {
  /** Plugin id — also the `.obsidian/plugins/<id>/` directory name. */
  id: string;
  /**
   * Manifest version. A REAL parameter, not decoration: plugin-code
   * convergence is VERSION-ORDERED (`ShadowVaultBootstrap.ts:762,806`
   * compares manifest versions to decide which copy wins), so a spec that
   * wants to pin which side of a local/remote race survives must control it.
   */
  version: string;
  /**
   * Body of `onload()`. Defaults to a probe that stamps
   * `window.__E2E_PROBE__ = { id: '<id>', loaded: true }` — i.e. proof
   * that Obsidian actually EXECUTED this plugin, which no on-disk
   * assertion can give you. Note the default does NOT expose the version;
   * a version-ordering spec should pass its own body (e.g. one that also
   * writes `version`).
   */
  onloadBody?: string;
}

export interface FakePluginFiles {
  'manifest.json': string;
  'main.js': string;
  'styles.css': string;
}

/**
 * The three files of a genuinely LOADABLE Obsidian community plugin.
 * `main.js` is CommonJS exporting a real `obsidian.Plugin` subclass, so
 * Obsidian's loader will run it — the point being that a spec can assert
 * a third-party plugin *works* against a remote vault, not merely that
 * its files were copied around.
 */
export function makeFakePlugin(opts: FakePluginOptions): FakePluginFiles {
  const { id, version } = opts;
  const onloadBody = opts.onloadBody
    ?? `window.__E2E_PROBE__ = { id: ${JSON.stringify(id)}, loaded: true };`;

  const manifest = {
    id,
    name: `E2E fixture ${id}`,
    version,
    minAppVersion: '1.5.0',
    description: 'Disposable plugin fixture seeded by the remote-ssh E2E suite.',
    author: 'remote-ssh e2e',
    isDesktopOnly: true,
  };

  const mainJs = [
    "const obsidian = require('obsidian');",
    '',
    'module.exports = class extends obsidian.Plugin {',
    '  async onload() {',
    `    ${onloadBody}`,
    '  }',
    '};',
    '',
  ].join('\n');

  return {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'main.js': mainJs,
    'styles.css': `/* ${id} v${version} — e2e fixture */\n`,
  };
}

/**
 * Seed a plugin's files under `.obsidian/plugins/<id>/` on the REMOTE, via
 * the ground-truth SFTP connection (not through the plugin). `mkdirp`
 * first: SFTP will not create the intermediate directories, and a fresh
 * fixture vault has no `.obsidian/plugins/` at all.
 */
export async function seedPluginOnRemote(
  remote: RemoteVerifier,
  id: string,
  files: Record<string, string>,
): Promise<void> {
  const dir = `.obsidian/plugins/${id}`;
  await remote.mkdirp(dir);
  for (const [name, content] of Object.entries(files)) {
    await remote.writeFile(`${dir}/${name}`, content);
  }
}
