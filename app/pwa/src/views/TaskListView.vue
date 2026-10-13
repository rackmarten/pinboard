<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useBackClose } from "@rackmarten/ui-kit";
import { useRoute, useRouter } from "vue-router";
import { useDisplay } from "vuetify";
import {
  getProjects,
  updateTask,
  TASK_STATUSES,
  TASK_TYPES,
  EXECUTOR_MODES,
  EFFORT_LEVELS,
  AUTONOMY_LEVELS,
  type Project,
  type TaskFilter,
} from "../api.js";
import { useTasks } from "../composables/useTasks.js";
import TaskFormDialog from "../components/TaskFormDialog.vue";
import TaskStatusChip from "../components/TaskStatusChip.vue";
import SortableDataTable, { type SortItem, type SortableDataTableHeader } from "../components/SortableDataTable.vue";
import { taskTypeColor, taskTypeIcon } from "../display.js";
import { groupTasks } from "../story.js";

const route = useRoute();
const router = useRouter();

// at the same `lg` (1280px+) breakpoint the layout shell (#163)
// widens the content container to ~1800px, give the table's fixed-width
// columns more room instead of leaving all the reclaimed space to Title
// alone - below `lg` the column widths stay exactly as they were before
// this task.
const { lgAndUp } = useDisplay();

// I10: filters/sort live in the URL's query params instead of component
// state alone, so a bookmark or refresh returns to the same view - read the
// initial values from the query once at mount, then keep them in sync both
// ways (a query param edited directly, e.g. a shared link, still works).
function filterFromQuery(): TaskFilter {
  const q = route.query;
  return {
    projectId: q.projectId ? Number(q.projectId) : undefined,
    status: typeof q.status === "string" ? q.status.split(",").filter(Boolean) : undefined,
    taskType: typeof q.taskType === "string" ? q.taskType : undefined,
    executorMode: typeof q.executorMode === "string" ? q.executorMode : undefined,
  };
}

const projects = ref<Project[]>([]);
const filter = ref<TaskFilter>(filterFromQuery());
// Column-header sort, persisted to the URL the same way filters are - Task
// #104's default is id desc, so the query string stays clean unless a
// column other than id is sorted.
const sortBy = ref<SortItem[]>(
  typeof route.query.sort === "string"
    ? [{ key: route.query.sort, order: route.query.dir === "asc" ? "asc" : "desc" }]
    : [{ key: "id", order: "desc" }],
);
// current page, persisted to the URL like sort/filters, so
// paging forward then navigating back (or reloading) doesn't drop you back
// to page 1. Table itself defaults to 25 rows/page (SortableDataTable).
const page = ref<number>(typeof route.query.page === "string" ? Number(route.query.page) || 1 : 1);
const showCreate = ref(false);
// bulk edit - ids of rows checked in the table's selection
// column. Covers every field an operator needs to set to queue a task
// (status, executor, effort, priority, autonomy), same set as the create/edit
// dialog's queue-relevant fields.
const selectedIds = ref<number[]>([]);
const showBulkEdit = ref(false);
useBackClose(showBulkEdit);
const bulkStatus = ref<string | null>(null);
const bulkExecutorMode = ref<string | null>(null);
const bulkEffort = ref<number | null>(null);
// Kept as a string (not `.number`-coerced) so clearing the field back to
// blank resolves to "" or null, not NaN - only a non-empty value counts as "set".
const bulkPriority = ref<string | null>("");
const bulkAutonomyLevel = ref<number | null>(null);
const bulkSaving = ref(false);
const autonomyLevelItems = AUTONOMY_LEVELS as unknown as { value: number; title: string }[];

function resetBulkEditFields(): void {
  bulkStatus.value = null;
  bulkExecutorMode.value = null;
  bulkEffort.value = null;
  bulkPriority.value = null;
  bulkAutonomyLevel.value = null;
}

const bulkEditHasChanges = computed(
  () =>
    bulkStatus.value !== null ||
    bulkExecutorMode.value !== null ||
    bulkEffort.value !== null ||
    !!bulkPriority.value ||
    bulkAutonomyLevel.value !== null,
);
// Free-text match over title/description, entirely client-side against the
// already-fetched list (no backend search endpoint - the task count here
// doesn't warrant one yet) - see PLAN.md/AGENTS.md on why keyword search
// was missing and Labels being the structured alternative to this.
const search = ref<string>(typeof route.query.q === "string" ? route.query.q : "");

const { tasks: allTasks, loading, error, load } = useTasks(filter);

// Status is a multi-select. Rejected and done tasks (accidental
// duplicates, finished work) stay in the default view's data but are hidden
// here unless the Status filter explicitly includes them - keeps them out
// of the way without deleting the row or letting a deleted/renumbered ID
// confuse later task references. Once the filter is explicit, the backend
// has already narrowed to exactly those statuses, so no further exclusion
// applies here.
const DEFAULT_HIDDEN_STATUSES = new Set(["rejected", "done"]);
const tasks = computed(() => {
  const q = search.value.trim().toLowerCase();
  const base = filter.value.status?.length
    ? allTasks.value
    : allTasks.value.filter((t) => !DEFAULT_HIDDEN_STATUSES.has(t.status));
  const matched = !q
    ? base
    : base.filter((t) => {
        return (
          t.title.toLowerCase().includes(q) ||
          (t.description ?? "").toLowerCase().includes(q) ||
          `#${t.id}` === q
        );
      });
  return matched;
});

// children of a story are nested under it. The table's own sort
// is turned into a no-op (`sortRaw` on every header) and the list is sorted
// here instead, so a story's children always follow it; top-level rows and
// each story's children are both sorted by the current column.
const COLLAPSED_KEY = "pinboard.collapsedStories";
function readCollapsed(): Set<number> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((n) => typeof n === "number") : []);
  } catch {
    return new Set();
  }
}
const collapsed = ref<Set<number>>(readCollapsed());
function toggleStory(id: number): void {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
}

function compareValues(a: unknown, b: unknown): number {
  if (a == null || a === "") return b == null || b === "" ? 0 : -1;
  if (b == null || b === "") return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: "accent" });
}

const rows = computed(() => {
  const sort = sortBy.value[0];
  const withName = (t: (typeof allTasks.value)[number]) => ({ ...t, projectName: projectName(t.projectId) });
  const sorted = tasks.value.map(withName).sort((a, b) => {
    if (sort) {
      const r = compareValues(a[sort.key as keyof typeof a], b[sort.key as keyof typeof b]);
      if (r) return sort.order === "asc" ? r : -r;
    }
    return b.id - a.id;
  });
  return groupTasks(sorted, allTasks.value.map(withName), collapsed.value).map((r) => ({
    ...r.task,
    depth: r.depth,
    progress: r.progress,
    childCount: r.childCount,
  }));
});

const compactHeaders: SortableDataTableHeader[] = [
  { title: "ID", key: "id", width: 70 },
  { title: "Title", key: "title" },
  { title: "Project", key: "projectName", width: 140 },
  { title: "Type", key: "taskType", width: 110 },
  { title: "Executor", key: "executorMode", width: 130 },
  { title: "Priority", key: "priority", align: "end", width: 90 },
  { title: "Effort", key: "estimatedEffort", align: "end", width: 90 },
  { title: "Status", key: "status", width: 170 },
  { title: "Updated", key: "updatedAt", width: 160 },
];
// Same columns, wider - the select/status cells hold a whole v-select and
// the priority cell a v-text-field, so left at the compact widths they'd
// stay just as cramped as before even with the container widened.
const desktopHeaders: SortableDataTableHeader[] = [
  { title: "ID", key: "id", width: 80 },
  { title: "Title", key: "title" },
  { title: "Project", key: "projectName", width: 200 },
  { title: "Type", key: "taskType", width: 150 },
  { title: "Executor", key: "executorMode", width: 180 },
  { title: "Priority", key: "priority", align: "end", width: 110 },
  { title: "Effort", key: "estimatedEffort", align: "end", width: 110 },
  { title: "Status", key: "status", width: 220 },
  { title: "Updated", key: "updatedAt", width: 200 },
];
const headers = computed<SortableDataTableHeader[]>(() =>
  (lgAndUp.value ? desktopHeaders : compactHeaders).map((h) => ({ ...h, sortRaw: () => 0 })),
);

// Any filter/sort/search change resets to page 1 - the current page
// otherwise stops corresponding to anything meaningful once the underlying
// result set changes.
watch([filter, sortBy, search], () => {
  page.value = 1;
}, { deep: true });

watch([filter, sortBy, search, page], () => {
  const primarySort = sortBy.value[0];
  const isDefaultSort = sortBy.value.length === 1 && primarySort?.key === "id" && primarySort.order === "desc";
  router.replace({
    query: {
      projectId: filter.value.projectId ?? undefined,
      status: filter.value.status?.length ? filter.value.status.join(",") : undefined,
      taskType: filter.value.taskType ?? undefined,
      executorMode: filter.value.executorMode ?? undefined,
      sort: isDefaultSort ? undefined : primarySort?.key,
      dir: !isDefaultSort && primarySort?.order === "asc" ? "asc" : undefined,
      q: search.value.trim() || undefined,
      page: page.value > 1 ? String(page.value) : undefined,
    },
  });
}, { deep: true });

onMounted(async () => {
  projects.value = await getProjects();
});

function projectName(id: number): string {
  return projects.value.find((p) => p.id === id)?.name ?? `#${id}`;
}

function onClickRow(_event: Event, { item }: { item: { id: number } }): void {
  router.push(`/tasks/${item.id}`);
}

// row-level quick edit - priority/executor/status directly in the
// table, without opening TaskFormDialog. Optimistic on the already-loaded
// row so the cell reflects the edit immediately, then reconciled against the
// server response (and re-fetched below if the new value would move the row
// out of the current filter, e.g. setting status to "done").
async function quickUpdate(taskId: number, patch: Partial<{ priority: number; executorMode: string; status: string }>): Promise<void> {
  const row = allTasks.value.find((t) => t.id === taskId);
  if (row) Object.assign(row, patch);
  try {
    await updateTask(taskId, patch);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    await load();
  }
}

// bulk edit - applies whichever fields the operator set (of
// status/executor/effort/priority/autonomy - the same fields needed to queue
// a task) to every selected row, leaving fields left blank untouched.
async function applyBulkEdit(): Promise<void> {
  if (!selectedIds.value.length || !bulkEditHasChanges.value) return;
  const patch: Partial<{
    status: string;
    executorMode: string;
    estimatedEffort: number;
    priority: number;
    autonomyLevel: number;
  }> = {};
  if (bulkStatus.value !== null) patch.status = bulkStatus.value;
  if (bulkExecutorMode.value !== null) patch.executorMode = bulkExecutorMode.value;
  if (bulkEffort.value !== null) patch.estimatedEffort = bulkEffort.value;
  if (bulkPriority.value) patch.priority = Number(bulkPriority.value);
  if (bulkAutonomyLevel.value !== null) patch.autonomyLevel = bulkAutonomyLevel.value;
  bulkSaving.value = true;
  try {
    await Promise.all(selectedIds.value.map((id) => updateTask(id, patch)));
    selectedIds.value = [];
    resetBulkEditFields();
    showBulkEdit.value = false;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    bulkSaving.value = false;
    await load();
  }
}
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <div class="d-flex align-center ga-2 flex-wrap">
      <h1 class="text-h5 mr-auto">Tasks</h1>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="showCreate = true">New task</v-btn>
    </div>

    <v-text-field
      v-model="search"
      label="Search title, description, or #id"
      prepend-inner-icon="mdi-magnify"
      clearable
      density="comfortable"
      hide-details
    />

    <div class="d-flex ga-3 flex-wrap">
      <v-select
        v-model="filter.projectId"
        label="Project"
        :items="projects"
        item-title="name"
        item-value="id"
        clearable
        density="comfortable"
        style="min-width: 180px"
      />
      <v-select
        v-model="filter.status"
        label="Status"
        :items="TASK_STATUSES as readonly string[]"
        multiple
        chips
        closable-chips
        clearable
        density="comfortable"
        style="min-width: 220px"
        hint="Defaults to hiding rejected/done"
        persistent-hint
      />
      <v-select
        v-model="filter.taskType"
        label="Type"
        :items="TASK_TYPES as readonly string[]"
        clearable
        density="comfortable"
        style="min-width: 160px"
      />
      <v-select
        v-model="filter.executorMode"
        label="Executor"
        :items="EXECUTOR_MODES as readonly string[]"
        clearable
        density="comfortable"
        style="min-width: 160px"
      />
    </div>

    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>

    <v-toolbar v-if="selectedIds.length" density="compact" color="surface-variant" rounded>
      <span class="text-body-2 ml-4">{{ selectedIds.length }} selected</span>
      <v-btn color="primary" class="ml-4" prepend-icon="mdi-pencil" @click="showBulkEdit = true">Bulk edit</v-btn>
      <v-btn variant="text" class="ml-1" @click="selectedIds = []">Clear</v-btn>
    </v-toolbar>

    <v-dialog v-model="showBulkEdit" max-width="500">
      <v-card title="Bulk edit">
        <v-card-text class="d-flex flex-column ga-3">
          <div class="text-body-2 text-medium-emphasis">
            Applies to {{ selectedIds.length }} selected task{{ selectedIds.length === 1 ? "" : "s" }}. Fields left
            blank are left unchanged.
          </div>
          <v-select
            v-model="bulkStatus"
            label="Status"
            :items="TASK_STATUSES as readonly string[]"
            clearable
            density="comfortable"
          />
          <v-select
            v-model="bulkExecutorMode"
            label="Executor"
            :items="EXECUTOR_MODES as readonly string[]"
            clearable
            density="comfortable"
          />
          <v-select
            v-model="bulkEffort"
            label="Effort"
            :items="EFFORT_LEVELS as readonly number[]"
            clearable
            density="comfortable"
          />
          <v-text-field
            v-model="bulkPriority"
            type="number"
            label="Priority"
            clearable
            density="comfortable"
          />
          <v-select
            v-model="bulkAutonomyLevel"
            label="Autonomy"
            :items="autonomyLevelItems"
            item-title="title"
            item-value="value"
            clearable
            density="comfortable"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="showBulkEdit = false">Cancel</v-btn>
          <v-btn color="primary" :loading="bulkSaving" :disabled="!bulkEditHasChanges" @click="applyBulkEdit">
            Apply
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <SortableDataTable
      :headers="headers"
      :items="rows"
      :loading="loading"
      :sort-by="sortBy"
      :page="page"
      show-select
      :model-value="selectedIds"
      empty-icon="mdi-format-list-checks"
      empty-title="No tasks match these filters"
      :empty-text="search ? `No title/description contains '${search}'` : undefined"
      @update:sort-by="sortBy = $event"
      @update:page="page = $event"
      @update:model-value="selectedIds = $event as number[]"
      @click:row="onClickRow"
    >
      <template #item.title="{ item }">
        <div class="d-flex align-center ga-1" :class="{ 'pl-8': item.depth === 1 }">
          <v-btn
            v-if="item.progress"
            :icon="collapsed.has(item.id) ? 'mdi-chevron-right' : 'mdi-chevron-down'"
            :disabled="!item.childCount"
            variant="text"
            size="x-small"
            density="comfortable"
            @click.stop="toggleStory(item.id)"
          />
          <v-icon v-else-if="item.depth === 1" icon="mdi-subdirectory-arrow-right" size="16" class="text-medium-emphasis" />
          <span :class="{ 'font-weight-medium': item.progress }">{{ item.title }}</span>
          <v-chip v-if="item.progress" size="x-small" variant="tonal" :color="taskTypeColor('story')" class="ml-1">
            {{ item.progress.done }}/{{ item.progress.total }}
          </v-chip>
        </div>
      </template>
      <template #item.taskType="{ item }">
        <v-icon :icon="taskTypeIcon(item.taskType)" :color="taskTypeColor(item.taskType)" size="18" class="mr-1" /> {{ item.taskType }}
      </template>
      <template #item.priority="{ item }">
        <v-text-field
          :model-value="item.priority"
          type="number"
          density="compact"
          variant="plain"
          hide-details
          style="max-width: 64px"
          @click.stop
          @update:model-value="(v) => quickUpdate(item.id, { priority: Number(v) || 0 })"
        />
      </template>
      <template #item.estimatedEffort="{ item }">
        {{ item.estimatedEffort ?? "" }}
      </template>
      <template #item.executorMode="{ item }">
        <v-select
          :model-value="item.executorMode"
          :items="EXECUTOR_MODES as readonly string[]"
          density="compact"
          variant="plain"
          hide-details
          style="max-width: 140px"
          @click.stop
          @update:model-value="(v) => quickUpdate(item.id, { executorMode: v as string })"
        />
      </template>
      <template #item.status="{ item }">
        <v-select
          :model-value="item.status"
          :items="TASK_STATUSES as readonly string[]"
          density="compact"
          variant="plain"
          hide-details
          style="max-width: 160px"
          @click.stop
          @update:model-value="(v) => quickUpdate(item.id, { status: v as string })"
        >
          <template #selection="{ item: selected }">
            <TaskStatusChip :status="selected.value as string" />
          </template>
        </v-select>
      </template>
      <template #item.updatedAt="{ item }">
        {{ new Date(item.updatedAt).toLocaleString() }}
      </template>
    </SortableDataTable>

    <TaskFormDialog
      v-model="showCreate"
      :projects="projects"
      :default-project-id="filter.projectId ?? null"
      @saved="load"
    />
  </div>
</template>
