import * as fs from 'fs';
import * as path from 'path';
import { inflateRawSync } from 'zlib';
import { causeOf } from './resolveServer';

/**
 * The download the resolver decides on, performed: fetch the pinned release
 * asset, take the binary out of it, and leave it somewhere runnable.
 *
 * The pure strategy names the URL and the destination (ADR 0003 §2 — the
 * function decides, the caller performs); this module is the caller. It is
 * also the only new seam on the extension side, and the place a network
 * failure becomes a sentence a person can act on.
 */

const LOCAL_FILE_HEADER = 0x04034b50;

/**
 * The one file `name` inside a zip archive, or `undefined` when it is not
 * there. Throws when the entry is present but the archive is truncated or its
 * checksum does not match — a resolver refuses a truncated or wrong download
 * instead of starting a corrupt binary (ADR 0003 §5).
 *
 * This reads the archive this repository publishes: local file headers,
 * stored or deflated entries, sizes in the header. It is not a general zip
 * library and does not try to be; an entry it cannot read is refused, not
 * guessed at.
 */
export function extractFile(archive: Uint8Array, name: string): Uint8Array | undefined {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let offset = 0;
  while (offset + 30 <= archive.length) {
    if (view.getUint32(offset, true) !== LOCAL_FILE_HEADER) {
      // The central directory follows the last entry; anything that is not a
      // local header is the end of the entries this reader walks.
      return undefined;
    }
    const method = view.getUint16(offset + 8, true);
    const checksum = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const entryName = new TextDecoder().decode(archive.subarray(offset + 30, offset + 30 + nameLength));
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) {
      throw new Error(`the archive is truncated: ${name} needs ${compressedSize} bytes at ${dataStart}`);
    }
    if (entryName === name) {
      const data = archive.subarray(dataStart, dataEnd);
      const bytes = method === 0 ? data : method === 8 ? inflateRawSync(data) : undefined;
      if (!bytes) {
        throw new Error(`the archive stores ${name} with unsupported method ${method}`);
      }
      if (crc32(bytes) !== checksum) {
        throw new Error(`the archive's ${name} does not match its checksum`);
      }
      return bytes;
    }
    offset = dataEnd;
  }
  return undefined;
}

/**
 * Fetches `url` and leaves the runnable binary at `destination`.
 *
 * A pinned release is immutable, so a binary already at the destination is
 * the bytes the version promised and a second activation starts them without
 * the network. Every failure throws with the cause in the message — the URL
 * on a network or HTTP failure, the entry name on a bad archive — because the
 * output channel has to say what happened (ADR 0003 §4).
 */
export async function downloadServer(url: string, destination: string): Promise<void> {
  if (fs.existsSync(destination)) {
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`could not reach ${url}: ${causeOf(error)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const archive = new Uint8Array(await response.arrayBuffer());
  const name = path.basename(destination);
  const binary = extractFile(archive, name);
  if (!binary) {
    throw new Error(`the archive at ${url} does not contain ${name}`);
  }
  fs.writeFileSync(destination, binary);
  if (process.platform !== 'win32') {
    // A downloaded binary is not executable until it is made so; the archive
    // carries no permissions and the release does not set them.
    fs.chmodSync(destination, 0o755);
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let crc = n;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[n] = crc >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
