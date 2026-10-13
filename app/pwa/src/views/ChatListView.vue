<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useBackClose } from "@rackmarten/ui-kit";
import { useRouter } from "vue-router";
import { useDisplay } from "vuetify";
import { getAgents, getChatThreads, getProjects, type Agent, type ChatThread, type Project } from "../api.js";
import { usePolling } from "../composables/usePolling.js";
import ChatThreadView from "./ChatThreadView.vue";

// desktop (`lg`+, 1280px) gets a persistent sidebar - the thread
// list to the left, the selected thread's content to the right - instead of
// navigating to a separate page per thread. Below `lg`, behavior is
// unchanged from before this task: this view is the full-page list, and
// picking a thread navigates to its own full page.
//
// Both are the same route record (`/chat/:id?`, see router.ts), so this
// component is never remounted when the selected thread changes - only
// `id` (and therefore `selectedId`) changes, which ChatThreadView already
// handles without a remount of its own.
const props = defineProps<{ id?: string }>();
const { lgAndUp } = useDisplay();
const router = useRouter();

const selectedId = computed(() => (props.id ? Number(props.id) : null));

const threads = ref<ChatThread[]>([]);
const projects = ref<Project[]>([]);
const agents = ref<Agent[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

// closed/archived threads are hidden from the default list at
// both sizes - "Archived" switches the same list (and, on desktop, the
// same sidebar) over to showing only closed ones.
const status = ref<"open" | "closed">("open");

// A past task rework: the sidebar used to scroll away with the page on long
// threads. It's now sticky with its own scroll region (GPT/WhatsApp-style),
// plus a collapse toggle so it can be tucked away.
const sidebarOpen = ref(true);

const showCreate = ref(false);
useBackClose(showCreate);
const newProjectId = ref<number | null>(null);
const newAgentId = ref<number | null>(null);
const newModel = ref<"sonnet" | "opus" | null>(null);
const newEffort = ref<"medium" | "high" | null>(null);

const MODEL_OPTIONS = [
  { title: "Sonnet", value: "sonnet" },
  { title: "Opus", value: "opus" },
];
const EFFORT_OPTIONS = [
  { title: "Medium", value: "medium" },
  { title: "High", value: "high" },
];

// I9: task-scoped session chat threads (taskId set) live on their own
// task's detail page instead - excluded here so this list stays purely
// planning chat, per I8's original scope.
async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    threads.value = await getChatThreads({ taskId: "none", status: status.value });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  [projects.value, agents.value] = await Promise.all([getProjects(), getAgents()]);
  await load();
});

watch(status, load);

usePolling(() =>
  getChatThreads({ taskId: "none", status: status.value })
    .then((t) => {
      threads.value = t;
    })
    .catch(() => {}),
);

function projectName(id: number | null): string {
  if (id === null) return "No project";
  return projects.value.find((p) => p.id === id)?.name ?? `#${id}`;
}

function agentName(id: number | null): string | null {
  if (id === null) return null;
  return agents.value.find((a) => a.id === id)?.name ?? `#${id}`;
}

// settings are still picked upfront, but nothing is created yet -
// the thread only exists in the database once the first message is actually
// sent, from the compose step this navigates to.
function startCompose(): void {
  showCreate.value = false;
  const query: Record<string, string> = {};
  if (newProjectId.value !== null) query.projectId = String(newProjectId.value);
  if (newAgentId.value !== null) query.agentId = String(newAgentId.value);
  if (newModel.value) query.model = newModel.value;
  if (newEffort.value) query.effort = newEffort.value;
  newProjectId.value = null;
  newAgentId.value = null;
  newModel.value = null;
  newEffort.value = null;
  router.push({ path: "/chat/new", query });
}
</script>

<template>
  <!-- Desktop: persistent, sticky sidebar + selected thread to the right. -->
  <div v-if="lgAndUp" class="chat-desktop">
    <div v-if="sidebarOpen" class="chat-sidebar d-flex flex-column">
      <div class="chat-sidebar-header d-flex flex-column ga-2">
        <div class="d-flex align-center ga-2">
          <h1 class="text-h6 mr-auto">Planning chat</h1>
          <v-btn icon="mdi-plus" size="small" variant="text" @click="showCreate = true" />
          <v-btn icon="mdi-chevron-left" size="small" variant="text" title="Collapse sidebar" @click="sidebarOpen = false" />
        </div>

        <v-tabs v-model="status" density="compact">
          <v-tab value="open">Open</v-tab>
          <v-tab value="closed">Archived</v-tab>
        </v-tabs>

        <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
        <v-progress-linear v-if="loading" indeterminate />
      </div>

      <div class="chat-sidebar-list">
        <v-list v-if="threads.length" lines="two" density="compact" nav>
          <v-list-item
            v-for="thread in threads"
            :key="thread.id"
            :to="`/chat/${thread.id}`"
            :active="thread.id === selectedId"
            rounded="lg"
            class="mb-1"
          >
            <template #title>{{ thread.title }}</template>
            <template #subtitle>
              {{ projectName(thread.projectId) }}
              <span v-if="agentName(thread.agentId)"> · {{ agentName(thread.agentId) }}</span>
            </template>
            <template #append>
              <v-chip v-if="thread.awaitingAgent" size="small" color="primary" variant="tonal">•</v-chip>
            </template>
          </v-list-item>
        </v-list>
        <v-empty-state
          v-else-if="!loading"
          icon="mdi-chat-outline"
          :title="status === 'open' ? 'No open threads' : 'No archived threads'"
        />
      </div>
    </div>

    <div class="chat-main">
      <v-btn
        v-if="!sidebarOpen"
        icon="mdi-menu"
        size="small"
        variant="text"
        title="Show sidebar"
        class="mb-2"
        @click="sidebarOpen = true"
      />
      <ChatThreadView v-if="selectedId" :id="String(selectedId)" />
      <v-empty-state
        v-else
        icon="mdi-chat-outline"
        title="Select a thread"
        text="Choose a thread from the sidebar, or start a new one."
      />
    </div>
  </div>

  <!-- Mobile/tablet (< 1280px): unchanged from before this task - a
       full-page list, or a full-page thread once one is selected. -->
  <template v-else>
    <ChatThreadView v-if="selectedId" :id="String(selectedId)" />
    <div v-else class="d-flex flex-column ga-4">
      <div class="d-flex align-center ga-2 flex-wrap">
        <h1 class="text-h5 mr-auto">Planning chat</h1>
        <v-btn color="primary" prepend-icon="mdi-plus" @click="showCreate = true">New thread</v-btn>
      </div>

      <v-tabs v-model="status">
        <v-tab value="open">Open</v-tab>
        <v-tab value="closed">Archived</v-tab>
      </v-tabs>

      <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
      <v-progress-linear v-if="loading" indeterminate />

      <v-list v-if="threads.length" lines="two">
        <v-list-item
          v-for="thread in threads"
          :key="thread.id"
          :to="`/chat/${thread.id}`"
          rounded="lg"
          class="mb-1"
        >
          <template #title>{{ thread.title }}</template>
          <template #subtitle>
            {{ projectName(thread.projectId) }}
            <span v-if="agentName(thread.agentId)"> · {{ agentName(thread.agentId) }}</span>
            <span v-if="thread.status === 'closed'"> · closed</span>
          </template>
          <template #append>
            <v-chip v-if="thread.awaitingAgent" size="small" color="primary" variant="tonal">
              waiting on agent
            </v-chip>
          </template>
        </v-list-item>
      </v-list>
      <v-empty-state
        v-else-if="!loading"
        icon="mdi-chat-outline"
        :title="status === 'open' ? 'No chat threads yet' : 'No archived threads'"
        :text="status === 'open' ? 'Start one to discuss and decompose a piece of work with a Claude session on foreman before filing a task.' : undefined"
      />
    </div>
  </template>

  <v-dialog v-model="showCreate" max-width="480">
    <v-card>
      <v-card-title>New chat thread</v-card-title>
      <v-card-text class="d-flex flex-column ga-3">
        <v-select
          v-model="newProjectId"
          label="Project (optional)"
          :items="projects"
          item-title="name"
          item-value="id"
          clearable
          autofocus
        />
        <v-select
          v-model="newAgentId"
          label="Agent (optional, defaults to foreman's planning agent)"
          :items="agents"
          item-title="name"
          item-value="id"
          clearable
        />
        <v-select
          v-model="newModel"
          label="Model (optional, defaults to the agent's own model)"
          :items="MODEL_OPTIONS"
          clearable
        />
        <v-select
          v-model="newEffort"
          label="Effort (optional, defaults to foreman's default)"
          :items="EFFORT_OPTIONS"
          clearable
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="showCreate = false">Cancel</v-btn>
        <v-btn color="primary" @click="startCompose">Continue</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.chat-desktop {
  display: flex;
  align-items: flex-start;
  gap: 24px;
}
.chat-sidebar {
  width: 300px;
  flex-shrink: 0;
  position: sticky;
  top: 80px;
  max-height: calc(100vh - 96px);
}
.chat-sidebar-header {
  flex-shrink: 0;
  padding-bottom: 8px;
}
.chat-sidebar-list {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
}
.chat-main {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
