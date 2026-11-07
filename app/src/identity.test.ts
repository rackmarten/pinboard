import assert from "node:assert/strict";
import { test } from "node:test";
import { actorFromHeaders } from "./identity.js";
import { PROXY_SECRET_HEADER } from "./root-grants.js";

const off = { proxySecret: "", userHeader: "" };
const on = { proxySecret: "s3cret", userHeader: "x-forwarded-user" };

test("the PWA is the one operator when no user header is configured", () => {
  assert.deepEqual(actorFromHeaders({ "x-pinboard-client": "pwa", "x-forwarded-user": "alice" }, off), {
    actorType: "human",
    actorName: "operator",
  });
});

test("a named actor and an unnamed caller resolve as before", () => {
  assert.deepEqual(actorFromHeaders({ "x-pinboard-actor": "agent:foreman-runner" }, on), { actorType: "agent", actorName: "foreman-runner" });
  assert.deepEqual(actorFromHeaders({}, on), { actorType: "system", actorName: "api" });
});

test("the user header names the person only alongside the proxy's secret", () => {
  const viaProxy = { "x-pinboard-client": "pwa", [PROXY_SECRET_HEADER]: "s3cret", "x-forwarded-user": "alice" };
  assert.deepEqual(actorFromHeaders(viaProxy, on), { actorType: "human", actorName: "alice" });
  assert.equal(actorFromHeaders({ ...viaProxy, [PROXY_SECRET_HEADER]: "guess" }, on).actorName, "operator");
  assert.equal(actorFromHeaders({ ...viaProxy, [PROXY_SECRET_HEADER]: undefined }, on).actorName, "operator");
  assert.equal(actorFromHeaders({ ...viaProxy, "x-forwarded-user": "a:b c" }, on).actorName, "operator");
});

test("a beacon marks itself as the PWA from the query string", () => {
  assert.deepEqual(actorFromHeaders({}, off, { client: "pwa" }), { actorType: "human", actorName: "operator" });
});
