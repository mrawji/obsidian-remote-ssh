import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  collectModelEntries,
  deleteTreeSnapshot,
  readTreeSnapshot,
  treeSnapshotPath,
  writeTreeSnapshot,
} from '../src/vault/TreeSnapshot';
import type { RemoteEntry } from '../src/vault/VaultModelBuilder';

let root: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-snapshot-'));
  file = treeSnapshotPath(root, 'profile-1');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ENTRIES: RemoteEntry[] = [
  { path: 'notes', isDirectory: true, ctime: 0, mtime: 0, size: 0 },
  { path: 'notes/a.md', isDirectory: false, ctime: 1_758_500_000_000, mtime: 1_758_500_000_000, size: 120 },
  { path: 'index.md', isDirectory: false, ctime: 1_758_400_000_000, mtime: 1_758_400_000_000, size: 7 },
];

describe('TreeSnapshot', () => {
  it('lives beside the other per-device state, outside every vault', () => {
    expect(file).toBe(path.join(root, 'state', 'profile-1', 'tree-snapshot.json'));
  });

  it('round-trips paths, kinds, mtime and size', () => {
    writeTreeSnapshot(file, '/home/u/vault', ENTRIES);
    expect(readTreeSnapshot(file, '/home/u/vault')).toEqual(ENTRIES);
  });

  it('is ignored for a different remotePath', () => {
    writeTreeSnapshot(file, '/home/u/vault', ENTRIES);
    expect(readTreeSnapshot(file, '/home/u/other')).toBeNull();
  });

  it('is null when missing, corrupt, or from another version', () => {
    expect(readTreeSnapshot(file, '/v')).toBeNull();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    expect(readTreeSnapshot(file, '/v')).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 99, remotePath: '/v', entries: [] }));
    expect(readTreeSnapshot(file, '/v')).toBeNull();
  });

  it('writes atomically and leaves no temp file behind', () => {
    writeTreeSnapshot(file, '/v', ENTRIES);
    writeTreeSnapshot(file, '/v', ENTRIES.slice(0, 1));
    expect(fs.readdirSync(path.dirname(file))).toEqual(['tree-snapshot.json']);
    expect(readTreeSnapshot(file, '/v')).toHaveLength(1);
  });

  it('delete is idempotent', () => {
    writeTreeSnapshot(file, '/v', ENTRIES);
    deleteTreeSnapshot(file);
    deleteTreeSnapshot(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  describe('collectModelEntries', () => {
    it('skips the root and the config dir, and orders parents before children', () => {
      const out = collectModelEntries([
        { path: '/', children: [] },
        { path: 'notes/a.md', stat: { mtime: 5, size: 50 } },
        { path: '.obsidian', children: [] },
        { path: '.obsidian/app.json', stat: { mtime: 1, size: 1 } },
        { path: 'notes', children: [] },
        { path: 'index.md', stat: { mtime: 2, size: 20 } },
      ], '.obsidian');

      expect(out.map((e) => e.path)).toEqual(['notes', 'index.md', 'notes/a.md']);
      expect(out[2]).toEqual({ path: 'notes/a.md', isDirectory: false, ctime: 5, mtime: 5, size: 50 });
      expect(out[0].isDirectory).toBe(true);
    });
  });
});
