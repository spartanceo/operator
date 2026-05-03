/**
 * Minimal ZIP archive writer (no external deps).
 *
 * Implements the subset of PKZIP needed for diagnostic bundles:
 *   - Local file headers + central directory + end-of-central-directory
 *   - DEFLATE compression via node:zlib
 *   - UTF-8 file names
 *
 * Intentionally minimal: no encryption, no ZIP64, no streaming. Bundles are
 * always under ~50MB so a single in-memory build is fine.
 */
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

interface Entry {
  name: string;
  data: Buffer;
  compressed: Buffer;
  crc: number;
  date: number; // dos date
  time: number; // dos time
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function dosDateTime(d = new Date()): { date: number; time: number } {
  const date =
    ((d.getFullYear() - 1980) << 9) |
    ((d.getMonth() + 1) << 5) |
    d.getDate();
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date, time };
}

function crc32(buf: Buffer): number {
  // Use node:crypto's md5 fallback? No — a real CRC32 is needed for ZIP.
  // Implement small table-based CRC32.
  let table = (crc32 as unknown as { _t?: Uint32Array })._t;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    (crc32 as unknown as { _t?: Uint32Array })._t = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] as number;
    const idx = (crc ^ byte) & 0xff;
    crc = (table[idx] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(
  files: ReadonlyArray<{ name: string; data: Buffer | string }>,
): Buffer {
  const { date, time } = dosDateTime();
  const entries: Entry[] = files.map((f) => {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    return {
      name: f.name,
      data,
      compressed: deflateRawSync(data),
      crc: crc32(data),
      date,
      time,
    };
  });

  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const localOffsets: number[] = [];

  for (const e of entries) {
    localOffsets.push(offset);
    const nameBuf = Buffer.from(e.name, "utf8");
    const lf = Buffer.alloc(30);
    lf.writeUInt32LE(SIG_LOCAL, 0);
    lf.writeUInt16LE(20, 4); // version needed
    lf.writeUInt16LE(0x0800, 6); // flags: utf-8 names
    lf.writeUInt16LE(8, 8); // method: deflate
    lf.writeUInt16LE(e.time, 10);
    lf.writeUInt16LE(e.date, 12);
    lf.writeUInt32LE(e.crc, 14);
    lf.writeUInt32LE(e.compressed.length, 18);
    lf.writeUInt32LE(e.data.length, 22);
    lf.writeUInt16LE(nameBuf.length, 26);
    lf.writeUInt16LE(0, 28); // extra
    local.push(lf, nameBuf, e.compressed);
    offset += lf.length + nameBuf.length + e.compressed.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as Entry;
    const nameBuf = Buffer.from(e.name, "utf8");
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8); // flags
    cd.writeUInt16LE(8, 10); // method
    cd.writeUInt16LE(e.time, 12);
    cd.writeUInt16LE(e.date, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.compressed.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // int attrs
    cd.writeUInt32LE(0, 38); // ext attrs
    cd.writeUInt32LE(localOffsets[i] as number, 42);
    central.push(cd, nameBuf);
    centralSize += cd.length + nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with central
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment

  return Buffer.concat([...local, ...central, eocd]);
}

/**
 * Stable identifier for a built bundle — useful for support tickets so the
 * support team can confirm the user is referencing the bundle they were
 * told to attach.
 */
export function bundleHash(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}
