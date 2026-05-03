/**
 * Size-capped log rotation.
 *
 * Each log file is capped at `maxBytes` (default 10MB). When the cap is
 * reached we roll the file:
 *     app.log → app.log.1 → app.log.2 → ... → app.log.5 (dropped)
 *
 * The writer is a `Writable` so pino can stream JSON lines into it. We
 * accumulate the byte count locally to avoid a `fs.statSync` per write.
 *
 * Failures are intentionally swallowed (logged to `process.stderr` once) —
 * a logging crash MUST NOT take the server down. The total disk budget per
 * domain is `maxBytes * (maxFiles + 1)` (the live file + N rotated files);
 * with the defaults that is 60MB per domain, well under the ~300MB total
 * budget once the five domains share the directory.
 */
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";

export interface RotatingFileOptions {
  filePath: string;
  maxBytes?: number;
  maxFiles?: number;
}

export class RotatingFileStream extends Writable {
  private bytesWritten = 0;
  private fd: number | null = null;
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private warned = false;

  constructor(opts: RotatingFileOptions) {
    super({ decodeStrings: true });
    this.filePath = opts.filePath;
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.maxFiles = opts.maxFiles ?? 5;
    this.openFile();
  }

  private openFile() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.fd = fs.openSync(this.filePath, "a");
      try {
        const st = fs.fstatSync(this.fd);
        this.bytesWritten = st.size;
      } catch {
        this.bytesWritten = 0;
      }
    } catch (e) {
      this.warnOnce(`open failed: ${(e as Error).message}`);
      this.fd = null;
    }
  }

  private warnOnce(msg: string) {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write(`[logger] ${this.filePath}: ${msg}\n`);
  }

  private rotate() {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }

    // Drop the oldest, shift each .N → .(N+1), then live → .1.
    const oldest = `${this.filePath}.${this.maxFiles}`;
    try {
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    } catch {
      /* ignore */
    }
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = `${this.filePath}.${i}`;
      const dst = `${this.filePath}.${i + 1}`;
      try {
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      } catch {
        /* ignore */
      }
    }
    try {
      if (fs.existsSync(this.filePath))
        fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      /* ignore */
    }
    this.bytesWritten = 0;
    this.openFile();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    cb: (e?: Error | null) => void,
  ): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    try {
      if (this.bytesWritten + buf.length > this.maxBytes) {
        this.rotate();
      }
      if (this.fd === null) {
        this.openFile();
      }
      if (this.fd !== null) {
        fs.writeSync(this.fd, buf);
        this.bytesWritten += buf.length;
      }
      cb();
    } catch (e) {
      this.warnOnce(`write failed: ${(e as Error).message}`);
      cb();
    }
  }

  override _final(cb: (e?: Error | null) => void): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
    cb();
  }
}

/**
 * List the live + rotated files for a given domain log path, ordered
 * newest-first (live, .1, .2, ...).
 */
export function listRotatedFiles(filePath: string, maxFiles = 5): string[] {
  const out: string[] = [];
  if (fs.existsSync(filePath)) out.push(filePath);
  for (let i = 1; i <= maxFiles; i++) {
    const p = `${filePath}.${i}`;
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}
