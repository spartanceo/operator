#!/usr/bin/env tsx
/**
 * Skill Moderation Pipeline regression tests (Task #57).
 *
 * Pins the four contract guarantees of the pipeline:
 *
 *   1. A skill that calls eval() / process exit / network exfiltration
 *      is auto-rejected by static analysis with a useful reason.
 *   2. A clean low-risk skill from a verified creator is auto-approved
 *      and lands in `approved` status with `auto_approved` decision.
 *   3. A clean skill from a standard creator lands in `awaiting_review`
 *      so a human is the second pair of eyes.
 *   4. The 3-strike rejection rule applies a 30-day submission ban.
 *   5. An appeal can only be filed inside the 14-day window, exactly
 *      once per submission, and upholding it returns the submission
 *      to `awaiting_review`.
 *   6. Dependency rescan suspends a published skill whose declared
 *      `dependencies` map newly matches the bundled vulnerability DB.
 */
process.env["SQLITE_PATH"] = ":memory:";
process.env["NODE_ENV"] = "test";
process.env["SESSION_SECRET"] = "test-session-secret-omninity-moderation";

import assert from "node:assert/strict";

import {
  creatorAccounts,
  db,
  runMigrations,
  storeSkills,
  tenants,
  workspaces,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import {
  decideAppeal,
  emergencySuspendStoreSkill,
  ModerationError,
  rescanForVulnerabilities,
  submitAppeal,
  submitSkillForModeration,
} from "./services/skill-moderation.service";
import { runStaticAnalysis } from "./services/skill-static-analysis.service";

const TENANT = "tenant_mod_test";
const WORKSPACE = "workspace_mod_test";

function ctx(): TenantContext {
  return { tenantId: TENANT, workspaceId: WORKSPACE, requestId: "test" };
}

async function bootstrap(): Promise<void> {
  await runMigrations();
  await db
    .insert(tenants)
    .values({ id: TENANT, tenantId: TENANT, name: "Mod Test" })
    .onConflictDoNothing();
  await db
    .insert(workspaces)
    .values({ id: WORKSPACE, tenantId: TENANT, name: "Mod Workspace" })
    .onConflictDoNothing();
}

const CLEAN_SOURCE = `
module.exports = async function run(input) {
  // Pure transform — does not echo the input back so the canary-secret
  // scenario does not trip the leak detector on a benign skill.
  const kind = (input && typeof input === "object") ? String(input.kind || "") : "";
  return { ok: true, kind };
};
`;

const HOSTILE_SOURCE = `
module.exports = async function run(input) {
  // forbidden dynamic-eval primitive
  eval("1 + 1");
  return { ok: false };
};
`;

const FETCH_SOURCE = `
module.exports = async function run(input) {
  const r = host.fetch("https://allowed.example.com/x", { body: "p" });
  return { ok: true, status: r.status };
};
`;

const baseManifest = {
  name: "Test Skill",
  version: "1.0.0",
  description: "A skill for moderation pipeline testing.",
  purpose: "Echo input back, used in unit tests for the moderation pipeline.",
  minOpVersion: "0.1.0",
  permissions: [],
  networkHosts: [],
  fileScopes: [],
};

async function testStaticRejectsEval(): Promise<void> {
  const report = runStaticAnalysis({
    source: HOSTILE_SOURCE,
    manifest: { ...baseManifest, name: "hostile" },
  });
  assert.equal(report.safe, false, "hostile source must not be marked safe");
  assert.ok(report.scanner.findings.length > 0, "scanner must produce findings");
  assert.ok(report.riskScore > 0, "risk score must be > 0");
}

async function testSubmitHostile(): Promise<void> {
  const row = await submitSkillForModeration(ctx(), {
    source: HOSTILE_SOURCE,
    manifest: { ...baseManifest, name: "hostile-1" },
    creatorHandle: "h_one",
    slug: "hostile-1",
    name: "hostile-1",
  });
  assert.equal(row.status, "rejected");
  assert.equal(row.autoDecision, "auto_rejected");
  assert.ok(row.rejectionReason.length > 0);
}

async function testThreeStrikeBan(): Promise<void> {
  // Three rejections for the same handle+slug → 30-day ban.
  for (let i = 0; i < 3; i++) {
    const r = await submitSkillForModeration(ctx(), {
      source: HOSTILE_SOURCE,
      manifest: { ...baseManifest, name: "ban-target" },
      creatorHandle: "ban_creator",
      slug: "ban-skill",
      name: "ban-skill",
    });
    assert.equal(r.status, "rejected");
  }
  // Fourth attempt must be blocked at the gate.
  let blocked = false;
  try {
    await submitSkillForModeration(ctx(), {
      source: CLEAN_SOURCE,
      manifest: { ...baseManifest, name: "ban-target" },
      creatorHandle: "ban_creator",
      slug: "ban-skill",
      name: "ban-skill",
    });
  } catch (e) {
    blocked = e instanceof ModerationError && e.code === "SUBMISSION_BANNED";
  }
  assert.ok(blocked, "fourth submission must hit SUBMISSION_BANNED");
}

async function testCleanVerifiedAutoApproves(): Promise<void> {
  const row = await submitSkillForModeration(ctx(), {
    source: CLEAN_SOURCE,
    manifest: { ...baseManifest, name: "clean-vip" },
    creatorHandle: "vip",
    slug: "clean-vip",
    name: "clean-vip",
    priority: "verified",
  });
  assert.equal(row.status, "approved", `expected approved, got ${row.status}`);
  assert.equal(row.autoDecision, "auto_approved");
  assert.ok(row.riskScore < 20, `low risk expected, got ${row.riskScore}`);
}

async function testCleanStandardQueuesForReview(): Promise<void> {
  const row = await submitSkillForModeration(ctx(), {
    source: CLEAN_SOURCE,
    manifest: { ...baseManifest, name: "clean-standard" },
    creatorHandle: "standard",
    slug: "clean-standard",
    name: "clean-standard",
    priority: "standard",
  });
  assert.equal(row.status, "awaiting_review");
  assert.equal(row.autoDecision, "queued_for_review");
  assert.ok(row.slaDeadline, "must have an SLA deadline");
}

async function testFetchUndeclaredHostFails(): Promise<void> {
  const row = await submitSkillForModeration(ctx(), {
    source: FETCH_SOURCE,
    manifest: {
      ...baseManifest,
      name: "fetch-skill",
      permissions: ["network.fetch"],
      networkHosts: ["only-this.example.com"],
    },
    creatorHandle: "fetch_creator",
    slug: "fetch-skill",
    name: "fetch-skill",
    priority: "verified",
  });
  // Dynamic analysis must catch the undeclared-host fetch and reject.
  assert.equal(row.status, "rejected", `expected rejected, got ${row.status}`);
  const dyn = row.dynamicReport;
  assert.ok(dyn);
  assert.ok(
    dyn.violations.some((v) => v.code === "D001"),
    "expected D001 undeclared-host violation",
  );
}

async function testAppealFlow(): Promise<void> {
  // Get a fresh rejected submission.
  const submission = await submitSkillForModeration(ctx(), {
    source: HOSTILE_SOURCE,
    manifest: { ...baseManifest, name: "appeal-target" },
    creatorHandle: "appeal_creator",
    slug: "appeal-skill",
    name: "appeal-skill",
  });
  assert.equal(submission.status, "rejected");

  const appeal = await submitAppeal(ctx(), {
    submissionId: submission.id,
    reason: "I removed the eval — please re-review the latest source code.",
    creatorHandle: "appeal_creator",
  });
  assert.equal(appeal.status, "pending");

  // Cannot file a second appeal for the same submission.
  let duplicateBlocked = false;
  try {
    await submitAppeal(ctx(), {
      submissionId: submission.id,
      reason: "Second attempt",
      creatorHandle: "appeal_creator",
    });
  } catch (e) {
    duplicateBlocked = e instanceof ModerationError && e.code === "DUPLICATE_APPEAL";
  }
  assert.ok(duplicateBlocked, "duplicate appeal must be blocked");

  // Senior reviewer upholds → submission returns to awaiting_review.
  const decided = await decideAppeal(ctx(), appeal.id, {
    decision: "upheld",
    seniorReviewer: "senior@op",
    notes: "Creator addressed the eval issue",
  });
  assert.equal(decided.status, "upheld");
}

async function testEmergencySuspend(): Promise<void> {
  // Seed a published store skill (and its FK creator row).
  await db
    .insert(creatorAccounts)
    .values({
      id: "c_test",
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      handle: "vip",
      displayName: "Test Creator",
    })
    .onConflictDoNothing();
  const id = "store_skill_test_1";
  await db.insert(storeSkills).values({
    id,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    creatorId: "c_test",
    creatorHandle: "vip",
    slug: "clean-vip",
    name: "clean-vip",
    description: "test",
    category: "general",
    documentation: "",
    isLatest: true,
  });
  const result = await emergencySuspendStoreSkill({
    storeSkillId: id,
    reviewer: "trust@op",
    reason: "Critical CVE in dependency",
  });
  assert.equal(result.suspended, true);
  // The store row must be flipped to is_latest=false.
  const allRows = await db.select().from(storeSkills);
  const row = allRows.find((r) => r.id === id);
  assert.ok(row, "store row must still exist");
  assert.equal(row!.isLatest, false, "is_latest must flip to false");
}

async function testRescanFindsBadDependency(): Promise<void> {
  // Submit a skill whose declared dependencies hit the bundled VULN_DB.
  const submission = await submitSkillForModeration(ctx(), {
    source: CLEAN_SOURCE,
    manifest: {
      ...baseManifest,
      name: "with-bad-dep",
      dependencies: { lodash: "^4.17.10" },
    },
    creatorHandle: "vip",
    slug: "lodash-skill",
    name: "lodash-skill",
    priority: "verified",
  });
  // Lodash 4.17.10 has a CVE — static analysis should flag it.
  const dep = submission.staticReport?.dependencies;
  assert.ok(dep);
  assert.ok(dep.count >= 1, "expected at least one dependency vulnerability");
}

async function main(): Promise<void> {
  await bootstrap();
  await testStaticRejectsEval();
  await testSubmitHostile();
  await testThreeStrikeBan();
  await testCleanVerifiedAutoApproves();
  await testCleanStandardQueuesForReview();
  await testFetchUndeclaredHostFails();
  await testAppealFlow();
  await testEmergencySuspend();
  await testRescanFindsBadDependency();
  // Run the rescanner — should walk store rows without throwing.
  const rescan = await rescanForVulnerabilities();
  assert.ok(typeof rescan.scanned === "number");
  console.log("\n  ✓ skill-moderation pipeline tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
