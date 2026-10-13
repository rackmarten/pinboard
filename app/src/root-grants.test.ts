import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkGrantable,
  checkOperatorRequest,
  checkQueueMove,
  CLIENT_IP_HEADER,
  DEFAULT_TTL_HOURS,
  grantState,
  PROXY_SECRET_HEADER,
  validateRootScope,
  validateTtlHours,
} from "./root-grants.js";

const settings = { proxySecret: "s3cret", operatorIps: ["100.64.0.9", "100.64.0.20"] };
const viaCaddy = (ip: string, secret = "s3cret") => ({ [PROXY_SECRET_HEADER]: secret, [CLIENT_IP_HEADER]: ip });

test("an operator device through Caddy may grant", () => {
  const r = checkOperatorRequest(viaCaddy("100.64.0.9"), settings);
  assert.deepEqual(r, { ok: true, clientIp: "100.64.0.9" });
});

test("a direct call without the proxy secret is refused, whatever IP it claims", () => {
  // foreman calling pinboard:8095 can set any header it likes except the secret.
  assert.equal(checkOperatorRequest({ [CLIENT_IP_HEADER]: "100.64.0.9" }, settings).ok, false);
  assert.equal(checkOperatorRequest(viaCaddy("100.64.0.9", "guess"), settings).ok, false);
  assert.equal(checkOperatorRequest(viaCaddy("100.64.0.9", "s3cret-longer"), settings).ok, false);
});

test("a request through Caddy from a non-operator address is refused and names it", () => {
  // e.g. an agent that SSHed to an LXC and curled pinboard.example.com from there
  const r = checkOperatorRequest(viaCaddy("100.64.0.33"), settings);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /100\.64\.0\.33/);
  assert.equal(checkOperatorRequest(viaCaddy(""), settings).ok, false);
});

test("grants fail closed when either setting is missing", () => {
  assert.equal(checkOperatorRequest(viaCaddy("100.64.0.9", ""), { proxySecret: "", operatorIps: ["100.64.0.9"] }).ok, false);
  assert.equal(checkOperatorRequest(viaCaddy("100.64.0.9"), { proxySecret: "s3cret", operatorIps: [] }).ok, false);
});

test("a repeated header uses its first value", () => {
  const r = checkOperatorRequest({ [PROXY_SECRET_HEADER]: ["s3cret"], [CLIENT_IP_HEADER]: ["100.64.0.9", "1.2.3.4"] }, settings);
  assert.equal(r.ok, true);
});

test("root scope is deduped, sorted and limited to plausible CTIDs", () => {
  assert.deepEqual(validateRootScope([301, 110, 301]), { ok: true, ctids: [110, 301] });
  assert.deepEqual(validateRootScope([]), { ok: true, ctids: [] });
  assert.equal(validateRootScope([99]).ok, false);
  assert.equal(validateRootScope(["301"]).ok, false);
  assert.equal(validateRootScope([301.5]).ok, false);
  assert.equal(validateRootScope("301").ok, false);
});

test("ttl defaults to 4h and is capped at 24h", () => {
  assert.deepEqual(validateTtlHours(undefined), { ok: true, hours: DEFAULT_TTL_HOURS });
  assert.deepEqual(validateTtlHours(0.5), { ok: true, hours: 0.5 });
  assert.equal(validateTtlHours(0).ok, false);
  assert.equal(validateTtlHours(25).ok, false);
  assert.equal(validateTtlHours("4").ok, false);
});

test("only a labelled, scoped task that nothing is working can be granted", () => {
  assert.equal(checkGrantable({ status: "defined", rootScope: [301] }, true).ok, true);
  assert.equal(checkGrantable({ status: "rework", rootScope: [301] }, true).ok, true);
  assert.equal(checkGrantable({ status: "queued", rootScope: [301] }, true).ok, true);
  assert.equal(checkGrantable({ status: "defined", rootScope: [301] }, false).ok, false);
  assert.equal(checkGrantable({ status: "defined", rootScope: [] }, true).ok, false);
  for (const status of ["executing", "handoff", "awaiting_ci", "deploying", "done", "rejected"]) {
    assert.equal(checkGrantable({ status, rootScope: [301] }, true).ok, false, status);
  }
});

const now = new Date("2026-09-22T12:00:00Z");
const grant = (over: Partial<Parameters<typeof grantState>[0]> = {}) => ({
  status: "queued",
  rootGrantCtids: [301],
  rootGrantExpiresAt: new Date("2026-09-22T16:00:00Z"),
  rootGrantedAt: new Date("2026-09-22T12:00:00Z"),
  rootGrantedBy: "operator (100.64.0.9)",
  ...over,
});

test("a grant is active until it expires", () => {
  const s = grantState(grant(), now);
  assert.equal(s.active, true);
  assert.deepEqual(s.ctids, [301]);
  assert.equal(s.expiresAt, "2026-09-22T16:00:00.000Z");
  assert.equal(grantState(grant({ rootGrantExpiresAt: now }), now).active, false);
});

test("a closed task, a missing grant or an empty scope is never active", () => {
  assert.equal(grantState(grant({ status: "done" }), now).active, false);
  assert.equal(grantState(grant({ status: "rejected" }), now).active, false);
  assert.equal(grantState(grant({ rootGrantCtids: null, rootGrantExpiresAt: null }), now).active, false);
  assert.equal(grantState(grant({ rootGrantCtids: [] }), now).active, false);
});

test("moving a root task into queued needs a live grant", () => {
  assert.equal(checkQueueMove("defined", "queued", true, false).ok, false);
  assert.equal(checkQueueMove("rework", "queued", true, false).ok, false);
  // foreman's session-limit refund, inside the grant window
  assert.equal(checkQueueMove("executing", "queued", true, true).ok, true);
});

test("the queue gate leaves unlabelled tasks, other moves and no-op edits alone", () => {
  assert.equal(checkQueueMove("defined", "queued", false, false).ok, true);
  assert.equal(checkQueueMove("queued", "defined", true, false).ok, true);
  assert.equal(checkQueueMove("queued", "queued", true, false).ok, true);
  assert.equal(checkQueueMove("defined", undefined, true, false).ok, true);
});
