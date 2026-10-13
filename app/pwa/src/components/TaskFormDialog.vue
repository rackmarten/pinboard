<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useBackClose } from "@rackmarten/ui-kit";
import {
  addTaskLabel,
  createLabel,
  createTask,
  getLabels,
  removeTaskLabel,
  updateTask,
  AUTONOMY_LEVELS,
  EFFORT_LEVELS,
  EXECUTOR_MODES,
  ROOT_LABEL,
  TASK_STATUSES,
  TASK_TYPES,
  type Label,
  type Project,
  type Task,
  type TaskDetail,
} from "../api.js";
import DescriptionEditor from "./DescriptionEditor.vue";

const props = defineProps<{
  modelValue: boolean;
  projects: Project[];
  task?: Task | TaskDetail | null;
  defaultProjectId?: number | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [task: Task];
}>();

// back closes the dialog instead of leaving the page.
const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});
useBackClose(open);

const projectId = ref<number | null>(null);
const title = ref("");
const description = ref("");
const taskType = ref<string>("implementation");
const status = ref<string>("idea");
const executorMode = ref<string>("human");
const priority = ref(0);
const estimatedEffort = ref<number | null>(null);
const autonomyLevel = ref<number | null>(null);
const relatedProjectIds = ref<number[]>([]);
// CTIDs, only shown once the task carries the root-access label.
const rootScope = ref<string[]>([]);
const autonomyLevelItems = AUTONOMY_LEVELS as unknown as { value: number; title: string }[];
const saving = ref(false);
const error = ref<string | null>(null);

// a project reference (id under the hood, name/slug shown),
// not a repo path string - excludes this task's own project, which is
// already implied.
const relatedProjectOptions = computed(() => props.projects.filter((p) => p.id !== projectId.value));

// I10: label assignment - existing labels can be picked, or a new name
// typed in and created on save (combobox allows values with no matching item).
const allLabels = ref<Label[]>([]);
const selectedLabelNames = ref<string[]>([]);

function taskLabels(t: Task | TaskDetail | null | undefined): { id: number; name: string }[] {
  return "labels" in (t ?? {}) ? (t as TaskDetail).labels : [];
}

function reset(): void {
  const t = props.task;
  projectId.value = t?.projectId ?? props.defaultProjectId ?? props.projects[0]?.id ?? null;
  title.value = t?.title ?? "";
  description.value = t?.description ?? "";
  taskType.value = t?.taskType ?? "implementation";
  status.value = t?.status ?? "idea";
  executorMode.value = t?.executorMode ?? "human";
  priority.value = t?.priority ?? 0;
  estimatedEffort.value = t?.estimatedEffort ?? null;
  autonomyLevel.value = t?.autonomyLevel ?? null;
  relatedProjectIds.value = t?.relatedProjectIds ?? [];
  rootScope.value = (t?.rootScope ?? []).map(String);
  selectedLabelNames.value = taskLabels(t).map((l) => l.name);
  error.value = null;
  getLabels().then((labels) => {
    allLabels.value = labels;
  });
}

watch(() => props.modelValue, (open) => {
  if (open) reset();
});

// Creates any typed-in names that don't match an existing label, then
// reconciles the task's assigned labels against the previously-assigned
// set (a brand-new task has none yet, so every selected name is an add).
async function syncLabels(taskId: number): Promise<void> {
  const previouslyAssigned = new Set(taskLabels(props.task).map((l) => l.id));
  const nameToId = new Map(allLabels.value.map((l) => [l.name, l.id]));

  const desiredIds = new Set<number>();
  for (const name of selectedLabelNames.value) {
    let id = nameToId.get(name);
    if (id === undefined) {
      const created = await createLabel(name);
      id = created.id;
      nameToId.set(name, id);
    }
    desiredIds.add(id);
  }

  for (const id of desiredIds) {
    if (!previouslyAssigned.has(id)) await addTaskLabel(taskId, id);
  }
  for (const id of previouslyAssigned) {
    if (!desiredIds.has(id)) await removeTaskLabel(taskId, id);
  }
}

// set when the server's readiness lint refused a move to queued.
const lintFailed = ref(false);

async function save(force = false): Promise<void> {
  lintFailed.value = false;
  if (!projectId.value || !title.value.trim()) {
    error.value = "Project and title are required";
    return;
  }
  const badCtid = rootScope.value.find((v) => !/^\d+$/.test(String(v).trim()));
  if (badCtid !== undefined) {
    error.value = `Root scope entries must be CTIDs (numbers), got "${badCtid}"`;
    return;
  }
  saving.value = true;
  error.value = null;
  const input = {
    projectId: projectId.value,
    title: title.value.trim(),
    description: description.value || undefined,
    taskType: taskType.value,
    status: status.value,
    executorMode: executorMode.value,
    priority: priority.value,
    estimatedEffort: estimatedEffort.value,
    autonomyLevel: autonomyLevel.value,
    relatedProjectIds: relatedProjectIds.value,
    rootScope: rootScope.value.map((v) => Number(String(v).trim())),
    ...(force ? { force: true } : {}),
  };
  try {
    const saved = props.task ? await updateTask(props.task.id, input) : await createTask(input);
    await syncLabels(saved.id);
    emit("saved", saved);
    emit("update:modelValue", false);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    lintFailed.value = (err as { status?: number }).status === 422;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="900">
    <v-card :title="task ? 'Edit task' : 'New task'">
      <v-card-text class="d-flex flex-column ga-3">
        <v-select
          v-model="projectId"
          label="Project"
          :items="projects"
          item-title="name"
          item-value="id"
          density="comfortable"
        />
        <v-text-field v-model="title" label="Title" density="comfortable" autofocus />
        <div>
          <div class="text-caption text-medium-emphasis mb-1">Description</div>
          <DescriptionEditor v-model="description" />
        </div>
        <div class="d-flex ga-3">
          <v-select v-model="taskType" label="Type" :items="TASK_TYPES as readonly string[]" density="comfortable" />
          <v-select v-model="status" label="Status" :items="TASK_STATUSES as readonly string[]" density="comfortable" />
        </div>
        <div class="d-flex ga-3">
          <v-select v-model="executorMode" label="Executor" :items="EXECUTOR_MODES as readonly string[]" density="comfortable" />
          <v-select
            v-model="estimatedEffort"
            label="Effort"
            :items="EFFORT_LEVELS as readonly number[]"
            clearable
            density="comfortable"
          />
        </div>
        <div class="d-flex ga-3">
          <v-text-field v-model.number="priority" type="number" label="Priority" density="comfortable" />
          <v-select
            v-model="autonomyLevel"
            label="Autonomy"
            :items="autonomyLevelItems"
            item-title="title"
            item-value="value"
            clearable
            density="comfortable"
          />
        </div>
        <v-select
          v-model="relatedProjectIds"
          label="Related projects"
          :items="relatedProjectOptions"
          item-title="name"
          item-value="id"
          multiple
          chips
          closable-chips
          density="comfortable"
          hint="Other projects this task needs write access to, on top of its own project and related projects"
          persistent-hint
        />
        <v-combobox
          v-model="selectedLabelNames"
          label="Labels"
          :items="allLabels.map((l) => l.name)"
          multiple
          chips
          closable-chips
          density="comfortable"
          hint="Type a new name and press enter to create a label"
          persistent-hint
        />
        <v-combobox
          v-if="selectedLabelNames.includes(ROOT_LABEL)"
          v-model="rootScope"
          label="Root scope (CTIDs)"
          multiple
          chips
          closable-chips
          density="comfortable"
          hint="Containers this task may get root on once you grant it. Type a CTID and press enter."
          persistent-hint
        />
        <v-alert v-if="error" type="error" density="compact" variant="tonal">
          {{ error }}
          <template v-if="lintFailed" #append>
            <v-btn size="small" variant="text" :loading="saving" @click="save(true)">Queue anyway</v-btn>
          </template>
        </v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" :loading="saving" @click="save()">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
