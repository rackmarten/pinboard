import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveNotification, type JournalEventForNotification } from "./notifications.js";

const task = { id: 12, title: "Fix the thing" };
const ev = (e: Partial<JournalEventForNotification>): JournalEventForNotification => ({
  eventType: "status",
  actorType: "agent",
  actorName: "foreman-runner",
  taskId: 12,
  payload: null,
  ...e,
});

test("a human's own action never notifies", () => {
  assert.equal(deriveNotification(ev({ actorType: "human", payload: { to: "rework" } }), task), null);
  assert.equal(deriveNotification(ev({ actorType: "human", eventType: "handoff" }), task), null);
});

test("status changes that need attention", () => {
  assert.equal(deriveNotification(ev({ payload: { from: "executing", to: "rework" } }), task)?.kind, "failure");
  assert.equal(deriveNotification(ev({ payload: { to: "review" } }), task)?.kind, "review");
  assert.equal(deriveNotification(ev({ payload: { to: "done" } }), task)?.kind, "completed");
  assert.equal(deriveNotification(ev({ payload: { to: "executing" } }), task), null);
});

test("pipeline: a repair handback is a failure, a hold is an approval", () => {
  const failed = deriveNotification(ev({ eventType: "pipeline", payload: { from: "awaiting_ci", to: "queued", repairReason: "ci_failed" } }), task);
  assert.equal(failed?.kind, "failure");
  assert.match(failed!.title, /^CI failed: #12 Fix the thing$/);
  const held = deriveNotification(ev({ eventType: "pipeline", payload: { to: "awaiting_review" } }), task);
  assert.equal(held?.kind, "approval");
  assert.equal(held?.url, "/review");
  assert.equal(deriveNotification(ev({ eventType: "pipeline", payload: { to: "deploying" } }), task), null);
});

test("a human+agent park says it is waiting on the human", () => {
  const parked = deriveNotification(ev({ eventType: "pipeline", payload: { from: "verifying", to: "rework", repairReason: "deploy_failed" } }), task);
  assert.equal(parked?.kind, "failure");
  assert.match(parked!.title, /^deploy failed: #12/);
  assert.match(parked!.body ?? "", /requeue/);
});

test("handoff and complete report completion, linked to the task", () => {
  const n = deriveNotification(ev({ eventType: "handoff" }), task);
  assert.equal(n?.kind, "completed");
  assert.equal(n?.url, "/tasks/12");
  assert.equal(deriveNotification(ev({ eventType: "complete" }), task)?.kind, "completed");
});

test("chat permission requests and task questions link to the thread", () => {
  const perm = deriveNotification(ev({ eventType: "chat_permission_request", taskId: null, payload: { threadId: 4, toolName: "Bash" } }), null);
  assert.deepEqual([perm?.kind, perm?.url, perm?.title], ["approval", "/chat/4", "Permission requested: Bash"]);
  const q = deriveNotification(ev({ eventType: "chat_question", payload: { threadId: 9, preview: "Which DB?" } }), task);
  assert.deepEqual([q?.kind, q?.url, q?.body], ["question", "/chat/9", "Which DB?"]);
});

test("unrelated events and task events without a task are ignored", () => {
  assert.equal(deriveNotification(ev({ eventType: "comment" }), task), null);
  assert.equal(deriveNotification(ev({ eventType: "config_changed", taskId: null }), null), null);
  assert.equal(deriveNotification(ev({ payload: { to: "rework" } }), null), null);
});

test("deploy: only task-less deploys notify, failures always, successes when requested", () => {
  const deploy = (payload: Record<string, unknown>, taskId: number | null = null) =>
    deriveNotification(ev({ eventType: "deploy", actorName: "foreman-releases", taskId, payload }), null);
  const failed = deploy({ repo: "my-moments", app: "my-moments", host: "sandbox", outcome: "failed" });
  assert.equal(failed?.kind, "failure");
  assert.equal(failed?.title, "Deploy failed: my-moments/my-moments on sandbox");
  assert.equal(deploy({ repo: "glance", host: "glance", outcome: "succeeded", requestId: 3 })?.title, "Deployed glance on glance");
  assert.equal(deploy({ repo: "glance", host: "glance", outcome: "succeeded" }), null);
  assert.equal(deploy({ repo: "glance", host: "glance", outcome: "failed" }, 12), null);
});

test("backup: only a failed backup notifies", () => {
  const backup = (payload: Record<string, unknown>) =>
    deriveNotification(ev({ eventType: "backup", actorType: "system", actorName: "pinboard-backup", taskId: null, payload }), null);
  const failed = backup({ outcome: "failed", detail: "pg_dump failed" });
  assert.equal(failed?.kind, "failure");
  assert.equal(failed?.title, "Pinboard backup failed");
  assert.equal(failed?.body, "pg_dump failed");
  assert.equal(backup({ outcome: "succeeded", detail: "ok" }), null);
});

test("health: failing and recovered transitions notify, with the reporter's name and check", () => {
  const health = (payload: Record<string, unknown>) =>
    deriveNotification(ev({ eventType: "health", actorType: "system", actorName: "foreman", taskId: null, payload }), null);
  const failing = health({ check: "llm-gateway", status: "failing", detail: "fetch failed" });
  assert.equal(failing?.kind, "failure");
  assert.equal(failing?.title, "foreman: llm-gateway is failing");
  assert.equal(failing?.body, "fetch failed");
  const recovered = health({ check: "llm-gateway", status: "recovered" });
  assert.equal(recovered?.kind, "completed");
  assert.equal(recovered?.title, "foreman: llm-gateway recovered");
  assert.equal(health({ check: "llm-gateway", status: "bogus" }), null);
});
