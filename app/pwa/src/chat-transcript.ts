// the pure half of the live chat transcript - turning the flat
// `chat_events` stream into the grouped, Claude-Code-shaped structure the
// view renders. Deliberately free of Vue and of `fetch`, the same split
// app/src/chat-events.ts uses on the server side, so the mapping can be
// exercised without mounting anything.
//
// The producer side of this contract is foreman's `chat-session.ts`
// (`translateSdkMessage`) and `chat-permissions.ts` (`createCanUseTool`);
// pinboard's own `POST /chat/threads/:id/permission-decision` and
// `POST .../interrupt` write two further rows directly. A past task learned
// the hard way that a consumer and producer disagreeing about a field name
// fails silently on both sides, so every payload field read here is named
// after the line that writes it, not guessed.

export interface ChatEvent {
  id: number;
  threadId: number;
  turn: number;
  seq: number;
  kind: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface PermissionRequest {
  requestId: string;
  toolUseId: string | null;
  toolName: string;
  input: unknown;
  reason: string | null;
  // The Agent SDK's own PermissionUpdate[], carried verbatim. Handed straight
  // back on a "don't ask again" - never rebuilt here, since foreman feeds it
  // directly into the SDK and a rule this app invented would grant something
  // the SDK never offered.
  suggestions: unknown[];
  title: string | null;
  description: string | null;
  displayName: string | null;
  decisionReason: string | null;
  blockedPath: string | null;
  // Set by the SDK when the rule a "don't ask again" would write grants more
  // than the call being approved. The button must be hidden, not merely
  // disabled - this is the one field in the payload that is a correctness
  // requirement rather than a display detail.
  suppressAlwaysAllowRule: boolean;
  turn: number | null;
  expiresAt: string | null;
}

// an AskUserQuestion call, rendered as option cards instead of
// failing and making the agent retype its questions as prose. The shape is
// foreman's `chat-permissions.ts` `normalizeQuestions` output, which is in
// turn the SDK's own AskUserQuestion schema - so the model keeps writing
// well-formed questions and nothing here has to invent structure.
export interface QuestionOption {
  label: string;
  description: string;
  /** Mockups, code snippets or layout sketches the option is compared by.
   *  Rendered as markdown in a monospace block, same as Claude Code's own. */
  preview: string | null;
}

export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface QuestionRequest {
  requestId: string;
  toolUseId: string | null;
  questions: Question[];
  turn: number | null;
  expiresAt: string | null;
}

export interface QuestionAnswer {
  /** False for the timeout case: the session allowed the call through with no
   *  answers and the agent carried on, which is not the same as a refusal. */
  answered: boolean;
  answers: Record<string, string>;
  reason: string | null;
}

export interface PermissionDecision {
  behavior: "allow" | "deny";
  message: string | null;
  remembered: boolean;
}

interface ItemBase {
  key: string;
  eventId: number;
  at: string;
}

export type TranscriptItem =
  | (ItemBase & { type: "text"; text: string })
  // `text` is empty and `estimatedTokens` set during the API's
  // redacted-thinking phase, where there is no thinking text to show at all -
  // only the SDK's running token estimate.
  | (ItemBase & { type: "thinking"; text: string; estimatedTokens: number | null })
  | (ItemBase & {
      type: "tool";
      toolUseId: string | null;
      name: string;
      input: unknown;
      state: "running" | "ok" | "error";
      preview: string | null;
      endedAt: string | null;
    })
  | (ItemBase & { type: "permission"; request: PermissionRequest; decision: PermissionDecision | null })
  | (ItemBase & { type: "question"; request: QuestionRequest; answer: QuestionAnswer | null })
  | (ItemBase & { type: "error"; message: string; interrupted: boolean });

export type ToolItem = Extract<TranscriptItem, { type: "tool" }>;
export type PermissionItem = Extract<TranscriptItem, { type: "permission" }>;
export type QuestionItem = Extract<TranscriptItem, { type: "question" }>;
export type ThinkingItem = Extract<TranscriptItem, { type: "thinking" }>;

export interface TranscriptTurn {
  turn: number;
  /** The operator message that opened the turn, from `turn_start`. */
  prompt: string | null;
  items: TranscriptItem[];
  startedAt: string | null;
  endedAt: string | null;
  costUsd: number | null;
  durationMs: number | null;
  isError: boolean;
  running: boolean;
  /**
   * Started, never ended, and a later turn has since begun - so it did not
   * finish and never will. Real: thread #31's turn 5 is one, left behind by a
   * daemon restart mid-turn. Without this, its unfinished tool row would spin
   * forever with an elapsed time counting up from last week.
   */
  abandoned: boolean;
}

export interface Transcript {
  turns: TranscriptTurn[];
  /** Highest event id folded, i.e. what to pass as `?since=` next. */
  lastEventId: number;
  /** The permission request still waiting on the operator, if any. */
  pending: PermissionItem | null;
  /** The question still waiting on the operator, if any. */
  pendingQuestion: QuestionItem | null;
  /** A turn has started and not ended - the working indicator and Stop button. */
  running: boolean;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readPermissionRequest(payload: Record<string, unknown>): PermissionRequest {
  return {
    requestId: str(payload.requestId) ?? "",
    toolUseId: str(payload.toolUseId),
    toolName: str(payload.toolName) ?? "unknown tool",
    input: payload.input ?? null,
    reason: str(payload.reason),
    suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : [],
    title: str(payload.title),
    description: str(payload.description),
    displayName: str(payload.displayName),
    decisionReason: str(payload.decisionReason),
    blockedPath: str(payload.blockedPath),
    // Defaults to false only when the field is genuinely absent (an older
    // event, or a producer that predates it). Anything truthy hides the
    // button - erring towards hiding it is the safe direction here.
    suppressAlwaysAllowRule: payload.suppressAlwaysAllowRule === true,
    turn: num(payload.turn),
    expiresAt: str(payload.expiresAt),
  };
}

export function readQuestionRequest(payload: Record<string, unknown>): QuestionRequest {
  const rawQuestions = Array.isArray(payload.questions) ? payload.questions : [];
  const questions: Question[] = [];
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== "object") continue;
    const q = raw as Record<string, unknown>;
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options: QuestionOption[] = [];
    for (const rawOption of rawOptions) {
      if (!rawOption || typeof rawOption !== "object") continue;
      const o = rawOption as Record<string, unknown>;
      const label = str(o.label);
      if (label === null) continue;
      options.push({ label, description: str(o.description) ?? "", preview: str(o.preview) });
    }
    if (options.length === 0) continue;
    questions.push({
      question: str(q.question) ?? "",
      header: str(q.header) ?? "",
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return {
    requestId: str(payload.requestId) ?? "",
    toolUseId: str(payload.toolUseId),
    questions,
    turn: num(payload.turn),
    expiresAt: str(payload.expiresAt),
  };
}

// Written by two producers, like permission_decision: foreman emits
// {requestId, turn, answered, answers?|reason?} and pinboard's own
// question-answer route inserts {requestId, answers, annotations, answered}.
export function readQuestionAnswer(payload: Record<string, unknown>): QuestionAnswer {
  const raw = payload.answers;
  const answers: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [question, answer] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof answer === "string" && answer.length > 0) answers[question] = answer;
    }
  }
  return {
    answered: payload.answered !== false && Object.keys(answers).length > 0,
    answers,
    reason: str(payload.reason),
  };
}

// `permission_decision` is written by two different producers with two
// different payloads, which is easy to miss: foreman emits
// {requestId, toolName, behavior, reason?, remembered?, forgotten?, turn}
// as part of its event stream, while pinboard's own permission-decision
// route inserts the normalized operator answer
// {requestId, behavior, updatedPermissions, message}. Both are read here.
export function readPermissionDecision(payload: Record<string, unknown>): PermissionDecision {
  const updated = Array.isArray(payload.updatedPermissions) ? payload.updatedPermissions : [];
  return {
    behavior: payload.behavior === "deny" ? "deny" : "allow",
    message: str(payload.message) ?? str(payload.reason),
    remembered: payload.remembered === true || updated.length > 0,
  };
}

/**
 * Fold the flat event list into turns.
 *
 * Two ordering facts this relies on: rows arrive in `id` order (both the
 * `?since=` replay and the SSE stream are id-ordered), and `turn` is a label
 * rather than a sort key. pinboard's own inserts - the operator's
 * permission-decision row and the interrupt marker - carry no turn at all
 * and land as turn 0, so they are attached to the turn in progress rather
 * than opening a bogus group of their own.
 */
export function foldChatEvents(events: ChatEvent[]): Transcript {
  const turns: TranscriptTurn[] = [];
  const byTurn = new Map<number, TranscriptTurn>();
  const toolsByUseId = new Map<string, ToolItem>();
  const permsByRequestId = new Map<string, PermissionItem>();
  const questionsByRequestId = new Map<string, QuestionItem>();
  let lastEventId = 0;
  let currentTurn = 0;

  function turnFor(n: number): TranscriptTurn {
    const existing = byTurn.get(n);
    if (existing) return existing;
    const created: TranscriptTurn = {
      turn: n,
      prompt: null,
      items: [],
      startedAt: null,
      endedAt: null,
      costUsd: null,
      durationMs: null,
      isError: false,
      running: false,
      abandoned: false,
    };
    byTurn.set(n, created);
    turns.push(created);
    return created;
  }

  for (const event of events) {
    if (event.id > lastEventId) lastEventId = event.id;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.turn > currentTurn) currentTurn = event.turn;
    const turn = turnFor(event.turn > 0 ? event.turn : currentTurn);
    const base = { key: `e${event.id}`, eventId: event.id, at: event.createdAt };

    switch (event.kind) {
      case "turn_start": {
        turn.prompt = str(payload.text);
        turn.startedAt = event.createdAt;
        turn.running = true;
        break;
      }
      case "text_delta":
      case "thinking": {
        const type = event.kind === "thinking" ? "thinking" : "text";
        const text = typeof payload.text === "string" ? payload.text : "";
        if (text === "") {
          // a thinking event with no text is the redacted-thinking
          // phase, where the API streams only progress. One row that counts
          // up, not one row per report - and nothing at all for the blank
          // events recorded before foreman stopped emitting them.
          const tokens = num(payload.estimatedTokens);
          if (type !== "thinking" || tokens === null) break;
          const previous = turn.items.at(-1);
          if (previous && previous.type === "thinking" && previous.text === "") previous.estimatedTokens = tokens;
          else turn.items.push({ ...base, type: "thinking", text: "", estimatedTokens: tokens });
          break;
        }
        // foreman merges consecutive deltas inside one batch; across batches
        // they arrive as separate rows, so they are merged again here rather
        // than rendering one paragraph as twenty <p> blocks.
        const last = turn.items.at(-1);
        // Only into a row that already holds text: a progress row means
        // something different and has nothing to append to.
        if (last && last.type === type && (last.type !== "thinking" || last.text !== "")) last.text += text;
        else if (type === "thinking") turn.items.push({ ...base, type, text, estimatedTokens: null });
        else turn.items.push({ ...base, type, text });
        break;
      }
      case "tool_start": {
        const item: ToolItem = {
          ...base,
          type: "tool",
          toolUseId: str(payload.toolUseId),
          name: str(payload.name) ?? "tool",
          input: payload.input ?? null,
          state: "running",
          preview: null,
          endedAt: null,
        };
        turn.items.push(item);
        if (item.toolUseId) toolsByUseId.set(item.toolUseId, item);
        break;
      }
      case "tool_end": {
        const toolUseId = str(payload.toolUseId);
        const state = payload.isError === true ? "error" : "ok";
        const preview = typeof payload.preview === "string" ? payload.preview : null;
        const started = toolUseId ? toolsByUseId.get(toolUseId) : undefined;
        if (started) {
          started.state = state;
          started.preview = preview;
          started.endedAt = event.createdAt;
          break;
        }
        // Retention can trim a `tool_start` out from under its own
        // `tool_end` on a very long turn. Showing the result alone beats
        // dropping it.
        turn.items.push({
          ...base,
          type: "tool",
          toolUseId,
          name: "tool",
          input: null,
          state,
          preview,
          endedAt: event.createdAt,
        });
        break;
      }
      case "permission_request": {
        const request = readPermissionRequest(payload);
        const item: PermissionItem = { ...base, type: "permission", request, decision: null };
        turn.items.push(item);
        if (request.requestId) permsByRequestId.set(request.requestId, item);
        break;
      }
      case "permission_decision": {
        const requestId = str(payload.requestId);
        const decision = readPermissionDecision(payload);
        const request = requestId ? permsByRequestId.get(requestId) : undefined;
        if (request) {
          // Both producers write one of these per request; whichever lands
          // first resolves the card, and the second only fills in detail the
          // first lacked (foreman's carries `remembered`, pinboard's the
          // operator's own message).
          request.decision = {
            behavior: decision.behavior,
            message: decision.message ?? request.decision?.message ?? null,
            remembered: decision.remembered || (request.decision?.remembered ?? false),
          };
          break;
        }
        turn.items.push({
          ...base,
          type: "permission",
          request: readPermissionRequest({ requestId: requestId ?? "", toolName: payload.toolName }),
          decision,
        });
        break;
      }
      case "question": {
        const request = readQuestionRequest(payload);
        const item: QuestionItem = { ...base, type: "question", request, answer: null };
        turn.items.push(item);
        if (request.requestId) questionsByRequestId.set(request.requestId, item);
        break;
      }
      case "question_answer": {
        const requestId = str(payload.requestId);
        const answer = readQuestionAnswer(payload);
        const asked = requestId ? questionsByRequestId.get(requestId) : undefined;
        if (asked) {
          // Both producers write one of these per question; whichever lands
          // first resolves the card, and a later one only fills in what the
          // first lacked - foreman's timeout notice carries a `reason` and no
          // answers, pinboard's route carries the answers themselves.
          asked.answer = {
            answered: answer.answered || (asked.answer?.answered ?? false),
            answers: Object.keys(answer.answers).length > 0 ? answer.answers : (asked.answer?.answers ?? {}),
            reason: answer.reason ?? asked.answer?.reason ?? null,
          };
          break;
        }
        // Retention can trim a `question` out from under its own answer on a
        // long turn; showing what was answered beats dropping it.
        turn.items.push({
          ...base,
          type: "question",
          request: readQuestionRequest({ requestId: requestId ?? "" }),
          answer,
        });
        break;
      }
      case "cost": {
        turn.costUsd = num(payload.costUsd);
        turn.durationMs = num(payload.durationMs);
        break;
      }
      case "turn_end": {
        turn.endedAt = event.createdAt;
        turn.running = false;
        turn.isError = payload.isError === true;
        break;
      }
      case "error": {
        const interrupted = payload.interrupted === true;
        turn.items.push({
          ...base,
          type: "error",
          interrupted,
          message: interrupted
            ? `Stopped by ${str(payload.by) ?? "the operator"}`
            : (str(payload.message) ?? str(payload.subtype) ?? "Unknown error"),
        });
        // An interrupt ends the turn as far as the operator is concerned;
        // the SDK may or may not still emit a `turn_end` behind it.
        if (interrupted) turn.running = false;
        break;
      }
      default:
        // An unrecognised kind is dropped rather than rendered raw. The set
        // is expected to grow (see chat-events.ts's EVENT_KINDS note), and a
        // JSON blob in the transcript is worse than a gap.
        break;
    }
  }

  // Only the newest turn can still be in progress: a later `turn_start` is
  // proof that whatever came before it is over, whether or not its own
  // `turn_end` ever arrived.
  const last = turns.at(-1);
  for (const turn of turns) {
    if (turn === last || !turn.running) continue;
    turn.running = false;
    turn.abandoned = true;
  }

  // A request in an older turn has no session parked on it any more, so it is
  // history rather than something to answer. The live one, if there is one,
  // is always in the turn in progress.
  let pending: PermissionItem | null = null;
  let pendingQuestion: QuestionItem | null = null;
  for (const item of last?.items ?? []) {
    if (item.type === "permission" && item.decision === null && item.request.requestId) pending = item;
    if (item.type === "question" && item.answer === null && item.request.requestId && item.request.questions.length > 0) {
      pendingQuestion = item;
    }
  }

  return { turns, lastEventId, pending, pendingQuestion, running: last?.running ?? false };
}

/**
 * Add freshly-arrived events to the ones already held, keeping id order and
 * dropping duplicates.
 *
 * Duplicates are routine rather than exceptional: every SSE (re)connect
 * triggers a catch-up sweep, because pinboard's chat bus is fire-and-forget
 * and anything published while nothing was subscribed is simply gone. That
 * sweep overlaps whatever the stream already delivered.
 */
export function mergeChatEvents(existing: ChatEvent[], incoming: ChatEvent[]): ChatEvent[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<number, ChatEvent>();
  for (const event of existing) byId.set(event.id, event);
  let changed = false;
  for (const event of incoming) {
    if (byId.has(event.id)) continue;
    byId.set(event.id, event);
    changed = true;
  }
  if (!changed) return existing;
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * The `chat_messages` rows to render as plain bubbles above the transcript -
 * a pre-#148 thread's history, or the part of a long one below the events
 * window.
 *
 * The cutoff is the first event held, minus the human message that opened
 * that turn: pinboard stores the message a few hundred ms before foreman
 * writes its `turn_start`, so a plain timestamp cut rendered every thread's
 * first prompt twice - once as a bubble, once as the turn's own prompt.
 */
export function legacyMessages<M extends { role: string; body: string; createdAt: string }>(
  messages: M[],
  events: ChatEvent[],
): M[] {
  const first = events[0];
  if (!first) return messages;
  const older = messages.filter((message) => message.createdAt < first.createdAt);
  const prompt = first.kind === "turn_start" ? str(first.payload?.text) : null;
  if (prompt === null) return older;
  for (let index = older.length - 1; index >= 0; index -= 1) {
    const message = older[index];
    if (message.role === "human" && message.body.trim() === prompt.trim()) {
      return older.filter((_, i) => i !== index);
    }
  }
  return older;
}

/**
 * Whether a row starts out expanded.
 *
 * Everything the model "did" is collapsed by default - the transcript is
 * read on a phone, and twenty expanded tool calls is a page of JSON between
 * the operator and the answer. A failed tool call is the exception: it is
 * the one row that is usually the reason for reading the transcript at all.
 */
export function defaultExpanded(item: TranscriptItem): boolean {
  if (item.type === "tool") return item.state === "error";
  if (item.type === "thinking") return false;
  return true;
}

/** The label a thinking row shows when there is no thinking text to show -
 *  the redacted-thinking case. */
export function thinkingLabel(item: ThinkingItem): string {
  if (item.text !== "") return "Thinking";
  if (item.estimatedTokens === null) return "Thinking…";
  const tokens = item.estimatedTokens;
  const rounded = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  return `Thinking… ~${rounded} tokens`;
}

const MAX_SUMMARY_CHARS = 160;

function clamp(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_SUMMARY_CHARS ? `${oneLine.slice(0, MAX_SUMMARY_CHARS)}…` : oneLine;
}

/**
 * The one line a collapsed tool row shows next to the tool name - the same
 * "what did it actually do" that Claude Code's own transcript shows, rather
 * than the full input object.
 */
export function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
  };

  switch (name) {
    case "Bash":
      return clamp(pick("command") ?? "");
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return clamp(pick("file_path", "notebook_path") ?? "");
    case "Grep":
    case "Glob":
      return clamp([pick("pattern"), pick("path")].filter(Boolean).join("  "));
    case "WebFetch":
    case "WebSearch":
      return clamp(pick("url", "query") ?? "");
    case "Task":
      return clamp(pick("description") ?? "");
    case "TodoWrite":
      return Array.isArray(fields.todos) ? `${fields.todos.length} items` : "";
    default: {
      const first = pick("command", "file_path", "pattern", "url", "query", "description", "prompt");
      if (first) return clamp(first);
      const serialised = JSON.stringify(input);
      return serialised === undefined ? "" : clamp(serialised);
    }
  }
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

export function prettyJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
