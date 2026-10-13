import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTaskEnums, parentMap, storyShouldComplete, dependencySatisfied } from "./task-model.js";
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
  assert.equal(storyShouldComplete("planned", ["done", "executing"]), false);
  assert.equal(storyShouldComplete("planned", ["done", "rejected"]), true);
  assert.equal(storyShouldComplete("planned", []), false);
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
  assert.equal(storyShouldComplete("planned", ["done", "rejected", "verifying"]), false);
  assert.equal(storyShouldComplete("planned", ["done", "rejected", "done"]), true);
});
