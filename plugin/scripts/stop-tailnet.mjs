#!/usr/bin/env node
/**
 * Tear down the tailnet test environment (`docker-compose.tailnet.yml`).
 *
 * Takes the volumes with it. The tailnet's whole state — headscale's node
 * registry and each node's identity — lives in those volumes, and the
 * preauth keys on disk only mean anything to that registry. Keeping one
 * without the other leaves an environment that starts and then fails to
 * register, so both go together.
 *
 * The keypair in `docker/keys/` is deliberately left alone: the local
 * environment shares it.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here     = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const runDir   = path.join(repoRoot, 'docker', 'tailnet', 'run');

const r = spawnSync('docker', [
  'compose', '-f', path.join(repoRoot, 'docker-compose.tailnet.yml'),
  'down', '-v', '--remove-orphans',
], { stdio: 'inherit', cwd: repoRoot });

if (r.error?.code === 'ENOENT') {
  console.error('Missing required tool: docker. Is it on PATH?');
  process.exit(1);
}

// Stale keys would be handed to nodes registering against a registry that
// no longer knows them.
for (const node of ['vault', 'client']) {
  fs.rmSync(path.join(runDir, `authkey-${node}`), { force: true });
}

process.exit(r.status ?? 0);
