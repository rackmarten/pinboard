<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useBackClose } from "@rackmarten/ui-kit";
import { createAgent, updateAgent, getLicenses, AUTONOMY_LEVELS, type Agent, type License } from "../api.js";

const props = defineProps<{
  modelValue: boolean;
  agent?: Agent | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [agent: Agent];
}>();

// back closes the dialog instead of leaving the page.
const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});
useBackClose(open);

const name = ref("");
const role = ref("");
const provider = ref("");
const model = ref("");
const executor = ref("");
const autonomyLevel = ref(0);
const credentialRef = ref("");
const routingWeight = ref(1);
const enabled = ref(true);
const isHost = ref(false);
const licenseId = ref<number | null>(null);
const licenses = ref<License[]>([]);
const saving = ref(false);
const error = ref<string | null>(null);

function reset(): void {
  const a = props.agent;
  name.value = a?.name ?? "";
  role.value = a?.role ?? "";
  provider.value = a?.provider ?? "";
  model.value = a?.model ?? "";
  executor.value = a?.executor ?? "";
  autonomyLevel.value = a?.autonomyLevel ?? 0;
  credentialRef.value = a?.credentialRef ?? "";
  routingWeight.value = a?.routingWeight ?? 1;
  enabled.value = a?.enabled ?? true;
  isHost.value = a?.isHost ?? false;
  licenseId.value = a?.licenseId ?? licenses.value[0]?.id ?? null;
  error.value = null;
}

onMounted(async () => {
  licenses.value = await getLicenses();
  if (props.modelValue) reset();
});

watch(
  () => props.modelValue,
  (open) => {
    if (open) reset();
  },
);

async function save(): Promise<void> {
  if (!name.value.trim() || !provider.value.trim() || !executor.value.trim() || !licenseId.value) {
    error.value = "Name, provider, executor and license are required";
    return;
  }
  saving.value = true;
  error.value = null;
  const input = {
    role: role.value.trim() || undefined,
    provider: provider.value.trim(),
    model: model.value.trim() || undefined,
    executor: executor.value.trim(),
    autonomyLevel: autonomyLevel.value,
    credentialRef: credentialRef.value.trim() || undefined,
    routingWeight: routingWeight.value,
    enabled: enabled.value,
    isHost: isHost.value,
    licenseId: licenseId.value,
  };
  try {
    // name is only settable on create - see routes.ts's PATCH /agents/:id.
    const saved = props.agent ? await updateAgent(props.agent.id, input) : await createAgent({ ...input, name: name.value.trim() });
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
  <v-dialog v-model="open" max-width="520">
    <v-card :title="agent ? 'Edit agent' : 'New agent'">
      <v-card-text class="d-flex flex-column ga-3">
        <v-text-field v-model="name" label="Name" density="comfortable" :disabled="!!agent" autofocus />
        <v-text-field v-model="role" label="Role" density="comfortable" hint="e.g. code-runner, planning-chat" persistent-hint />
        <div class="d-flex ga-3">
          <v-text-field v-model="provider" label="Provider" density="comfortable" hint="e.g. anthropic, 8ball, human" persistent-hint />
          <v-text-field v-model="executor" label="Executor" density="comfortable" hint="e.g. cli, api, human" persistent-hint />
        </div>
        <v-text-field v-model="model" label="Model" density="comfortable" hint="Leave blank to use foreman's own default" persistent-hint />
        <v-select v-model="autonomyLevel" :items="AUTONOMY_LEVELS" item-title="title" item-value="value" label="Max autonomy level" density="comfortable" />
        <v-select
          v-model="licenseId"
          :items="licenses"
          item-title="name"
          item-value="id"
          label="License"
          density="comfortable"
          hint="Which account/seat this agent runs under - determines its Linux user and budget scope"
          persistent-hint
        />
        <v-text-field
          v-model="credentialRef"
          label="Credential reference"
          density="comfortable"
          hint="Name foreman resolves against its own secret store - never a real credential"
          persistent-hint
        />
        <v-text-field v-model.number="routingWeight" type="number" min="0" label="Routing weight" density="comfortable" hint="Tie-break among routing rules of equal priority - higher wins" persistent-hint />
        <v-switch v-model="enabled" label="Enabled" density="comfortable" hide-details />
        <v-switch
          v-model="isHost"
          label="Host persona (unrestricted chat access)"
          density="comfortable"
          hint="Chat threads on this agent get full tool access instead of the restricted read-only planning persona - one per license, at most"
          persistent-hint
        />
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
