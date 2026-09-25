import * as http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes, timingSafeEqual } from 'crypto';
import { logger } from '../util/logger';
import { isPreconditionFailed } from '../proto/rpcError';
import { errorMessage } from "../util/errorMessage";

/** Fetches whole vault binaries, through whatever adapter stack is wired. */
export type FetchBinaryFn = (vaultPath: string) => Promise<Uint8Array>;

/**
 * Partial reads. Optional — without it a `Range:` request falls back to
 * fetching the whole file and slicing.
 *
 * `bytes` may be short of `length` at EOF; `totalSize` builds the
 * `Content-Range` header either way. `expectedMtime` asks the implementation
 * to fail with `PreconditionFailed` (-32020) on a newer generation; see
 * {@link ResourceBridge.mtimeCache} for why that matters.
 */
export interface BinaryRange {
  bytes: Uint8Array;
  mtime: number;
  totalSize: number;
}

export type FetchBinaryRangeFn = (
  vaultPath: string,
  offset: number,
  length: number,
  expectedMtime?: number,
) => Promise<BinaryRange>;

/**
 * Daemon-resized thumbnails. Optional — falls back to the full binary.
 * `format` sets the MIME type without re-sniffing; PNG when the source had
 * alpha, so transparency survives.
 */
export type FetchThumbnailFn = (
  vaultPath: string,
  maxDim: number,
) => Promise<{ bytes: Uint8Array; format: 'jpeg' | 'png' }>;

export interface StartResult {
  port: number;
  /** Hex token embedded in every URL the bridge hands out. */
  token: string;
}

/**
 * Long enough to cover scrubbing a video for a minute, short enough that an
 * idle session stops pinning an old generation. #171.
 */
const MTIME_CACHE_TTL_MS = 30_000;

/** Sized for the one or two media files being scrubbed at once; LRU beyond. */
const MTIME_CACHE_MAX_ENTRIES = 64;

interface MtimeCacheEntry {
  mtime: number;
  /** Wall-clock ms (`Date.now()`) of the most recent read or write. */
  lastUsed: number;
}

/**
 * Localhost HTTP server that serves binary vault assets to Obsidian's
 * webview, so `<img>`, `<iframe>` and `<audio>` can render content that
 * lives on a remote host.
 *
 * Binds 127.0.0.1 on an OS-assigned port. Every URL embeds a token
 * regenerated on each `start()`, so a leaked URL from a past session cannot
 * replay against a new one.
 *
 * GET only. `Range:` is served from a single `fs.readBinaryRange` RPC when
 * one is wired, and otherwise by fetching the whole file and slicing.
 */
export class ResourceBridge {
  private server: http.Server | null = null;
  private token: string | null = null;
  private port: number | null = null;
  private fetchBinary: FetchBinaryFn | null = null;
  private fetchThumbnail: FetchThumbnailFn | null = null;
  private fetchBinaryRange: FetchBinaryRangeFn | null = null;

  /**
   * Pins each path to one file generation for the range fast path (#171).
   *
   * The first request caches the daemon's mtime; later ones send it back as
   * `expectedMtime`, so a slice from a NEWER generation is rejected instead of
   * silently splicing into the stream. On rejection the entry is dropped and
   * the read re-issued unpinned: a mid-scrub edit costs one round-trip and
   * never a corrupt response.
   *
   * Bounded and TTL'd; cleared on `stop()`.
   */
  private mtimeCache = new Map<string, MtimeCacheEntry>();

  /**
   * Start the server and return its port and token. Starting one that is
   * already running is an error — `stop` first.
   *
   * Both optional fetchers are fast paths, not requirements: without them a
   * `?thumb=N` or `Range:` request is still answered from the full binary,
   * correctly but at the cost of the whole file. See {@link FetchThumbnailFn}
   * and {@link FetchBinaryRangeFn}.
   */
  async start(
    fetchBinary: FetchBinaryFn,
    fetchThumbnail?: FetchThumbnailFn,
    fetchBinaryRange?: FetchBinaryRangeFn,
  ): Promise<StartResult> {
    if (this.server) {
      throw new Error('ResourceBridge already started');
    }
    this.token = randomBytes(32).toString('hex');
    this.fetchBinary = fetchBinary;
    this.fetchThumbnail = fetchThumbnail ?? null;
    this.fetchBinaryRange = fetchBinaryRange ?? null;

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = server;

    return new Promise<StartResult>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server = null;
        this.token = null;
        this.fetchBinary = null;
        this.fetchThumbnail = null;
        this.fetchBinaryRange = null;
        reject(err);
      };
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const addr = server.address() as AddressInfo;
        this.port = addr.port;
        logger.info(`ResourceBridge: listening on 127.0.0.1:${addr.port}`);
        resolve({ port: addr.port, token: this.token! });
      });
    });
  }

  /** Stop the HTTP server. Safe to call when not running. */
  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.token = null;
    this.port = null;
    this.fetchBinary = null;
    this.fetchThumbnail = null;
    this.fetchBinaryRange = null;
    this.mtimeCache.clear();

    return new Promise<void>(resolve => {
      // Force-close any in-flight responses so we don't hang on a slow
      // remote read while the user is reloading the plugin.
      try {
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      } catch { /* older Node: best-effort */ }
      server.close(() => resolve());
    });
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * URL for the webview to fetch `vaultPath`. The bridge must be started, and
   * the path is vault-canonical — mapping back into the per-client subtree
   * happens inside the `fetchBinary` callback.
   *
   * `opts.thumbMaxDim` asks for a resized image, falling back to the full
   * binary so something always renders.
   */
  urlFor(vaultPath: string, opts?: { thumbMaxDim?: number }): string {
    if (!this.server || !this.token || this.port === null) {
      throw new Error('ResourceBridge not started');
    }
    const encoded = encodeURIComponent(vaultPath);
    const thumb =
      opts?.thumbMaxDim != null && opts.thumbMaxDim > 0
        ? `&thumb=${opts.thumbMaxDim}`
        : '';
    return `http://127.0.0.1:${this.port}/r/${this.token}?p=${encoded}${thumb}`;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Allow': 'GET, HEAD' }).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = /^\/r\/([0-9a-f]+)$/.exec(url.pathname);
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    if (!this.token || !constantTimeEqualHex(m[1], this.token)) {
      res.writeHead(401).end();
      return;
    }
    const rawPath = url.searchParams.get('p');
    if (rawPath === null || rawPath === '') {
      res.writeHead(400).end('missing p');
      return;
    }
    if (!isSafeVaultPath(rawPath)) {
      res.writeHead(400).end('bad path');
      return;
    }
    if (!this.fetchBinary) {
      res.writeHead(503).end();
      return;
    }

    const thumbStr = url.searchParams.get('thumb');
    if (thumbStr !== null && this.fetchThumbnail) {
      if (await this.serveThumbnail(req, res, rawPath, thumbStr)) return;
    }

    if (this.fetchBinaryRange && req.headers.range) {
      if (await this.serveRangeFastPath(req, res, rawPath, req.headers.range)) return;
    }

    await this.serveFullBinary(req, res, rawPath);
  }

  /** Serve a daemon-resized thumbnail. Returns true if served. */
  private async serveThumbnail(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawPath: string,
    thumbStr: string,
  ): Promise<boolean> {
    const maxDim = parseInt(thumbStr, 10);
    if (!Number.isFinite(maxDim) || maxDim <= 0) {
      res.writeHead(400).end('bad thumb');
      return true;
    }
    try {
      const { bytes, format } = await this.fetchThumbnail!(rawPath, maxDim);
      const contentType = format === 'png' ? 'image/png' : 'image/jpeg';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': bytes.byteLength,
        'Cache-Control': 'no-store',
      });
      sendBody(req, res, bytes);
      return true;
    } catch (e) {
      logger.warn(
        `ResourceBridge: thumbnail failed for "${rawPath}" maxDim=${maxDim}: ` +
        `${errorMessage(e)}; falling back to full binary`,
      );
      return false;
    }
  }

  /**
   * Serve an explicit `bytes=N-M` range via `fs.readBinaryRange` without
   * loading the full file. Returns true if served; false falls through
   * to the full-binary path.
   */
  private async serveRangeFastPath(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawPath: string,
    rangeHeader: string,
  ): Promise<boolean> {
    const explicit = parseExplicitByteRange(rangeHeader);
    if (explicit === null) return false;
    const fetchRange = this.fetchBinaryRange!;
    try {
      // Pin follow-up requests to the cached generation so the daemon
      // rejects mid-stream edits with PreconditionFailed (#171).
      const expectedMtime = this.lookupMtime(rawPath);
      let result: BinaryRange;
      try {
        result = await fetchRange(rawPath, explicit.start, explicit.length, expectedMtime);
      } catch (e) {
        if (expectedMtime !== undefined && isPreconditionFailed(e)) {
          logger.info(
            `ResourceBridge: mtime mismatch for "${rawPath}" ${rangeHeader}; ` +
            `dropping cache and re-issuing without expectedMtime`,
          );
          this.mtimeCache.delete(rawPath);
          result = await fetchRange(rawPath, explicit.start, explicit.length, undefined);
        } else {
          throw e;
        }
      }
      this.storeMtime(rawPath, result.mtime);
      const totalSize = result.totalSize;
      if (explicit.start >= totalSize) {
        res.writeHead(416, {
          'Content-Range': `bytes */${totalSize}`,
          'Cache-Control': 'no-store',
        }).end();
        return true;
      }
      const sliceLen = result.bytes.byteLength;
      const end = explicit.start + sliceLen - 1;
      res.writeHead(206, {
        'Content-Type': guessMimeType(rawPath),
        'Content-Length': sliceLen,
        'Content-Range': `bytes ${explicit.start}-${end}/${totalSize}`,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      });
      sendBody(req, res, result.bytes);
      return true;
    } catch (e) {
      logger.warn(
        `ResourceBridge: fs.readBinaryRange failed for "${rawPath}" ` +
        `${rangeHeader}: ${errorMessage(e)}; falling back to full binary`,
      );
      return false;
    }
  }

  /** Fetch the full file and serve it, with legacy Range support. */
  private async serveFullBinary(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawPath: string,
  ): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fetchBinary!(rawPath);
    } catch (e) {
      logger.warn(`ResourceBridge: read failed for "${rawPath}": ${errorMessage(e)}`);
      res.writeHead(404).end();
      return;
    }

    const contentType = guessMimeType(rawPath);
    const total = bytes.byteLength;
    const rangeHeader = req.headers.range;
    const parsed = rangeHeader ? parseRangeHeader(rangeHeader, total) : 'none';

    if (parsed === 'invalid') {
      res.writeHead(416, {
        'Content-Range': `bytes */${total}`,
        'Cache-Control': 'no-store',
      }).end();
      return;
    }

    if (parsed === 'none') {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': total,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      });
      sendBody(req, res, bytes);
      return;
    }

    const { start, end } = parsed;
    const sliceLen = end - start + 1;
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': sliceLen,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    });
    sendBody(req, res, bytes.subarray(start, end + 1));
  }

  /**
   * A hit refreshes `lastUsed`, so a file being scrubbed does not TTL out.
   * A stale entry is dropped on the spot rather than left to be re-checked.
   */
  private lookupMtime(vaultPath: string): number | undefined {
    const entry = this.mtimeCache.get(vaultPath);
    if (!entry) return undefined;
    const now = Date.now();
    if (now - entry.lastUsed > MTIME_CACHE_TTL_MS) {
      this.mtimeCache.delete(vaultPath);
      return undefined;
    }
    entry.lastUsed = now;
    return entry.mtime;
  }

  /** Insert or refresh, evicting the LRU past {@link MTIME_CACHE_MAX_ENTRIES}. */
  private storeMtime(vaultPath: string, mtime: number): void {
    const now = Date.now();
    // Map keeps insertion order, so delete-then-set moves the entry to the
    // back. An in-place update would leave it where it was and the sweep
    // below would evict a more recently used path.
    this.mtimeCache.delete(vaultPath);
    this.mtimeCache.set(vaultPath, { mtime, lastUsed: now });
    if (this.mtimeCache.size > MTIME_CACHE_MAX_ENTRIES) {
      const oldest = this.mtimeCache.keys().next();
      if (!oldest.done) this.mtimeCache.delete(oldest.value);
    }
  }
}

/**
 * Parse a `Range:` header against a known total size. Pure, so the rules are
 * testable without a server.
 *
 * `'invalid'` means reply 416; `{start, end}` means reply 206. RFC 7233 forms
 * `bytes=N-M`, `bytes=N-` and `bytes=-N` are understood. Multi-range is
 * rejected on purpose: the webview asks for one at a time, and
 * multipart/byteranges is a much larger change.
 */
export function parseRangeHeader(
  headerValue: string,
  totalSize: number,
): { start: number; end: number } | 'invalid' {
  if (totalSize <= 0) return 'invalid';
  const m = /^bytes=(\d*)-(\d*)$/.exec(headerValue.trim());
  if (!m) return 'invalid';
  const startStr = m[1];
  const endStr = m[2];
  let start: number;
  let end: number;
  if (startStr === '' && endStr === '') return 'invalid';
  if (startStr === '') {
    // Suffix range: last N bytes.
    const n = parseInt(endStr, 10);
    if (!Number.isFinite(n) || n <= 0) return 'invalid';
    start = Math.max(0, totalSize - n);
    end = totalSize - 1;
  } else if (endStr === '') {
    start = parseInt(startStr, 10);
    end = totalSize - 1;
  } else {
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start < 0 || start >= totalSize) return 'invalid';
  if (end < start) return 'invalid';
  // Spec allows clamping a too-large end; do so.
  if (end >= totalSize) end = totalSize - 1;
  return { start, end };
}

/**
 * The same, WITHOUT knowing the total — for the fast path (#134) that learns
 * it from the daemon's reply.
 *
 * Only `bytes=N-M` can be answered that way: `bytes=N-` needs the total for
 * `end` and `bytes=-N` needs it for `start`, so both return `null` and the
 * caller takes the full-file path, which has it. The daemon clamps past EOF,
 * so `length` needs no local bound.
 */
export function parseExplicitByteRange(
  headerValue: string,
): { start: number; length: number } | null {
  const m = /^bytes=(\d+)-(\d+)$/.exec(headerValue.trim());
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start) return null;
  return { start, length: end - start + 1 };
}

/**
 * Constant-time hex comparison. timingSafeEqual itself requires equal
 * lengths and Buffer inputs; we guard the length first since a length
 * mismatch on tokens of different sizes would throw.
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Reject anything that could escape the vault root. Vault-relative
 * paths shouldn't begin with `/` and shouldn't contain `..` segments;
 * NULs are filesystem traps regardless of platform.
 */
function isSafeVaultPath(p: string): boolean {
  if (p.includes('\0')) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  for (const part of p.split(/[\\/]+/)) {
    if (part === '..') return false;
  }
  return true;
}

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',

  pdf: 'application/pdf',

  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  opus: 'audio/opus',

  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',

  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md:  'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm:  'text/html; charset=utf-8',
  css:  'text/css; charset=utf-8',
  js:   'application/javascript; charset=utf-8',
  xml:  'application/xml; charset=utf-8',
};

/** Write body or end empty for HEAD requests. */
function sendBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bytes: Uint8Array,
): void {
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
}

function guessMimeType(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext = path.slice(dot + 1).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}
