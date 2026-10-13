import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveNotification, type JournalEventForNotification } from "./notifications.js";
import { PushGate, type PushItem, digestText, healthKey, inQuietHours, localClock, pushCategory } from "./push-policy.js";

const task = { id: 12, title: "Fix the thing" };
const ev = (eventType: string, payload: Record<string, unknown>, taskId: number | null = 12, actorName = "foreman"): JournalEventForNotification => ({
  eventType,
  actorType: "agent",
  actorName,
  taskId,
  payload,
});

function category(e: JournalEventForNotification) {
  const draft = deriveNotification(e, e.taskId ? task : null);
  assert.ok(draft, `${e.eventType} should still make a bell notification`);
  return pushCategory(e, draft);
}

test("filter: only things that need a human push", () => {
  assert.equal(category(ev("ask", { kind: "question", question: "Which?" })), "decision");
  assert.equal(category(ev("chat_question", { threadId: 3 })), "decision");
  assert.equal(category(ev("status", { to: "needs_input" })), "decision");
  assert.equal(category(ev("chat_permission_request", { toolName: "Bash" }, null)), "decision");
  assert.equal(category(ev("pipeline", { to: "rework", repairReason: "ci_failed" })), "failure");
  assert.equal(category(ev("deploy", { outcome: "failed", repo: "x", host: "y" }, null)), "failure");
  assert.equal(category(ev("backup", { outcome: "failed" }, null)), "failure");
  assert.equal(category(ev("health", { check: "llm-gateway", status: "failing" }, null)), "health");

  assert.equal(category(ev("status", { to: "done" })), null);
  assert.equal(category(ev("complete", {})), null);
  assert.equal(category(ev("handoff", {})), null);
  assert.equal(category(ev("health", { check: "llm-gateway", status: "recovered" }, null)), null);
  assert.equal(category(ev("deploy", { outcome: "ok", requestId: 1, repo: "x", host: "y" }, null)), null);
  assert.equal(category(ev("pipeline", { to: "queued", repairReason: "ci_failed" })), null, "handed to an agent");
  // Reviews never push on their own; they only count in the digest.
  assert.equal(category(ev("status", { to: "review" })), "review");
  assert.equal(category(ev("pipeline", { to: "awaiting_review" })), "review");
});

test("healthKey names reporter and check", () => {
  assert.equal(healthKey(ev("health", { check: "disk" }, null, "foreman")), "foreman:disk");
  assert.equal(healthKey(ev("ask", {})), null);
});

test("quiet hours and the Bratislava clock", () => {
  assert.equal(inQuietHours(0, 1, 9), false);
  assert.equal(inQuietHours(1, 1, 9), true);
  assert.equal(inQuietHours(8, 1, 9), true);
  assert.equal(inQuietHours(9, 1, 9), false);
  assert.equal(inQuietHours(23, 22, 7), true);
  assert.equal(inQuietHours(3, 3, 3), false);
  // 2026-09-29 is CEST (UTC+2).
  assert.deepEqual(localClock(new Date("2026-09-29T23:30:00Z"), "Europe/Bratislava"), { day: "2026-09-30", hour: 1 });
});

test("digestText", () => {
  assert.equal(digestText({ decisions: 3, reviews: 2, failures: 1 }), "3 decisions, 2 reviews, 1 failure overnight");
  assert.equal(digestText({ decisions: 0, reviews: 1, failures: 0 }), "1 review overnight");
  assert.equal(digestText({ decisions: 0, reviews: 0, failures: 0 }), null);
});

// Times in UTC; Bratislava is UTC+2 on these dates, so 01-09 local = 23-07 UTC.
const at = (iso: string) => new Date(`2026-09-${iso}Z`);
const item = (id: number, title = `item ${id}`): PushItem => ({ id, kind: "question", title, body: null, url: `/tasks/${id}` });

function gate() {
  const sent: PushItem[] = [];
  const g = new PushGate({ send: (n) => sent.push(n), quietStart: 1, quietEnd: 9, digestAt: 9, timeZone: "Europe/Bratislava" });
  return { g, sent };
}

test("daytime: first push goes out at once, never-push kinds don't", () => {
  const { g, sent } = gate();
  g.offer(item(1), null, null, at("29T10:00:00"));
  g.offer(item(2), "review", null, at("29T10:00:00"));
  assert.equal(sent.length, 0);
  g.offer(item(3), "decision", null, at("29T10:00:00"));
  assert.deepEqual(sent, [item(3)]);
});

test("coalescing: pushes within 10 minutes become one 'N things need you'", () => {
  const { g, sent } = gate();
  g.offer(item(1), "decision", null, at("29T10:00:00"));
  g.offer(item(2), "failure", null, at("29T10:02:00"));
  g.offer(item(3), "decision", null, at("29T10:05:00"));
  g.tick(at("29T10:09:00"));
  assert.equal(sent.length, 1);
  g.tick(at("29T10:10:00"));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].title, "2 things need you");
  assert.equal(sent[1].url, "/inbox");
  // That flush opened a new window; a single held item is sent as itself.
  g.offer(item(4), "decision", null, at("29T10:15:00"));
  g.tick(at("29T10:20:00"));
  assert.deepEqual(sent[2], item(4));
  // Nothing held: the window closes and the next push is immediate again.
  g.tick(at("29T10:30:00"));
  g.offer(item(5), "decision", null, at("29T10:31:00"));
  assert.deepEqual(sent[3], item(5));
  assert.equal(sent.length, 4);
});

test("quiet hours: nothing pushes, one digest at 09:00 linking to /inbox", () => {
  const { g, sent } = gate();
  g.offer(item(1), "decision", null, at("29T23:30:00")); // 01:30 local
  g.offer(item(2), "decision", null, at("30T00:00:00"));
  g.offer(item(3), "review", null, at("30T01:00:00"));
  g.offer(item(4), "failure", null, at("30T02:00:00"));
  g.offer(item(5), "health", "foreman:disk", at("30T03:00:00"));
  g.offer(item(6), "health", "foreman:llm-gateway", at("30T03:00:00"));
  g.offer(item(7), null, "foreman:llm-gateway", at("30T04:00:00")); // recovered
  g.tick(at("30T06:59:00")); // 08:59 local
  assert.equal(sent.length, 0);
  g.tick(at("30T07:00:30")); // 09:00 local
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, "2 decisions, 1 review, 2 failures overnight");
  assert.equal(sent[0].url, "/inbox");
  // Only once per day.
  g.tick(at("30T08:00:00"));
  assert.equal(sent.length, 1);
});

test("empty digest is skipped", () => {
  const { g, sent } = gate();
  g.offer(item(1), null, null, at("29T23:30:00"));
  g.offer(item(2), "health", "foreman:disk", at("30T00:00:00"));
  g.offer(item(3), null, "foreman:disk", at("30T01:00:00")); // recovered before digest
  g.tick(at("30T07:01:00"));
  assert.equal(sent.length, 0);
});
