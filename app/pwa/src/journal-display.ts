import type { JournalEvent, NotificationKind } from "./api.js";

// how a journal row reads in a timeline. Kept free of Vue so the
// wording lives in one place for every timeline (global, project, task).

function s(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
}

function list(v: unknown): string {
  return Array.isArray(v) ? v.join(", ") : "";
}

export function describeEvent(e: JournalEvent): string {
  const p = e.payload ?? {};
  switch (e.eventType) {
    case "created":
      return `created the task (${s(p.status)})`;
    case "status":
      return `changed status ${s(p.from)} → ${s(p.to)}${p.reason ? ` (${s(p.reason)})` : ""}`;
    case "updated":
      return `edited ${list(p.fields) || "the task"}`;
    case "pipeline":
      return `pipeline ${s(p.from)} → ${s(p.to)}${p.repairReason ? ` (${s(p.repairReason)})` : ""}`;
    case "claim":
      return "claimed the task";
    case "handoff":
      return "handed off";
    case "complete":
      return "marked it done";
    case "reject":
      return "sent it back to rework";
    case "comment":
      return "commented";
    case "control_requested":
      return `requested ${s(p.action)}`;
    case "relation_added":
      return `linked #${s(p.toTaskId)} as ${s(p.relationType)}`;
    case "relation_removed":
      return "removed a relation";
    case "label_added":
      return "added a label";
    case "label_removed":
      return "removed a label";
    case "project_created":
      return `created project ${s(p.slug)}`;
    case "project_updated":
      return `edited project ${list(p.fields)}`.trim();
    case "chat_thread_created":
      return `started chat “${s(p.title)}”`;
    case "chat_question":
      return "asked a question in chat";
    case "chat_permission_request":
      return `requested permission${p.toolName ? ` for ${s(p.toolName)}` : ""}`;
    case "chat_permission_decision":
      return `answered a permission request (${s(p.decision)})`;
    case "config_changed":
      return `${s(p.method)} ${s(p.route)}`;
    case "activity":
      return "session activity";
    case "deploy":
      return `deployed ${s(p.repo)}${p.app ? `/${s(p.app)}` : ""} to ${s(p.host)}${p.sha ? ` @ ${s(p.sha).slice(0, 7)}` : ""}${p.outcome === "failed" ? " — failed" : ""}`;
    case "deploy_requested":
      return `requested a deploy (#${s(p.requestId)})`;
    default:
      return e.eventType;
  }
}

export function actorIcon(actorType: string): string {
  if (actorType === "human") return "mdi-account";
  if (actorType === "agent") return "mdi-robot-outline";
  return "mdi-cog-outline";
}

const KIND_ICONS: Record<NotificationKind, string> = {
  failure: "mdi-alert-circle-outline",
  review: "mdi-clipboard-check-outline",
  approval: "mdi-hand-back-right-outline",
  question: "mdi-help-circle-outline",
  completed: "mdi-check-circle-outline",
};

const KIND_COLORS: Record<NotificationKind, string> = {
  failure: "error",
  review: "info",
  approval: "warning",
  question: "warning",
  completed: "success",
};

export function notificationIcon(kind: NotificationKind): string {
  return KIND_ICONS[kind] ?? "mdi-bell-outline";
}

export function notificationColor(kind: NotificationKind): string {
  return KIND_COLORS[kind] ?? "primary";
}

export function relativeTime(iso: string, now = Date.now()): string {
  const secs = Math.round((now - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
