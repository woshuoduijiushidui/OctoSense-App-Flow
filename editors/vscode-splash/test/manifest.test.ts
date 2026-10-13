import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * The version the plugin downloads is a constant in its manifest, and the
 * manifest mirrors tools/splash-server-toolchain.json — the record the release
 * workflow reads and publishes under (ADR 0003 §3). A pull request moves the
 * pin and names what changed in the server; this guard is what stops the two
 * copies from drifting apart in silence.
 */

// The test build mirrors the source tree (rootDir "."), so the package root is
// two levels up from the compiled test file.
const packageRoot = path.join(__dirname, '..', '..');

test('the manifest pins the server version the release record names', () => {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    splashCheck?: { serverVersion?: string };
  };
  const record = JSON.parse(
    readFileSync(path.join(packageRoot, '..', '..', 'tools', 'splash-server-toolchain.json'), 'utf8'),
  ) as { server: { version: string } };

  assert.equal(manifest.splashCheck?.serverVersion, record.server.version);
});
