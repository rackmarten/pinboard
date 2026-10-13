<script setup lang="ts">
// the PWA half of the live chat session (#146's B3).
//
// Before this, the view polled `/messages` every 5s and detected a permission
// request by prefix-matching the *body text* of an agent message (#136). The
// backend (#147) and foreman's Agent SDK daemon (#148) now produce a real
// transcript - `chat_events` rows arriving over SSE - so the transcript is
// the view, and permission requests are structured events with a requestId
// rather than text to be pattern-matched.
//
// Two things about pinboard's chat bus decide the shape of the plumbing here,
// both learned the hard way in #148:
//
// 1. It is fire-and-forget. Anything published while nothing is subscribed is
//    gone for good. So every (re)connect of the EventSource runs a catch-up
//    sweep from the last event id held, and a slow backstop poll does the
//    same when the stream is down. Without that this would be *less* reliable
//    than the poller it replaces.
// 2. A dropped event logs nothing on either side. So nothing here relies on
//    having seen a particular event: state is always re-derived by folding
//    the whole event list, and the catch-up sweep is what closes any gap.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import {
  closeChatThread,
  getAgents,
  getChatEvents,
  getChatMessages,
  getChatPermissionRules,
  getChatThread,
  getProjects,
  interruptChatThread,
  renameChatThread,
  revokeChatPermissionRule,
  sendChatMessage,
  sendPermissionDecision,
  sendQuestionAnswer,
  type Agent,
  type ChatEvent,
  type ChatMessage,
  type ChatPermissionRule,
  type ChatThread,
  type Project,
  API_BASE,
} from "../api.js";
import {
  foldChatEvents,
  formatDuration,
  legacyMessages as legacyMessagesBefore,
  mergeChatEvents,
} from "../chat-transcript.js";
import { usePolling } from "../composables/usePolling.js";
import { renderDescriptionHtml } from "../description-html.js";
import ChatTranscript from "../components/ChatTranscript.vue";
import PermissionRequestCard from "../components/PermissionRequestCard.vue";
import QuestionCard from "../components/QuestionCard.vue";

const props = defineProps<{ id: string }>();
const router = useRouter();

const thread = ref<ChatThread | null>(null);
const messages = ref<ChatMessage[]>([]);
const events = ref<ChatEvent[]>([]);
const rules = ref<ChatPermissionRule[]>([]);
const projects = ref<Project[]>([]);
const agents = ref<Agent[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const newMessage = ref("");
const sending = ref(false);
const closing = ref(false);
const stopping = ref(false);
const renaming = ref(false);
const editingTitle = ref(false);
const titleDraft = ref("");
const connected = ref(false);
const busyRequestId = ref<string | null>(null);
const revokingRuleId = ref<number | null>(null);
// The optimistic echo of a message that has been accepted by pinboard but
// whose `turn_start` has not come back from foreman yet - otherwise sending
// looks like nothing happened for as long as the daemon takes to pick it up.
const pendingPrompt = ref<string | null>(null);

// One ticking clock for every elapsed/countdown readout on the page, rather
// than a timer per row. Only runs while something is actually in flight.
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

const threadId = computed(() => Number(props.id));

// This component is reused across /chat/:id navigations (the route has no
// key), so an async load started for one thread can resolve after the view
// has already switched to another. Every load captures the generation it
// belongs to and throws its result away if the view has moved on since -
// otherwise thread A's events and header splice themselves into thread B.
let loadGeneration = 0;

// How many rows the events route returns in one page (its own default). A
// full page means there is more behind it.
const EVENTS_PAGE_SIZE = 500;
const transcript = computed(() => foldChatEvents(events.value));
const hasTranscript = computed(() => events.value.length > 0);
const isOpen = computed(() => thread.value?.status === "open");

// A thread that predates #148 has messages and no events; one that straddles
// the cutover has both. Messages older than the first event held are rendered
// as the plain bubbles they were, so the history of an in-flight thread
// doesn't vanish on the day the daemon shipped.
//
// This also covers the long-transcript case for free: the initial load takes
// the newest page of events and catch-up only ever walks *forward*, so on a
// thread with more events than one page the turns below the window have no
// transcript rows here - but their final assistant text is still a
// `chat_messages` row, and it lands above the transcript in the right order.
// A condensed older conversation beats a hole.
const legacyMessages = computed(() => legacyMessagesBefore(messages.value, events.value));

const runningTurn = computed(() => {
  const last = transcript.value.turns.at(-1);
  return last && last.running ? last : null;
});

const turnElapsed = computed(() => {
  const turn = runningTurn.value;
  if (!turn?.startedAt) return "";
  return formatDuration(now.value - new Date(turn.startedAt).getTime());
});

const pendingPermission = computed(() => transcript.value.pending);
const pendingQuestion = computed(() => transcript.value.pendingQuestion);

// The request the dock above the compose box is showing, so the transcript
// skips its own copy while it waits - two identical cards a "Working…" row
// apart read as a duplicate, not as a convenience. Once answered, the dock
// empties and the inline card comes back as history.
const dockedRequestIds = computed(() => {
  if (!isOpen.value) return [];
  return [pendingPermission.value?.request.requestId, pendingQuestion.value?.request.requestId].filter(
    (id): id is string => Boolean(id),
  );
});

function isStale(generation: number, id: number): boolean {
  return generation !== loadGeneration || id !== threadId.value;
}

async function loadAll(): Promise<void> {
  const generation = loadGeneration;
  const id = threadId.value;
  loading.value = true;
  error.value = null;
  try {
    const [loadedThread, loadedMessages, loadedEvents] = await Promise.all([
      getChatThread(id),
      getChatMessages(id),
      // No `since`, so this is the newest page - the live tip. A transcript
      // longer than one page is walked forward by the catch-up sweep the
      // stream's onopen fires immediately after this.
      getChatEvents(id),
    ]);
    if (isStale(generation, id)) return;
    thread.value = loadedThread;
    messages.value = loadedMessages;
    events.value = loadedEvents;
    await loadRules();
  } catch (err) {
    if (isStale(generation, id)) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (!isStale(generation, id)) loading.value = false;
  }
}

async function loadRules(): Promise<void> {
  const generation = loadGeneration;
  const id = threadId.value;
  try {
    const loaded = await getChatPermissionRules(id);
    if (isStale(generation, id)) return;
    rules.value = loaded;
  } catch {
    // The standing-approvals list is a readout, not something the rest of the
    // page depends on - a failure here must not blank the transcript.
  }
}

// The gap-closer. Asks only for what it doesn't have, so the steady-state
// cost of running it on a timer is one indexed query returning nothing.
//
// Sweeps are chained rather than run concurrently, the same way foreman's
// ChatEventBatcher chains its flushes and for the same reason: two in-flight
// requests can resolve out of order, and a stale response overwriting a fresh
// one is worse than being a beat late.
let catchUpTail: Promise<void> = Promise.resolve();

function catchUp(): Promise<void> {
  catchUpTail = catchUpTail.then(runCatchUp);
  return catchUpTail;
}

async function runCatchUp(): Promise<void> {
  const generation = loadGeneration;
  const id = threadId.value;
  try {
    // Walk forward a page at a time. A gap wider than one page is ordinary -
    // a tab left in the background through a long turn, or a stream that was
    // down for a while - and stopping after one page would leave the view
    // stranded mid-transcript with no way to notice.
    for (;;) {
      const fresh = await getChatEvents(id, transcript.value.lastEventId);
      if (isStale(generation, id)) return;
      if (fresh.length === 0) break;
      events.value = mergeChatEvents(events.value, fresh);
      if (fresh.length < EVENTS_PAGE_SIZE) break;
    }
    const updated = await getChatThread(id);
    if (isStale(generation, id)) return;
    thread.value = updated;
  } catch {
    // A transient catch-up failure isn't worth surfacing as a page error;
    // the next tick tries again.
  }
}

let source: EventSource | null = null;

function closeStream(): void {
  source?.close();
  source = null;
  connected.value = false;
}

function openStream(): void {
  closeStream();
  const id = threadId.value;
  const stream = new EventSource(`${API_BASE}/chat/threads/${id}/stream`);
  source = stream;

  stream.addEventListener("chat_event", (event) => {
    const row = JSON.parse((event as MessageEvent).data) as ChatEvent;
    if (row.threadId !== id) return;
    events.value = mergeChatEvents(events.value, [row]);
  });
  // The thread's own totals and status change outside the event stream (the
  // per-turn usage POST, closing the thread).
  stream.addEventListener("thread_updated", () => void catchUp());
  stream.addEventListener("permission_rule", () => void loadRules());
  // Neither of these carries a transcript row of its own that this view can
  // use directly - the interrupt marker is written to `chat_events` but
  // published under its own name, so both are resolved by re-reading.
  stream.addEventListener("interrupt", () => void catchUp());
  stream.addEventListener("permission_decision", () => void catchUp());
  // same shape as a permission decision - published under its own
  // name, so the transcript row it wrote is only visible by re-reading.
  stream.addEventListener("question_answer", () => void catchUp());

  stream.onopen = () => {
    connected.value = true;
    // Fires on the first connect and on every EventSource auto-reconnect,
    // which is exactly when a fire-and-forget bus has been dropping events.
    void catchUp();
  };
  stream.onerror = () => {
    // EventSource reconnects on its own; this only drives the "live" chip and
    // hands the backstop poll something to key off.
    connected.value = false;
  };
}

onMounted(async () => {
  [projects.value, agents.value] = await Promise.all([getProjects(), getAgents()]);
  await loadAll();
  openStream();
  clock = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  closeStream();
  if (clock) clearInterval(clock);
});

watch(threadId, async () => {
  // Invalidates anything still in flight for the thread being left.
  loadGeneration += 1;
  events.value = [];
  messages.value = [];
  rules.value = [];
  pendingPrompt.value = null;
  await loadAll();
  openStream();
});

// Backstop. The stream is the fast path; this is what makes a missed
// notification cost latency rather than the event.
usePolling(() => {
  if (!connected.value) void catchUp();
}, 5_000);

// Clear the optimistic echo once the real turn_start for it has landed.
watch(transcript, (value) => {
  if (pendingPrompt.value !== null && value.turns.at(-1)?.prompt === pendingPrompt.value) pendingPrompt.value = null;
});

// Follow the bottom while reading live, but never yank the page out from
// under someone who has scrolled up to read an earlier tool call.
const stickToBottom = ref(true);

function onScroll(): void {
  const distance = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
  stickToBottom.value = distance < 120;
}

onMounted(() => window.addEventListener("scroll", onScroll, { passive: true }));
onUnmounted(() => window.removeEventListener("scroll", onScroll));

watch(
  () => events.value.length,
  async () => {
    if (!stickToBottom.value) return;
    await nextTick();
    window.scrollTo({ top: document.documentElement.scrollHeight });
  },
);

function projectName(id: number | null): string {
  if (id === null) return "No project";
  return projects.value.find((p) => p.id === id)?.name ?? `#${id}`;
}

function agentName(id: number | null): string {
  if (id === null) return "foreman's planning agent (default)";
  return agents.value.find((a) => a.id === id)?.name ?? `#${id}`;
}

async function submitMessage(): Promise<void> {
  const body = newMessage.value.trim();
  if (!body || !isOpen.value) return;
  sending.value = true;
  error.value = null;
  try {
    const generation = loadGeneration;
    const id = threadId.value;
    const message = await sendChatMessage(id, body);
    if (isStale(generation, id)) return;
    messages.value.push(message);
    pendingPrompt.value = body;
    newMessage.value = "";
    const updated = await getChatThread(id);
    if (isStale(generation, id)) return;
    thread.value = updated;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    sending.value = false;
  }
}

// The reply the session is parked on inside canUseTool, keyed by requestId.
// `updatedPermissions` is whatever the request itself suggested, handed back
// untouched - see PermissionRequestCard for why nothing is constructed here.
async function decide(value: {
  requestId: string;
  behavior: "allow" | "deny";
  updatedPermissions: unknown[] | null;
}): Promise<void> {
  busyRequestId.value = value.requestId;
  error.value = null;
  try {
    await sendPermissionDecision(threadId.value, {
      requestId: value.requestId,
      behavior: value.behavior,
      updatedPermissions: value.updatedPermissions,
    });
    await catchUp();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busyRequestId.value = null;
  }
}

// the operator's picks for an AskUserQuestion call. The session is
// parked inside canUseTool on exactly this, keyed by requestId, and feeds the
// answers into the tool's own input - so nothing is reshaped here beyond what
// QuestionCard already collected.
async function answer(value: { requestId: string; answers: Record<string, string> }): Promise<void> {
  busyRequestId.value = value.requestId;
  error.value = null;
  try {
    await sendQuestionAnswer(threadId.value, { requestId: value.requestId, answers: value.answers });
    await catchUp();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busyRequestId.value = null;
  }
}

async function stop(): Promise<void> {
  stopping.value = true;
  error.value = null;
  try {
    await interruptChatThread(threadId.value);
    await catchUp();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    stopping.value = false;
  }
}

async function revokeRule(rule: ChatPermissionRule): Promise<void> {
  revokingRuleId.value = rule.id;
  error.value = null;
  try {
    await revokeChatPermissionRule(threadId.value, rule.id);
    await loadRules();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    revokingRuleId.value = null;
  }
}

// the only rename affordance in the app - titles are otherwise
// auto-generated from the thread's first message and never editable again.
function startRename(): void {
  if (!thread.value) return;
  titleDraft.value = thread.value.title;
  editingTitle.value = true;
}

async function commitRename(): Promise<void> {
  if (!editingTitle.value) return;
  const title = titleDraft.value.trim();
  if (!title || !thread.value || title === thread.value.title) {
    editingTitle.value = false;
    return;
  }
  renaming.value = true;
  error.value = null;
  try {
    thread.value = await renameChatThread(threadId.value, title);
    editingTitle.value = false;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    renaming.value = false;
  }
}

async function close(): Promise<void> {
  closing.value = true;
  error.value = null;
  try {
    thread.value = await closeChatThread(threadId.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    closing.value = false;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function ruleLabel(rule: ChatPermissionRule): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}

// Enter sends, Shift+Enter inserts a newline - matches Claude/ChatGPT compose
// boxes rather than the meta+enter convention used elsewhere in this app.
function onComposeKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitMessage();
  }
}
</script>

<template>
  <div class="d-flex flex-column ga-4 chat-thread">
    <v-btn
      variant="text"
      prepend-icon="mdi-arrow-left"
      class="align-self-start"
      @click="router.push(thread?.taskId ? `/tasks/${thread.taskId}` : '/chat')"
    >
      {{ thread?.taskId ? "Back to task" : "Back to threads" }}
    </v-btn>

    <v-progress-linear v-if="loading" indeterminate />
    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>

    <template v-if="thread">
      <div class="d-flex align-center ga-2 flex-wrap">
        <template v-if="editingTitle">
          <v-text-field
            v-model="titleDraft"
            density="compact"
            hide-details
            autofocus
            class="mr-auto title-edit"
            :loading="renaming"
            @keydown.enter="commitRename"
            @keydown.esc="editingTitle = false"
            @blur="commitRename"
          />
        </template>
        <template v-else>
          <h1 class="text-h5 mr-auto">
            {{ thread.title }}
            <v-btn icon="mdi-pencil" size="x-small" variant="text" density="comfortable" @click="startRename" />
          </h1>
        </template>
        <v-btn v-if="runningTurn" color="error" variant="flat" prepend-icon="mdi-stop" :loading="stopping" @click="stop">
          Stop
        </v-btn>
        <v-btn v-if="isOpen" variant="tonal" :loading="closing" @click="close">Close thread</v-btn>
      </div>

      <div class="d-flex ga-2 flex-wrap align-center">
        <v-chip size="small" variant="tonal">{{ projectName(thread.projectId) }}</v-chip>
        <v-chip size="small" variant="tonal">agent: {{ agentName(thread.agentId) }}</v-chip>
        <v-chip v-if="thread.model" size="small" variant="tonal">model: {{ thread.model }}</v-chip>
        <v-chip v-if="thread.effort" size="small" variant="tonal">effort: {{ thread.effort }}</v-chip>
        <!-- #145 made these real per turn, so they're worth a permanent spot
             in the header rather than only appearing once money was spent. -->
        <v-chip size="small" variant="tonal">${{ Number(thread.totalCostUsd).toFixed(2) }}</v-chip>
        <v-chip v-if="thread.totalDurationMs > 0" size="small" variant="tonal">
          {{ formatDuration(thread.totalDurationMs) }}
        </v-chip>
        <v-chip size="small" :color="thread.status === 'closed' ? 'grey' : undefined" variant="tonal">
          {{ thread.status }}
        </v-chip>
        <v-chip v-if="thread.taskId" size="small" variant="tonal">session chat for task {{ thread.taskId }}</v-chip>
        <v-chip
          v-if="isOpen"
          size="small"
          variant="tonal"
          :color="connected ? 'success' : 'warning'"
          :prepend-icon="connected ? 'mdi-access-point' : 'mdi-access-point-off'"
        >
          {{ connected ? "live" : "reconnecting" }}
        </v-chip>
      </div>

      <!-- What "don't ask again" has granted. A persisted rule is otherwise
           completely invisible, which is the whole difference from #135's
           per-turn Set that died with the subprocess. -->
      <v-expansion-panels v-if="rules.length" variant="accordion" class="standing-rules">
        <v-expansion-panel elevation="0">
          <v-expansion-panel-title class="text-body-2">
            Standing approvals ({{ rules.length }})
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-list density="compact" class="py-0">
              <v-list-item v-for="rule in rules" :key="rule.id" class="px-0">
                <v-list-item-title class="text-body-2 font-monospace">{{ ruleLabel(rule) }}</v-list-item-title>
                <v-list-item-subtitle class="text-caption">
                  {{ rule.behavior }} · {{ rule.scope === "turn" ? `turn ${rule.turn}` : "this thread" }}
                </v-list-item-subtitle>
                <template #append>
                  <v-btn
                    size="small"
                    variant="text"
                    color="error"
                    :loading="revokingRuleId === rule.id"
                    @click="revokeRule(rule)"
                  >
                    Revoke
                  </v-btn>
                </template>
              </v-list-item>
            </v-list>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>

      <v-divider />

      <!-- Pre-#148 history, plus anything from before the daemon took over
           on a thread that straddles the cutover. -->
      <div v-if="legacyMessages.length" class="d-flex flex-column ga-3">
        <div
          v-for="message in legacyMessages"
          :key="message.id"
          class="d-flex"
          :class="message.role === 'agent' ? 'justify-start' : 'justify-end'"
        >
          <div :class="message.role === 'agent' ? 'chat-message chat-message--agent' : 'chat-message chat-message--human'">
            <div class="d-flex justify-space-between ga-2 text-caption text-medium-emphasis mb-1">
              <span>{{ message.role === "agent" ? "Claude (foreman)" : "You" }}</span>
              <span>{{ formatDate(message.createdAt) }}</span>
            </div>
            <div class="description-html" v-html="renderDescriptionHtml(message.body)" />
          </div>
        </div>
      </div>

      <ChatTranscript
        v-if="hasTranscript"
        :turns="transcript.turns"
        :now="now"
        :busy-request-id="busyRequestId"
        :decisions-disabled="!isOpen"
        :docked-request-ids="dockedRequestIds"
        @decide="decide"
        @answer="answer"
      />

      <p v-if="!hasTranscript && !legacyMessages.length" class="text-medium-emphasis">
        No messages yet - say what you'd like to discuss or decompose.
      </p>

      <!-- The optimistic echo: pinboard has the message, foreman hasn't
           opened the turn for it yet. -->
      <div v-if="pendingPrompt" class="d-flex justify-end">
        <div class="chat-message chat-message--human">
          <div class="text-caption text-medium-emphasis mb-1">You · sending</div>
          <div class="description-html" v-html="renderDescriptionHtml(pendingPrompt)" />
        </div>
      </div>

      <!-- Persistent working indicator: a five-minute answer must never look
           like a hang. Cost only becomes known when the turn's `result`
           arrives, so it's elapsed time that carries this, not $. -->
      <div v-if="runningTurn" class="d-flex align-center ga-3">
        <v-progress-circular indeterminate size="18" width="2" />
        <span class="text-body-2">Working… {{ turnElapsed }}</span>
        <v-btn size="small" color="error" variant="tonal" prepend-icon="mdi-stop" :loading="stopping" @click="stop">
          Stop
        </v-btn>
      </div>
      <v-alert v-else-if="isOpen && thread.awaitingAgent" type="info" density="compact" variant="tonal">
        Waiting for foreman's chat daemon to pick this up.
      </v-alert>

      <!-- The pending request lives here, just above the compose box, rather
           than inline in the transcript (which skips it while it's docked), so
           the buttons are always in thumb reach on a phone without scrolling -
           which is what "usable one-handed" actually costs. -->
      <PermissionRequestCard
        v-if="pendingPermission && isOpen"
        :request="pendingPermission.request"
        :decision="null"
        :now="now"
        :busy="busyRequestId === pendingPermission.request.requestId"
        :disabled="false"
        class="permission-dock"
        @decide="decide({ requestId: pendingPermission.request.requestId, ...$event })"
      />

      <!-- Docked for the same reason as a permission request: a question with
           its options below the fold is a question the operator scrolls past. -->
      <QuestionCard
        v-if="pendingQuestion && isOpen"
        :request="pendingQuestion.request"
        :answer="null"
        :now="now"
        :busy="busyRequestId === pendingQuestion.request.requestId"
        :disabled="false"
        class="permission-dock"
        @answer="answer({ requestId: pendingQuestion.request.requestId, ...$event })"
      />

      <div v-if="isOpen" class="d-flex ga-2">
        <v-textarea
          v-model="newMessage"
          label="Message"
          rows="2"
          density="comfortable"
          auto-grow
          @keydown="onComposeKeydown"
        />
        <v-btn icon="mdi-send" :loading="sending" @click="submitMessage" />
      </div>
      <p v-else class="text-medium-emphasis">This thread is closed.</p>
    </template>
  </div>
</template>

<style scoped>
.chat-thread {
  min-width: 0;
}
.title-edit {
  max-width: 480px;
}
.chat-message {
  min-width: 0;
}
.chat-message--human {
  max-width: 75%;
  background: rgba(var(--v-theme-primary), 0.12);
  border-radius: 16px;
  padding: 8px 12px;
}
.chat-message--agent {
  width: 100%;
}
.font-monospace {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.standing-rules {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 4px;
}
/* Sticks to the bottom of the viewport so an escalated tool call can be
   answered without scrolling, including through an auth proxy on a laptop
   where the transcript may be long. */
.permission-dock {
  position: sticky;
  bottom: 8px;
  z-index: 2;
}
.description-html :deep(p) {
  margin: 0 0 0.5em;
}
.description-html :deep(p:last-child) {
  margin-bottom: 0;
}
.description-html :deep(ul),
.description-html :deep(ol) {
  margin: 0 0 0.5em;
  padding-left: 1.5em;
}
.description-html :deep(blockquote) {
  margin: 0 0 0.5em;
  padding-left: 0.75em;
  border-left: 3px solid rgba(var(--v-border-color), var(--v-border-opacity));
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.description-html :deep(code) {
  background: rgba(var(--v-theme-on-surface), 0.08);
  border-radius: 4px;
  padding: 0 4px;
}
.description-html :deep(pre) {
  background: rgba(var(--v-theme-on-surface), 0.08);
  border-radius: 4px;
  padding: 8px;
  overflow-x: auto;
}
.description-html :deep(pre code) {
  background: none;
  padding: 0;
}
</style>
