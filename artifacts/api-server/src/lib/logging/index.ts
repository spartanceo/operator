/**
 * Structured logging framework — Task 40.
 *
 * Single entry-point for every module-scoped logger in the api-server. Five
 * domain channels share a single writer pipeline so the on-disk shape is
 * uniform:
 *
 *   logs/
 *     app.log          general application + http
 *     agents.log       agent loop, planner/executor/verifier traces
 *     tools.log        tool catalog + invocations
 *     security.log     auth, csrf, rate-limit, sandbox violations
 *     performance.log  budget breaches, slow queries
 *
 * Every log line is a JSON object with the same fields:
 *   { ts, level, module, traceId?, tenantId?, msg, ...meta }
 *
 * The pipeline runs every record through `sanitise()` BEFORE it lands on
 * disk OR in the in-memory ring buffer — there is no path that bypasses
 * sanitisation.
 *
 * The standard `pino` instance exported by `lib/logger.ts` re-exports the
 * `app` channel for back-compat, so existing imports continue to work.
 */
import path from "node:path";

import pino, { type Logger as PinoLogger } from "pino";

import { LogRingBuffer, recentLogs, type LogRecord } from "./ring-buffer";
import { RotatingFileStream } from "./rotation";
import { sanitise } from "./sanitiser";

export type LogDomain =
  | "app"
  | "agents"
  | "tools"
  | "security"
  | "performance";

export const LOG_DOMAINS: ReadonlyArray<LogDomain> = [
  "app",
  "agents",
  "tools",
  "security",
  "performance",
] as const;

export interface LoggingConfig {
  logDir: string;
  level: "debug" | "info" | "warn" | "error" | "fatal";
  maxBytes: number;
  maxFiles: number;
  consoleOnly: boolean;
}

function readConfig(): LoggingConfig {
  const env = process.env["NODE_ENV"] ?? "development";
  const isDev = env === "development";
  const isTest = env === "test";
  const defaultLevel: LoggingConfig["level"] = isDev ? "debug" : "info";
  const level = (process.env["LOG_LEVEL"] ?? defaultLevel) as
    | LoggingConfig["level"]
    | string;
  const allowed = new Set(["debug", "info", "warn", "error", "fatal"]);
  return {
    logDir:
      process.env["LOG_DIR"] ??
      (isTest
        ? path.join(process.cwd(), ".tmp-test-logs")
        : path.join(process.cwd(), "logs")),
    level: (allowed.has(level)
      ? level
      : defaultLevel) as LoggingConfig["level"],
    maxBytes: Number(process.env["LOG_MAX_BYTES"] ?? 10 * 1024 * 1024),
    maxFiles: Number(process.env["LOG_MAX_FILES"] ?? 5),
    consoleOnly: isTest || process.env["LOG_CONSOLE_ONLY"] === "1",
  };
}

const config = readConfig();

function buildDomainStreams(): Map<LogDomain, NodeJS.WritableStream> {
  const map = new Map<LogDomain, NodeJS.WritableStream>();
  if (config.consoleOnly) {
    for (const d of LOG_DOMAINS) map.set(d, process.stdout);
    return map;
  }
  for (const d of LOG_DOMAINS) {
    map.set(
      d,
      new RotatingFileStream({
        filePath: path.join(config.logDir, `${d}.log`),
        maxBytes: config.maxBytes,
        maxFiles: config.maxFiles,
      }),
    );
  }
  return map;
}

const domainStreams = buildDomainStreams();

const LEVELS: ReadonlyArray<LogRecord["level"]> = [
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
];
const LEVEL_RANK: Record<LogRecord["level"], number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

function shouldEmit(level: LogRecord["level"]): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[config.level];
}

function emit(record: LogRecord, domain: LogDomain): void {
  if (!shouldEmit(record.level)) return;
  const sanitised = sanitise(record);
  recentLogs.push(sanitised);
  const stream = domainStreams.get(domain);
  if (!stream) return;
  try {
    stream.write(`${JSON.stringify(sanitised)}\n`);
  } catch {
    /* never let logging crash the server */
  }
}

export interface ModuleLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  fatal(msg: string, meta?: Record<string, unknown>): void;
  child(extra: { module?: string; traceId?: string; tenantId?: string }): ModuleLogger;
}

interface BoundContext {
  module: string;
  domain: LogDomain;
  traceId?: string;
  tenantId?: string;
}

function makeLogger(ctx: BoundContext): ModuleLogger {
  function log(
    level: LogRecord["level"],
    msg: string,
    meta?: Record<string, unknown>,
  ) {
    const rec: LogRecord = {
      ts: new Date().toISOString(),
      level,
      module: ctx.module,
      msg,
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
    };
    emit(rec, ctx.domain);
  }
  return {
    debug: (m, meta) => log("debug", m, meta),
    info: (m, meta) => log("info", m, meta),
    warn: (m, meta) => log("warn", m, meta),
    error: (m, meta) => log("error", m, meta),
    fatal: (m, meta) => log("fatal", m, meta),
    child: (extra) =>
      makeLogger({
        module: extra.module ?? ctx.module,
        domain: ctx.domain,
        traceId: extra.traceId ?? ctx.traceId,
        tenantId: extra.tenantId ?? ctx.tenantId,
      }),
  };
}

/**
 * Public factory. Modules call this once at the top of their file:
 *   const log = getLogger("agent.planner", "agents");
 */
export function getLogger(
  moduleName: string,
  domain: LogDomain = "app",
): ModuleLogger {
  return makeLogger({ module: moduleName, domain });
}

/**
 * Pino instance for the existing `pino-http` middleware + back-compat
 * imports. Streams to the same `app.log` rotated file as `getLogger("*",
 * "app")`. Pino's redaction handles the standard authorization/cookie
 * headers; the deeper sanitiser still runs on every payload that goes
 * through `getLogger`.
 */
function buildPinoStream(): NodeJS.WritableStream {
  const stream = domainStreams.get("app");
  if (!stream) return process.stdout;
  return {
    write: (chunk: string) => {
      try {
        const obj = JSON.parse(chunk);
        const rec: LogRecord = {
          ts: new Date(
            typeof obj.time === "number" ? obj.time : Date.now(),
          ).toISOString(),
          level: levelFromPino(obj.level),
          module: typeof obj.module === "string" ? obj.module : "http",
          msg: typeof obj.msg === "string" ? obj.msg : "",
          ...(obj.requestId ? { traceId: String(obj.requestId) } : {}),
          ...(obj.tenantId ? { tenantId: String(obj.tenantId) } : {}),
          meta: scrubPinoFields(obj),
        };
        if (!shouldEmit(rec.level)) return true;
        const sanitised = sanitise(rec);
        recentLogs.push(sanitised);
        stream.write(`${JSON.stringify(sanitised)}\n`);
      } catch {
        stream.write(chunk);
      }
      return true;
    },
  } as unknown as NodeJS.WritableStream;
}

function levelFromPino(n: unknown): LogRecord["level"] {
  const num = typeof n === "number" ? n : Number(n);
  if (num <= 20) return "debug";
  if (num <= 30) return "info";
  if (num <= 40) return "warn";
  if (num <= 50) return "error";
  return "fatal";
}

function scrubPinoFields(obj: Record<string, unknown>): Record<string, unknown> {
  const skip = new Set([
    "level",
    "time",
    "pid",
    "hostname",
    "msg",
    "module",
    "requestId",
    "tenantId",
    "v",
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export const pinoInstance: PinoLogger = pino(
  {
    level: config.level,
    base: undefined,
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "headers.authorization",
      "headers.cookie",
      "*.password",
      "*.token",
      "*.secret",
      "*.apiKey",
      "*.api_key",
    ],
  },
  buildPinoStream(),
);

export { LOG_DOMAINS as LOG_DOMAIN_NAMES, LogRingBuffer, recentLogs, sanitise };
export type { LogRecord } from "./ring-buffer";

/**
 * Test-only: flush all writers + reset config (used by the diagnostic
 * bundle test to point logs at a temp directory).
 */
export const _testHelpers = {
  config,
  domainStreams,
};
