<script setup lang="ts">
// the live transcript, rendered the way Claude Code's own is -
// assistant text as prose, tool calls as one-line rows that expand, thinking
// collapsed. It takes already-folded turns (see chat-transcript.ts) and owns
// nothing but the per-row expand/collapse state.
import { computed, ref } from "vue";
import {
  defaultExpanded,
  formatDuration,
  prettyJson,
  thinkingLabel,
  toolSummary,
  type ToolItem,
  type TranscriptItem,
  type TranscriptTurn,
} from "../chat-transcript.js";
import { renderDescriptionHtml } from "../description-html.js";
import PermissionRequestCard from "./PermissionRequestCard.vue";
import QuestionCard from "./QuestionCard.vue";

const props = defineProps<{
  turns: TranscriptTurn[];
  now: number;
  busyRequestId: string | null;
  decisionsDisabled: boolean;
  /** Pending requests the thread view docks above the compose box - skipped
   *  here so the same card isn't on screen twice. */
  dockedRequestIds?: string[];
}>();

function isDocked(requestId: string): boolean {
  return props.dockedRequestIds?.includes(requestId) ?? false;
}

// A redacted-thinking row has no text to expand, so the chevron would open an
// empty block.
function thinkingExpandable(item: Extract<TranscriptItem, { type: "thinking" }>): boolean {
  return item.text !== "";
}

const emit = defineEmits<{
  (
    event: "decide",
    value: { requestId: string; behavior: "allow" | "deny"; updatedPermissions: unknown[] | null },
  ): void;
  (event: "answer", value: { requestId: string; answers: Record<string, string> }): void;
}>();

// Only rows the operator has actually touched are tracked; everything else
// falls back to defaultExpanded. Keyed by event id, so a row's state survives
// new events arriving above and below it.
const overrides = ref(new Map<string, boolean>());

function isExpanded(item: TranscriptItem): boolean {
  return overrides.value.get(item.key) ?? defaultExpanded(item);
}

function toggle(item: TranscriptItem): void {
  overrides.value = new Map(overrides.value).set(item.key, !isExpanded(item));
}

const toolIcons: Record<string, string> = {
  running: "mdi-circle-outline",
  ok: "mdi-check-circle-outline",
  error: "mdi-alert-circle-outline",
  unknown: "mdi-help-circle-outline",
};

const toolColors: Record<string, string | undefined> = {
  running: undefined,
  ok: "success",
  error: "error",
  unknown: "warning",
};

// A tool row with no `tool_end` is only genuinely still running if its turn
// is. In an abandoned turn (see foldChatEvents) it is a call whose result was
// never recorded, and counting elapsed time up from whenever that was is
// worse than saying so.
function toolState(item: ToolItem, turn: TranscriptTurn): "running" | "ok" | "error" | "unknown" {
  if (item.state !== "running") return item.state;
  return turn.abandoned ? "unknown" : "running";
}

function toolElapsed(item: ToolItem, turn: TranscriptTurn): string {
  if (item.endedAt) return formatDuration(new Date(item.endedAt).getTime() - new Date(item.at).getTime());
  if (turn.abandoned) return "no result";
  return formatDuration(props.now - new Date(item.at).getTime());
}

function turnMeta(turn: TranscriptTurn): string {
  const parts = [`turn ${turn.turn}`];
  const elapsed = turn.startedAt
    ? formatDuration((turn.endedAt ? new Date(turn.endedAt).getTime() : props.now) - new Date(turn.startedAt).getTime())
    : "";
  if (elapsed) parts.push(elapsed);
  if (turn.costUsd !== null) parts.push(`$${turn.costUsd.toFixed(4)}`);
  return parts.join(" · ");
}

// Turn 0 only ever exists when retention trimmed a turn's own `turn_start`
// out from under the rows that followed it - there is no real turn to name.
const numberedTurns = computed(() => props.turns.filter((turn) => turn.turn > 0 || turn.items.length > 0));
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <div v-for="turn in numberedTurns" :key="turn.turn" class="d-flex flex-column ga-2">
      <div v-if="turn.prompt" class="d-flex justify-end">
        <div class="chat-message chat-message--human">
          <div class="text-caption text-medium-emphasis mb-1">You</div>
          <div class="description-html" v-html="renderDescriptionHtml(turn.prompt)" />
        </div>
      </div>

      <template v-for="item in turn.items" :key="item.key">
        <!-- Assistant prose. -->
        <div v-if="item.type === 'text'" class="description-html transcript-text" v-html="renderDescriptionHtml(item.text)" />

        <!-- Extended thinking: collapsed by default, it is background not answer. -->
        <div v-else-if="item.type === 'thinking'" class="transcript-row">
          <button
            type="button"
            class="transcript-head"
            :disabled="!thinkingExpandable(item)"
            @click="toggle(item)"
          >
            <v-icon
              v-if="thinkingExpandable(item)"
              size="small"
              :icon="isExpanded(item) ? 'mdi-chevron-down' : 'mdi-chevron-right'"
            />
            <v-icon size="small" icon="mdi-lightbulb-outline" class="me-1" />
            <span class="text-medium-emphasis">{{ thinkingLabel(item) }}</span>
          </button>
          <pre v-if="thinkingExpandable(item) && isExpanded(item)" class="transcript-detail">{{ item.text }}</pre>
        </div>

        <!-- One tool call. Collapsed shows what Claude Code's own transcript
             shows: the tool, the one thing it acted on, and how long it took. -->
        <div v-else-if="item.type === 'tool'" class="transcript-row">
          <button type="button" class="transcript-head" @click="toggle(item)">
            <v-icon size="small" :icon="isExpanded(item) ? 'mdi-chevron-down' : 'mdi-chevron-right'" />
            <v-icon
              size="small"
              :icon="toolIcons[toolState(item, turn)]"
              :color="toolColors[toolState(item, turn)]"
              :class="toolState(item, turn) === 'running' ? 'transcript-spin me-1' : 'me-1'"
            />
            <span class="transcript-tool-name">{{ item.name }}</span>
            <span class="transcript-tool-summary">{{ toolSummary(item.name, item.input) }}</span>
            <span class="transcript-tool-time text-medium-emphasis">{{ toolElapsed(item, turn) }}</span>
          </button>
          <div v-if="isExpanded(item)" class="transcript-detail-wrap">
            <pre v-if="item.input" class="transcript-detail">{{ prettyJson(item.input) }}</pre>
            <pre v-if="item.preview" class="transcript-detail transcript-detail--output">{{ item.preview }}</pre>
            <p v-else-if="toolState(item, turn) === 'running'" class="text-caption text-medium-emphasis mb-0">Running…</p>
            <p v-else-if="toolState(item, turn) === 'unknown'" class="text-caption text-medium-emphasis mb-0">
              The turn ended before this call's result was recorded.
            </p>
          </div>
        </div>

        <PermissionRequestCard
          v-else-if="item.type === 'permission' && !isDocked(item.request.requestId)"
          :request="item.request"
          :decision="item.decision"
          :now="now"
          :busy="busyRequestId === item.request.requestId"
          :disabled="decisionsDisabled"
          @decide="emit('decide', { requestId: item.request.requestId, ...$event })"
        />

        <QuestionCard
          v-else-if="item.type === 'question' && !isDocked(item.request.requestId)"
          :request="item.request"
          :answer="item.answer"
          :now="now"
          :busy="busyRequestId === item.request.requestId"
          :disabled="decisionsDisabled"
          @answer="emit('answer', { requestId: item.request.requestId, ...$event })"
        />

        <v-alert
          v-else-if="item.type === 'error'"
          :type="item.interrupted ? 'warning' : 'error'"
          density="compact"
          variant="tonal"
        >
          {{ item.message }}
        </v-alert>
      </template>

      <div v-if="turn.endedAt" class="text-caption text-medium-emphasis transcript-meta">
        {{ turnMeta(turn) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-message--human {
  max-width: 75%;
  min-width: 0;
  background: rgba(var(--v-theme-primary), 0.12);
  border-radius: 16px;
  padding: 8px 12px;
}
.transcript-text {
  width: 100%;
}
.transcript-row {
  width: 100%;
  min-width: 0;
}
/* A button rather than a div so the row is reachable by keyboard and gets a
   real tap target on a phone; the Vuetify-default button styling is stripped
   back because this is a list row, not a control. */
.transcript-head {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-height: 32px;
  padding: 2px 4px;
  border-radius: 4px;
  background: none;
  border: none;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.transcript-head:hover:not(:disabled) {
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.transcript-head:disabled {
  cursor: default;
}
.transcript-tool-name {
  font-weight: 600;
  flex: 0 0 auto;
}
.transcript-tool-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8125rem;
  opacity: 0.75;
}
.transcript-tool-time {
  flex: 0 0 auto;
  font-size: 0.75rem;
}
.transcript-detail-wrap {
  padding-left: 24px;
}
.transcript-detail {
  background: rgba(var(--v-theme-on-surface), 0.08);
  border-radius: 4px;
  padding: 8px;
  margin: 4px 0 0;
  max-height: 40vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.8125rem;
}
.transcript-detail--output {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.transcript-meta {
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding-top: 4px;
}
.transcript-spin {
  animation: transcript-spin 1.2s linear infinite;
}
@keyframes transcript-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .transcript-spin {
    animation: none;
  }
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
