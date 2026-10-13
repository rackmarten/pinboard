import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_PROJECT, PushLimiter, buildDescription, handleAlert, parseGrafanaPayload, type AlertStore, type AlertTask } from "./alerts.js";

const firing = (labels: Record<string, string>, status = "firing") => ({
  alerts: [{ status, labels, annotations: { summary: "Disk almost full", description: "root fs at 93%" }, values: { B: 93.2 } }],
});

function fakeStore(projects: string[] = ["homelab"]) {
  const tasks: (AlertTask & { projectSlug: string; description: string; labels: string[] })[] = [];
  const log: string[] = [];
  const ids = new Map(projects.map((s, i) => [s, i + 1]));
  const store: AlertStore = {
    async findOpenTask(key) {
      return tasks.find((t) => t.description.includes(`alert-key: ${key}`) && t.status !== "done") ?? null;
    },
    async ensureProject(slug) {
      if (!ids.has(slug)) {
        if (slug === "broken") return null;
        ids.set(slug, ids.size + 1);
        log.push(`project ${slug}`);
      }
      return ids.get(slug)!;
    },
    async createTask(t) {
      const slug = [...ids].find(([, id]) => id === t.projectId)![0];
      const task = { id: tasks.length + 1, status: "queued", projectSlug: slug, description: t.description, labels: t.labels };
      tasks.push(task);
      return task;
    },
    async addComment(id, body) {
      log.push(`comment ${id}: ${body}`);
    },
    async setStatus(id, status) {
      tasks.find((t) => t.id === id)!.status = status;
    },
    async push(n) {
      log.push(`push ${n.title} ${n.url}`);
    },
  };
  return { store, tasks, log };
}

test("parses Grafana's payload and skips alerts with no alertname", () => {
  const events = parseGrafanaPayload({
    alerts: [
      { status: "firing", labels: { alertname: "DiskFull", host: "sandbox", category: "disk" }, annotations: { summary: "s" }, values: { B: 1 } },
      { status: "resolved", labels: { host: "x" } },
    ],
  });
  assert.equal(events.length, 1);
  assert.deepEqual(
    { ...events[0] },
    { status: "firing", alertname: "DiskFull", host: "sandbox", category: "disk", summary: "s", description: "", values: { B: 1 }, key: "DiskFull:sandbox" },
  );
  assert.deepEqual(parseGrafanaPayload(null), []);
  assert.deepEqual(parseGrafanaPayload({ alerts: "nope" }), []);
});

test("disk description carries the runbook and the alert-key", () => {
  const [e] = parseGrafanaPayload(firing({ alertname: "DiskFull", host: "sandbox", category: "disk" }));
  const d = buildDescription(e);
  assert.match(d, /sudo incinerator --pressure --verbose/);
  assert.match(d, /work root grow <ctid> <GB>/);
  assert.match(d, /Never\*\* delete named docker volumes/);
  assert.match(d, /alert-key: DiskFull:sandbox$/);
});

test("service description carries the outage playbook", () => {
  const [e] = parseGrafanaPayload(firing({ alertname: "ContainerRestarting", host: "media", category: "service" }));
  const d = buildDescription(e);
  assert.match(d, /## What to do/);
  assert.match(d, /`ssh media`, `cd \/app`/);
  assert.match(d, /docker compose ps -a/);
  assert.match(d, /docker compose logs --tail 50 <service>/);
  assert.match(d, /\.\/scripts\/healthcheck\.sh/);
  assert.match(d, /homelab\/scripts\/deploy-service\.sh media/);
  assert.match(d, /docker compose down -v/);
  assert.match(d, /whether that cause can recur/);
  assert.doesNotMatch(d, /incinerator|kopia/);
  assert.match(d, /alert-key: ContainerRestarting:media$/);
});

test("backup description carries the kopia playbook", () => {
  const [e] = parseGrafanaPayload(firing({ alertname: "BackupStale", host: "glance", category: "backup" }));
  const d = buildDescription(e);
  assert.match(d, /`ssh glance`, `sudo journalctl -u kopia-backup\.service -n 100`/);
  assert.match(d, /\/app\/scripts\/backup-dump\.sh/);
  assert.match(d, /sudo systemctl start kopia-backup\.service/);
  assert.match(d, /nightly timer will retry/);
  assert.match(d, /kopia-freshness sidecar/);
  assert.doesNotMatch(d, /incinerator|deploy-service/);
  assert.match(d, /alert-key: BackupStale:glance$/);
});

test("no or unknown category: no playbook, description otherwise unchanged", () => {
  for (const labels of [{ alertname: "A", host: "sandbox" }, { alertname: "A", host: "sandbox", category: "other" }] as Record<string, string>[]) {
    const [e] = parseGrafanaPayload(firing(labels));
    assert.equal(
      buildDescription(e),
      "Grafana alert **A** is firing on `sandbox`.\n\nDisk almost full\n\nroot fs at 93%\n\nValues: B=93.2\n\nalert-key: A:sandbox",
    );
  }
});

test("each playbook category becomes the task's label, others get none", async () => {
  const { store, tasks } = fakeStore();
  const limiter = new PushLimiter();
  for (const category of ["disk", "service", "backup", "other"]) {
    await handleAlert(parseGrafanaPayload(firing({ alertname: `A-${category}`, host: "sandbox", category }))[0], store, limiter);
  }
  assert.deepEqual(tasks.map((t) => t.labels), [["disk"], ["service"], ["backup"], []]);
});

test("firing creates a task in the host's project (created if missing) with the disk label, then dedupes", async () => {
  const { store, tasks, log } = fakeStore();
  const limiter = new PushLimiter();
  const [e] = parseGrafanaPayload(firing({ alertname: "DiskFull", host: "sandbox", category: "disk" }));
  const r1 = await handleAlert(e, store, limiter, new Date(0));
  assert.equal(r1.action, "created");
  assert.equal(tasks[0].projectSlug, "sandbox");
  assert.deepEqual(tasks[0].labels, ["disk"]);
  assert.ok(log.includes("project sandbox"));
  const r2 = await handleAlert(e, store, limiter, new Date(1000));
  assert.equal(r2.action, "commented");
  assert.equal(r2.taskId, r1.taskId);
  assert.equal(tasks.length, 1);
  assert.ok(log.some((l) => l.startsWith("comment 1: still firing") && l.includes("B=93.2")));
});

test("falls back to the fallback project with no host label or when the host project can't be made", async () => {
  const { store, tasks } = fakeStore();
  const limiter = new PushLimiter();
  await handleAlert(parseGrafanaPayload(firing({ alertname: "A" }))[0], store, limiter);
  await handleAlert(parseGrafanaPayload(firing({ alertname: "B", host: "broken" }))[0], store, limiter);
  assert.deepEqual(tasks.map((t) => t.projectSlug), [FALLBACK_PROJECT, FALLBACK_PROJECT]);
  assert.deepEqual(tasks[0].labels, []);
});

test("resolved comments, closes a still-queued task, leaves a claimed one alone, ignores unknown keys", async () => {
  const { store, tasks, log } = fakeStore();
  const limiter = new PushLimiter();
  const at = new Date("2026-09-28T12:00:00Z");
  await handleAlert(parseGrafanaPayload(firing({ alertname: "A", host: "h" }))[0], store, limiter);
  const r = await handleAlert(parseGrafanaPayload(firing({ alertname: "A", host: "h" }, "resolved"))[0], store, limiter, at);
  assert.equal(r.action, "closed");
  assert.equal(tasks[0].status, "done");
  assert.ok(log.includes("comment 1: resolved at 2026-09-28T12:00:00.000Z"));

  await handleAlert(parseGrafanaPayload(firing({ alertname: "C", host: "h" }))[0], store, limiter);
  tasks[1].status = "in_progress";
  const r2 = await handleAlert(parseGrafanaPayload(firing({ alertname: "C", host: "h" }, "resolved"))[0], store, limiter, at);
  assert.equal(r2.action, "resolved");
  assert.equal(tasks[1].status, "in_progress");

  const r3 = await handleAlert(parseGrafanaPayload(firing({ alertname: "Z", host: "h" }, "resolved"))[0], store, limiter);
  assert.equal(r3.action, "ignored");
});

test("pushes at most once per alert-key per hour", async () => {
  const { store, log } = fakeStore();
  const limiter = new PushLimiter();
  const e = parseGrafanaPayload(firing({ alertname: "A", host: "h" }))[0];
  const other = parseGrafanaPayload(firing({ alertname: "B", host: "h" }))[0];
  const t0 = Date.parse("2026-09-28T12:00:00Z");
  assert.equal((await handleAlert(e, store, limiter, new Date(t0))).pushed, true);
  assert.equal((await handleAlert(e, store, limiter, new Date(t0 + 59 * 60_000))).pushed, false);
  assert.equal((await handleAlert(other, store, limiter, new Date(t0 + 60_000))).pushed, true);
  assert.equal((await handleAlert(e, store, limiter, new Date(t0 + 60 * 60_000))).pushed, true);
  assert.ok(log.includes("push h: Disk almost full /tasks/1"));
});

// shaped like the #513 alert, whose rule sets
// `host: '{{ $labels.hostname }}'` and which arrived with that unrendered.
const incinerator = (labels: Record<string, string>) => ({
  alerts: [
    {
      status: "firing",
      labels: { alertname: "incinerator silent", category: "disk", severity: "warning", ...labels },
      annotations: { summary: "No incinerator log line from {{ .hostname }} for 26h (it logged in the last 7d). Check its timer: ssh {{ $labels.hostname }} systemctl list-timers" },
      values: { A: 4, B: 4, C: 1 },
    },
  ],
});

async function createOne(payload: unknown) {
  const { store, tasks, log } = fakeStore();
  const [e] = parseGrafanaPayload(payload);
  await handleAlert(e, store, new PushLimiter());
  return { e, task: tasks[0], title: log.find((l) => l.startsWith("push "))! };
}

test("host label present: its value names the task, project and key", async () => {
  const { e, task, title } = await createOne(incinerator({ host: "foreman", hostname: "foreman" }));
  assert.equal(e.host, "foreman");
  assert.equal(task.projectSlug, "foreman");
  assert.match(title, /^push foreman: No incinerator log line from foreman for 26h.*ssh foreman systemctl/);
  assert.match(task.description, /alert-key: incinerator silent:foreman$/);
  assert.doesNotMatch(task.description + title, /\{\{/);
});

test("host label is an unrendered template: filled from the hostname label (the #513 payload)", async () => {
  const { e, task, title } = await createOne(incinerator({ host: "{{ .hostname }}", hostname: "foreman" }));
  assert.equal(e.host, "foreman");
  assert.equal(task.projectSlug, "foreman");
  assert.match(title, /^push foreman: No incinerator log line from foreman/);
  assert.doesNotMatch(task.description + title, /\{\{/);
});

test("only a hostname label: used as the host", async () => {
  const { e, task, title } = await createOne(incinerator({ hostname: "sandbox" }));
  assert.equal(e.host, "sandbox");
  assert.equal(task.projectSlug, "sandbox");
  assert.match(title, /^push sandbox: No incinerator log line from sandbox/);
});

test("neither label: alert name titles it, the fallback project owns it, no template syntax left", async () => {
  for (const labels of [{}, { host: "{{ .hostname }}" }, { host: "{{ $labels.hostname }}" }] as Record<string, string>[]) {
    const { e, task, title } = await createOne(incinerator(labels));
    assert.equal(e.host, null);
    assert.equal(e.key, "incinerator silent:unknown");
    assert.equal(task.projectSlug, FALLBACK_PROJECT);
    assert.match(title, /^push incinerator silent: No incinerator log line from unknown for 26h/);
    assert.doesNotMatch(task.description + title, /\{\{/);
  }
});

test("a summary-less alert with no host is titled by its alert name alone", async () => {
  const { store, log } = fakeStore();
  const [e] = parseGrafanaPayload({ alerts: [{ status: "firing", labels: { alertname: "Lonely" } }] });
  await handleAlert(e, store, new PushLimiter());
  assert.ok(log.includes("push Lonely /tasks/1"));
});
