/**
 * Diagnostic-bundle generator.
 *
 * One-click "send to support": collects sanitised recent logs, the OS /
 * hardware profile, the installed-skills + model lists, and the running
 * Omninity-Operator + OS version into a single ZIP. Every text payload
 * passes through `sanitise()` so paths outside `OP_HOME`, credentials, and
 * user content never reach the bundle.
 *
 * `previewBundle()` returns the manifest WITHOUT building the ZIP — the UI
 * shows the user exactly what will be exported and asks for confirmation
 * before `buildBundle()` produces the binary.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LOG_DOMAIN_NAMES, type LogDomain } from "./index";
import { listRotatedFiles } from "./rotation";
import { sanitise, opHome } from "./sanitiser";
import { recentLogs } from "./ring-buffer";
import { buildZip, bundleHash } from "./zip";

export interface BundleManifest {
  generatedAt: string;
  opVersion: string;
  os: {
    platform: NodeJS.Platform;
    release: string;
    arch: string;
  };
  hardware: {
    cpus: number;
    cpuModel: string;
    totalMemoryMb: number;
    freeMemoryMb: number;
  };
  files: ReadonlyArray<{
    name: string;
    description: string;
    sizeBytes: number;
  }>;
  skills: ReadonlyArray<string>;
  models: ReadonlyArray<string>;
  excludes: ReadonlyArray<string>;
}

const EXCLUDES = [
  "User chat content & agent prompts",
  "File contents from outside the OP home directory",
  "Credentials, tokens, API keys, session cookies",
  "Screenshots, clipboard captures, microphone audio",
  "Personal identifiers (email, SSN, payment cards) when found in messages",
] as const;

export interface BundleSources {
  /** Override hooks so callers (the actual installed-skills service, the
   *  Ollama model list, etc.) can plug in their own data without this
   *  module importing every domain. Tests pass deterministic stubs. */
  installedSkills?: () => string[] | Promise<string[]>;
  installedModels?: () => string[] | Promise<string[]>;
  opVersion?: () => string;
  logDir?: () => string;
}

function defaultLogDir(): string {
  return process.env["LOG_DIR"] ?? path.join(process.cwd(), "logs");
}

function defaultOpVersion(): string {
  return (
    process.env["OP_VERSION"] ??
    process.env["npm_package_version"] ??
    "0.0.0-dev"
  );
}

function readLogTail(filePath: string, maxBytes: number): string {
  try {
    const st = fs.statSync(filePath);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function collectDomainLogText(
  domain: LogDomain,
  logDir: string,
  maxBytesPerDomain: number,
): string {
  const live = path.join(logDir, `${domain}.log`);
  const rotated = listRotatedFiles(live);
  if (rotated.length === 0) return "";
  // Pull from oldest rotated file forward to the live file so the ordering
  // of lines reflects the original time sequence.
  const ordered = [...rotated].reverse();
  const perFile = Math.floor(maxBytesPerDomain / ordered.length);
  const parts: string[] = [];
  for (const f of ordered) parts.push(readLogTail(f, perFile));
  return parts.join("");
}

function sanitiseLogText(input: string): string {
  if (!input) return input;
  // Each line is JSON; sanitise field-wise, then re-emit. Lines that fail
  // to parse (truncated tail) are dropped — better than leaking raw bytes
  // into a support bundle.
  const out: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      out.push(JSON.stringify(sanitise(parsed)));
    } catch {
      /* drop malformed line */
    }
  }
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}

function gatherHardware(): BundleManifest["hardware"] {
  const cpus = os.cpus();
  const first = cpus[0];
  return {
    cpus: cpus.length,
    cpuModel: first ? first.model : "unknown",
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
  };
}

function gatherOs(): BundleManifest["os"] {
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
  };
}

export async function previewBundle(
  sources: BundleSources = {},
): Promise<BundleManifest> {
  const logDir = sources.logDir?.() ?? defaultLogDir();
  const skills = sources.installedSkills ? await sources.installedSkills() : [];
  const models = sources.installedModels ? await sources.installedModels() : [];

  const files: BundleManifest["files"] = [
    {
      name: "manifest.json",
      description: "Bundle manifest + hardware/version profile",
      sizeBytes: 0,
    },
    ...LOG_DOMAIN_NAMES.map((d) => {
      const live = path.join(logDir, `${d}.log`);
      const rotated = listRotatedFiles(live);
      let total = 0;
      for (const f of rotated) {
        try {
          total += fs.statSync(f).size;
        } catch {
          /* ignore */
        }
      }
      return {
        name: `logs/${d}.log`,
        description: `Sanitised tail of ${d} channel`,
        sizeBytes: total,
      };
    }),
    {
      name: "ring-buffer.json",
      description: "Recent in-memory log records",
      sizeBytes: recentLogs.length,
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    opVersion: (sources.opVersion ?? defaultOpVersion)(),
    os: gatherOs(),
    hardware: gatherHardware(),
    files,
    skills,
    models,
    excludes: EXCLUDES,
  };
}

export interface BuiltBundle {
  buffer: Buffer;
  manifest: BundleManifest;
  sha256Prefix: string;
  filename: string;
}

const MAX_TOTAL_LOG_BYTES = 20 * 1024 * 1024; // 20MB hard cap on bundle log payload

export async function buildBundle(
  sources: BundleSources = {},
): Promise<BuiltBundle> {
  const logDir = sources.logDir?.() ?? defaultLogDir();
  const manifest = await previewBundle(sources);

  const perDomain = Math.floor(MAX_TOTAL_LOG_BYTES / LOG_DOMAIN_NAMES.length);
  const files: { name: string; data: string | Buffer }[] = [];

  files.push({
    name: "manifest.json",
    data: JSON.stringify(
      { ...manifest, opHome: opHome() },
      null,
      2,
    ),
  });

  for (const d of LOG_DOMAIN_NAMES) {
    const raw = collectDomainLogText(d, logDir, perDomain);
    files.push({ name: `logs/${d}.log`, data: sanitiseLogText(raw) });
  }

  const ring = recentLogs.query({ limit: 1000 });
  files.push({
    name: "ring-buffer.json",
    data: JSON.stringify(sanitise(ring), null, 2),
  });

  const buffer = buildZip(files);
  const sha = bundleHash(buffer);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    buffer,
    manifest,
    sha256Prefix: sha,
    filename: `omninity-diagnostic-${stamp}-${sha}.zip`,
  };
}
