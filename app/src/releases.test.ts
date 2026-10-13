import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PENDING_COMMITS, findProjectForRepo, parseReleaseBump, parseTargetReport, truncateRequestOutput } from "./releases.js";

test("findProjectForRepo matches the repo segment of localPath, preferring live projects", () => {
  const projects = [
    { id: 1, localPath: "my-org/pinboard", archived: true },
    { id: 2, localPath: "my-org/pinboard", archived: false },
    { id: 3, localPath: "uncik-projects/my-moments", archived: false },
    { id: 4, localPath: null, archived: false },
  ];
  assert.equal(findProjectForRepo(projects, "pinboard")?.id, 2);
  assert.equal(findProjectForRepo(projects, "my-moments")?.id, 3);
  assert.equal(findProjectForRepo(projects, "my-org"), null);
  assert.equal(findProjectForRepo(projects, "nope"), null);
});

test("parseTargetReport normalizes a probe report", () => {
  const [t] = parseTargetReport({
    targets: [{ host: "sandbox", app: "my-moments", deployedSha: "a", mainSha: "b", pendingCount: 2, pendingCommits: [{ sha: "b", subject: "x" }, { bad: 1 }], probeError: "" }],
  });
  assert.deepEqual(t, { host: "sandbox", app: "my-moments", deployedSha: "a", mainSha: "b", pendingCount: 2, pendingCommits: [{ sha: "b", subject: "x" }], probeError: null, release: false, deployedVersion: null });
  const [lxc] = parseTargetReport({ targets: [{ host: "glance", pendingCount: -1 }] });
  assert.equal(lxc.app, "");
  assert.equal(lxc.pendingCount, null);
});

test("parseTargetReport caps the commit list but not the count", () => {
  const commits = Array.from({ length: 50 }, (_, i) => ({ sha: String(i), subject: "s" }));
  const [t] = parseTargetReport({ targets: [{ host: "h", pendingCount: 50, pendingCommits: commits }] });
  assert.equal(t.pendingCommits.length, MAX_PENDING_COMMITS);
  assert.equal(t.pendingCount, 50);
});

test("parseTargetReport rejects malformed reports", () => {
  assert.throws(() => parseTargetReport({}), /array/);
  assert.throws(() => parseTargetReport({ targets: [{}] }), /host/);
  assert.throws(() => parseTargetReport({ targets: [{ host: "a" }, { host: "a", app: "" }] }), /duplicates/);
  assert.doesNotThrow(() => parseTargetReport({ targets: [] }));
});

test("truncateRequestOutput keeps the tail", () => {
  const out = truncateRequestOutput("x".repeat(30_000) + "END");
  assert.ok(out.endsWith("END"));
  assert.ok(out.length <= 20_001);
});

test("parseTargetReport keeps a release target and its version", () => {
  const [t] = parseTargetReport({ targets: [{ host: "production", app: "my-moments", release: true, deployedVersion: "v0.2.0" }] });
  assert.equal(t.release, true);
  assert.equal(t.deployedVersion, "v0.2.0");
  const [notRelease] = parseTargetReport({ targets: [{ host: "production", release: "yes" }] });
  assert.equal(notRelease.release, false);
});

test("parseReleaseBump defaults to patch and rejects anything else", () => {
  assert.equal(parseReleaseBump({}), "patch");
  assert.equal(parseReleaseBump(null), "patch");
  assert.equal(parseReleaseBump({ bump: "minor" }), "minor");
  assert.equal(parseReleaseBump({ bump: "major" }), "major");
  assert.throws(() => parseReleaseBump({ bump: "1.2.3" }), /bump must be/);
});
