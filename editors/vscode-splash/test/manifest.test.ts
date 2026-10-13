import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { resolveServer } from '../src/resolveServer';

/**
 * The pin the plugin downloads with, and the release it points at, mirrored
 * from tools/splash-server-toolchain.json — the record the release workflow
 * reads and publishes under (ADR 0003 §3). A pull request moves the pin and
 * names what changed in the server; these guards are what stop the manifest's
 * copy, and the naming the strategy builds URLs from, from drifting away from
 * the record in silence.
 */

// The test build mirrors the source tree (rootDir "."), so the package root is
// two levels up from the compiled test file.
const packageRoot = path.join(__dirname, '..', '..');

const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
  splashCheck?: { serverRevision?: string };
};
const record = JSON.parse(
  readFileSync(path.join(packageRoot, '..', '..', 'tools', 'splash-server-toolchain.json'), 'utf8'),
) as {
  server: {
    version: string;
    source: { revision: string };
    release: { repository: string; tag: string };
  };
  platforms: Array<{ platform: string; target?: string; asset?: string }>;
};

test('the manifest pins the server version the release record names', () => {
  assert.equal(
    manifest.contributes.configuration.properties['splashCheck.serverVersion'].default,
    record.server.version,
  );
});

test('the manifest records the revision the release asset was built from', () => {
  assert.equal(manifest.splashCheck?.serverRevision, record.server.source.revision);
});

test('the download names the release the record publishes', async () => {
  const fetched: string[] = [];
  const published = record.platforms.find((entry) => entry.platform === 'win32');
  assert.ok(published?.asset, 'the record publishes a win32 asset');

  await resolveServer({
    setting: undefined,
    env: {},
    workspaceFolders: [],
    exists: () => false,
    platform: 'win32',
    arch: 'x64',
    version: record.server.version,
    download: { cacheDir: '/cache', fetch: async (url) => void fetched.push(url) },
  });

  assert.deepEqual(fetched, [
    `https://github.com/${record.server.release.repository}/releases/download/${record.server.release.tag}/${published.asset}`,
  ]);
});
