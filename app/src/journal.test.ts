import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";
import { sql } from "./db/client.js";
import { parseJournalQuery, parseTaskEventsQuery, TASK_EVENTS_MAX_LIMIT, TRANSITION_EVENT_TYPES } from "./journal.js";
import { registerRoutes } from "./routes.js";

// Query parsing only: a malformed date is refused before any query runs, so
// these never reach the database (DATABASE_URL points nowhere real).
const app = Fastify();
await registerRoutes(app);
after(async () => {
  await app.close();
  await sql.end({ timeout: 0 });
});

test("parseJournalQuery reads the since/until window and the target status", () => {
  const q = parseJournalQuery({ since: "2026-11-01T00:00:00Z", until: "2026-11-08", to: "rework", projectId: "3" });
  assert.equal(q.since?.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(q.until?.toISOString(), "2026-11-08T00:00:00.000Z");
  assert.equal(q.toStatus, "rework");
  assert.equal(q.projectId, 3);
});

test("to= narrows to transition events unless types says otherwise", () => {
  assert.deepEqual(parseJournalQuery({ to: "rework" }).eventTypes, TRANSITION_EVENT_TYPES);
  assert.deepEqual(parseJournalQuery({ to: "rework", types: "pipeline" }).eventTypes, ["pipeline"]);
  assert.equal(parseJournalQuery({}).eventTypes, undefined);
});

test("empty values are ignored", () => {
  const q = parseJournalQuery({ since: "", until: "", to: "", limit: "" });
  assert.equal(q.since, undefined);
  assert.equal(q.until, undefined);
  assert.equal(q.toStatus, undefined);
  assert.equal(q.limit, undefined);
});

test("parseJournalQuery throws on a malformed date", () => {
  assert.throws(() => parseJournalQuery({ since: "last week" }), /since must be an ISO date/);
  assert.throws(() => parseJournalQuery({ until: "nope" }), /until must be an ISO date/);
});

test("GET /events answers 400 for a malformed since", async () => {
  const res = await app.inject({ method: "GET", url: "/events?since=yesterday&to=rework" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message ?? res.json().error, /since must be an ISO date/);
});

test("parseTaskEventsQuery reads the type and limit, and caps the limit", () => {
  assert.deepEqual(parseTaskEventsQuery({ type: "activity", limit: "50" }), { type: "activity", limit: 50 });
  assert.deepEqual(parseTaskEventsQuery({ limit: "100000" }), { type: undefined, limit: TASK_EVENTS_MAX_LIMIT });
});

test("parseTaskEventsQuery leaves a bare request unbounded", () => {
  assert.deepEqual(parseTaskEventsQuery({}), { type: undefined, limit: undefined });
  assert.deepEqual(parseTaskEventsQuery({ type: "", limit: "" }), { type: undefined, limit: undefined });
});

test("GET /tasks/:id/events answers 400 for a limit that isn't a positive integer", async () => {
  for (const limit of ["0", "-3", "1.5", "lots"]) {
    const res = await app.inject({ method: "GET", url: `/tasks/1/events?limit=${limit}` });
    assert.equal(res.statusCode, 400, limit);
    assert.match(res.json().message ?? res.json().error, /limit must be a positive integer/);
  }
});
