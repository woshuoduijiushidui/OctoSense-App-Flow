import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { downloadServer, extractFile } from '../src/serverDownload';

/**
 * The archive the release workflow publishes: one entry, named for the
 * platform's own binary, packed by Python's zipfile exactly as
 * .github/workflows/release-splash-lsp.yml packs it. The fixtures below are
 * written the same way — with Node's own `crc32` and `deflateRawSync`, which
 * are not the reader's implementations, so a checksum that agrees means
 * something.
 */

/** A zip archive holding one entry, as the release workflow packs one. */
function zipOf(name: string, data: Uint8Array, method: 0 | 8 = 8, flags = 0): Uint8Array {
  const stored = method === 0 ? data : deflateRawSync(data);
  const nameBytes = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // local file header signature
  header.writeUInt16LE(20, 4); // version needed to extract
  header.writeUInt16LE(flags, 6); // flags
  header.writeUInt16LE(method, 8); // 0 = stored, 8 = deflated
  header.writeUInt16LE(0, 10); // mod time
  header.writeUInt16LE(0, 12); // mod date
  header.writeUInt32LE(crc32(data), 14);
  // A data descriptor (flag bit 3) puts the sizes after the data, zeroed here.
  header.writeUInt32LE(flags & 0x08 ? 0 : stored.length, 18);
  header.writeUInt32LE(flags & 0x08 ? 0 : data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([header, nameBytes, stored]);
}

const binary = Buffer.from('MZ this is not really a portable executable, only its bytes');

describe('extractFile', () => {
  test('the one entry in the release asset', () => {
    const archive = zipOf('splash-lsp.exe', binary);

    assert.deepEqual(extractFile(archive, 'splash-lsp.exe'), binary);
  });

  test('a stored entry', () => {
    const archive = zipOf('splash-lsp', binary, 0);

    assert.deepEqual(extractFile(archive, 'splash-lsp'), binary);
  });

  test('an entry that is not there', () => {
    const archive = zipOf('something-else.exe', binary);

    assert.equal(extractFile(archive, 'splash-lsp.exe'), undefined);
  });

  test('a truncated archive is refused, not started', () => {
    const archive = zipOf('splash-lsp.exe', binary);
    const truncated = archive.subarray(0, 30 + 'splash-lsp.exe'.length + 2);

    assert.throws(() => extractFile(truncated, 'splash-lsp.exe'));
  });

  test('an entry that does not match its checksum is refused, not started', () => {
    const archive = zipOf('splash-lsp.exe', binary, 0);
    const corrupted = Uint8Array.from(archive);
    corrupted[30 + 'splash-lsp.exe'.length] ^= 0xff;

    assert.throws(() => extractFile(corrupted, 'splash-lsp.exe'));
  });

  test('an entry written with a data descriptor is refused, not guessed at', () => {
    // Sizes zeroed in the header and written after the data: neither this
    // entry's length nor the next header's offset is knowable from it.
    const archive = zipOf('splash-lsp.exe', binary, 8, 0x08);

    assert.throws(() => extractFile(archive, 'splash-lsp.exe'), /data descriptor/);
  });
});

describe('downloadServer', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('fetches the URL and leaves the binary at the destination', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (url: string) => {
      requested.push(url);
      return new Response(zipOf('splash-lsp.exe', binary));
    }) as typeof fetch;
    const destination = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'splash-check-')), 'splash-lsp-2.0.0', 'splash-lsp.exe');

    await downloadServer('https://example.invalid/splash-lsp-2.0.0-x86_64-pc-windows-msvc.zip', destination);

    assert.deepEqual(requested, ['https://example.invalid/splash-lsp-2.0.0-x86_64-pc-windows-msvc.zip']);
    assert.deepEqual(fs.readFileSync(destination), binary);
  });

  test('a binary already at the destination is not fetched again', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(zipOf('splash-lsp.exe', binary));
    }) as typeof fetch;
    const destination = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'splash-check-')), 'splash-lsp-2.0.0', 'splash-lsp.exe');

    await downloadServer('https://example.invalid/asset.zip', destination);
    await downloadServer('https://example.invalid/asset.zip', destination);

    assert.equal(calls, 1, 'a pinned release is immutable: the bytes on disk are the version promised');
  });

  test('a response that is not ok throws with the status in the message', async () => {
    globalThis.fetch = (async () => new Response('no such release', { status: 404 })) as typeof fetch;
    const destination = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'splash-check-')), 'splash-lsp-2.0.0', 'splash-lsp.exe');

    await assert.rejects(downloadServer('https://example.invalid/asset.zip', destination), /HTTP 404/);
  });

  test('a failed extraction leaves nothing startable at the destination', async () => {
    globalThis.fetch = (async () => new Response(zipOf('something-else.exe', binary))) as typeof fetch;
    const destination = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'splash-check-')), 'splash-lsp-2.0.0', 'splash-lsp.exe');

    await assert.rejects(downloadServer('https://example.invalid/asset.zip', destination), /does not contain/);
    assert.equal(fs.existsSync(destination), false, 'no partial file may pass for the version\'s binary');
  });
});
