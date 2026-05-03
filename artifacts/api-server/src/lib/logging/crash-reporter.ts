/**
 * Opt-in remote crash reporter — pairs with Task 21 (Opt-in Analytics &
 * Crash Reporting). Disabled by default; the tenant must have toggled the
 * `crashReporting` preference for any payload to leave the machine.
 *
 * The reporter intentionally has zero hard dependency on the analytics
 * service: when enabled, it POSTs sanitised ERROR/FATAL records (plus the
 * bundle manifest) to `OP_CRASH_REPORT_URL`. If that URL is unset OR the
 * tenant has not opted in, every call is a no-op.
 *
 * Network failures are swallowed — a failed crash report MUST NOT trigger
 * another crash report. We log a single line at WARN to the local
 * `security` channel so operators see the failure during triage.
 */
import { getLogger, type LogRecord } from "./index";
import { sanitise } from "./sanitiser";

const log = getLogger("logging.crash-reporter", "security");

export interface CrashReporterConfig {
  enabled: boolean;
  endpoint: string | null;
}

export function readCrashReporterConfig(): CrashReporterConfig {
  return {
    enabled: process.env["OP_CRASH_REPORTING"] === "1",
    endpoint: process.env["OP_CRASH_REPORT_URL"] ?? null,
  };
}

export async function reportCrash(
  records: ReadonlyArray<LogRecord>,
  context: Record<string, unknown> = {},
): Promise<{ delivered: boolean; reason?: string }> {
  const cfg = readCrashReporterConfig();
  if (!cfg.enabled) return { delivered: false, reason: "opt-out" };
  if (!cfg.endpoint) return { delivered: false, reason: "no-endpoint" };

  const body = sanitise({
    schema: "omninity.crash-report.v1",
    sentAt: new Date().toISOString(),
    context,
    records: records.filter(
      (r) => r.level === "error" || r.level === "fatal",
    ),
  });

  try {
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn("Crash report rejected", { status: res.status });
      return { delivered: false, reason: `http-${res.status}` };
    }
    return { delivered: true };
  } catch (e) {
    log.warn("Crash report transport failed", {
      err: (e as Error).message,
    });
    return { delivered: false, reason: "transport" };
  }
}
