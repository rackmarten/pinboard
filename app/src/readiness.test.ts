import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionsRepo, readinessApplies, readinessFailures, repoName, toWorkspaceRepos } from "./readiness.js";

const body = "Implement the thing properly. ".repeat(8) + "\n## Acceptance\n- it works";
const ready = { executorMode: "agent", estimatedEffort: 3, priority: 2, autonomyLevel: 3, description: body, projectId: 1, relatedProjectIds: [] };
const repos = [{ id: 1, repo: "pinboard" }, { id: 2, repo: "foreman" }, { id: 3, repo: "homelab-kit" }];

test("a ready task passes", () => {
  assert.deepEqual(readinessFailures(ready, repos), []);
});

test("effort must be set and <= 8", () => {
  assert.match(readinessFailures({ ...ready, estimatedEffort: null }, repos)[0], /estimatedEffort is not set/);
  assert.match(readinessFailures({ ...ready, estimatedEffort: 13 }, repos)[0], /over 8/);
  assert.deepEqual(readinessFailures({ ...ready, estimatedEffort: 8 }, repos), []);
});

test("priority > 0 and autonomy set", () => {
  assert.deepEqual(readinessFailures({ ...ready, priority: 0 }, repos), ["priority must be > 0"]);
  assert.deepEqual(readinessFailures({ ...ready, autonomyLevel: null }, repos), ["autonomyLevel is not set"]);
});

test("description length and acceptance section", () => {
  const f = readinessFailures({ ...ready, description: "short" }, repos);
  assert.equal(f.length, 2);
  assert.match(f[0], /needs at least 200/);
  assert.match(f[1], /acceptance section/);
  assert.deepEqual(readinessFailures({ ...ready, description: body.replace("## Acceptance", "Done when:") }, repos), []);
});

test("repo coverage lists every missing repo, ignoring the own project", () => {
  const d = body + "\nTouch foreman/app/src/x.ts and homelab-kit#12 and pinboard/app.";
  assert.deepEqual(readinessFailures({ ...ready, description: d }, repos), [
    "description mentions repos not in relatedProjectIds: foreman, homelab-kit",
  ]);
  assert.deepEqual(readinessFailures({ ...ready, description: d, relatedProjectIds: [2, 3] }, repos), []);
});

test("mentionsRepo needs a path or # reference, not a bare word", () => {
  assert.equal(mentionsRepo("the foreman runner", "foreman"), false);
  assert.equal(mentionsRepo("see my-org/foreman/README", "foreman"), true);
  assert.equal(mentionsRepo("foreman#473", "foreman"), true);
  assert.equal(mentionsRepo("homelab-kit/x", "kit"), false);
  assert.equal(repoName("my-org/foreman/"), "foreman");
});

// false positives that forced queues on 2026-10-04.
const projectRows = [
  { id: 1, localPath: "my-org/pinboard", repoUrl: null },
  { id: 2, localPath: "my-org/foreman", repoUrl: null },
  { id: 7, localPath: "my-org", repoUrl: "https://github.com/orgs/my-org/repositories" },
  { id: 41, localPath: "rackmarten", repoUrl: "https://github.com/orgs/rackmarten/repositories" },
  { id: 28, localPath: "my-org/.github", repoUrl: "https://github.com/my-org/.github" },
  { id: 35, localPath: null, repoUrl: null },
];

test("toWorkspaceRepos leaves out GitHub org pages and projects without a localPath", () => {
  assert.deepEqual(toWorkspaceRepos(projectRows), [
    { id: 1, repo: "pinboard", org: "my-org" },
    { id: 2, repo: "foreman", org: "my-org" },
    { id: 28, repo: ".github", org: "my-org" },
  ]);
});

test("an org-prefixed repo path does not flag the org project", () => {
  const d = body + "\nPublish rackmarten/eslint-config from my-org/homelab-kit.";
  assert.deepEqual(readinessFailures({ ...ready, projectId: 10, description: d }, toWorkspaceRepos(projectRows)), []);
});

test("a .github workflow path does not flag the .github repo, an org-qualified one does", () => {
  const all = toWorkspaceRepos(projectRows);
  const lint = (extra: string) => readinessFailures({ ...ready, description: body + "\n" + extra }, all);
  assert.deepEqual(lint("Add .github/workflows/lint.yml and app/.github/workflows/ci.yml."), []);
  assert.deepEqual(lint("Call my-org/.github/workflows/security-check.yml."), [
    "description mentions repos not in relatedProjectIds: .github",
  ]);
  assert.equal(mentionsRepo("in my-org/.github.", ".github", "my-org"), true);
  assert.equal(mentionsRepo("see .github#4", ".github", "my-org"), true);
  assert.equal(mentionsRepo("rackmarten/.github/profile", ".github", "my-org"), false);
  assert.equal(mentionsRepo("touch foreman/app", "foreman", "my-org"), true);
});

test("unresolved-question markers fail", () => {
  for (const line of ["TBD: pick a port", "? which table", "Open question: x", "Decide between a and b"]) {
    const f = readinessFailures({ ...ready, description: body + "\n" + line }, repos);
    assert.equal(f.length, 1, line);
    assert.match(f[0], /unresolved questions/);
  }
});

test("foreman's own handbacks into queued are not linted", () => {
  assert.equal(readinessApplies("executing"), false);
  assert.equal(readinessApplies("needs_input"), false);
  assert.equal(readinessApplies("defined"), true);
  assert.equal(readinessApplies("rework"), true);
});
