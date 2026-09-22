import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Deterministic large-vault fixtures for `scale.spec.ts` (#513).
 *
 * Written straight onto the HOST side of the sshd bind mount
 * (`docker/test-vault` → `/home/tester/vault`), so seeding 5 GB costs disk
 * throughput, not SSH round-trips.
 *
 * Notes look like real notes as far as `metadataCache` cares: frontmatter,
 * headings, tags and `[[links]]` to other notes in the same fixture. Link
 * density matters because resolving links is part of what is being timed.
 * Attachments are opaque bytes. Obsidian does not parse them, so the mixed
 * profiles show how much of a vault's size actually crosses the wire.
 */

export interface ScaleProfile {
  name: string;
  notes: number;
  /** Target size of one note body, in bytes. */
  noteBytes: number;
  attachments: number;
  attachmentBytes: number;
}

export const SCALE_PROFILES: Record<string, ScaleProfile> = {
  // ~5 MB of markdown
  s: { name: 's', notes: 1_000, noteBytes: 5_000, attachments: 0, attachmentBytes: 0 },
  // ~50 MB of markdown
  m: { name: 'm', notes: 10_000, noteBytes: 5_000, attachments: 0, attachmentBytes: 0 },
  // ~500 MB of markdown
  l: { name: 'l', notes: 10_000, noteBytes: 50_000, attachments: 0, attachmentBytes: 0 },
  // ~5 GB of markdown: the worst case #513 extrapolates to
  'xl-md': { name: 'xl-md', notes: 50_000, noteBytes: 100_000, attachments: 0, attachmentBytes: 0 },
  // ~500 MB of markdown beside ~4.5 GB of attachments: a more typical big vault
  'xl-mixed': {
    name: 'xl-mixed', notes: 5_000, noteBytes: 100_000, attachments: 450, attachmentBytes: 10_000_000,
  },
};

/** Host side of the sshd bind mount (see docker-compose.yml). */
export const HOST_VAULT_ROOT = path.resolve(__dirname, '..', '..', '..', 'docker', 'test-vault');
/** The same directory as the remote sees it. */
export const REMOTE_VAULT_ROOT = '/home/tester/vault';

const FOLDERS_PER_LEVEL = 10;
const LINKS_PER_NOTE = 5;
const TAGS = Array.from({ length: 50 }, (_, i) => `#scale/t${i}`);

/** mulberry32: small, fast and seedable, so every run builds the same vault. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Note i lives two folders down, so the lazy connect walk cannot see it. */
function notePath(i: number): string {
  const a = i % FOLDERS_PER_LEVEL;
  const b = Math.floor(i / FOLDERS_PER_LEVEL) % FOLDERS_PER_LEVEL;
  return `d${a}/d${a}-${b}/n${i}.md`;
}

const FILLER =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod ' +
  'tempor incididunt ut labore et dolore magna aliqua. ';

function noteBody(i: number, p: ScaleProfile, rand: () => number): string {
  const links = Array.from({ length: LINKS_PER_NOTE }, () => {
    const target = notePath(Math.floor(rand() * p.notes)).replace(/\.md$/, '');
    return `[[${target}]]`;
  });
  const tags = [TAGS[i % TAGS.length], TAGS[Math.floor(rand() * TAGS.length)]];
  const head =
    `---\nid: ${i}\nkind: k${i % 7}\n---\n\n# Note ${i}\n\n` +
    `${tags.join(' ')}\n\n${links.join(' ')}\n\n## Body\n\n`;
  const remaining = Math.max(0, p.noteBytes - head.length);
  return head + FILLER.repeat(Math.ceil(remaining / FILLER.length)).slice(0, remaining);
}

export interface SeededFixture {
  /** Remote path to use as the profile's `remotePath`. */
  remotePath: string;
  hostPath: string;
  /** Markdown files in the fixture, including the root index note. */
  markdownFiles: number;
  markdownBytes: number;
  attachmentBytes: number;
}

/**
 * Build the fixture under `docker/test-vault/scale-<profile>/`. Skips the work
 * when a previous run left a complete copy (the marker file is written last).
 */
export function seedScaleFixture(p: ScaleProfile): SeededFixture {
  const dir = `scale-${p.name}`;
  const hostPath = path.join(HOST_VAULT_ROOT, dir);
  const marker = path.join(hostPath, '.scale-complete.json');
  if (fs.existsSync(marker)) {
    return JSON.parse(fs.readFileSync(marker, 'utf8')) as SeededFixture;
  }
  fs.rmSync(hostPath, { recursive: true, force: true });
  fs.mkdirSync(hostPath, { recursive: true });

  const rand = rng(0x5eed + p.notes);
  let markdownBytes = 0;
  for (let i = 0; i < p.notes; i++) {
    const rel = notePath(i);
    fs.mkdirSync(path.join(hostPath, path.dirname(rel)), { recursive: true });
    const body = noteBody(i, p, rand);
    fs.writeFileSync(path.join(hostPath, rel), body);
    markdownBytes += Buffer.byteLength(body);
  }

  // A root-level note, so the shadow vault has something at depth 0 to render
  // (waitForShadowVaultLoaded waits for >= 1 markdown file).
  const index = `# Scale ${p.name}\n\n[[${notePath(0).replace(/\.md$/, '')}]]\n`;
  fs.writeFileSync(path.join(hostPath, 'index.md'), index);
  markdownBytes += Buffer.byteLength(index);

  let attachmentBytes = 0;
  if (p.attachments > 0) {
    const block = Buffer.alloc(1 << 20);
    const r = rng(0xa77ac4);
    for (let i = 0; i < block.length; i++) block[i] = Math.floor(r() * 256);
    fs.mkdirSync(path.join(hostPath, 'attachments'), { recursive: true });
    for (let i = 0; i < p.attachments; i++) {
      const fd = fs.openSync(path.join(hostPath, 'attachments', `a${i}.bin`), 'w');
      for (let written = 0; written < p.attachmentBytes; written += block.length) {
        fs.writeSync(fd, block, 0, Math.min(block.length, p.attachmentBytes - written));
      }
      fs.closeSync(fd);
      attachmentBytes += p.attachmentBytes;
    }
  }

  const seeded: SeededFixture = {
    remotePath: `${REMOTE_VAULT_ROOT}/${dir}`,
    hostPath,
    markdownFiles: p.notes + 1,
    markdownBytes,
    attachmentBytes,
  };
  fs.writeFileSync(marker, JSON.stringify(seeded));
  return seeded;
}
