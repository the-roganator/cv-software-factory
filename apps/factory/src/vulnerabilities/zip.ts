/**
 * One file from a zip archive, as GitHub hands out a workflow run's artifact: no library, since the factory reads one
 * small file from an archive its own workflow made.
 *
 * It reads the central directory, finds the entry by its exact name, and inflates it only up to the size its caller
 * allows, so a malformed or oversized archive is an error, never a large allocation. It reads stored and deflated
 * entries, checks each one's CRC, and refuses ZIP64, encryption and anything else as not what the factory's workflows
 * upload.
 */
import { crc32, inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  override name = 'ZipError';
}

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The end record's fixed part, and the most its comment may add. */
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;

const u16 = (zip: Buffer, at: number) => {
  if (at < 0 || at + 2 > zip.length) throw new ZipError('the archive is cut short');
  return zip.readUInt16LE(at);
};
const u32 = (zip: Buffer, at: number) => {
  if (at < 0 || at + 4 > zip.length) throw new ZipError('the archive is cut short');
  return zip.readUInt32LE(at);
};

/** The entry named `name`, inflated, or undefined when the archive has none; at most `maxBytes`, or a `ZipError`. */
export function zipEntry(zip: Buffer, name: string, maxBytes: number): Buffer | undefined {
  let end = -1;
  for (let at = zip.length - END_SIZE; at >= Math.max(0, zip.length - END_SIZE - MAX_COMMENT); at--) {
    if (zip.readUInt32LE(at) === END) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ZipError('not a zip archive');
  const entries = u16(zip, end + 10);
  const offset = u32(zip, end + 16);
  if (entries === 0xffff || offset === 0xffffffff) throw new ZipError('a ZIP64 archive');
  let at = offset;
  for (let i = 0; i < entries; i++) {
    if (u32(zip, at) !== CENTRAL) throw new ZipError('the central directory is malformed');
    const flags = u16(zip, at + 8);
    const method = u16(zip, at + 10);
    const crc = u32(zip, at + 16);
    const packed = u32(zip, at + 20);
    const size = u32(zip, at + 24);
    const nameLength = u16(zip, at + 28);
    const extraLength = u16(zip, at + 30);
    const commentLength = u16(zip, at + 32);
    const local = u32(zip, at + 42);
    if (at + 46 + nameLength > zip.length) throw new ZipError('the archive is cut short');
    const entry = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (entry !== name) continue;
    if (flags & 0x1) throw new ZipError('an encrypted entry');
    if (packed === 0xffffffff || size === 0xffffffff) throw new ZipError('a ZIP64 entry');
    if (size > maxBytes) throw new ZipError(`${name} is over ${maxBytes} bytes`);
    if (u32(zip, local) !== LOCAL) throw new ZipError('a local header is malformed');
    const start = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
    if (start + packed > zip.length) throw new ZipError('the archive is cut short');
    const data = zip.subarray(start, start + packed);
    let out: Buffer;
    if (method === 0) out = Buffer.from(data);
    else if (method === 8) {
      try {
        out = inflateRawSync(data, { maxOutputLength: maxBytes });
      } catch {
        throw new ZipError(`${name} does not inflate within ${maxBytes} bytes`);
      }
    } else throw new ZipError(`${name} is compressed by a method the factory does not read`);
    if (out.length !== size || crc32(out) !== crc) throw new ZipError(`${name} is not what its directory says`);
    return out;
  }
  return undefined;
}
