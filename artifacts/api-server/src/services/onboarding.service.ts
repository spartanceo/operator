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
import { and, eq } from "drizzle-orm";

import {
  db,
  onboardingProfiles,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type {
  HardwareProfile,
  HardwareTierKey,
  ModelRecommendation,
  TenantContext,
} from "@workspace/types";

import {
  detectHardware as detectHardwareInternal,
  recommendModelLegacy,
} from "./hardware";

// Re-export the canonical types so existing call sites keep compiling.
// New code should import from "@workspace/types" directly. The previous
// `import { logger }` from "../lib/logger" was removed with the override
// parser — that lives in `services/hardware/detector.ts` now.
export type HardwareTier = HardwareTierKey;
export type { HardwareProfile, ModelRecommendation };

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
// Hardware detection + recommendation
//
// The catalogue + recommendation engine moved to `services/hardware/`
// (Task #64). These shims keep the original public surface stable so the
// `/api/onboarding/hardware` route and any older callers continue to work.
// ─────────────────────────────────────────────────────────────────────────

export function detectHardware(): HardwareProfile {
  return detectHardwareInternal();
}

export function recommendModel(
  hardware: HardwareProfile,
): ModelRecommendation {
  return recommendModelLegacy(hardware);
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
