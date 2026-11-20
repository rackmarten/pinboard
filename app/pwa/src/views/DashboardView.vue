<script setup lang="ts">
// status/aggregate dashboard - a read-only rollup of task counts by
// status (and, for the still-open statuses, by project), separate from
// TaskListView's filterable infinite list. GET /tasks/counts does the
// counting, so this never loads the tasks themselves.
import { computed, onMounted, ref } from "vue";
import { getProjects, getTaskCounts, TASK_STATUSES, type Project, type TaskCount } from "../api.js";
import { usePolling } from "../composables/usePolling.js";
import TaskStatusChip from "../components/TaskStatusChip.vue";
import { statusColor, statusIcon } from "../display.js";

const projects = ref<Project[]>([]);
const counts = ref<TaskCount[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  loading.value = true;
  try {
    [projects.value, counts.value] = await Promise.all([getProjects(), getTaskCounts()]);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});
// silent refresh, like the task list's.
usePolling(() =>
  getTaskCounts()
    .then((c) => {
      counts.value = c;
    })
    .catch(() => {}),
);

function projectName(id: number): string {
  return projects.value.find((p) => p.id === id)?.name ?? `#${id}`;
}

// "done"/"rejected" are terminal - shown as a single completed-to-date count
// rather than broken out by project, since what's waiting and on what is the
// more actionable question. Every other status counts as still open.
const TERMINAL_STATUSES = new Set(["done", "rejected"]);

interface StatusGroup {
  status: string;
  count: number;
  byProject: { projectId: number; projectName: string; count: number }[];
}

const openGroups = computed<StatusGroup[]>(() => {
  const byStatus = new Map<string, TaskCount[]>();
  for (const c of counts.value) {
    if (TERMINAL_STATUSES.has(c.status)) continue;
    if (!byStatus.has(c.status)) byStatus.set(c.status, []);
    byStatus.get(c.status)!.push(c);
  }
  return TASK_STATUSES.filter((s) => !TERMINAL_STATUSES.has(s) && byStatus.has(s)).map((status) => {
    const group = byStatus.get(status)!;
    return {
      status,
      count: group.reduce((sum, c) => sum + c.count, 0),
      byProject: group
        .map((c) => ({ projectId: c.projectId, projectName: projectName(c.projectId), count: c.count }))
        .sort((a, b) => b.count - a.count),
    };
  });
});

const statusTotal = (status: string) => counts.value.filter((c) => c.status === status).reduce((sum, c) => sum + c.count, 0);
const totalOpen = computed(() => openGroups.value.reduce((sum, g) => sum + g.count, 0));
const doneCount = computed(() => statusTotal("done"));
const rejectedCount = computed(() => statusTotal("rejected"));
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <h1 class="text-h5">Dashboard</h1>

    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
    <v-progress-linear v-if="loading && !counts.length" indeterminate />

    <div class="d-flex flex-wrap ga-3">
      <v-card class="stat-tile" variant="tonal">
        <v-card-text>
          <div class="text-caption text-medium-emphasis">Open</div>
          <div class="text-h4">{{ totalOpen }}</div>
        </v-card-text>
      </v-card>
      <v-card class="stat-tile" variant="tonal" color="success">
        <v-card-text>
          <div class="text-caption text-medium-emphasis">Completed to date</div>
          <div class="text-h4">{{ doneCount }}</div>
        </v-card-text>
      </v-card>
      <v-card class="stat-tile" variant="tonal">
        <v-card-text>
          <div class="text-caption text-medium-emphasis">Rejected</div>
          <div class="text-h4">{{ rejectedCount }}</div>
        </v-card-text>
      </v-card>
    </div>

    <v-card>
      <v-card-item>
        <template #title>Open tasks by status</template>
        <template #subtitle>What's waiting, and on what project</template>
      </v-card-item>
      <v-list v-if="openGroups.length" lines="two">
        <v-list-group v-for="group in openGroups" :key="group.status" :value="group.status">
          <template #activator="{ props }">
            <v-list-item v-bind="props">
              <template #prepend>
                <v-icon :icon="statusIcon(group.status)" :color="statusColor(group.status)" />
              </template>
              <v-list-item-title>
                <TaskStatusChip :status="group.status" :icon="false" class="mr-2" />
                {{ group.count }} task{{ group.count === 1 ? "" : "s" }}
              </v-list-item-title>
            </v-list-item>
          </template>
          <v-list-item
            v-for="p in group.byProject"
            :key="p.projectId"
            :to="`/tasks?projectId=${p.projectId}&status=${group.status}`"
            :title="p.projectName"
          >
            <template #append>
              <span class="text-medium-emphasis">{{ p.count }}</span>
            </template>
          </v-list-item>
        </v-list-group>
      </v-list>
      <v-empty-state v-else icon="mdi-format-list-checks" title="No open tasks" />
    </v-card>
  </div>
</template>

<style scoped>
.stat-tile {
  min-width: 140px;
  flex: 1;
}
</style>
