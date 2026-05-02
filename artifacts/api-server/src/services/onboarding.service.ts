/**
 * Onboarding service — first-run wizard answers, hardware probe,
 * model recommendation, and personalised starter-task generator.
 *
 * Singleton-per-tenant model: there is at most one row in
 * `onboarding_profiles` for a given tenant. The row id IS the tenantId,
 * which lets the upsert path be a deterministic INSERT-or-UPDATE keyed on
 * the primary key — no `ON CONFLICT` clauses needed because we read first
 * and dispatch.
 *
 * Hardware detection lives here (not in a shared lib) because it is the
 * only consumer right now and the bug-prevention standards prefer
 * use-case-local services over premature abstraction. The
 * `OMNINITY_HARDWARE_OVERRIDE` env var is the documented test seam — when
 * set, it short-circuits `os.*` reads and returns the override JSON. This
 * keeps the recommendation engine deterministically testable across hosts.
 *
 * Recommendation engine: a static, ordered catalogue maps a hardware tier
 * (low/mid/high/pro) to an Ollama model. The catalogue lives at the top of
 * this file (Standard 12 — config as data, not branches).
 */
import os from "node:os";

import { and, eq } from "drizzle-orm";

import {
  db,
  onboardingProfiles,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

export type HardwareTier = "low" | "mid" | "high" | "pro";

export interface HardwareProfile {
  platform: string;
  arch: string;
  cpuCount: number;
  cpuModel: string | null;
  totalRamBytes: number;
  freeRamBytes: number;
  appleSilicon: boolean;
  tier: HardwareTier;
  detectedAt: string;
}

export interface ModelRecommendation {
  model: string;
  reason: string;
  sizeBytes: number;
  tier: HardwareTier;
}

export interface OnboardingProfileRow {
  tenantId: string;
  displayName: string | null;
  userType: string | null;
  useCase: string | null;
  recommendedModel: string | null;
  completed: boolean;
  firstTaskCompleted: boolean;
  approvalTooltipSeen: boolean;
  hardwareSnapshot: HardwareProfile | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProfileInput {
  displayName?: string;
  userType?: "personal" | "business" | "developer";
  useCase?: "productivity" | "sales" | "creative" | "coding" | "research";
  recommendedModel?: string;
  completed?: boolean;
  firstTaskCompleted?: boolean;
  approvalTooltipSeen?: boolean;
  hardwareSnapshot?: HardwareProfile;
}

export interface StarterTask {
  id: string;
  title: string;
  prompt: string;
  category: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Recommendation catalogue — data-driven so adding a tier is a one-line
// edit, not a code change. Sized for Ollama's published quantised weights.
// ─────────────────────────────────────────────────────────────────────────

const ONE_GB = 1024 * 1024 * 1024;

interface CatalogueEntry {
  tier: HardwareTier;
  minRamBytes: number;
  model: string;
  sizeBytes: number;
  reason: string;
}

const MODEL_CATALOGUE: ReadonlyArray<CatalogueEntry> = [
  {
    tier: "pro",
    minRamBytes: 32 * ONE_GB,
    model: "llama3.1:70b",
    sizeBytes: 40 * ONE_GB,
    reason:
      "Detected 32GB+ of RAM — running Llama 3.1 70B for the best local quality.",
  },
  {
    tier: "high",
    minRamBytes: 16 * ONE_GB,
    model: "llama3.1:8b",
    sizeBytes: 5 * ONE_GB,
    reason:
      "Detected 16GB+ of RAM — Llama 3.1 8B is the sweet spot for speed and quality.",
  },
  {
    tier: "mid",
    minRamBytes: 8 * ONE_GB,
    model: "mistral:7b",
    sizeBytes: 4 * ONE_GB,
    reason:
      "Detected 8GB+ of RAM — Mistral 7B keeps memory headroom for tools and the editor.",
  },
  {
    tier: "low",
    minRamBytes: 0,
    model: "phi3:mini",
    sizeBytes: 2 * ONE_GB,
    reason:
      "Below 8GB of RAM — Phi-3 Mini runs comfortably and still supports the agent loop.",
  },
] as const;

function pickCatalogueEntry(totalRamBytes: number): CatalogueEntry {
  for (const entry of MODEL_CATALOGUE) {
    if (totalRamBytes >= entry.minRamBytes) return entry;
  }
  // Catalogue's last entry has minRamBytes=0 so this is unreachable, but
  // keep an explicit fallback for the type narrower.
  const fallback = MODEL_CATALOGUE[MODEL_CATALOGUE.length - 1];
  if (!fallback) {
    throw new Error("Model catalogue is empty");
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────
// Hardware detection
// ─────────────────────────────────────────────────────────────────────────

interface HardwareOverride {
  platform?: string;
  arch?: string;
  cpuCount?: number;
  cpuModel?: string | null;
  totalRamBytes?: number;
  freeRamBytes?: number;
  appleSilicon?: boolean;
}

function readOverride(): HardwareOverride | null {
  const raw = process.env["OMNINITY_HARDWARE_OVERRIDE"];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as HardwareOverride;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "Invalid OMNINITY_HARDWARE_OVERRIDE — ignoring",
    );
    return null;
  }
}

export function detectHardware(): HardwareProfile {
  const override = readOverride();
  const platform = override?.platform ?? os.platform();
  const arch = override?.arch ?? os.arch();
  const cpus = os.cpus();
  const cpuCount = override?.cpuCount ?? cpus.length;
  const cpuModel =
    override?.cpuModel !== undefined
      ? override.cpuModel
      : cpus[0]?.model ?? null;
  const totalRamBytes = override?.totalRamBytes ?? os.totalmem();
  const freeRamBytes = override?.freeRamBytes ?? os.freemem();
  const appleSilicon =
    override?.appleSilicon ?? (platform === "darwin" && arch === "arm64");

  const entry = pickCatalogueEntry(totalRamBytes);

  return {
    platform,
    arch,
    cpuCount,
    cpuModel,
    totalRamBytes,
    freeRamBytes,
    appleSilicon,
    tier: entry.tier,
    detectedAt: new Date().toISOString(),
  };
}

export function recommendModel(
  hardware: HardwareProfile,
): ModelRecommendation {
  const entry = pickCatalogueEntry(hardware.totalRamBytes);
  return {
    model: entry.model,
    reason: entry.reason,
    sizeBytes: entry.sizeBytes,
    tier: entry.tier,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Profile persistence
// ─────────────────────────────────────────────────────────────────────────

function toRow(
  r: typeof onboardingProfiles.$inferSelect,
): OnboardingProfileRow {
  let snapshot: HardwareProfile | null = null;
  if (r.hardwareSnapshot) {
    try {
      snapshot = JSON.parse(r.hardwareSnapshot) as HardwareProfile;
    } catch {
      snapshot = null;
    }
  }
  return {
    tenantId: r.tenantId,
    displayName: r.displayName,
    userType: r.userType,
    useCase: r.useCase,
    recommendedModel: r.recommendedModel,
    completed: r.completed === 1,
    firstTaskCompleted: r.firstTaskCompleted === 1,
    approvalTooltipSeen: r.approvalTooltipSeen === 1,
    hardwareSnapshot: snapshot,
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function getOnboardingProfile(
  ctx: TenantContext,
): Promise<OnboardingProfileRow | null> {
  const rows = await db
    .select()
    .from(onboardingProfiles)
    .where(
      and(
        tenantScope(ctx, onboardingProfiles),
        eq(onboardingProfiles.id, ctx.tenantId),
      ),
    )
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Idempotent upsert. Monotonic flags (`completed`, `firstTaskCompleted`,
 * `approvalTooltipSeen`) are only ever set to `true` here — once flipped
 * they cannot be re-set to `false` by a payload, even an authenticated
 * one. That keeps the wizard from re-appearing after a stale frontend
 * cache replays an old PUT.
 */
export async function upsertOnboardingProfile(
  ctx: TenantContext,
  input: UpsertProfileInput,
): Promise<OnboardingProfileRow> {
  // better-sqlite3 transactions are synchronous — the callback MUST NOT
  // return a Promise. We use the sync `.all()` / `.run()` drizzle methods
  // here and wrap the final value in `Promise.resolve` for the route's
  // async signature.
  const row = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(onboardingProfiles)
      .where(
        and(
          tenantScope(ctx, onboardingProfiles),
          eq(onboardingProfiles.id, ctx.tenantId),
        ),
      )
      .limit(1)
      .all();
    const now = Date.now();

    if (existing.length === 0) {
      const completed = input.completed === true;
      tx.insert(onboardingProfiles)
        .values(
          withTenantValues(ctx, {
            id: ctx.tenantId,
            displayName: input.displayName ?? null,
            userType: input.userType ?? null,
            useCase: input.useCase ?? null,
            recommendedModel: input.recommendedModel ?? null,
            completed: completed ? 1 : 0,
            firstTaskCompleted: input.firstTaskCompleted === true ? 1 : 0,
            approvalTooltipSeen: input.approvalTooltipSeen === true ? 1 : 0,
            hardwareSnapshot: input.hardwareSnapshot
              ? JSON.stringify(input.hardwareSnapshot)
              : null,
            completedAt: completed ? now : null,
            createdAt: now,
            updatedAt: now,
            version: 1,
          }),
        )
        .run();
    } else {
      const prev = existing[0];
      if (!prev) throw new Error("onboarding profile race: row vanished");
      const completed = prev.completed === 1 || input.completed === true;
      const firstTaskCompleted =
        prev.firstTaskCompleted === 1 || input.firstTaskCompleted === true;
      const approvalTooltipSeen =
        prev.approvalTooltipSeen === 1 || input.approvalTooltipSeen === true;
      tx.update(onboardingProfiles)
        .set({
          displayName: input.displayName ?? prev.displayName,
          userType: input.userType ?? prev.userType,
          useCase: input.useCase ?? prev.useCase,
          recommendedModel: input.recommendedModel ?? prev.recommendedModel,
          completed: completed ? 1 : 0,
          firstTaskCompleted: firstTaskCompleted ? 1 : 0,
          approvalTooltipSeen: approvalTooltipSeen ? 1 : 0,
          hardwareSnapshot: input.hardwareSnapshot
            ? JSON.stringify(input.hardwareSnapshot)
            : prev.hardwareSnapshot,
          completedAt:
            completed && !prev.completedAt ? now : prev.completedAt,
          updatedAt: now,
          version: prev.version + 1,
        })
        .where(
          and(
            tenantScope(ctx, onboardingProfiles),
            eq(onboardingProfiles.id, ctx.tenantId),
          ),
        )
        .run();
    }

    const after = tx
      .select()
      .from(onboardingProfiles)
      .where(
        and(
          tenantScope(ctx, onboardingProfiles),
          eq(onboardingProfiles.id, ctx.tenantId),
        ),
      )
      .limit(1)
      .all();
    if (!after[0]) {
      throw new Error("onboarding profile not found after upsert");
    }
    return toRow(after[0]);
  });
  return Promise.resolve(row);
}

// ─────────────────────────────────────────────────────────────────────────
// Starter-task generator
// ─────────────────────────────────────────────────────────────────────────

const STARTER_BUNDLES: Record<string, ReadonlyArray<StarterTask>> = {
  productivity: [
    {
      id: "starter-prod-inbox",
      title: "Sort my inbox",
      prompt: "Triage my inbox: flag urgent threads and draft quick replies.",
      category: "inbox",
    },
    {
      id: "starter-prod-summary",
      title: "Summarise today's notes",
      prompt: "Read the notes folder and give me a one-page recap of today.",
      category: "summary",
    },
    {
      id: "starter-prod-calendar",
      title: "Plan tomorrow",
      prompt: "Look at my calendar and suggest a focused plan for tomorrow.",
      category: "planning",
    },
  ],
  sales: [
    {
      id: "starter-sales-research",
      title: "Research a prospect",
      prompt: "Pull a briefing on the company I paste below before my call.",
      category: "research",
    },
    {
      id: "starter-sales-followup",
      title: "Draft a follow-up",
      prompt: "Draft a follow-up email to the prospect based on the call notes.",
      category: "outreach",
    },
    {
      id: "starter-sales-pipeline",
      title: "Pipeline check-in",
      prompt: "List deals that need a touch this week and suggest the next step.",
      category: "pipeline",
    },
  ],
  creative: [
    {
      id: "starter-creative-brainstorm",
      title: "Brainstorm 10 ideas",
      prompt: "Brainstorm 10 fresh angles for the project I describe below.",
      category: "ideation",
    },
    {
      id: "starter-creative-outline",
      title: "Outline a piece",
      prompt: "Turn this rough idea into a structured outline I can draft from.",
      category: "writing",
    },
    {
      id: "starter-creative-rewrite",
      title: "Tighten this draft",
      prompt: "Rewrite the draft below for clarity and a stronger opening.",
      category: "editing",
    },
  ],
  coding: [
    {
      id: "starter-code-explain",
      title: "Explain this code",
      prompt: "Read the file I paste and explain what it does, line by line.",
      category: "review",
    },
    {
      id: "starter-code-tests",
      title: "Generate tests",
      prompt: "Suggest unit tests for the function below, with edge cases.",
      category: "testing",
    },
    {
      id: "starter-code-bugfix",
      title: "Find the bug",
      prompt: "Walk through this stack trace and find the root cause.",
      category: "debugging",
    },
  ],
  research: [
    {
      id: "starter-research-deepdive",
      title: "Deep-dive a topic",
      prompt: "Compile a structured deep-dive on the topic I name below.",
      category: "research",
    },
    {
      id: "starter-research-compare",
      title: "Compare options",
      prompt: "Compare the options I list and recommend one with reasoning.",
      category: "analysis",
    },
    {
      id: "starter-research-cite",
      title: "Find sources",
      prompt: "Find three reputable sources that back the claim I paste.",
      category: "sourcing",
    },
  ],
};

const DEFAULT_BUNDLE_KEY = "productivity";

export function generateStarterTasks(
  useCase: string | null | undefined,
): { items: ReadonlyArray<StarterTask>; useCase: string } {
  const key =
    useCase && useCase in STARTER_BUNDLES ? useCase : DEFAULT_BUNDLE_KEY;
  const bundle = STARTER_BUNDLES[key] ?? STARTER_BUNDLES[DEFAULT_BUNDLE_KEY];
  if (!bundle) {
    return { items: [], useCase: DEFAULT_BUNDLE_KEY };
  }
  return { items: bundle, useCase: key };
}
