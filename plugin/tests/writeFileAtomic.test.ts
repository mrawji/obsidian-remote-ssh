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

const POSIX = process.platform !== 'win32';

describe('writeFileAtomic', () => {
  // Replacing the whole body with a plain `writeFileSync(dest, content)`
  // passed every other case here — so nothing pinned the tmp+rename at all,
  // which is the only reason this function exists.
  //
  // A read-only destination tells them apart for real: writing to it is
  // EACCES, but renaming over it needs write permission on the *directory*,
  // not on the file. Windows has no mode bits for `chmod` to set, and root
  // ignores them, so this is POSIX and non-root only.
  it.skipIf(!POSIX || process.getuid?.() === 0)(
    'replaces a file even when the file itself is read-only',
    () => {
      const dest = path.join(dir, 'app.json');
      fs.writeFileSync(dest, '{"old":true}', 'utf-8');
      fs.chmodSync(dest, 0o444);

      writeFileAtomic(dest, '{"new":true}');

      expect(fs.readFileSync(dest, 'utf-8'), 'a direct write could not have done this')
        .toBe('{"new":true}');
      expect(leftovers()).toEqual([]);
    },
  );

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
