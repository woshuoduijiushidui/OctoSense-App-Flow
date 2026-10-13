import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { resolveServer, type ResolveInputs } from '../src/resolveServer';

/**
 * The strategy over injected inputs, tested at the seam the ADR names: one
 * pure function, every effect an input (ADR 0003 §2, App Flow #7).
 *
 * Paths are built with `path.join` and compared through `path.normalize`, so
 * the suite reads the same whichever platform runs it.
 */

const exeName = (platform: string) => (platform === 'win32' ? 'splash-lsp.exe' : 'splash-lsp');

/** An `exists` that recognises exactly the given paths, whatever the separator. */
const existsIn = (...paths: string[]) => {
  const wanted = new Set(paths.map((candidate) => path.normalize(candidate)));
  return (candidate: string) => wanted.has(path.normalize(candidate));
};

const baseInputs = (overrides: Partial<ResolveInputs> = {}): ResolveInputs => ({
  setting: undefined,
  env: {},
  workspaceFolders: [],
  exists: () => false,
  platform: 'win32',
  arch: 'x64',
  version: '2.0.0',
  ...overrides,
});

describe('the discovery chain, unchanged', () => {
  test('a setting wins over the environment, the PATH, a sibling checkout and the download', async () => {
    const fetched: string[] = [];
    const setting = '/configured/splash-lsp.exe';
    const fromEnvironment = '/from-environment/splash-lsp.exe';
    const onPath = '/on-path/splash-lsp.exe';
    const sibling = '/workspace/../makepad/target/release/splash-lsp.exe';

    const resolution = await resolveServer(
      baseInputs({
        setting,
        env: { SPLASH_LSP: fromEnvironment, PATH: '/on-path' },
        workspaceFolders: ['/workspace'],
        exists: existsIn(setting, fromEnvironment, onPath, sibling),
        download: { cacheDir: '/cache', fetch: async (url) => void fetched.push(url) },
      }),
    );

    assert.deepEqual(resolution, {
      status: 'found',
      server: { command: setting, args: [] },
      source: 'setting',
    });
    assert.deepEqual(fetched, [], 'the download never runs when a local source answers');
  });

  test('the environment wins over the PATH, a sibling checkout and the download', async () => {
    const fromEnvironment = '/from-environment/splash-lsp.exe';
    const onPath = '/on-path/splash-lsp.exe';
    const sibling = '/workspace/makepad/target/release/splash-lsp.exe';

    const resolution = await resolveServer(
      baseInputs({
        env: { SPLASH_LSP: fromEnvironment, PATH: '/on-path' },
        workspaceFolders: ['/workspace'],
        exists: existsIn(fromEnvironment, onPath, sibling),
      }),
    );

    assert.deepEqual(resolution, {
      status: 'found',
      server: { command: fromEnvironment, args: [] },
      source: 'environment',
    });
  });

  test('the PATH wins over a sibling checkout and the download', async () => {
    const sibling = '/workspace/makepad/target/release/splash-lsp.exe';

    const resolution = await resolveServer(
      baseInputs({
        env: { PATH: '/on-path' },
        workspaceFolders: ['/workspace'],
        exists: existsIn('/on-path/splash-lsp.exe', sibling),
      }),
    );

    assert.equal(resolution.status, 'found');
    assert.equal(resolution.status === 'found' && resolution.source, 'path');
    assert.match(
      resolution.status === 'found' ? resolution.server.command.replaceAll('\\', '/') : '',
      /^\/on-path\/splash-lsp\.exe$/,
    );
  });

  test('a sibling checkout wins over the download', async () => {
    const fetched: string[] = [];
    const sibling = '/workspace/../Octoscript-Makepad/target/release/splash-lsp.exe';

    const resolution = await resolveServer(
      baseInputs({
        workspaceFolders: ['/workspace'],
        exists: existsIn(sibling),
        download: { cacheDir: '/cache', fetch: async (url) => void fetched.push(url) },
      }),
    );

    assert.equal(resolution.status, 'found');
    assert.equal(resolution.status === 'found' && resolution.source, 'sibling');
    assert.deepEqual(fetched, [], 'the download never runs when a local source answers');
  });

  test('with nothing local and no download, there is no server', async () => {
    const resolution = await resolveServer(baseInputs());

    assert.deepEqual(resolution, { status: 'unavailable', reason: { kind: 'no-server' } });
  });
});

describe('the download, the last source', () => {
  const RELEASE = 'https://github.com/woshuoduijiushidui/OctoSense-App-Flow/releases/download';

  test('with nothing local, the pinned version is downloaded and started', async () => {
    const fetched: Array<[string, string]> = [];

    const resolution = await resolveServer(
      baseInputs({
        download: {
          cacheDir: '/cache',
          fetch: async (url, destination) => void fetched.push([url, destination]),
        },
      }),
    );

    assert.deepEqual(fetched, [
      [`${RELEASE}/splash-lsp-v2.0.0/splash-lsp-2.0.0-x86_64-pc-windows-msvc.zip`, path.join('/cache', 'splash-lsp-2.0.0', 'splash-lsp.exe')],
    ]);
    assert.deepEqual(resolution, {
      status: 'found',
      server: { command: path.join('/cache', 'splash-lsp-2.0.0', 'splash-lsp.exe'), args: [] },
      source: 'download',
    });
  });

  test('the download names the version it was given, so a bump re-downloads', async () => {
    const fetched: string[] = [];

    await resolveServer(
      baseInputs({
        version: '9.9.9',
        download: { cacheDir: '/cache', fetch: async (url) => void fetched.push(url) },
      }),
    );

    assert.deepEqual(fetched, [`${RELEASE}/splash-lsp-v9.9.9/splash-lsp-9.9.9-x86_64-pc-windows-msvc.zip`]);
  });

  test('a platform with no published asset says so, distinctly from a failed download', async () => {
    let called = false;

    const resolution = await resolveServer(
      baseInputs({
        platform: 'darwin',
        arch: 'arm64',
        download: {
          cacheDir: '/cache',
          fetch: async () => {
            called = true;
          },
        },
      }),
    );

    assert.deepEqual(resolution, {
      status: 'unavailable',
      reason: { kind: 'unsupported-platform', platform: 'darwin', arch: 'arm64' },
    });
    assert.equal(called, false, 'nothing is fetched for a platform no asset was published for');
  });

  test('a failed download falls back to the discovery chain and does not throw', async () => {
    const resolution = await resolveServer(
      baseInputs({
        download: {
          cacheDir: '/cache',
          fetch: async () => {
            throw new Error('HTTP 404 for the release asset');
          },
        },
      }),
    );

    assert.deepEqual(resolution, {
      status: 'unavailable',
      reason: { kind: 'download-failed', cause: 'HTTP 404 for the release asset' },
    });
  });

  test('a local source still wins when the download would have failed', async () => {
    let called = false;
    const fromEnvironment = '/from-environment/splash-lsp.exe';

    const resolution = await resolveServer(
      baseInputs({
        env: { SPLASH_LSP: fromEnvironment },
        exists: existsIn(fromEnvironment),
        download: {
          cacheDir: '/cache',
          fetch: async () => {
            called = true;
          },
        },
      }),
    );

    assert.deepEqual(resolution, {
      status: 'found',
      server: { command: fromEnvironment, args: [] },
      source: 'environment',
    });
    assert.equal(called, false, 'the download never runs when a local source answers');
  });
});

describe('the failures that used to leave only highlighting', () => {
  // A Windows path typed the way a Windows person types it — single backslashes
  // — either fails to parse as JSON or, once it has round-tripped through a
  // layer that escaped it once, arrives with its separators eaten (ADR 0003).
  const mangledSetting = 'C:\\Users\\me\\splash-lsp.exe';

  test('a setting mangled by escaping does not win: resolution falls through to the environment', async () => {
    const fromEnvironment = '/from-environment/splash-lsp.exe';

    const resolution = await resolveServer(
      baseInputs({
        setting: mangledSetting,
        env: { SPLASH_LSP: fromEnvironment },
        exists: existsIn(fromEnvironment),
      }),
    );

    assert.deepEqual(resolution, {
      status: 'found',
      server: { command: fromEnvironment, args: [] },
      source: 'environment',
    });
  });

  test('a setting mangled by escaping does not stop the download either', async () => {
    const fetched: string[] = [];

    const resolution = await resolveServer(
      baseInputs({
        setting: mangledSetting,
        exists: existsIn(), // the mangled path points at nothing
        download: { cacheDir: '/cache', fetch: async (url) => void fetched.push(url) },
      }),
    );

    assert.equal(fetched.length, 1);
    assert.equal(resolution.status, 'found');
    assert.equal(resolution.status === 'found' && resolution.source, 'download');
  });

  test('a path the host cached earlier in the session is not returned once it is gone', async () => {
    // The extension host keeps the resolved server for its session. The
    // strategy holds no such state: a re-resolution answers from the inputs as
    // they are now, so a binary that moved cannot be answered from memory.
    const stale = '/from-environment/splash-lsp.exe';

    const first = await resolveServer(
      baseInputs({ env: { SPLASH_LSP: stale }, exists: existsIn(stale) }),
    );
    assert.deepEqual(first, {
      status: 'found',
      server: { command: stale, args: [] },
      source: 'environment',
    });

    const second = await resolveServer(
      baseInputs({
        env: { SPLASH_LSP: stale },
        exists: existsIn(), // the binary is no longer there
        download: { cacheDir: '/cache', fetch: async () => {} },
      }),
    );

    assert.deepEqual(second, {
      status: 'found',
      server: { command: path.join('/cache', 'splash-lsp-2.0.0', 'splash-lsp.exe'), args: [] },
      source: 'download',
    });
  });
});
