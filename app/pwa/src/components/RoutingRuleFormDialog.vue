<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useBackClose } from "@rackmarten/ui-kit";
import {
  createRoutingRule,
  updateRoutingRule,
  TASK_TYPES,
  type Agent,
  type Label,
  type RoutingRule,
} from "../api.js";

const props = defineProps<{
  modelValue: boolean;
  rule?: RoutingRule | null;
  agents: Agent[];
  labels: Label[];
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [rule: RoutingRule];
}>();

// back closes the dialog instead of leaving the page.
const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});
useBackClose(open);

const taskType = ref<string | null>(null);
const labelName = ref<string | null>(null);
const agentId = ref<number | null>(null);
const priority = ref(0);
const enabled = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);

function reset(): void {
  const r = props.rule;
  taskType.value = r?.taskType ?? null;
  labelName.value = r?.labelName ?? null;
  agentId.value = r?.agentId ?? null;
  priority.value = r?.priority ?? 0;
  enabled.value = r?.enabled ?? true;
  error.value = null;
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) reset();
  },
);

async function save(): Promise<void> {
  if (!agentId.value) {
    error.value = "An agent is required";
    return;
  }
  saving.value = true;
  error.value = null;
  const input = {
    taskType: taskType.value,
    labelName: labelName.value,
    agentId: agentId.value,
    priority: priority.value,
    enabled: enabled.value,
  };
  try {
    const saved = props.rule ? await updateRoutingRule(props.rule.id, input) : await createRoutingRule(input);
    emit("saved", saved);
    emit("update:modelValue", false);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="480">
    <v-card :title="rule ? 'Edit routing rule' : 'New routing rule'">
      <v-card-text class="d-flex flex-column ga-3">
        <v-select
          v-model="agentId"
          :items="agents"
          item-title="name"
          item-value="id"
          label="Agent"
          density="comfortable"
        />
        <v-select
          v-model="taskType"
          :items="[...TASK_TYPES] as string[]"
          label="Task type"
          density="comfortable"
          clearable
          hint="Blank matches any task type"
          persistent-hint
        />
        <v-select
          v-model="labelName"
          :items="labels.map((l) => l.name)"
          label="Label"
          density="comfortable"
          clearable
          hint="Blank matches any label"
          persistent-hint
        />
        <v-text-field
          v-model.number="priority"
          type="number"
          label="Priority"
          density="comfortable"
          hint="Higher wins when more than one rule matches a task"
          persistent-hint
        />
        <v-switch v-model="enabled" label="Enabled" density="comfortable" hide-details />
        <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" :loading="saving" @click="save">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
