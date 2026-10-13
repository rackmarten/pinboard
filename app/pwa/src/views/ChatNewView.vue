<script setup lang="ts">
// the compose step for a brand new chat thread. Settings
// (project/agent/model/effort) were already chosen on ChatListView and
// arrive here as query params - nothing is persisted yet. The thread row
// is only created, atomically with its first message, once the user
// actually sends something; navigating away before that leaves no trace.
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  createChatThread,
  getAgents,
  getProjects,
  sendChatMessage,
  type Agent,
  type Project,
} from "../api.js";

const route = useRoute();
const router = useRouter();

const projects = ref<Project[]>([]);
const agents = ref<Agent[]>([]);
const newMessage = ref("");
const sending = ref(false);
const error = ref<string | null>(null);

const projectId = computed(() => {
  const raw = route.query.projectId;
  return typeof raw === "string" ? Number(raw) : null;
});
const agentId = computed(() => {
  const raw = route.query.agentId;
  return typeof raw === "string" ? Number(raw) : null;
});
const model = computed(() => (typeof route.query.model === "string" ? route.query.model : null));
const effort = computed(() => (typeof route.query.effort === "string" ? route.query.effort : null));

onMounted(async () => {
  [projects.value, agents.value] = await Promise.all([getProjects(), getAgents()]);
});

function projectName(id: number | null): string {
  if (id === null) return "No project";
  return projects.value.find((p) => p.id === id)?.name ?? `#${id}`;
}

function agentName(id: number | null): string {
  if (id === null) return "foreman's planning agent (default)";
  return agents.value.find((a) => a.id === id)?.name ?? `#${id}`;
}

// Reasonable length for a list row / browser tab title - long enough to be
// recognizable, short enough not to wrap the list view.
const TITLE_MAX_LENGTH = 80;

function deriveTitle(body: string): string {
  const firstLine = body.trim().split("\n", 1)[0] ?? "";
  return firstLine.length > TITLE_MAX_LENGTH ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 1)}…` : firstLine;
}

async function send(): Promise<void> {
  const body = newMessage.value.trim();
  if (!body) return;
  sending.value = true;
  error.value = null;
  try {
    const thread = await createChatThread(
      deriveTitle(body),
      projectId.value ?? undefined,
      agentId.value ?? undefined,
      (model.value as "sonnet" | "opus" | null) ?? undefined,
      (effort.value as "medium" | "high" | null) ?? undefined,
    );
    await sendChatMessage(thread.id, body);
    router.replace(`/chat/${thread.id}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    sending.value = false;
  }
}

function onComposeKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="d-flex flex-column ga-4 chat-thread">
    <v-btn variant="text" prepend-icon="mdi-arrow-left" class="align-self-start" @click="router.push('/chat')">
      Back to threads
    </v-btn>

    <h1 class="text-h5">New chat thread</h1>

    <div class="d-flex ga-2 flex-wrap align-center">
      <v-chip size="small" variant="tonal">{{ projectName(projectId) }}</v-chip>
      <v-chip size="small" variant="tonal">agent: {{ agentName(agentId) }}</v-chip>
      <v-chip v-if="model" size="small" variant="tonal">model: {{ model }}</v-chip>
      <v-chip v-if="effort" size="small" variant="tonal">effort: {{ effort }}</v-chip>
    </div>

    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>

    <p class="text-medium-emphasis">
      Say what you'd like to discuss or decompose. The thread is created once you send this first message, titled
      from it - you can rename it afterward.
    </p>

    <div class="d-flex ga-2">
      <v-textarea
        v-model="newMessage"
        label="Message"
        rows="2"
        density="comfortable"
        auto-grow
        autofocus
        @keydown="onComposeKeydown"
      />
      <v-btn icon="mdi-send" :loading="sending" :disabled="!newMessage.trim()" @click="send" />
    </div>
  </div>
</template>

<style scoped>
.chat-thread {
  min-width: 0;
}
</style>
