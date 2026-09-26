import * as fs from 'fs';

/**
 * Write a file without a reader seeing a half-written one.
 *
 * Into a pid-suffixed temp file beside the destination, then rename, which is
 * atomic within a filesystem. The unlink on a failed rename earns its keep as
 * much as the rename does: a cross-device or permissions failure would
 * otherwise leave `<name>.<pid>.tmp` behind, to accumulate and — worse — to
 * look like real config to anything reading the directory.
 *
 * Two things it does not promise. The write itself is outside that guard, so a
 * full disk can still orphan a partial temp file; and there is no `fsync`, so
 * this is rename-atomic, not crash-durable — a power cut can lose the write
 * even though no reader ever saw it torn.
 *
 * Shared because the same sequence was written out three times across two
 * files that were split in the same pass. They had not diverged; scattering
 * was the problem.
 */
export function writeFileAtomic(destination: string, content: string): void {
  const tmp = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  try {
    fs.renameSync(tmp, destination);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}
