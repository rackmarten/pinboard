<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useBackClose } from "@rackmarten/ui-kit";
import {
  addComment,
  advancePipeline,
  approveTask,
  getHandoffs,
  getProjects,
  getPullRequests,
  getTasks,
  rejectTask,
  updateTask,
  type Project,
  type PullRequest,
  type Task,
} from "../api.js";
import { usePolling } from "../composables/usePolling.js";
import TaskPriorityChip from "../components/TaskPriorityChip.vue";
import { statusColor, taskTypeIcon } from "../display.js";
import { approveAction } from "../approve.js";
import { renderDescriptionHtml } from "../description-html.js";
import { REVIEW_STATUSES, handoffTldr } from "../inbox.js";

// the former ReviewQueueView, now the inbox's Review section
// (/review redirects to /inbox). Each card shows the latest handoff's TL;DR,
// not the whole handoff - the full one is on the task's own page.

// this screen now holds two different decisions, not one. A
// `review` task is finished and already deployed - approving it signs the
// work off (-> done). An `awaiting_review` task is the opposite end: its PR
// is still open and nothing has merged, because the pipeline holds anything
// judged too costly to unwind automatically (today, a diff touching a drizzle
// migration) for a human to look at BEFORE it reaches main. Approving that
// one releases the hold and lets the pipeline merge and deploy it.
//
// They share a queue deliberately - both are "something is waiting on you" -
// but the cards say which is which, because approving the second without
// opening its PR is exactly the mistake the hold exists to prevent.
const QUEUE_STATUSES = REVIEW_STATUSES;

function isPreMergeHold(task: Task): boolean {
  return task.status === "awaiting_review";
}

const tasks = ref<Task[]>([]);
const projects = ref<Project[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const acting = ref<number | null>(null);

// Only fetched for held tasks: a pre-merge approval without a link to the
// diff it approves would be a rubber stamp.
const prs = ref<Record<number, PullRequest | undefined>>({});

// Latest handoff TL;DR per task, fetched once per task id - a handoff does
// not change while the task waits for review.
const tldrs = ref<Record<number, string | null>>({});

async function loadTldrs(): Promise<void> {
  const missing = tasks.value.filter((t) => !(t.id in tldrs.value));
  const found = await Promise.all(
    missing.map((t) => getHandoffs(t.id).then((list) => [t.id, handoffTldr(list[0])] as const).catch(() => [t.id, null] as const)),
  );
  tldrs.value = { ...tldrs.value, ...Object.fromEntries(found) };
}

const rejectDialog = ref(false);
useBackClose(rejectDialog);
const rejectTarget = ref<Task | null>(null);
const rejectReason = ref("");

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    tasks.value = await getTasks({ status: QUEUE_STATUSES });
    await Promise.all([loadPullRequests(), loadTldrs()]);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

// The most recent PR per held task - the pipeline follows one PR through
// being merged, so the latest is the one the hold is about.
async function loadPullRequests(): Promise<void> {
  const held = tasks.value.filter(isPreMergeHold);
  const found = await Promise.all(
    held.map((task) => getPullRequests(task.id).then((list) => [task.id, list.at(-1)] as const).catch(() => [task.id, undefined] as const)),
  );
  prs.value = Object.fromEntries(found);
}

onMounted(async () => {
  projects.value = await getProjects();
  await load();
});

// Silent - a queue that's actively being worked from a phone shouldn't
// flicker its progress bar every 5s.
usePolling(() =>
  getTasks({ status: QUEUE_STATUSES })
    .then((t) => {
      tasks.value = t;
      return Promise.all([loadPullRequests(), loadTldrs()]).then(() => {});
    })
    .catch(() => {}),
);

function projectName(id: number): string {
  return projects.value.find((p) => p.id === id)?.name ?? `#${id}`;
}

async function approve(task: Task): Promise<void> {
  acting.value = task.id;
  error.value = null;
  try {
    const action = approveAction(isPreMergeHold(task), isPreMergeHold(task) ? [] : await getPullRequests(task.id));
    if (action === "release_hold") {
      await addComment(task.id, "Pre-merge hold released via review queue - the pipeline may merge and deploy this.");
      await advancePipeline(task.id, "awaiting_merge");
    } else if (action === "merge") {
      await addComment(task.id, "Approved via review queue - merging.");
      await advancePipeline(task.id, "awaiting_merge");
    } else {
      await addComment(task.id, "Approved via review queue.");
      await approveTask(task.id);
    }
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    acting.value = null;
  }
}

// the explicit escape hatch past /complete's open-PR guard.
async function doneWithoutMerging(task: Task): Promise<void> {
  acting.value = task.id;
  error.value = null;
  try {
    await addComment(task.id, "Marked done via review queue without merging its PR.");
    await approveTask(task.id, "marek", true);
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    acting.value = null;
  }
}

function openReject(task: Task): void {
  rejectTarget.value = task;
  rejectReason.value = "";
  rejectDialog.value = true;
}

// `requeue` sends the task straight back to `queued` instead of `rework`, for
// a rejection that just needs another automated attempt (e.g. #164's rework
// fix never made it out because the run's own push failed) rather than a
// human picking it up. Reuses the same PATCH /tasks/:id status change
// TaskDetailView's status menu already uses to requeue a task - the backend
// resets attemptCount and clears any stale repairReason for exactly this
// path (routes.ts), so this isn't a second, divergent way to requeue.
async function confirmReject(requeue: boolean): Promise<void> {
  const task = rejectTarget.value;
  if (!task || !rejectReason.value.trim()) return;
  acting.value = task.id;
  error.value = null;
  try {
    await addComment(task.id, `Rejected via review queue: ${rejectReason.value.trim()}`);
    if (requeue) {
      await updateTask(task.id, { status: "queued" });
    } else {
      await rejectTask(task.id);
    }
    rejectDialog.value = false;
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    acting.value = null;
  }
}
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate />

    <v-list v-if="tasks.length" lines="two">
      <v-card v-for="task in tasks" :key="task.id" variant="tonal" class="mb-3">
        <v-card-item>
          <template #prepend>
            <v-avatar :color="statusColor(task.status)" variant="tonal">
              <v-icon :icon="taskTypeIcon(task.taskType)" />
            </v-avatar>
          </template>
          <template #title>
            <router-link :to="`/tasks/${task.id}`" class="text-decoration-none">
              <span class="text-medium-emphasis">#{{ task.id }}</span> {{ task.title }}
            </router-link>
          </template>
          <template #subtitle>{{ projectName(task.projectId) }} · {{ task.taskType }}</template>
          <template #append>
            <TaskPriorityChip v-if="task.priority" :priority="task.priority" />
          </template>
        </v-card-item>
        <v-card-text v-if="tldrs[task.id]" class="pt-0 text-body-2 description-html" v-html="renderDescriptionHtml(tldrs[task.id]!)" />
        <v-card-text v-if="isPreMergeHold(task)" class="pt-0">
          <v-alert type="warning" density="compact" variant="tonal" icon="mdi-gate-alert">
            Held before merge - nothing has reached main yet. Read the diff before approving.
            <template v-if="prs[task.id]">
              <br />
              <a :href="prs[task.id]!.url" target="_blank" rel="noopener">{{ prs[task.id]!.url }}</a>
            </template>
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" color="error" :loading="acting === task.id" @click="openReject(task)">Reject</v-btn>
          <v-btn v-if="!isPreMergeHold(task)" variant="text" :loading="acting === task.id" @click="doneWithoutMerging(task)">Mark done without merging</v-btn>
          <v-btn variant="tonal" color="success" :loading="acting === task.id" @click="approve(task)">
            {{ isPreMergeHold(task) ? "Approve & merge" : "Approve" }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-list>
    <p v-else-if="!loading" class="text-medium-emphasis">Nothing waiting for review.</p>

    <v-dialog v-model="rejectDialog" max-width="480">
      <v-card title="Reject task">
        <v-card-text>
          <v-textarea
            v-model="rejectReason"
            label="Reason (recorded as a comment)"
            rows="3"
            density="comfortable"
            autofocus
          />
          <div class="text-caption text-medium-emphasis">
            "Reject" leaves this for a human to pick up (rework). "Reject &amp; requeue" sends it straight back to the
            queue for another automated attempt with the reason above attached.
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="rejectDialog = false">Cancel</v-btn>
          <v-btn
            variant="tonal"
            color="warning"
            :disabled="!rejectReason.trim()"
            :loading="acting === rejectTarget?.id"
            @click="confirmReject(true)"
          >
            Reject &amp; requeue
          </v-btn>
          <v-btn color="error" :disabled="!rejectReason.trim()" :loading="acting === rejectTarget?.id" @click="confirmReject(false)">
            Reject
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
