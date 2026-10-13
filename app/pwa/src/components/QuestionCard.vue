<script setup lang="ts">
// an AskUserQuestion call rendered as tappable option cards.
//
// Before this, the tool did not work in a chat session at all - it returned
// "The user did not answer the questions" because there was no UI on
// foreman's side for it to reach the operator through, and the agent's
// fallback was to retype every question as prose (thread #32, 2026-09-17,
// two turns and $0.84 largely spent working around it).
//
// Two things about the shape are the SDK's, not this component's, and must
// stay that way: `multiSelect` decides whether options are radio or
// checkbox, and every question offers a free-text "Other" because the tool's
// own schema promises the operator one. The answer is keyed by the question's
// own text - that is the key AskUserQuestion's `answers` field uses, and
// foreman feeds it straight back into the tool's input.
import { computed, ref } from "vue";
import type { QuestionAnswer, QuestionRequest } from "../chat-transcript.js";

const props = defineProps<{
  request: QuestionRequest;
  answer: QuestionAnswer | null;
  /** Ticking clock from the parent, so the expiry countdown is live. */
  now: number;
  busy: boolean;
  disabled: boolean;
}>();

const emit = defineEmits<{
  (event: "answer", value: { answers: Record<string, string> }): void;
}>();

// Keyed by question text throughout, so what is collected is already the
// shape the tool wants and nothing has to be re-keyed on submit.
const picks = ref<Record<string, string[]>>({});
const otherText = ref<Record<string, string>>({});

const OTHER = "__other__";

function selected(question: string): string[] {
  return picks.value[question] ?? [];
}

function toggle(question: string, label: string, multiSelect: boolean): void {
  const current = selected(question);
  if (!multiSelect) {
    picks.value = { ...picks.value, [question]: current[0] === label ? [] : [label] };
    return;
  }
  const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
  picks.value = { ...picks.value, [question]: next };
}

function answerFor(question: string): string {
  const chosen = selected(question).filter((label) => label !== OTHER);
  const other = (otherText.value[question] ?? "").trim();
  // "Comma-separated" is the SDK's own wording for a multi-select answer.
  return [...chosen, ...(other ? [other] : [])].join(", ");
}

const collected = computed(() => {
  const out: Record<string, string> = {};
  for (const q of props.request.questions) {
    const value = answerFor(q.question);
    if (value) out[q.question] = value;
  }
  return out;
});

// Every question, or none: a half-answered set hands the model a map with
// holes in it, and it cannot tell "no opinion" from "not asked".
const complete = computed(
  () => props.request.questions.length > 0 && Object.keys(collected.value).length === props.request.questions.length,
);

const expiresInMs = computed(() => {
  if (!props.request.expiresAt) return null;
  return new Date(props.request.expiresAt).getTime() - props.now;
});

// Unlike a permission request, running out of time here is not a refusal:
// the session allows the call through with no answers, the tool reports that
// nobody answered, and the agent carries on. Decided up front on the task - a
// question the operator misses must never strand a turn.
const expired = computed(() => expiresInMs.value !== null && expiresInMs.value <= 0);

const expiresLabel = computed(() => {
  const ms = expiresInMs.value;
  if (ms === null || ms <= 0) return "";
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return minutes > 0 ? `${minutes}m ${seconds}s left` : `${seconds}s left`;
});

const actionable = computed(() => props.answer === null && !expired.value && !props.disabled);
</script>

<template>
  <v-card
    :color="answer ? undefined : 'info'"
    :variant="answer ? 'outlined' : 'tonal'"
    density="compact"
    class="question-card"
  >
    <v-card-item class="pb-2">
      <template #prepend>
        <v-icon :icon="answer === null ? 'mdi-comment-question-outline' : 'mdi-comment-check-outline'" />
      </template>
      <v-card-title class="text-subtitle-2">
        {{ answer === null ? "The agent is asking" : "You answered" }}
      </v-card-title>
    </v-card-item>

    <v-card-text class="pt-0 d-flex flex-column ga-4">
      <div v-for="q in request.questions" :key="q.question">
        <div class="d-flex align-center ga-2 mb-1">
          <v-chip v-if="q.header" size="x-small" label>{{ q.header }}</v-chip>
          <span class="text-body-2 font-weight-medium">{{ q.question }}</span>
        </div>

        <template v-if="actionable">
          <div class="d-flex flex-column ga-1">
            <button
              v-for="option in q.options"
              :key="option.label"
              type="button"
              class="question-option"
              :class="{ 'question-option--on': selected(q.question).includes(option.label) }"
              @click="toggle(q.question, option.label, q.multiSelect)"
            >
              <v-icon
                size="small"
                :icon="
                  q.multiSelect
                    ? selected(q.question).includes(option.label)
                      ? 'mdi-checkbox-marked'
                      : 'mdi-checkbox-blank-outline'
                    : selected(q.question).includes(option.label)
                      ? 'mdi-radiobox-marked'
                      : 'mdi-radiobox-blank'
                "
              />
              <span class="question-option-body">
                <span class="text-body-2 font-weight-medium">{{ option.label }}</span>
                <span v-if="option.description" class="text-caption text-medium-emphasis d-block">
                  {{ option.description }}
                </span>
                <!-- Previews are mockups and code snippets: monospace and
                     pre-wrapped, the way Claude Code renders them. -->
                <pre v-if="option.preview" class="question-preview">{{ option.preview }}</pre>
              </span>
            </button>
          </div>
          <v-text-field
            v-model="otherText[q.question]"
            label="Other"
            placeholder="Type your own answer"
            density="compact"
            variant="outlined"
            hide-details
            class="mt-2"
          />
        </template>

        <template v-else>
          <p class="text-body-2 mb-0">
            <template v-if="answer?.answers[q.question]">{{ answer.answers[q.question] }}</template>
            <span v-else class="text-medium-emphasis">Not answered</span>
          </p>
        </template>
      </div>
    </v-card-text>

    <v-card-actions v-if="actionable" class="flex-wrap ga-2 px-4 pb-4 pt-0">
      <v-btn
        color="primary"
        variant="flat"
        :loading="busy"
        :disabled="!complete"
        prepend-icon="mdi-send"
        @click="emit('answer', { answers: collected })"
      >
        Send answers
      </v-btn>
      <span v-if="!complete" class="text-caption text-medium-emphasis">Answer every question first</span>
      <span v-if="expiresLabel" class="text-caption text-medium-emphasis ms-auto">{{ expiresLabel }}</span>
    </v-card-actions>

    <v-card-text v-else-if="answer === null" class="pt-0 text-caption text-medium-emphasis">
      <template v-if="expired">No reply in time - the agent carried on without an answer.</template>
      <template v-else>This thread is closed.</template>
    </v-card-text>

    <v-card-text v-else-if="!answer.answered && answer.reason" class="pt-0 text-caption text-medium-emphasis">
      {{ answer.reason }}
    </v-card-text>
  </v-card>
</template>

<style scoped>
.question-card {
  width: 100%;
}
/* A button, not a div, so each option is a real tap target and reachable by
   keyboard - the same reasoning as ChatTranscript's tool rows. */
.question-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  background: none;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.question-option:hover {
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.question-option--on {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.1);
}
.question-option-body {
  flex: 1 1 auto;
  min-width: 0;
}
.question-preview {
  background: rgba(var(--v-theme-on-surface), 0.08);
  border-radius: 4px;
  padding: 8px;
  margin: 6px 0 0;
  max-height: 30vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.75rem;
}
</style>
