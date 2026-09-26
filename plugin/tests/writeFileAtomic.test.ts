import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomic } from '../src/util/writeFileAtomic';

/**
 * Three copies of this lived in two files before it was shared, and the half
 * that matters was untested in all of them: what is left behind when the
 * rename fails. An orphaned `<name>.<pid>.tmp` in the vault's config
 * directory does not merely accumulate — it reads as real config to anything
 * listing that directory.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Anything the write should not have left behind. */
function leftovers(): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
}

describe('writeFileAtomic', () => {
  it('leaves the content in place and nothing beside it', () => {
    const dest = path.join(dir, 'community-plugins.json');

    writeFileAtomic(dest, '["dataview"]\n');

    expect(fs.readFileSync(dest, 'utf-8')).toBe('["dataview"]\n');
    expect(leftovers(), 'the temp file is an implementation detail').toEqual([]);
  });

  it('replaces an existing file rather than appending to it', () => {
    const dest = path.join(dir, 'app.json');
    fs.writeFileSync(dest, '{"old":true}', 'utf-8');

    writeFileAtomic(dest, '{"new":true}');

    expect(fs.readFileSync(dest, 'utf-8')).toBe('{"new":true}');
  });

  it('cleans up after itself when the rename fails', () => {
    // A real failure rather than a mocked one — renaming a file onto a
    // non-empty directory cannot succeed anywhere. Standing in for the
    // cross-device and permissions cases the unlink is actually there for.
    const dest = path.join(dir, 'occupied');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'keep.txt'), 'x', 'utf-8');

    expect(() => writeFileAtomic(dest, 'replacement')).toThrow();

    expect(leftovers(), 'a stray .tmp reads as real config to anything listing this dir')
      .toEqual([]);
    expect(
      fs.existsSync(path.join(dest, 'keep.txt')),
      'and what it failed to replace has to be untouched',
    ).toBe(true);
  });
});
