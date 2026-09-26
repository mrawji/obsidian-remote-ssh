import * as fs from 'fs';

/**
 * Write a file so no reader ever sees a partial one.
 *
 * Into a pid-suffixed temp file beside the destination, then rename, which is
 * atomic within a filesystem. The unlink on a failed rename earns its keep as
 * much as the rename does: a cross-device or permissions failure would
 * otherwise leave `<name>.<pid>.tmp` behind, to accumulate and — worse — to
 * look like real config to anything reading the directory.
 *
 * Shared because three copies of this had drifted apart into two files that
 * were split in the same pass.
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
