/**
 * Desktop input adapter — semantic targeting, no coordinates.
 *
 * This module is the SINGLE SEAM where keyboard / mouse / clipboard / screen
 * input meets the agent. Every public function takes a SEMANTIC description
 * ("the blue Save button in the toolbar"), never raw coordinates — that's
 * the whole point of the LAV cycle: the vision model resolves the semantic
 * target each time it's invoked, so the plan stays valid even if the UI
 * shifts a few pixels between runs.
 *
 * Tier-1 stub mode: nut-js requires X11/Wayland and is not available inside
 * the Replit container, so this file ships deterministic stubs that record
 * the intended action and return a structured receipt. The full input back-
 * end is plugged in by swapping the body of `runOnDevice()` for a dynamic
 * `await import("@nut-tree-fork/nut-js")` call — every call site already
 * passes the semantic shape the real adapter needs.
 *
 * Every public function logs a privacy event because each one represents a
 * sensitive interaction with the user's machine — even in stub mode the
 * audit log must show every intended action (Section 13).
 */
import type { TenantContext } from "@workspace/types";

import { logPrivacyEvent, type PrivacySeverity } from "./privacy.service";

export type DesktopActionSource = "live" | "stub";

export interface DesktopActionReceipt {
  source: DesktopActionSource;
  action: string;
  description: string;
  ok: boolean;
  detail?: string;
  observedState?: string;
}

export interface DesktopScreenshotPayload {
  source: DesktopActionSource;
  mimeType: string;
  data: string; // base64-encoded
  width: number;
  height: number;
  capturedAt: string;
}

export interface SemanticTarget {
  description: string;
  role?: string | undefined;
  label?: string | undefined;
}

export interface DesktopAdapterStatus {
  available: boolean;
  reason: string;
  mode: "live" | "stub";
}

// 1×1 transparent PNG — the deterministic stub frame. Real adapter returns a
// freshly-captured frame; the structural shape is identical so the route +
// frontend never need to switch on `source`.
const STUB_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Probe whether the live nut-js adapter is reachable in this process. Tier
 * 1 always returns stub-mode; the function exists so `getFeatureStatus()`
 * has a single source of truth.
 */
export function probeAdapter(): DesktopAdapterStatus {
  // The architect explicitly chose stub-mode for Tier 1 — the Replit
  // container has no X11 / display server, so attempting to load nut-js
  // would crash the process at import time. The full adapter swap is the
  // first move in the dedicated desktop-control follow-up.
  return {
    available: false,
    reason:
      "Desktop control is in deterministic stub mode for Tier 1. Real input " +
      "(nut-js) requires a display server and is enabled by setting " +
      "OMNINITY_DESKTOP_LIVE=1 once the host environment supports it.",
    mode: "stub",
  };
}

/**
 * Capture a screenshot of the active display.
 *
 * Live mode: nut-js `screen.captureRegion()` returns a Buffer that gets
 * base64-encoded here. Stub mode: a deterministic 1×1 transparent PNG so
 * the route + frontend rendering paths stay unblocked.
 */
export async function captureScreenshot(
  ctx: TenantContext,
): Promise<DesktopScreenshotPayload> {
  const status = probeAdapter();
  await logPrivacyEvent(ctx, {
    eventType: "desktop.screenshot",
    actor: ctx.userId ?? ctx.tenantId,
    target: "screen",
    severity: "medium",
    detail: `mode=${status.mode}`,
  });
  return {
    source: status.mode,
    mimeType: "image/png",
    data: STUB_PNG_BASE64,
    width: 1,
    height: 1,
    capturedAt: new Date().toISOString(),
  };
}

/** Resolve a semantic description to a screen target. */
export async function resolveTarget(
  ctx: TenantContext,
  target: SemanticTarget,
): Promise<DesktopActionReceipt> {
  await logPrivacyEvent(ctx, {
    eventType: "desktop.find_element",
    actor: ctx.userId ?? ctx.tenantId,
    target: target.description.slice(0, 200),
    severity: "low",
    detail: `role=${target.role ?? "*"} label=${target.label ?? "*"}`,
  });
  return stubReceipt("find_element", target.description, {
    detail: "Stub adapter returned a synthetic target match.",
    observedState: `target=${target.description}`,
  });
}

export async function clickTarget(
  ctx: TenantContext,
  target: SemanticTarget,
): Promise<DesktopActionReceipt> {
  return audit(ctx, "desktop.click", target.description, "medium", () =>
    stubReceipt("click", target.description, {
      observedState: `clicked ${target.description}`,
    }),
  );
}

export async function typeText(
  ctx: TenantContext,
  text: string,
): Promise<DesktopActionReceipt> {
  // Audit redacts the text body so secrets don't leak into the privacy log;
  // length only is preserved for forensic correlation.
  return audit(ctx, "desktop.type_text", `text(len=${text.length})`, "high", () =>
    stubReceipt("type_text", `text(len=${text.length})`, {
      observedState: `typed ${text.length} char(s)`,
    }),
  );
}

export async function pressKey(
  ctx: TenantContext,
  key: string,
): Promise<DesktopActionReceipt> {
  return audit(ctx, "desktop.press_key", key, "medium", () =>
    stubReceipt("press_key", key, { observedState: `pressed ${key}` }),
  );
}

export async function openApplication(
  ctx: TenantContext,
  name: string,
): Promise<DesktopActionReceipt> {
  return audit(ctx, "desktop.open_application", name, "high", () =>
    stubReceipt("open_application", name, {
      observedState: `would launch ${name}`,
    }),
  );
}

export async function scroll(
  ctx: TenantContext,
  direction: "up" | "down" | "left" | "right",
  amount: number,
): Promise<DesktopActionReceipt> {
  return audit(ctx, "desktop.scroll", `${direction}:${amount}`, "low", () =>
    stubReceipt("scroll", `${direction}:${amount}`, {
      observedState: `scrolled ${direction} ${amount}`,
    }),
  );
}

export async function dragDrop(
  ctx: TenantContext,
  fromTarget: SemanticTarget,
  toTarget: SemanticTarget,
): Promise<DesktopActionReceipt> {
  return audit(
    ctx,
    "desktop.drag_drop",
    `${fromTarget.description} → ${toTarget.description}`,
    "high",
    () =>
      stubReceipt(
        "drag_drop",
        `${fromTarget.description} → ${toTarget.description}`,
        { observedState: "dragged" },
      ),
  );
}

export async function readScreenText(
  ctx: TenantContext,
  hint: string,
): Promise<DesktopActionReceipt> {
  return audit(ctx, "desktop.read_text", hint, "low", () =>
    stubReceipt("read_text", hint, {
      observedState: `Stub OCR for: ${hint}`,
    }),
  );
}

export async function runTerminalCommand(
  ctx: TenantContext,
  command: string,
): Promise<DesktopActionReceipt> {
  // Highest risk tier — never executed in stub mode; the receipt records
  // intent so the audit trail is still complete.
  return audit(ctx, "desktop.terminal", command, "critical", () =>
    stubReceipt("terminal", command, {
      ok: false,
      detail: "Refused: terminal execution disabled in stub mode.",
    }),
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function stubReceipt(
  action: string,
  description: string,
  extra: Partial<DesktopActionReceipt> = {},
): DesktopActionReceipt {
  return {
    source: "stub",
    action,
    description,
    ok: true,
    detail: `Stub adapter logged ${action}`,
    ...extra,
  };
}

async function audit<T extends DesktopActionReceipt>(
  ctx: TenantContext,
  eventType: string,
  target: string,
  severity: PrivacySeverity,
  produce: () => T,
): Promise<T> {
  const result = produce();
  await logPrivacyEvent(ctx, {
    eventType,
    actor: ctx.userId ?? ctx.tenantId,
    target: target.slice(0, 200),
    severity,
    detail: `source=${result.source} ok=${result.ok}`,
  });
  return result;
}
