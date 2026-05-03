/**
 * Smoke test for argv parsing — exercises the help path and the
 * scaffold-only branch which doesn't need a running API server.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { run } from "./cli";

test("help exits 0", async () => {
  const code = await run(["help"]);
  assert.equal(code, 0);
});

test("skill create writes a file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "op-cli-"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const code = await run(["skill", "create", "demo", "Demo Skill"]);
    assert.equal(code, 0);
    const file = join(dir, "demo.skill.json");
    assert.ok(existsSync(file));
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.slug, "demo");
    assert.equal(parsed.name, "Demo Skill");
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
