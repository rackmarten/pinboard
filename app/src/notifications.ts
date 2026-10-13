// which journal events need the operator's attention, and how the
// notification for one reads. Pure - no db, no Fastify - so the rules can be
// unit tested without a Postgres, the same split session-windows.ts uses.
//
// The rule of thumb: notify when something happened that the operator did
// not just do themselves and would otherwise have to go looking for. A
// human's own action (actorType "human") never notifies - they already know.

export const NOTIFICATION_KINDS = ["failure", "review", "approval", "question", "completed"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface JournalEventForNotification {
  eventType: string;
  actorType: string;
  actorName: string;
  taskId: number | null;
  payload: Record<string, unknown> | null;
}

export interface TaskForNotification {
  id: number;
  title: string;
}

export interface NotificationDraft {
  kind: NotificationKind;
  title: string;
  body: string | null;
  url: string | null;
}

const REPAIR_LABELS: Record<string, string> = {
  ci_failed: "CI failed",
  merge_conflict: "merge conflict",
  deploy_failed: "deploy failed",
};

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function deriveNotification(
  event: JournalEventForNotification,
  task: TaskForNotification | null,
): NotificationDraft | null {
  if (event.actorType === "human") return null;
  const p = event.payload ?? {};
  const ref = task ? `#${task.id} ${task.title}` : "";
  const taskUrl = task ? `/tasks/${task.id}` : null;

  switch (event.eventType) {
    case "status": {
      const to = str(p.to);
      if (!task) return null;
      // parked on an unanswered question; the thread is where the operator answers.
      if (to === "needs_input") return { kind: "question", title: `Agent needs input: #${task.id}`, body: str(p.reason) ?? null, url: typeof p.threadId === "number" ? `/chat/${p.threadId}` : taskUrl };
      if (to === "rework") return { kind: "failure", title: `Needs rework: ${ref}`, body: str(p.reason) ?? null, url: taskUrl };
      if (to === "review") return { kind: "review", title: `Ready for review: ${ref}`, body: null, url: taskUrl };
      if (to === "done") return { kind: "completed", title: `Done: ${ref}`, body: null, url: taskUrl };
      return null;
    }
    case "pipeline": {
      if (!task) return null;
      const to = str(p.to);
      const repair = str(p.repairReason);
      if (repair) {
        return {
          kind: "failure",
          title: `${REPAIR_LABELS[repair] ?? repair}: ${ref}`,
          // a human+agent task is parked for its human, not handed
          // to another agent.
          body: to === "rework" ? "Parked for you to fix; requeue it to resume with the evidence." : "Handed back to an agent to fix.",
          url: taskUrl,
        };
      }
      // parked on an unanswered question; the thread is where the operator answers.
      if (to === "needs_input") return { kind: "question", title: `Agent needs input: #${task.id}`, body: str(p.reason) ?? null, url: typeof p.threadId === "number" ? `/chat/${p.threadId}` : taskUrl };
      if (to === "awaiting_review") return { kind: "approval", title: `Waiting for approval: ${ref}`, body: "Approve & merge from the review queue.", url: "/review" };
      if (to === "review") return { kind: "review", title: `Ready for review: ${ref}`, body: null, url: taskUrl };
      return null;
    }
    case "handoff":
      if (!task) return null;
      return { kind: "completed", title: `Agent finished: ${ref}`, body: `Handoff from ${event.actorName}.`, url: taskUrl };
    case "complete":
      if (!task) return null;
      return { kind: "completed", title: `Done: ${ref}`, body: null, url: taskUrl };
    case "deploy": {
      // A past task. A deploy inside a task's pipeline already notifies through
      // that task's own pipeline events, so only a deploy with no task (a
      // Deploy-now click, or a script run) speaks for itself here.
      if (event.taskId !== null) return null;
      const where = `${str(p.repo) ?? "?"}${p.app ? `/${str(p.app)}` : ""} on ${str(p.host) ?? "?"}`;
      if (p.outcome === "failed") return { kind: "failure", title: `Deploy failed: ${where}`, body: null, url: "/releases" };
      if (typeof p.requestId === "number") return { kind: "completed", title: `Deployed ${where}`, body: null, url: "/releases" };
      return null;
    }
    case "backup": {
      // scripts/backup.sh's nightly dump. Success is routine and
      // stays in the journal; a failure is exactly what went unnoticed before.
      if (p.outcome !== "failed") return null;
      return { kind: "failure", title: "Pinboard backup failed", body: str(p.detail) ?? null, url: null };
    }
    case "health": {
      // a dependency foreman watches (an LLM gateway, a seat's claude
      // login, the workdir disk). The reporter dedups, so each event is a
      // transition: one entry when it starts failing, one when it recovers.
      const check = str(p.check) ?? "?";
      if (p.status === "failing") return { kind: "failure", title: `${event.actorName}: ${check} is failing`, body: str(p.detail) ?? null, url: null };
      if (p.status === "recovered") return { kind: "completed", title: `${event.actorName}: ${check} recovered`, body: str(p.detail) ?? null, url: null };
      return null;
    }
    case "chat_permission_request": {
      const threadId = p.threadId;
      const tool = str(p.toolName);
      return {
        kind: "approval",
        title: `Permission requested${tool ? `: ${tool}` : ""}`,
        body: str(p.threadTitle) ?? null,
        url: typeof threadId === "number" ? `/chat/${threadId}` : null,
      };
    }
    case "ask": {
      // a structured question from a run; the question itself is the body.
      if (!task || p.kind !== "question") return null;
      return {
        kind: "question",
        title: `Question on ${ref}`,
        body: str(p.question) ?? null,
        url: typeof p.threadId === "number" ? `/chat/${p.threadId}` : taskUrl,
      };
    }
    case "chat_question": {
      const threadId = p.threadId;
      return {
        kind: "question",
        title: task ? `Question on ${ref}` : "Agent is asking a question",
        body: str(p.preview) ?? null,
        url: typeof threadId === "number" ? `/chat/${threadId}` : taskUrl,
      };
    }
    default:
      return null;
  }
}
