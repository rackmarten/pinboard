<script setup lang="ts">
// "Needs you" - everything waiting on the operator in one place,
// meant to be cleared in about 30 seconds on a phone. Decide (open questions),
// Review (the former review queue), FYI (recent assumptions, what finished
// since the last visit), in that order.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  answerAsk,
  answerRecommendedAsks,
  createChatThread,
  getAsks,
  getHandoffs,
  getTasks,
  sendChatMessage,
  vetoAsk,
  type Ask,
  type Task,
} from "../api.js";
import { startAskChat } from "../ask-chat.js";
import { usePolling } from "../composables/usePolling.js";
import AskCard from "../components/AskCard.vue";
import ReviewSection from "../components/ReviewSection.vue";
import { renderDescriptionHtml } from "../description-html.js";
import { LAST_VISIT_KEY, createDecideQueue, doneSince, recentAssumptions } from "../inbox.js";

const error = ref<string | null>(null);
const busyAsk = ref<number | null>(null);
const acceptingAll = ref(false);

const decide = createDecideQueue({
  getAsks,
  answerAsk,
  answerRecommended: answerRecommendedAsks,
  confirm: (message) => window.confirm(message),
});
const { groups, questions } = decide;
const router = useRouter();

// Decide cards ticked for "Resolve in chat". Kept as ids so a poll
// replacing the list keeps the selection; an ask that left the list drops out.
const selectedIds = ref(new Set<number>());
const selectedAsks = computed(() => questions.value.filter((a) => selectedIds.value.has(a.id)));
const startingChat = ref(false);

function setSelected(id: number, on: boolean): void {
  const next = new Set(selectedIds.value);
  if (on) next.add(id);
  else next.delete(id);
  selectedIds.value = next;
}

async function resolveInChat(): Promise<void> {
  startingChat.value = true;
  await run(async () => {
    const thread = await startAskChat(
      { getHandoffs, createChatThread: (title, projectId) => createChatThread(title, projectId), sendChatMessage },
      selectedAsks.value,
    );
    await router.push(`/chat/${thread.id}`);
  });
  startingChat.value = false;
}

const assumptions = ref<Ask[]>([]);
const done = ref<Task[]>([]);
const vetoing = ref<number | null>(null);
const vetoText = ref("");

// "Since the last visit" is the previous visit: read once on arrival and
// moved forward on leaving, so what finished stays listed while the page is
// open. A first visit shows the last day.
const lastVisit = Number(localStorage.getItem(LAST_VISIT_KEY)) || Date.now() - 24 * 3600_000;
onUnmounted(() => localStorage.setItem(LAST_VISIT_KEY, String(Date.now())));

async function loadFyi(): Promise<void> {
  const [asks, doneTasks] = await Promise.all([getAsks(["open", "accepted"]), getTasks({ status: ["done"] })]);
  assumptions.value = recentAssumptions(asks, Date.now());
  done.value = doneSince(doneTasks, lastVisit);
}

async function load(): Promise<void> {
  try {
    await Promise.all([decide.load(), loadFyi()]);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(load);
usePolling(() => load().catch(() => {}), 15_000);

async function run(action: () => Promise<unknown>): Promise<void> {
  error.value = null;
  try {
    await action();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function answer(ask: Ask, value: { option: number | null; text: string }): Promise<void> {
  busyAsk.value = ask.id;
  await run(() => decide.answer(ask.id, value.option, value.text));
  busyAsk.value = null;
}

async function acceptAll(): Promise<void> {
  acceptingAll.value = true;
  await run(() => decide.acceptAllRecommended());
  acceptingAll.value = false;
}

async function acceptAssumption(ask: Ask): Promise<void> {
  busyAsk.value = ask.id;
  await run(async () => {
    await answerAsk(ask.id, {});
    await loadFyi();
  });
  busyAsk.value = null;
}

function startVeto(ask: Ask): void {
  vetoing.value = ask.id;
  vetoText.value = "";
}

async function confirmVeto(ask: Ask): Promise<void> {
  if (!vetoText.value.trim()) return;
  busyAsk.value = ask.id;
  await run(async () => {
    await vetoAsk(ask.id, vetoText.value.trim());
    vetoing.value = null;
    await loadFyi();
  });
  busyAsk.value = null;
}
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <h1 class="text-h5">Needs you</h1>
    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>

    <section class="d-flex flex-column ga-3">
      <div class="d-flex align-center flex-wrap ga-2">
        <h2 class="text-h6">Decide</h2>
        <v-chip v-if="questions.length" size="small" color="info">{{ questions.length }}</v-chip>
        <v-spacer />
        <v-btn
          v-if="selectedAsks.length"
          variant="tonal"
          color="primary"
          prepend-icon="mdi-chat-processing-outline"
          :loading="startingChat"
          @click="resolveInChat"
        >
          Resolve {{ selectedAsks.length }} in chat
        </v-btn>
        <v-btn
          v-if="questions.length"
          variant="tonal"
          color="success"
          prepend-icon="mdi-check-all"
          :loading="acceptingAll"
          @click="acceptAll"
        >
          Accept all recommended
        </v-btn>
      </div>
      <template v-for="group in groups" :key="group.projectId">
        <div class="text-overline text-medium-emphasis">{{ group.projectName }}</div>
        <AskCard
          v-for="ask in group.items"
          :key="ask.id"
          :ask="ask"
          :busy="busyAsk === ask.id"
          :selected="selectedIds.has(ask.id)"
          @update:selected="setSelected(ask.id, $event)"
          @answer="answer(ask, $event)"
        />
      </template>
      <p v-if="!questions.length" class="text-medium-emphasis">No open questions.</p>
    </section>

    <v-divider />

    <section class="d-flex flex-column ga-3">
      <h2 class="text-h6">Review</h2>
      <ReviewSection />
    </section>

    <v-divider />

    <section class="d-flex flex-column ga-3">
      <h2 class="text-h6">FYI</h2>

      <v-card v-for="ask in assumptions" :key="ask.id" variant="outlined" density="compact">
        <v-card-item class="pb-1">
          <v-card-subtitle class="px-0">
            Assumed on
            <router-link :to="`/tasks/${ask.taskId}`" class="text-decoration-none">#{{ ask.taskId }}</router-link>
            {{ ask.taskTitle }}
            <v-chip v-if="ask.status === 'accepted'" size="x-small" label class="ms-1">accepted</v-chip>
          </v-card-subtitle>
        </v-card-item>
        <v-card-text class="pt-0">
          <div class="text-body-2 description-html" v-html="renderDescriptionHtml(ask.question)" />
          <div v-if="ask.context" class="text-caption text-medium-emphasis description-html" v-html="renderDescriptionHtml(ask.context)" />
          <v-textarea
            v-if="vetoing === ask.id"
            v-model="vetoText"
            label="What's wrong with it? (sends the task to rework)"
            rows="2"
            auto-grow
            density="compact"
            variant="outlined"
            hide-details
            autofocus
            class="mt-2"
          />
        </v-card-text>
        <v-card-actions class="pt-0">
          <v-spacer />
          <template v-if="vetoing === ask.id">
            <v-btn variant="text" @click="vetoing = null">Cancel</v-btn>
            <v-btn color="error" variant="tonal" :disabled="!vetoText.trim()" :loading="busyAsk === ask.id" @click="confirmVeto(ask)">
              Veto
            </v-btn>
          </template>
          <template v-else>
            <v-btn variant="text" color="error" @click="startVeto(ask)">Veto</v-btn>
            <v-btn v-if="ask.status === 'open'" variant="tonal" color="success" :loading="busyAsk === ask.id" @click="acceptAssumption(ask)">
              Accept
            </v-btn>
          </template>
        </v-card-actions>
      </v-card>

      <v-list v-if="done.length" density="compact" class="py-0">
        <v-list-subheader>Done since your last visit</v-list-subheader>
        <v-list-item v-for="task in done" :key="task.id" :to="`/tasks/${task.id}`" prepend-icon="mdi-check-circle-outline">
          <v-list-item-title><span class="text-medium-emphasis">#{{ task.id }}</span> {{ task.title }}</v-list-item-title>
        </v-list-item>
      </v-list>

      <p v-if="!assumptions.length && !done.length" class="text-medium-emphasis">Nothing new.</p>
    </section>
  </div>
</template>

<style scoped>
.description-html :deep(p) {
  margin: 0;
}
</style>
