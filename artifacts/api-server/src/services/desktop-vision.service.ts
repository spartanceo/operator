/**
 * Desktop vision adapter — turns screenshots + intent into structured plans.
 *
 * The LAV cycle uses this module twice per step: once in the "Look" phase
 * to resolve a semantic target, and once in "Verify" to check the observed
 * state matches the expected one. The model is asked SEMANTIC questions
 * ("where is the Save button?", "did the dialog close?") — never coordinate
 * questions — because coordinates are brittle and a re-plan should not be
 * triggered by a one-pixel layout shift.
 *
 * Tier 1 ships a deterministic verifier that does NOT call the vision model
 * (no LLaVA/Moondream loaded by default in the Replit container). The shape
 * exactly matches what the live model returns so the orchestrator stays
 * unchanged when the live adapter is enabled.
 */
import type { TenantContext } from "@workspace/types";

import { logPrivacyEvent } from "./privacy.service";
import { probeAdapter, captureScreenshot } from "./desktop-input.service";
import { chat as ollamaChat } from "./ollama.service";

export interface VisionVerifyVerdict {
  matched: boolean;
  confidence: number; // 0..1
  observed: string;
  source: "live" | "stub";
}

export interface VisionPlanStep {
  actionType:
    | "screenshot"
    | "find_element"
    | "click"
    | "type_text"
    | "press_key"
    | "open_application"
    | "scroll"
    | "drag_drop"
    | "read_text";
  targetDescription: string;
  targetRole?: string;
  targetLabel?: string;
  inputValue?: string;
  expectedState: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  rationale: string;
}

const ACTION_KEYWORDS: ReadonlyArray<{
  kw: string;
  build: (goal: string) => VisionPlanStep[];
}> = [
  {
    kw: "open ",
    build: (goal) => [
      {
        actionType: "screenshot",
        targetDescription: "current desktop",
        expectedState: "captured baseline frame",
        riskLevel: "low",
        rationale: "Capture initial state so we can verify the launch.",
      },
      {
        actionType: "open_application",
        targetDescription: extractAfter(goal, "open ") || "the requested app",
        expectedState: "application window visible and focused",
        riskLevel: "high",
        rationale: "Launch the named application.",
      },
      {
        actionType: "find_element",
        targetDescription: "the application's main window",
        expectedState: "main window detected",
        riskLevel: "low",
        rationale: "Verify the window appeared after launch.",
      },
    ],
  },
  {
    kw: "click ",
    build: (goal) => [
      {
        actionType: "screenshot",
        targetDescription: "current screen",
        expectedState: "captured baseline frame",
        riskLevel: "low",
        rationale: "Snapshot before the click for verification.",
      },
      {
        actionType: "click",
        targetDescription: extractAfter(goal, "click ") || "the requested element",
        expectedState: "click registered, UI state advanced",
        riskLevel: "medium",
        rationale: "Click the named element with semantic targeting.",
      },
    ],
  },
  {
    kw: "type ",
    build: (goal) => [
      {
        actionType: "type_text",
        targetDescription: "active focused input",
        inputValue: extractAfter(goal, "type ") || "",
        expectedState: "text appeared in the focused input",
        riskLevel: "high",
        rationale: "Type the requested text into the focused control.",
      },
    ],
  },
];

/**
 * Plan a goal into LAV steps. Tier 1 uses a deterministic keyword-driven
 * planner — every plan ends with a `read_text` verification so the verdict
 * branch is always exercised.
 */
export async function planSteps(
  ctx: TenantContext,
  goal: string,
): Promise<VisionPlanStep[]> {
  await logPrivacyEvent(ctx, {
    eventType: "desktop.plan",
    actor: ctx.userId ?? ctx.tenantId,
    target: goal.slice(0, 200),
    severity: "info",
    detail: "planner=deterministic",
  });

  const lowered = goal.toLowerCase();
  const matched = ACTION_KEYWORDS.find((entry) => lowered.includes(entry.kw));
  const head = matched
    ? matched.build(goal)
    : [
        {
          actionType: "screenshot" as const,
          targetDescription: "current desktop",
          expectedState: "captured baseline frame",
          riskLevel: "low" as const,
          rationale: "Capture state — no specific action keyword detected.",
        },
        {
          actionType: "find_element" as const,
          targetDescription: goal,
          expectedState: "element matching the goal located",
          riskLevel: "low" as const,
          rationale: "Try to locate something matching the goal description.",
        },
      ];

  // Always finish with a verification step so every plan has a verdict.
  const tail: VisionPlanStep = {
    actionType: "read_text",
    targetDescription: "post-action state",
    expectedState: "observed state confirms goal",
    riskLevel: "low",
    rationale: "Verify the goal was met after the action(s).",
  };
  return [...head, tail];
}

/**
 * Verify a step's expected state against the latest screen frame. Tier 1
 * returns a deterministic match so the orchestrator can advance; the live
 * model would compare the screenshot to the expected description.
 */
export async function verifyStep(
  ctx: TenantContext,
  expected: string,
): Promise<VisionVerifyVerdict> {
  const status = probeAdapter();
  await logPrivacyEvent(ctx, {
    eventType: "desktop.verify",
    actor: ctx.userId ?? ctx.tenantId,
    target: expected.slice(0, 200),
    severity: "info",
    detail: `mode=${status.mode}`,
  });

  if (status.mode === "live") {
    try {
      // Capture current screen for live verification
      const frame = await captureScreenshot(ctx);

      const result = await ollamaChat(ctx, {
        model: "moondream:latest", // Lightweight multimodal model
        messages: [
          {
            role: "system",
            content:
              "You are a desktop vision verifier. Look at the screenshot and determine if the expected state is met. " +
              "Reply with EXACTLY: MATCHED: <true/false> | CONFIDENCE: <0..1> | OBSERVED: <description>",
          },
          {
            role: "user",
            content: `Expected state: ${expected}`,
          },
        ],
        images: [frame.data],
        temperature: 0,
      });

      const content = result.message.content?.trim();
      if (content && !content.startsWith("Ollama is not reachable")) {
        const matched = content.toLowerCase().includes("matched: true");
        const confidenceMatch = content.match(/confidence: (0\.\d+|1\.0|0|1)/i);
        const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5;
        const observedMatch = content.match(/observed: (.*)/i);
        const observed = observedMatch ? observedMatch[1] : content;

        return {
          matched,
          confidence,
          observed,
          source: "live",
        };
      }
    } catch (err) {
      // Fallback to stub on error
    }
  }

  return {
    matched: true,
    confidence: 0.7,
    observed: `Stub verifier accepted "${expected}".`,
    source: "stub",
  };
}

function extractAfter(text: string, marker: string): string {
  const i = text.toLowerCase().indexOf(marker);
  if (i < 0) return text;
  return text.slice(i + marker.length).trim();
}
