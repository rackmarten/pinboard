<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { getEvents, getProjects, getTasks, requestControl, type Project, type Task, type TaskEvent } from "../api.js";
import { usePolling } from "../composables/usePolling.js";
import { statusColor, taskTypeIcon } from "../display.js";

const tasks = ref<Task[]>([]);
const projects = ref<Project[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const acting = ref<number | null>(null);
const now = ref(Date.now());
// I19: latest live-activity line per executing task, keyed by task id - a
// glance-level answer to "what is it doing right now" without opening the
// task's own detail page for its full activity log.
const latestActivity = ref<Record<number, TaskEvent | undefined>>({});

async function refreshLatestActivity(currentTasks: Task[]): Promise<void> {
  const entries = await Promise.all(
    currentTasks.map(async (t) => {
      const events = await getEvents(t.id).catch(() => []);
      const activity = events.filter((e) => e.eventType === "activity");
      return [t.id, activity[activity.length - 1]] as const;
    }),
  );
  latestActivity.value = Object.fromEntries(entries);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    tasks.value = await getTasks({ status: ["executing"] });
    await refreshLatestActivity(tasks.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  projects.value = await getProjects();
  await load();
});

usePolling(() =>
  getTasks({ status: ["executing"] })
    .then(async (t) => {
      tasks.value = t;
      await refreshLatestActivity(t);
    })
    .catch(() => {}),
);

function activitySummary(event: TaskEvent | undefined): string | null {
  if (!event) return null;
  const detail = event.payload as { kind: string; detail: { text?: string; name?: string; input?: string; content?: string } };
  if (detail.kind === "tool_use") return `Using ${detail.detail.name}`;
  if (detail.kind === "tool_result") return detail.detail.content ?? "";
  return detail.detail.text ?? "";
}

// A local ticking clock (not another poll) so "leased for Xs" and "expires
// in Xs" count down smoothly between the 5s task refreshes.
const clock = setInterval(() => (now.value = Date.now()), 1000);
onUnmounted(() => clearInterval(clock));

function projectName(id: number): string {
  return projects.value.find((p) => p.id === id)?.name ?? `#${id}`;
}

function leaseLive(task: Task): boolean {
  return !!task.leaseExpiresAt && new Date(task.leaseExpiresAt).getTime() > now.value;
}

function leaseRemaining(task: Task): string {
  if (!task.leaseExpiresAt) return "no lease";
  const ms = new Date(task.leaseExpiresAt).getTime() - now.value;
  if (ms <= 0) return "lease expired - stale, reclaimable";
  return `lease renews in ${Math.round(ms / 1000)}s`;
}

function elapsedSince(task: Task): string {
  const ms = now.value - new Date(task.updatedAt).getTime();
  return `${Math.max(0, Math.round(ms / 1000))}s since last update`;
}

async function control(task: Task, action: "stop" | "kill"): Promise<void> {
  acting.value = task.id;
  error.value = null;
  try {
    await requestControl(task.id, action);
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
    <h1 class="text-h5">Running workers</h1>

    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate />

    <v-list v-if="tasks.length" lines="three">
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
          <template #subtitle>{{ projectName(task.projectId) }} · attempt {{ task.attemptCount }} · {{ elapsedSince(task) }}</template>
        </v-card-item>
        <v-card-text class="d-flex flex-column ga-2">
          <div class="d-flex align-center ga-2">
            <v-chip size="small" :color="leaseLive(task) ? 'primary' : 'warning'" variant="tonal">
              {{ leaseLive(task) ? leaseRemaining(task) : "stale lease - crashed runner, reclaimable" }}
            </v-chip>
            <v-chip v-if="task.controlAction" size="small" color="warning" variant="tonal">
              {{ task.controlAction }} requested
            </v-chip>
          </div>
          <div v-if="activitySummary(latestActivity[task.id])" class="text-caption text-medium-emphasis text-truncate">
            <v-icon icon="mdi-radio-tower" size="x-small" class="mr-1" />{{ activitySummary(latestActivity[task.id]) }}
          </div>
        </v-card-text>
        <v-card-actions v-if="leaseLive(task)">
          <v-spacer />
          <v-btn
            variant="text"
            :disabled="task.controlAction === 'stop'"
            :loading="acting === task.id"
            @click="control(task, 'stop')"
          >
            Graceful stop
          </v-btn>
          <v-btn
            variant="tonal"
            color="error"
            :disabled="task.controlAction === 'kill'"
            :loading="acting === task.id"
            @click="control(task, 'kill')"
          >
            Kill
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-list>
    <v-empty-state
      v-else-if="!loading"
      icon="mdi-robot-outline"
      title="No tasks currently executing"
    />
  </div>
</template>
