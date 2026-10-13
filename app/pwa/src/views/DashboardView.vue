<script setup lang="ts">
// status/aggregate dashboard - a read-only rollup of task counts by
// status (and, for the still-open statuses, by project), separate from
// TaskListView's filterable infinite list. Reuses useTasks with an empty
// filter to pull every task regardless of status, then groups client-side -
// the task volume here doesn't warrant a dedicated aggregate endpoint yet
// (same reasoning TaskListView's free-text search uses).
import { computed, onMounted, ref } from "vue";
import { getProjects, TASK_STATUSES, type Project, type TaskFilter } from "../api.js";
import { useTasks } from "../composables/useTasks.js";
import TaskStatusChip from "../components/TaskStatusChip.vue";
import { statusColor, statusIcon } from "../display.js";

const projects = ref<Project[]>([]);
const filter = ref<TaskFilter>({});
const { tasks, loading, error } = useTasks(filter);

onMounted(async () => {
  projects.value = await getProjects();
});

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
  const byStatus = new Map<string, typeof tasks.value>();
  for (const t of tasks.value) {
    if (TERMINAL_STATUSES.has(t.status)) continue;
    if (!byStatus.has(t.status)) byStatus.set(t.status, []);
    byStatus.get(t.status)!.push(t);
  }
  return TASK_STATUSES.filter((s) => !TERMINAL_STATUSES.has(s) && byStatus.has(s)).map((status) => {
    const group = byStatus.get(status)!;
    const byProject = new Map<number, number>();
    for (const t of group) byProject.set(t.projectId, (byProject.get(t.projectId) ?? 0) + 1);
    return {
      status,
      count: group.length,
      byProject: [...byProject.entries()]
        .map(([projectId, count]) => ({ projectId, projectName: projectName(projectId), count }))
        .sort((a, b) => b.count - a.count),
    };
  });
});

const totalOpen = computed(() => openGroups.value.reduce((sum, g) => sum + g.count, 0));
const doneCount = computed(() => tasks.value.filter((t) => t.status === "done").length);
const rejectedCount = computed(() => tasks.value.filter((t) => t.status === "rejected").length);
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <h1 class="text-h5">Dashboard</h1>

    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
    <v-progress-linear v-if="loading && !tasks.length" indeterminate />

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
