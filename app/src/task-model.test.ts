import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STATUS_ALIASES, STATUS_MIGRATION, STATUS_PHASES, TASK_PHASES, TASK_STATUSES, canonicalStatus, statusPhase, storyRollup, normalizeTaskEnums, parentMap, storyShouldComplete, dependencySatisfied, dependencyGate, unmergedDependencies, isReviewMode } from "./task-model.js";
import { rankRunnableTasks, type RunnableTask } from "./plan.js";

test("unknown status, taskType or executorMode is rejected", () => {
  assert.equal(normalizeTaskEnums({ status: "nonsense" }).ok, false);
  assert.equal(normalizeTaskEnums({ taskType: "epic" }).ok, false);
  assert.equal(normalizeTaskEnums({ executorMode: "robot" }).ok, false);
  assert.equal(normalizeTaskEnums({ status: null }).ok, false);
  assert.equal(normalizeTaskEnums({ status: "queued", taskType: "story", executorMode: "agent" }).ok, true);
  assert.equal(normalizeTaskEnums({ title: "no enum fields" }).ok, true);
});

test("backlog is rewritten to defined", () => {
  const body: Record<string, unknown> = { status: "backlog" };
  assert.equal(normalizeTaskEnums(body).ok, true);
  assert.equal(body.status, "defined");
});

test("the 13 statuses", () => {
  assert.deepEqual(
    [...TASK_STATUSES].sort(),
    ["awaiting_ci", "awaiting_merge", "defined", "deploying", "done", "idea", "in_progress", "needs_input", "queued", "rejected", "review", "rework", "verifying"],
  );
});

test("old status names are accepted and rewritten to the current ones", () => {
  const cases: [string, string][] = [
    ["planned", "defined"],
    ["todo", "defined"],
    ["backlog", "defined"],
    ["executing", "in_progress"],
    ["awaiting_review", "review"],
    ["decomposed", "defined"],
  ];
  for (const [old, now] of cases) {
    const body: Record<string, unknown> = { status: old };
    assert.deepEqual(normalizeTaskEnums(body), { ok: true }, old);
    assert.equal(body.status, now, old);
    assert.equal(canonicalStatus(old), now);
  }
  assert.equal(canonicalStatus("queued"), "queued");
  // handoff is an event now; nobody may set it as a status.
  assert.equal(normalizeTaskEnums({ status: "handoff" }).ok, false);
  for (const target of Object.values(STATUS_ALIASES)) assert.ok((TASK_STATUSES as readonly string[]).includes(target), target);
});

test("migration 0049 moves every removed status where STATUS_MIGRATION says", () => {
  const sql = readFileSync(new URL("../drizzle/0049_task_status_model.sql", import.meta.url), "utf8");
  const moved = new Map<string, string>();
  for (const m of sql.matchAll(/SET "status" = '(\w+)'[^;]*?WHERE "status" (?:= '(\w+)'|IN \(([^)]*)\))/g)) {
    const froms = m[2] ? [m[2]] : m[3].split(",").map((s) => s.trim().replace(/'/g, ""));
    for (const from of froms) moved.set(from, m[1]);
  }
  assert.deepEqual(Object.fromEntries([...moved].sort()), Object.fromEntries(Object.entries(STATUS_MIGRATION).sort()));
  for (const target of moved.values()) assert.ok((TASK_STATUSES as readonly string[]).includes(target), target);
  assert.ok(!moved.has("decomposed"), "decomposed is 0050's");
  // a task leaving handoff gets a comment saying why
  assert.match(sql, /INSERT INTO "comments"[\s\S]*handoff is no longer a status/);
  // the migration hold keeps its meaning as a reason
  assert.match(sql, /"status" = 'review', "review_reason" = 'migration'/);
});

test("migration 0050 makes every decomposed story defined", () => {
  const sql = readFileSync(new URL("../drizzle/0050_stories_defined.sql", import.meta.url), "utf8");
  assert.match(sql, /UPDATE "tasks" SET "status" = 'defined' WHERE "status" = 'decomposed';/);
  assert.equal(canonicalStatus("decomposed"), "defined");
});

test("every status has a phase", () => {
  for (const status of TASK_STATUSES) assert.ok((TASK_PHASES as readonly string[]).includes(STATUS_PHASES[status]), status);
  assert.equal(statusPhase("executing"), "in_progress");
});

test("a story's rollup counts its children per phase, leaving rejected ones out", () => {
  assert.deepEqual(storyRollup("defined", ["idea", "defined", "queued", "in_progress", "awaiting_ci", "verifying", "review", "rework", "done", "rejected"]).counts, {
    backlog: 2,
    ready: 1,
    in_progress: 1,
    pipeline: 2,
    needs_you: 2,
    done: 1,
  });
});

test("a story's phase: needs you, then in progress, pipeline, ready, backlog; done when every child is", () => {
  const phase = (children: string[], story = "defined") => storyRollup(story, children).phase;
  assert.equal(phase(["needs_input", "in_progress", "awaiting_ci"]), "needs_you");
  assert.equal(phase(["review", "done"]), "needs_you");
  assert.equal(phase(["rework", "queued"]), "needs_you");
  assert.equal(phase(["in_progress", "deploying", "queued"]), "in_progress");
  assert.equal(phase(["awaiting_merge", "queued", "defined"]), "pipeline");
  assert.equal(phase(["queued", "defined", "done"]), "ready");
  assert.equal(phase(["defined", "idea", "done"]), "backlog");
  assert.equal(phase(["done", "rejected"]), "done");
  assert.equal(phase(["rejected"]), "done");
  // closed by hand while children were open
  assert.equal(phase(["defined"], "done"), "done");
  assert.equal(phase(["defined"], "rejected"), "done");
});

test("an empty story is backlog with no counts", () => {
  assert.deepEqual(storyRollup("defined", []), { phase: "backlog", counts: {} });
  assert.deepEqual(storyRollup("done", []), { phase: "done", counts: {} });
});

test("a story is never ranked runnable, even when queued", () => {
  const base = { projectId: 1, title: "t", status: "queued", priority: 0, executorMode: "agent", autonomyLevel: 1, estimatedEffort: 1, createdAt: "2026-01-01T00:00:00Z" };
  const queued: RunnableTask[] = [
    { ...base, id: 1, taskType: "story" },
    { ...base, id: 2, taskType: "implementation" },
  ];
  assert.deepEqual(rankRunnableTasks(queued, new Set()).map((t) => t.id), [2]);
});

test("parentMap reads parent/child rows in both directions", () => {
  const parents = parentMap([
    { fromTaskId: 10, toTaskId: 1, relationType: "parent" },
    { fromTaskId: 1, toTaskId: 11, relationType: "child" },
    { fromTaskId: 12, toTaskId: 1, relationType: "related" },
    { fromTaskId: 13, toTaskId: 1, relationType: "depends_on" },
  ]);
  assert.deepEqual([...parents.entries()].sort(), [[10, 1], [11, 1]]);
});

test("story completes on its last child finishing, not before", () => {
  assert.equal(storyShouldComplete("defined", ["done", "in_progress"]), false);
  assert.equal(storyShouldComplete("defined", ["done", "review"]), false);
  assert.equal(storyShouldComplete("defined", ["rejected"]), true);
  assert.equal(storyShouldComplete("rejected", ["done"]), false);
  assert.equal(storyShouldComplete("defined", ["done", "rejected"]), true);
  assert.equal(storyShouldComplete("defined", []), false);
  assert.equal(storyShouldComplete("done", ["done"]), false);
});

test("a depends_on target in review satisfies only when every PR is merged", () => {
  assert.equal(dependencySatisfied("review", ["merged", "merged"]), true);
  assert.equal(dependencySatisfied("review", ["merged", "open"]), false);
  assert.equal(dependencySatisfied("review", []), false);
  assert.equal(dependencySatisfied("done", []), true);
  assert.equal(dependencySatisfied("rejected", ["open"]), true);
  assert.equal(dependencySatisfied("verifying", ["merged"]), false);
});

test("verifying -> done closes the parent story when it was the last open child", () => {
  assert.equal(storyShouldComplete("defined", ["done", "rejected", "verifying"]), false);
  assert.equal(storyShouldComplete("defined", ["done", "rejected", "done"]), true);
});

const inReview = (taskId: number, prStates: string[] = ["open"]) => ({ taskId, status: "review", prStates });

test("a standard project waits for every dependency to merge", () => {
  assert.deepEqual(dependencyGate("standard", []), { blocked: false, stackOnTaskId: null });
  assert.deepEqual(dependencyGate("standard", [inReview(1, ["merged"])]), { blocked: false, stackOnTaskId: null });
  assert.deepEqual(dependencyGate("standard", [inReview(1)]), { blocked: true });
});

test("a playtest task stacks on its one dependency still in review", () => {
  assert.deepEqual(dependencyGate("playtest", [inReview(1)]), { blocked: false, stackOnTaskId: 1 });
  assert.deepEqual(dependencyGate("playtest", [inReview(1), { taskId: 2, status: "done", prStates: [] }]), { blocked: false, stackOnTaskId: 1 });
  // one PR merged and one still open: stack on the open one
  assert.deepEqual(dependencyGate("playtest", [inReview(1, ["merged", "open"])]), { blocked: false, stackOnTaskId: 1 });
  // everything merged: nothing to stack on
  assert.deepEqual(dependencyGate("playtest", [inReview(1, ["merged"])]), { blocked: false, stackOnTaskId: null });
});

test("a playtest task waits when stacking isn't possible", () => {
  // two unmerged dependencies
  assert.deepEqual(dependencyGate("playtest", [inReview(1), inReview(2)]), { blocked: true });
  // in review without a PR, or only a closed one
  assert.deepEqual(dependencyGate("playtest", [inReview(1, [])]), { blocked: true });
  assert.deepEqual(dependencyGate("playtest", [inReview(1, ["closed"])]), { blocked: true });
  // not in review yet
  assert.deepEqual(dependencyGate("playtest", [{ taskId: 1, status: "in_progress", prStates: ["open"] }]), { blocked: true });
  assert.deepEqual(dependencyGate("playtest", [{ taskId: 1, status: "awaiting_ci", prStates: ["open"] }]), { blocked: true });
  // one stackable and one not started
  assert.deepEqual(dependencyGate("playtest", [inReview(1), { taskId: 2, status: "queued", prStates: [] }]), { blocked: true });
});

test("unmergedDependencies lists what has to merge first", () => {
  assert.deepEqual(unmergedDependencies([inReview(1), inReview(2, ["merged"]), { taskId: 3, status: "done", prStates: [] }]), [1]);
  assert.deepEqual(unmergedDependencies([]), []);
});

test("review modes", () => {
  assert.equal(isReviewMode("standard"), true);
  assert.equal(isReviewMode("playtest"), true);
  assert.equal(isReviewMode("Playtest"), false);
  assert.equal(isReviewMode(undefined), false);
});
