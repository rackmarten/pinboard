// Grafana alert webhook. Each alert becomes (or updates) one open
// task keyed by `alert-key: <alertname>:<host>` in its description, and a web
// push. Parsing and the firing/resolved decisions are pure over an injected
// store, so they're unit tested without Postgres; the db wiring is at the
// bottom, same split as push.ts.

import { and, eq, like, notInArray, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "./db/client.js";
import { comments, labels, projects, taskLabels, tasks } from "./db/schema.js";
import { recordEvent as recordJournalEvent } from "./journal.js";
import { pushNotification } from "./push.js";
import { projectKeywords, taskKeywords } from "./keywords.js";

export interface AlertEvent {
  status: "firing" | "resolved";
  alertname: string;
  host: string | null;
  category: string | null;
  summary: string;
  description: string;
  values: Record<string, unknown>;
  key: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// a rule can hand us template syntax Grafana didn't render (the
// incinerator rule's `host: '{{ $labels.hostname }}'` arrived as a literal
// `{{ .hostname }}`, and the task's repo became that). Fill `{{ .x }}` and
// `{{ $labels.x }}` from the alert's own labels; anything still templated is
// unknown.
const TEMPLATE = /\{\{\s*(?:\$labels)?\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
export function renderLabels(s: string, labels: Record<string, unknown>, missing = "unknown"): string {
  return s.replace(TEMPLATE, (_, k: string) => str(labels[k]) ?? missing).replace(/\{\{[^}]*\}\}/g, missing);
}

// The host is a project slug and a repo directory, so only a plain name is
// accepted. `host` wins (the alert rules' own label), then
// `hostname` (Loki's label, which those rules copy into `host`).
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function alertHost(labels: Record<string, unknown>): string | null {
  for (const k of ["host", "hostname"]) {
    const v = str(labels[k]);
    const h = v && renderLabels(v, labels, "");
    if (h && HOST_RE.test(h)) return h;
  }
  return null;
}

// Grafana's webhook contact point: { alerts: [{ status, labels, annotations,
// values, ... }] }. An alert with no alertname can't be keyed, so it's
// skipped rather than guessed at.
export function parseGrafanaPayload(body: unknown): AlertEvent[] {
  const alerts = (body as { alerts?: unknown } | null)?.alerts;
  if (!Array.isArray(alerts)) return [];
  const out: AlertEvent[] = [];
  for (const a of alerts) {
    const labelsIn = (a?.labels ?? {}) as Record<string, unknown>;
    const ann = (a?.annotations ?? {}) as Record<string, unknown>;
    const alertname = str(labelsIn.alertname);
    if (!alertname) continue;
    const host = alertHost(labelsIn);
    const text = (v: unknown) => {
      const t = str(v);
      return t && str(renderLabels(t, labelsIn));
    };
    const values = a?.values && typeof a.values === "object" ? (a.values as Record<string, unknown>) : {};
    out.push({
      status: a?.status === "resolved" ? "resolved" : "firing",
      alertname,
      host,
      category: str(labelsIn.category),
      summary: text(ann.summary) ?? alertname,
      description: text(ann.description) ?? "",
      values,
      key: `${alertname}:${host ?? "unknown"}`,
    });
  }
  return out;
}

// Alerts with no usable host (or whose host project can't be made) land in
// the project that owns the alert rules.
// Set ALERTS_FALLBACK_PROJECT and ALERTS_REPO_ORG to match your monitoring repo and GitHub org.
export const FALLBACK_PROJECT = process.env.ALERTS_FALLBACK_PROJECT || "monitoring";
const ALERTS_REPO_ORG = process.env.ALERTS_REPO_ORG ?? "";
export const PUSH_INTERVAL_MS = 60 * 60 * 1000;
// Categories with a playbook in buildDescription; the task gets the category as a label.
const PLAYBOOK_LABELS = new Set(["disk", "service", "backup"]);

export function formatValues(values: Record<string, unknown>): string {
  const entries = Object.entries(values);
  return entries.length ? entries.map(([k, v]) => `${k}=${String(v)}`).join(", ") : "(none)";
}

export function buildDescription(e: AlertEvent): string {
  const host = e.host ?? "<host>";
  const lines = [
    `Grafana alert **${e.alertname}** is firing on \`${host}\`.`,
    "",
    e.summary,
    ...(e.description ? ["", e.description] : []),
    "",
    `Values: ${formatValues(e.values)}`,
  ];
  if (e.category === "disk") {
    lines.push(
      "",
      "## What to do",
      `1. \`ssh ${host}\`.`,
      "2. If `incinerator` is installed, run `sudo incinerator --pressure --verbose`.",
      "3. Find the largest consumers: `du -xh --max-depth=2 /` and `docker system df`.",
      `4. Fix what is safe within ${host}'s own repo conventions (its AGENTS.md).`,
      "5. **Never** delete named docker volumes or service state under `/app`.",
      `6. If the disk really needs to grow, create a separate task with the \`root-access\` label and rootScope=<ctid of ${host} from homelab/lan-plan.tsv>, asking for \`work root grow <ctid> <GB>\` (max 4 GB per call), and say why in the handoff.`,
    );
  } else if (e.category === "service") {
    lines.push(
      "",
      "## What to do",
      `1. \`ssh ${host}\`, \`cd /app\` (read that repo's AGENTS.md first).`,
      "2. `docker compose ps -a`: look for services that are Exited/Created, not only the one restarting; a crash loop is often a dependency (db, broker) that is down. Then `docker compose logs --tail 50 <service>`.",
      "3. If a dependency simply isn't running, `docker compose up -d` and confirm `./scripts/healthcheck.sh` passes.",
      `4. If the service itself fails, fix it in ${host}'s repo following its conventions and deploy with \`homelab/scripts/deploy-service.sh ${host}\`.`,
      "5. **Never** run `docker compose down -v`, and never delete named volumes or state under `/app`.",
      "6. In the handoff, say what stopped it and whether that cause can recur.",
    );
  } else if (e.category === "backup") {
    lines.push(
      "",
      "## What to do",
      `1. \`ssh ${host}\`, \`sudo journalctl -u kopia-backup.service -n 100\` (or \`journalctl\` without sudo if allowed).`,
      "2. Common cause: the service's own pre-snapshot dump (`/app/scripts/backup-dump.sh`) fails because its db is down, so check `docker compose ps -a` in `/app` first and treat that as a service outage.",
      "3. Once the cause is fixed, run the backup: `sudo systemctl start kopia-backup.service`. If sudo is unavailable, say so in the handoff; the nightly timer will retry.",
      "4. The alert resolves once keep's kopia-freshness sidecar sees a fresh snapshot (it checks about every hour).",
    );
  }
  lines.push("", `alert-key: ${e.key}`);
  return lines.join("\n");
}

// At most one push per alert-key per hour. In memory: a restart can let one
// extra push through, which is fine for a phone notification.
export class PushLimiter {
  private last = new Map<string, number>();
  constructor(private intervalMs = PUSH_INTERVAL_MS) {}
  allow(key: string, now: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.intervalMs) return false;
    this.last.set(key, now);
    return true;
  }
}

export interface AlertTask {
  id: number;
  status: string;
}

export interface AlertStore {
  findOpenTask(key: string): Promise<AlertTask | null>;
  // Returns the project id for this slug, creating it if missing; null if
  // it could neither be found nor created.
  ensureProject(slug: string): Promise<number | null>;
  createTask(t: { projectId: number; title: string; description: string; labels: string[] }): Promise<AlertTask>;
  addComment(taskId: number, body: string): Promise<void>;
  setStatus(taskId: number, status: string): Promise<void>;
  push(n: { taskId: number; title: string; body: string; url: string }): Promise<void>;
}

export interface AlertResult {
  key: string;
  status: AlertEvent["status"];
  taskId: number | null;
  action: "created" | "commented" | "resolved" | "closed" | "ignored";
  pushed: boolean;
}

export function alertTitle(e: AlertEvent): string {
  if (e.host) return `${e.host}: ${e.summary}`;
  return e.summary === e.alertname ? e.alertname : `${e.alertname}: ${e.summary}`;
}

export async function handleAlert(e: AlertEvent, store: AlertStore, limiter: PushLimiter, now = new Date()): Promise<AlertResult> {
  const existing = await store.findOpenTask(e.key);
  if (e.status === "resolved") {
    if (!existing) return { key: e.key, status: e.status, taskId: null, action: "ignored", pushed: false };
    await store.addComment(existing.id, `resolved at ${now.toISOString()}`);
    // Never claimed: nobody needs to act any more. A claimed task keeps
    // going; the agent can see the comment.
    if (existing.status === "queued") {
      await store.setStatus(existing.id, "done");
      return { key: e.key, status: e.status, taskId: existing.id, action: "closed", pushed: false };
    }
    return { key: e.key, status: e.status, taskId: existing.id, action: "resolved", pushed: false };
  }

  let taskId: number;
  let action: AlertResult["action"];
  if (existing) {
    await store.addComment(existing.id, `still firing at ${now.toISOString()}: ${e.summary}\nValues: ${formatValues(e.values)}`);
    taskId = existing.id;
    action = "commented";
  } else {
    const projectId = (e.host ? await store.ensureProject(e.host) : null) ?? (await store.ensureProject(FALLBACK_PROJECT));
    if (projectId == null) throw new Error(`no project for alert ${e.key}`);
    const task = await store.createTask({
      projectId,
      title: alertTitle(e),
      description: buildDescription(e),
      labels: e.category && PLAYBOOK_LABELS.has(e.category) ? [e.category] : [],
    });
    taskId = task.id;
    action = "created";
  }
  let pushed = false;
  if (limiter.allow(e.key, now.getTime())) {
    await store.push({ taskId, title: alertTitle(e), body: formatValues(e.values), url: `/tasks/${taskId}` });
    pushed = true;
  }
  return { key: e.key, status: e.status, taskId, action, pushed };
}

// --- db wiring ---

const OPEN_EXCLUDED = ["done", "rejected"];
const ACTOR = { actorType: "system", actorName: "grafana" };

export const dbAlertStore: AlertStore = {
  async findOpenTask(key) {
    // The key line ends at a newline or the end of the description, so
    // "Disk:sandbox" doesn't also match "Disk:sandbox2".
    const pattern = `%alert-key: ${key.replace(/[\\%_]/g, "\\$&")}`;
    const [row] = await db
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(and(or(like(tasks.description, `${pattern}`), like(tasks.description, `${pattern}\n%`)), notInArray(tasks.status, OPEN_EXCLUDED)))
      .limit(1);
    return row ?? null;
  },
  async ensureProject(slug) {
    const [found] = await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug));
    if (found) return found.id;
    try {
      const [p] = await db
        .insert(projects)
        .values({ slug, name: slug, localPath: ALERTS_REPO_ORG ? `${ALERTS_REPO_ORG}/${slug}` : slug, keywords: projectKeywords({ name: slug }) })
        .returning({ id: projects.id });
      await recordJournalEvent({ projectId: p.id, eventType: "project_created", ...ACTOR, payload: { slug } });
      return p.id;
    } catch {
      return null;
    }
  },
  async createTask(t) {
    const [task] = await db
      .insert(tasks)
      .values({
        projectId: t.projectId,
        title: t.title,
        description: t.description,
        keywords: taskKeywords(t),
        taskType: "maintenance",
        status: "queued",
        executorMode: "agent",
        priority: 10,
        autonomyLevel: 3,
        estimatedEffort: 2,
      })
      .returning({ id: tasks.id, status: tasks.status });
    await recordJournalEvent({ taskId: task.id, eventType: "created", ...ACTOR, payload: { status: task.status } });
    for (const name of t.labels) {
      const [label] = await db.insert(labels).values({ name }).onConflictDoUpdate({ target: labels.name, set: { name } }).returning({ id: labels.id });
      await db.insert(taskLabels).values({ taskId: task.id, labelId: label.id }).onConflictDoNothing();
    }
    return task;
  },
  async addComment(taskId, body) {
    const [c] = await db.insert(comments).values({ taskId, authorType: "system", authorName: "grafana", body }).returning({ id: comments.id });
    await recordJournalEvent({ taskId, eventType: "comment", ...ACTOR, payload: { commentId: c.id } });
  },
  async setStatus(taskId, status) {
    await db.update(tasks).set({ status, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    await recordJournalEvent({ taskId, eventType: "status", ...ACTOR, payload: { from: "queued", to: status, reason: "alert resolved" } });
  },
  async push(n) {
    const sent = await pushNotification({ id: n.taskId, kind: "alert", title: n.title, body: n.body, url: n.url });
    console.log(`alert push for task ${n.taskId}: ${sent ? "published to ntfy" : "not published (unconfigured or failed)"}`);
  },
};

export const alertPushLimiter = new PushLimiter();

// POST /api/alerts/grafana - Grafana's webhook contact point on the
// monitoring host. No auth beyond tailnet/LAN trust, like the rest of the API.
export async function registerAlertRoutes(app: FastifyInstance): Promise<void> {
  app.post("/alerts/grafana", async (req) => {
    const results: AlertResult[] = [];
    for (const e of parseGrafanaPayload(req.body)) {
      const r = await handleAlert(e, dbAlertStore, alertPushLimiter);
      req.log.info(r, "grafana alert");
      results.push(r);
    }
    return { results };
  });
}
