import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";
import { sql } from "./db/client.js";
import { AGENT_EXECUTORS, registerRoutes } from "./routes.js";

// The executor check runs before any query, so these requests never reach
// the database (the test script's DATABASE_URL points nowhere real).
const app = Fastify();
await registerRoutes(app);
after(async () => {
  await app.close();
  await sql.end({ timeout: 0 });
});

const agent = { name: "runner", provider: "anthropic", licenseId: 1 };

test("POST /agents rejects an executor foreman does not run with 400", async () => {
  const res = await app.inject({ method: "POST", url: "/agents", payload: { ...agent, executor: "api" } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message ?? res.json().error, /executor must be one of cli, cli-host, 8ball/);
});

test("PATCH /agents/:id rejects an unknown executor with 400", async () => {
  const res = await app.inject({ method: "PATCH", url: "/agents/1", payload: { executor: "human" } });
  assert.equal(res.statusCode, 400);
});

test("AGENT_EXECUTORS lists the values foreman dispatches on, cli first", () => {
  assert.deepEqual(AGENT_EXECUTORS, ["cli", "cli-host", "8ball"]);
});
