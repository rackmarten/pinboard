import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedIds, groupTargetRows } from "./dependencies.js";

const row = (from: number, mode: string, taskId: number, status: string, prStates: string[]) => ({
  from_task_id: from,
  review_mode: mode,
  task_id: taskId,
  status,
  pr_states: prStates,
});

test("target rows group per dependent with the dependent's review mode", () => {
  const grouped = groupTargetRows([row(10, "playtest", 1, "review", ["open"]), row(10, "playtest", 2, "queued", []), row(11, "standard", 1, "review", ["open"])]);
  assert.deepEqual(grouped.get(10), {
    mode: "playtest",
    targets: [
      { taskId: 1, status: "review", prStates: ["open"] },
      { taskId: 2, status: "queued", prStates: [] },
    ],
  });
  assert.equal(grouped.get(11)?.mode, "standard");
});

test("an unknown review mode reads as standard", () => {
  assert.equal(groupTargetRows([row(10, "nonsense", 1, "review", ["open"])]).get(10)?.mode, "standard");
});

test("blockedIds applies each dependent's own mode", () => {
  const grouped = groupTargetRows([
    // same open dependency: the playtest dependent stacks, the standard one waits
    row(10, "playtest", 1, "review", ["open"]),
    row(11, "standard", 1, "review", ["open"]),
    // playtest with two unmerged dependencies waits
    row(12, "playtest", 1, "review", ["open"]),
    row(12, "playtest", 2, "review", ["open"]),
    // merged in review satisfies either mode
    row(13, "standard", 3, "review", ["merged"]),
  ]);
  assert.deepEqual([...blockedIds(grouped)].sort(), [11, 12]);
});
