import { test } from "node:test";
import assert from "node:assert/strict";
import { createNtfyClient } from "@rackmarten/server-kit";
import { deriveNotification } from "./notifications.js";
import { MAX_BODY_CHARS, buildNtfyMessage, clickUrl } from "./push.js";

const opts = { topic: "pinboard", baseUrl: "https://pinboard.example.com" };
const n = { id: 7, kind: "failure", title: "CI failed: #12 Fix the thing", body: "Handed back to an agent to fix.", url: "/tasks/12" };

test("message carries topic, title, body, a clean click URL, priority and tag", () => {
  assert.deepEqual(buildNtfyMessage(n, opts), {
    topic: "pinboard",
    title: n.title,
    message: n.body,
    clickUrl: "https://pinboard.example.com/tasks/12",
    priority: "high",
    tags: ["rotating_light"],
  });
});

test("message: missing body falls back to the title, missing url to the history", () => {
  const m = buildNtfyMessage({ ...n, kind: "completed", body: null, url: null }, opts);
  assert.equal(m.message, n.title);
  assert.equal(m.clickUrl, "https://pinboard.example.com/notifications");
  assert.equal(m.priority, "low");
});

test("click URL: a tap can never leave pinboard's origin", () => {
  assert.equal(clickUrl("https://pinboard.example.com", "https://evil.example/x"), "https://pinboard.example.com/notifications");
  assert.equal(clickUrl("https://pinboard.example.com", "//evil.example/x"), "https://pinboard.example.com/notifications");
  assert.equal(clickUrl("https://pinboard.example.com/", "/chat/4"), "https://pinboard.example.com/chat/4");
});

test("message: long bodies are trimmed", () => {
  const m = buildNtfyMessage({ ...n, body: "x".repeat(MAX_BODY_CHARS * 2) }, opts);
  assert.equal(m.message.length, MAX_BODY_CHARS);
  assert.ok(m.message.endsWith("…"));
});

test("a new bell notification is published to the pinboard topic with a clean click URL", async () => {
  const draft = deriveNotification(
    { eventType: "status", taskId: 12, actorType: "agent", actorName: "foreman-runner", payload: { from: "in_progress", to: "review" } },
    { id: 12, title: "Fix the thing" },
  );
  assert.ok(draft, "status change to review rings the bell");

  const calls: { url: string; init: RequestInit }[] = [];
  const client = createNtfyClient({
    url: "http://192.168.0.126",
    token: "tk_test",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });

  assert.equal(await client.notify(buildNtfyMessage({ id: 99, ...draft }, opts)), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://192.168.0.126");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer tk_test");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.topic, "pinboard");
  assert.equal(body.click, "https://pinboard.example.com/tasks/12");
  assert.equal(body.title, draft.title);
});
