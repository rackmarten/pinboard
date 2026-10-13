<script setup lang="ts">
// the task rows the project detail page shows (status-colored
// type avatar, "#id title", type and executor mode, priority and status
// chips), shared with the task detail's Relations card. The `actions` slot
// adds per-row controls after the chips (the relations list's delete button)
// without forking the row markup.
import TaskPriorityChip from "./TaskPriorityChip.vue";
import TaskStatusChip from "./TaskStatusChip.vue";
import { statusColor, taskTypeIcon } from "../display.js";

export interface TaskListItem {
  id: number;
  title: string;
  status: string;
  taskType: string;
  executorMode: string;
  priority: number;
}

defineProps<{ tasks: readonly TaskListItem[] }>();
defineSlots<{ actions?(props: { task: TaskListItem; index: number }): unknown }>();
</script>

<template>
  <v-list lines="two">
    <v-list-item v-for="(task, index) in tasks" :key="task.id" :to="`/tasks/${task.id}`" rounded="lg" class="mb-1">
      <template #prepend>
        <v-avatar :color="statusColor(task.status)" variant="tonal" size="36">
          <v-icon :icon="taskTypeIcon(task.taskType)" size="20" />
        </v-avatar>
      </template>
      <template #title>
        <span class="text-medium-emphasis">#{{ task.id }}</span> {{ task.title }}
      </template>
      <template #subtitle>{{ task.taskType }} · {{ task.executorMode }}</template>
      <template #append>
        <div class="d-flex ga-1 align-center flex-wrap justify-end" style="max-width: 220px">
          <TaskPriorityChip v-if="task.priority" :priority="task.priority" />
          <TaskStatusChip :status="task.status" />
          <slot name="actions" :task="task" :index="index" />
        </div>
      </template>
    </v-list-item>
  </v-list>
</template>
