<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  getAgents,
  getRoutingRules,
  getLabels,
  updateAgent,
  deleteRoutingRule,
  type Agent,
  type RoutingRule,
  type Label,
} from "../api.js";
import AgentFormDialog from "../components/AgentFormDialog.vue";
import RoutingRuleFormDialog from "../components/RoutingRuleFormDialog.vue";

const agents = ref<Agent[]>([]);
const rules = ref<RoutingRule[]>([]);
const labels = ref<Label[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const showAgentForm = ref(false);
const editingAgent = ref<Agent | null>(null);
const showRuleForm = ref(false);
const editingRule = ref<RoutingRule | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    [agents.value, rules.value, labels.value] = await Promise.all([getAgents(), getRoutingRules(), getLabels()]);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function agentName(id: number): string {
  return agents.value.find((a) => a.id === id)?.name ?? `#${id}`;
}

function openCreateAgent(): void {
  editingAgent.value = null;
  showAgentForm.value = true;
}

function openEditAgent(agent: Agent): void {
  editingAgent.value = agent;
  showAgentForm.value = true;
}

async function toggleAgentEnabled(agent: Agent): Promise<void> {
  try {
    await updateAgent(agent.id, { enabled: !agent.enabled });
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function openCreateRule(): void {
  editingRule.value = null;
  showRuleForm.value = true;
}

function openEditRule(rule: RoutingRule): void {
  editingRule.value = rule;
  showRuleForm.value = true;
}

async function removeRule(rule: RoutingRule): Promise<void> {
  try {
    await deleteRoutingRule(rule.id);
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<template>
  <div class="d-flex flex-column ga-6">
    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate />

    <div class="d-flex flex-column ga-4">
      <div class="d-flex align-center ga-2 flex-wrap">
        <h1 class="text-h5 mr-auto">Agents</h1>
        <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreateAgent">New agent</v-btn>
      </div>

      <v-list v-if="agents.length" lines="two">
        <v-list-item v-for="agent in agents" :key="agent.id" rounded="lg" class="mb-1">
          <template #title>
            {{ agent.name }}
            <v-chip v-if="agent.role" size="x-small" variant="tonal" class="ml-1">{{ agent.role }}</v-chip>
            <v-chip v-if="agent.isHost" size="x-small" variant="tonal" color="primary" class="ml-1">host</v-chip>
            <v-chip v-if="!agent.enabled" size="x-small" variant="tonal" color="grey" class="ml-1">disabled</v-chip>
          </template>
          <template #subtitle>
            {{ agent.provider }}/{{ agent.executor }}<span v-if="agent.model"> · {{ agent.model }}</span>
            · autonomy ≤{{ agent.autonomyLevel }} · weight {{ agent.routingWeight }}
            <span v-if="agent.credentialRef"> · cred: {{ agent.credentialRef }}</span>
          </template>
          <template #append>
            <v-btn icon="mdi-pencil" variant="text" size="small" @click="openEditAgent(agent)" />
            <v-btn
              :icon="agent.enabled ? 'mdi-toggle-switch' : 'mdi-toggle-switch-off-outline'"
              variant="text"
              size="small"
              @click="toggleAgentEnabled(agent)"
            />
          </template>
        </v-list-item>
      </v-list>
      <v-empty-state v-else-if="!loading" icon="mdi-robot-outline" title="No agents yet" />
    </div>

    <v-divider />

    <div class="d-flex flex-column ga-4">
      <div class="d-flex align-center ga-2 flex-wrap">
        <div class="mr-auto">
          <h1 class="text-h5">Routing rules</h1>
          <div class="text-body-2 text-medium-emphasis">
            Which agent runs a task automatically when none is explicitly assigned, matched by task type and/or
            label. Highest priority wins; ties break on the agent's own routing weight.
          </div>
        </div>
        <v-btn color="primary" prepend-icon="mdi-plus" :disabled="!agents.length" @click="openCreateRule">
          New rule
        </v-btn>
      </div>

      <v-list v-if="rules.length" lines="two">
        <v-list-item v-for="rule in rules" :key="rule.id" rounded="lg" class="mb-1">
          <template #title>
            <v-chip size="x-small" variant="tonal" color="primary" class="mr-1">{{ agentName(rule.agentId) }}</v-chip>
            <span v-if="rule.taskType">{{ rule.taskType }}</span>
            <span v-else class="text-medium-emphasis">any task type</span>
            <span v-if="rule.labelName"> + label "{{ rule.labelName }}"</span>
            <v-chip v-if="!rule.enabled" size="x-small" variant="tonal" color="grey" class="ml-1">disabled</v-chip>
          </template>
          <template #subtitle>priority {{ rule.priority }}</template>
          <template #append>
            <v-btn icon="mdi-pencil" variant="text" size="small" @click="openEditRule(rule)" />
            <v-btn icon="mdi-delete-outline" variant="text" size="small" @click="removeRule(rule)" />
          </template>
        </v-list-item>
      </v-list>
      <v-empty-state
        v-else-if="!loading"
        icon="mdi-signpost-outline"
        title="No routing rules yet"
        text="Tasks fall back to the runner's default agent until a rule is added."
      />
    </div>

    <AgentFormDialog v-model="showAgentForm" :agent="editingAgent" @saved="load" />
    <RoutingRuleFormDialog v-model="showRuleForm" :rule="editingRule" :agents="agents" :labels="labels" @saved="load" />
  </div>
</template>
