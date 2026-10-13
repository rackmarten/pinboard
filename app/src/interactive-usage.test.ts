import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";
import { sql } from "./db/client.js";
import { registerRoutes } from "./routes.js";
import {
  calibrationCostUsd,
  countsTowardBudgetGate,
  INTERACTIVE_DEDUPE_MS,
  InteractiveDedupe,
  licenseIdForLinuxUser,
} from "./usage.js";

// Schema validation runs before the handler, so these requests never reach
// the database (the test script's DATABASE_URL points nowhere real).
const app = Fastify();
await registerRoutes(app);
after(async () => {
  await app.close();
  await sql.end({ timeout: 0 });
});

const valid = { costUsd: 0.5, source: "interactive", linuxUser: "alice", sessionId: "s1" };

for (const [name, payload] of [
  ["a zero cost", { ...valid, costUsd: 0 }],
  ["a negative cost", { ...valid, costUsd: -1 }],
  ["a non-numeric cost", { ...valid, costUsd: "lots" }],
  ["a source other than interactive", { ...valid, source: "handoff" }],
  ["a missing linuxUser", { ...valid, linuxUser: undefined }],
  ["an empty sessionId", { ...valid, sessionId: "" }],
] as const) {
  test(`POST /usage rejects ${name} with 400`, async () => {
    const res = await app.inject({ method: "POST", url: "/usage", payload: payload as object });
    assert.equal(res.statusCode, 400);
  });
}

test("licenseIdForLinuxUser resolves a license by its linux user, null when unknown", () => {
  const rows = [
    { id: 1, linuxUser: "alice" },
    { id: 2, linuxUser: "bob" },
  ];
  assert.equal(licenseIdForLinuxUser(rows, "bob"), 2);
  assert.equal(licenseIdForLinuxUser(rows, "carol"), null);
});

test("InteractiveDedupe stores the same session and cost once within a minute", () => {
  const d = new InteractiveDedupe();
  const t0 = 1_000_000;
  assert.equal(d.check("s1", 0.5, t0).duplicate, false);
  d.remember("s1", 0.5, 42);
  assert.deepEqual(d.check("s1", 0.5, t0 + 30_000), { duplicate: true, id: 42 });
  // a different cost or session is a separate report
  assert.equal(d.check("s1", 0.75, t0 + 30_000).duplicate, false);
  assert.equal(d.check("s2", 0.5, t0 + 30_000).duplicate, false);
  // after the window it counts again
  assert.equal(d.check("s1", 0.5, t0 + INTERACTIVE_DEDUPE_MS).duplicate, false);
});

test("InteractiveDedupe lets a retry through after a failed insert", () => {
  const d = new InteractiveDedupe();
  assert.equal(d.check("s1", 0.5, 0).duplicate, false);
  d.forget("s1", 0.5);
  assert.equal(d.check("s1", 0.5, 1).duplicate, false);
});

test("interactive spend is excluded from the budget gate, agent and chat spend are not", () => {
  assert.equal(countsTowardBudgetGate("interactive"), false);
  assert.equal(countsTowardBudgetGate("handoff"), true);
  assert.equal(countsTowardBudgetGate("chat"), true);
});

test("calibration cost includes interactive spend on top of agent spend", () => {
  assert.equal(calibrationCostUsd(10, { handoff: 10, chat: 3, interactive: 2 }), 12);
  assert.equal(calibrationCostUsd(10, {}), 10);
});
