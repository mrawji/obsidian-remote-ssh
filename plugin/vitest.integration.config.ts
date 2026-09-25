import { defineConfig } from 'vitest/config';
import { coverageScope } from './vitest.coverage';

// Integration tests against the docker sshd container started by
// `npm run sshd:start`. Slower than unit tests (real network +
// keypair handshake) so they live in their own config and aren't
// included by default.
//
// Run manually with `npm run test:integration`. The CI integration
// job (`.github/workflows/integration.yml`) brings docker up, runs
// this config, and tears down.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/integration/**/*.test.ts'],
    // Each test usually opens its own SSH session; serialise so we
    // don't fight over the single sshd container.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Same scope as the unit config, no thresholds: this suite covers the
    // transport and daemon seams on purpose and would fail any number set
    // for the whole tree. CI runs it with `--coverage` and uploads the
    // result, so code that only the real sshd can reach stops reading as
    // untested — `SftpClient.connect()` and the jump-host route are only
    // ever executed here.
    coverage: { ...coverageScope },
  },
});
