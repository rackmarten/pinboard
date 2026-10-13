// the pure half of the live-chat transcript - validating and
// normalising what foreman posts, and deciding what retention has to drop.
// Everything here is deliberately free of db/Fastify so it can be unit
// tested without a Postgres, the same split session-windows.ts already uses
// against plan.ts.

// Emitted by foreman's Agent SDK daemon as it reads the SDK's
// message stream:
//   turn_start / turn_end    a turn's boundaries, so a reload mid-turn can
//                            tell "still running" from "finished"
//   text_delta               a chunk of assistant text as it streams
//   thinking                 extended-thinking text
//   tool_start / tool_end    a tool call and its result/error
//   permission_request       a canUseTool escalation reached the operator
//   permission_decision      what the operator answered, and what rule (if
//                            any) that created
//   question / question_answer
//                            an AskUserQuestion call's option
//                            cards, and the operator's picks. Not a
//                            permission_request - the session is not deciding
//                            whether a tool may run, it is waiting for the
//                            tool's own answer, and a question the operator
//                            ignores is allowed through rather than denied
//   cost                     a running cost tick, so spend is visible before
//                            the turn ends rather than only after
//   error                    anything the daemon caught and wants on the
//                            transcript instead of only in journalctl
export const EVENT_KINDS = [
  "turn_start",
  "turn_end",
  "text_delta",
  "thinking",
  "tool_start",
  "tool_end",
  "permission_request",
  "permission_decision",
  "question",
  "question_answer",
  "cost",
  "error",
] as const;

export type ChatEventKind = (typeof EVENT_KINDS)[number];

export interface IncomingChatEvent {
  kind: string;
  payload?: unknown;
  turn?: number;
  seq?: number;
}

export interface NormalizedChatEvent {
  kind: ChatEventKind;
  payload: unknown;
  turn: number;
  seq: number;
}

// How many events one thread keeps. Sized so a long working turn (hundreds
// of text deltas plus its tool calls) is kept whole several turns back,
// while a runaway turn can't grow the table without bound. Trimmed inside
// the same request that inserts, so the bound holds without a scheduler -
// an age-based nightly sweep would let a single pathological turn balloon
// the table for up to a day before catching it.
export const EVENTS_PER_THREAD_CAP = 2000;

// A batch POST is rejected outright past this, rather than silently
// truncated: foreman batches its own deltas, so a batch this large means
// something is wrong on that side and swallowing it would hide it.
export const MAX_EVENTS_PER_BATCH = 500;

// One event's payload, serialised. A stray multi-megabyte tool result
// (a whole file read, a screenshot) would otherwise land in jsonb and be
// replayed to every SSE subscriber on every reconnect. Truncated rather
// than rejected - a clipped tool result still tells the operator what
// happened, where a 400 would lose the event entirely.
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export class ChatEventError extends Error {}

export function isChatEventKind(value: unknown): value is ChatEventKind {
  return EVENT_KINDS.includes(value as ChatEventKind);
}

// Truncation keeps the shape recognisable: an object payload keeps its
// other keys and gets a `truncated` marker, so the PWA can render "…"
// rather than having to guess why a tool result looks short.
export function truncatePayload(payload: unknown, maxBytes = MAX_PAYLOAD_BYTES): unknown {
  if (payload === undefined || payload === null) return payload ?? null;
  const serialised = JSON.stringify(payload);
  if (serialised === undefined || Buffer.byteLength(serialised, "utf8") <= maxBytes) return payload;

  if (typeof payload === "string") {
    return `${payload.slice(0, maxBytes)}… [truncated by pinboard]`;
  }
  if (typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const out: Record<string, unknown> = { truncated: true };
    for (const [key, value] of Object.entries(record)) {
      const encoded = JSON.stringify(value);
      out[key] =
        typeof value === "string" && Buffer.byteLength(value, "utf8") > maxBytes / 2
          ? `${value.slice(0, Math.floor(maxBytes / 2))}… [truncated by pinboard]`
          : encoded !== undefined && Buffer.byteLength(encoded, "utf8") > maxBytes
            ? "[truncated by pinboard]"
            : value;
    }
    return out;
  }
  return { truncated: true, note: "[payload too large, dropped by pinboard]" };
}

// `turn`/`seq` are foreman's to assign - it knows the turn it is in and the
// order it read events off the SDK stream. Both are optional so a caller
// posting a single one-off event (an `error` from a failure path, say)
// doesn't have to invent them; seq then falls back to the event's index in
// the batch, which preserves the order it was sent in.
export function normalizeEventBatch(raw: unknown): NormalizedChatEvent[] {
  const events = Array.isArray(raw) ? raw : (raw as { events?: unknown })?.events;
  if (!Array.isArray(events)) throw new ChatEventError("events must be an array");
  if (events.length === 0) throw new ChatEventError("events must not be empty");
  if (events.length > MAX_EVENTS_PER_BATCH) {
    throw new ChatEventError(`at most ${MAX_EVENTS_PER_BATCH} events per batch (got ${events.length})`);
  }

  return events.map((entry, index) => {
    const event = entry as IncomingChatEvent;
    if (!event || typeof event !== "object") throw new ChatEventError(`events[${index}] must be an object`);
    if (!isChatEventKind(event.kind)) {
      throw new ChatEventError(`events[${index}].kind must be one of: ${EVENT_KINDS.join(", ")}`);
    }
    const turn = event.turn === undefined ? 0 : Number(event.turn);
    if (!Number.isInteger(turn) || turn < 0) throw new ChatEventError(`events[${index}].turn must be a non-negative integer`);
    const seq = event.seq === undefined ? index : Number(event.seq);
    if (!Number.isInteger(seq) || seq < 0) throw new ChatEventError(`events[${index}].seq must be a non-negative integer`);

    return { kind: event.kind, payload: truncatePayload(event.payload ?? null), turn, seq };
  });
}

export const RULE_BEHAVIORS = ["allow", "deny", "ask"] as const;
export const RULE_SCOPES = ["thread", "turn"] as const;

export interface NormalizedPermissionRule {
  toolName: string;
  ruleContent: string | null;
  behavior: (typeof RULE_BEHAVIORS)[number];
  scope: (typeof RULE_SCOPES)[number];
  turn: number | null;
}

export function normalizePermissionRule(raw: unknown): NormalizedPermissionRule {
  const body = (raw ?? {}) as Record<string, unknown>;
  const toolName = typeof body.toolName === "string" ? body.toolName.trim() : "";
  if (!toolName) throw new ChatEventError("toolName is required");
  const behavior = body.behavior as NormalizedPermissionRule["behavior"];
  if (!RULE_BEHAVIORS.includes(behavior)) {
    throw new ChatEventError(`behavior must be one of: ${RULE_BEHAVIORS.join(", ")}`);
  }
  const scope = (body.scope ?? "thread") as NormalizedPermissionRule["scope"];
  if (!RULE_SCOPES.includes(scope)) {
    throw new ChatEventError(`scope must be one of: ${RULE_SCOPES.join(", ")}`);
  }
  // A turn-scoped rule that doesn't say which turn would apply forever,
  // which is exactly the opposite of what asking for "turn" meant.
  if (scope === "turn" && (body.turn === undefined || body.turn === null)) {
    throw new ChatEventError("turn is required when scope is 'turn'");
  }
  const turn = body.turn === undefined || body.turn === null ? null : Number(body.turn);
  if (turn !== null && (!Number.isInteger(turn) || turn < 0)) {
    throw new ChatEventError("turn must be a non-negative integer");
  }
  const ruleContent = typeof body.ruleContent === "string" && body.ruleContent.length > 0 ? body.ruleContent : null;
  return { toolName, ruleContent, behavior, scope, turn };
}

export interface StoredPermissionRule {
  toolName: string;
  ruleContent: string | null;
  behavior: string;
  scope: string;
  turn: number | null;
  revokedAt?: Date | null;
}

// Which stored rules still apply for a given turn. A thread-scoped rule
// always does; a turn-scoped one only within the turn it was granted in.
// Revoked rules never do, regardless of scope.
export function activeRulesForTurn<T extends StoredPermissionRule>(rules: T[], turn: number | null): T[] {
  return rules.filter((rule) => {
    if (rule.revokedAt) return false;
    if (rule.scope !== "turn") return true;
    return turn !== null && rule.turn === turn;
  });
}

// The Agent SDK's own `PermissionUpdate` shape (see its PermissionRuleValue/
// PermissionUpdate types) - grouped by behavior because one update carries
// many rules but exactly one behavior. `destination: "session"` because
// these rules belong to the live session foreman is holding, not to a
// settings file on that LXC: pinboard is the durable store here, and
// writing them into ~/.claude would put a second, invisible authority on
// what the operator has approved.
export function toPermissionUpdates(rules: StoredPermissionRule[]): {
  type: "addRules";
  rules: { toolName: string; ruleContent?: string }[];
  behavior: string;
  destination: "session";
}[] {
  const byBehavior = new Map<string, { toolName: string; ruleContent?: string }[]>();
  for (const rule of rules) {
    const list = byBehavior.get(rule.behavior) ?? [];
    list.push(rule.ruleContent === null ? { toolName: rule.toolName } : { toolName: rule.toolName, ruleContent: rule.ruleContent });
    byBehavior.set(rule.behavior, list);
  }
  return [...byBehavior.entries()].map(([behavior, ruleValues]) => ({
    type: "addRules" as const,
    rules: ruleValues,
    behavior,
    destination: "session" as const,
  }));
}

// SSE wire format (https://html.spec.whatwg.org/multipage/server-sent-events.html):
// every line of the data payload needs its own `data:` prefix, and a blank
// line terminates the event. JSON.stringify never emits a raw newline, so
// this is one data line in practice - the split is kept anyway so a future
// non-JSON payload can't silently produce a malformed frame.
export function formatSseFrame(event: string, data: unknown, id?: number | string): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  for (const line of JSON.stringify(data ?? null).split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

export const DECISION_BEHAVIORS = ["allow", "deny"] as const;

export interface NormalizedPermissionDecision {
  requestId: string;
  behavior: (typeof DECISION_BEHAVIORS)[number];
  // The Agent SDK's own PermissionUpdate[], passed through untouched -
  // normally the request's own `suggestions` array handed straight back.
  // pinboard does not construct or validate the inside of these: the SDK
  // owns that shape, and a schema guess here would reject a legitimate
  // update the day the SDK grows a new one.
  updatedPermissions: unknown[] | null;
  message: string | null;
}

// The operator's answer to a `permission_request`. Separate from a chat
// message because a live session is blocked inside canUseTool waiting for
// exactly this, keyed by requestId - matching on "the most recent human
// message after the question", the way permission-server.ts had to, cannot
// tell two concurrent requests apart and cannot carry a rule at all.
export function normalizePermissionDecision(raw: unknown): NormalizedPermissionDecision {
  const body = (raw ?? {}) as Record<string, unknown>;
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!requestId) throw new ChatEventError("requestId is required");
  const behavior = body.behavior as NormalizedPermissionDecision["behavior"];
  if (!DECISION_BEHAVIORS.includes(behavior)) {
    throw new ChatEventError(`behavior must be one of: ${DECISION_BEHAVIORS.join(", ")}`);
  }
  if (body.updatedPermissions !== undefined && body.updatedPermissions !== null && !Array.isArray(body.updatedPermissions)) {
    throw new ChatEventError("updatedPermissions must be an array of Agent SDK PermissionUpdate objects");
  }
  return {
    requestId,
    behavior,
    updatedPermissions: (body.updatedPermissions as unknown[] | undefined) ?? null,
    message: typeof body.message === "string" && body.message.length > 0 ? body.message : null,
  };
}

// the operator's picks for an AskUserQuestion call. Same shape of
// route as a permission decision and for the same reason - a live session is
// parked inside canUseTool keyed by requestId - but a different payload: what
// comes back is fed into the tool's own `answers` input, so it is validated
// as a plain string map here rather than passed through opaquely.
//
// `answers` is keyed by the question's own text, which is the key the SDK's
// AskUserQuestion schema uses. A multi-select answer is the chosen labels
// joined with a comma; an "Other" answer is the free text the operator typed.
export interface NormalizedQuestionAnswer {
  requestId: string;
  answers: Record<string, string>;
  annotations: Record<string, { preview?: string; notes?: string }> | null;
}

export function normalizeQuestionAnswer(raw: unknown): NormalizedQuestionAnswer {
  const body = (raw ?? {}) as Record<string, unknown>;
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!requestId) throw new ChatEventError("requestId is required");
  if (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) {
    throw new ChatEventError("answers must be an object of question -> answer");
  }
  const answers: Record<string, string> = {};
  for (const [question, answer] of Object.entries(body.answers as Record<string, unknown>)) {
    // Rejected rather than coerced: whatever lands here is handed to the
    // model as the operator's own words, and String(someObject) would reach
    // it as "[object Object]".
    if (typeof answer !== "string") throw new ChatEventError(`answers[${JSON.stringify(question)}] must be a string`);
    if (answer.length === 0) continue;
    answers[question] = answer;
  }
  // An empty map is the same nothing a missed question produces, except the
  // session would stop waiting for a real reply - so it is an error, not an
  // answer.
  if (Object.keys(answers).length === 0) throw new ChatEventError("answers must contain at least one answer");

  let annotations: NormalizedQuestionAnswer["annotations"] = null;
  if (body.annotations && typeof body.annotations === "object" && !Array.isArray(body.annotations)) {
    const out: Record<string, { preview?: string; notes?: string }> = {};
    for (const [question, entry] of Object.entries(body.annotations as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const { preview, notes } = entry as { preview?: unknown; notes?: unknown };
      const cleaned = {
        ...(typeof preview === "string" && preview.length > 0 ? { preview } : {}),
        ...(typeof notes === "string" && notes.length > 0 ? { notes } : {}),
      };
      if (Object.keys(cleaned).length > 0) out[question] = cleaned;
    }
    if (Object.keys(out).length > 0) annotations = out;
  }

  return { requestId, answers, annotations };
}

// Which bus events foreman's whole-firehose subscription receives: the
// things a live session cannot observe from inside itself. Its own
// transcript events (`chat_event`) are deliberately excluded - it wrote
// them, and echoing them back would double every delta it just sent.
//
// `permission_decision` is the one a session is actually *blocked* on.
// Omitting it, as the first version of this list did, leaves every escalated
// tool call parked until its 30-minute fail-closed deadline, with the
// operator's answer sitting in the database the whole time and nothing
// logging a reason - found live on 2026-09-17, on the first denial ever sent
// through this path. Anything added here later should be weighed the same
// way: does a session need it to make progress?
export const FOREMAN_STREAM_EVENTS = [
  "human_message",
  "permission_decision",
  // A past task. Left out, an AskUserQuestion call would park until its
  // 30-minute deadline with the answer already in the database - the exact
  // failure `permission_decision` had on the day this list was written.
  "question_answer",
  "permission_rule",
  "interrupt",
  "thread_updated",
] as const;

export function isForemanStreamEvent(event: string): boolean {
  return (FOREMAN_STREAM_EVENTS as readonly string[]).includes(event);
}
