import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";
import { sql } from "./db/client.js";
import { registerRoutes } from "./routes.js";
import { mergeChecklist, parseChecklist, parseChecklistPatch, type ChecklistTick } from "./checklist.js";

// Validation runs before any query, so these requests never reach the
// database (the test script's DATABASE_URL points nowhere real).
const app = Fastify();
await registerRoutes(app);
after(async () => {
  await app.close();
  await sql.end({ timeout: 0 });
});

const actor = { actorType: "agent", actorName: "runner" };

test("parseChecklist keeps older clients working: absent or null is no checklist", () => {
  assert.equal(parseChecklist(undefined), null);
  assert.equal(parseChecklist(null), null);
  assert.equal(parseChecklist([]), null);
});

test("parseChecklist trims items and drops blanks and repeats, keeping order", () => {
  assert.deepEqual(parseChecklist([" Open the PR ", "", "Run tests", "Open the PR"]), ["Open the PR", "Run tests"]);
});

test("parseChecklist rejects anything but an array of strings", () => {
  assert.throws(() => parseChecklist("do it"), /array of strings/);
  assert.throws(() => parseChecklist(["ok", 3]), /array of strings/);
  assert.throws(() => parseChecklist(Array.from({ length: 51 }, (_, i) => `item ${i}`)), /at most 50/);
});

const tick = (item: string, checked: boolean, note: string | null = null): ChecklistTick => ({
  item,
  checked,
  note,
  checkedAt: checked ? new Date("2026-11-03T10:00:00Z") : null,
  checkedBy: checked ? "marek" : null,
});

test("mergeChecklist returns the items in order, unticked when no tick is stored", () => {
  const merged = mergeChecklist(["a", "b"], []);
  assert.deepEqual(
    merged.map((i) => [i.item, i.checked, i.note]),
    [
      ["a", false, null],
      ["b", false, null],
    ],
  );
  assert.deepEqual(mergeChecklist(null, [tick("a", true)]), []);
});

test("ticks keyed by text survive a second handoff with a partly changed list, and a removed item drops out", () => {
  const ticks = [tick("Read the diff", true, "looks fine"), tick("Try it on a phone", true), tick("Check the docs", false, "later")];
  // second handoff: one item reworded, one removed, one new
  const merged = mergeChecklist(["Read the diff", "Try it on a tablet", "Check the docs", "New item"], ticks);
  assert.deepEqual(
    merged.map((i) => [i.item, i.checked, i.note, i.checkedBy]),
    [
      ["Read the diff", true, "looks fine", "marek"],
      ["Try it on a tablet", false, null, null],
      ["Check the docs", false, "later", null],
      ["New item", false, null, null],
    ],
  );
  assert.ok(!merged.some((i) => i.item === "Try it on a phone"));
});

test("parseChecklistPatch needs an item and a checked state or note", () => {
  assert.deepEqual(parseChecklistPatch({ item: " a ", checked: true }), { item: "a", checked: true });
  assert.deepEqual(parseChecklistPatch({ item: "a", note: "  " }), { item: "a", note: null });
  assert.throws(() => parseChecklistPatch({ checked: true }), /item is required/);
  assert.throws(() => parseChecklistPatch({ item: "a" }), /checked, note, or both/);
  assert.throws(() => parseChecklistPatch({ item: "a", checked: "yes" }), /boolean/);
  assert.throws(() => parseChecklistPatch({ item: "a", note: "x".repeat(501) }), /at most 500/);
});

test("POST /tasks/:id/handoff rejects a malformed checklist with 400", async () => {
  const res = await app.inject({ method: "POST", url: "/tasks/1/handoff", payload: { ...actor, checklist: "not a list" } });
  assert.equal(res.statusCode, 400);
});

test("PATCH /tasks/:id/checklist rejects a body without a change with 400", async () => {
  const res = await app.inject({ method: "PATCH", url: "/tasks/1/checklist", payload: { ...actor, item: "a" } });
  assert.equal(res.statusCode, 400);
});
