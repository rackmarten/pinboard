<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  getCostRollup,
  getUsageSummary,
  getWeeklyResetSetting,
  sendDigestNow,
  updateWeeklyResetSetting,
  type CostRollup,
  type UsageSummary,
  type WeeklyResetSetting,
} from "../api.js";

const summary = ref<UsageSummary | null>(null);
const rollup = ref<CostRollup | null>(null);
const resetSetting = ref<WeeklyResetSetting | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const view = ref<"chart" | "table">("chart");
const sendingDigest = ref(false);
const digestResult = ref<string | null>(null);
const savingSetting = ref(false);

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    [summary.value, rollup.value, resetSetting.value] = await Promise.all([
      getUsageSummary(),
      getCostRollup(),
      getWeeklyResetSetting(),
    ]);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function saveResetSetting(): Promise<void> {
  if (!resetSetting.value) return;
  savingSetting.value = true;
  try {
    resetSetting.value = await updateWeeklyResetSetting(resetSetting.value);
    [summary.value, rollup.value] = await Promise.all([getUsageSummary(), getCostRollup()]);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    savingSetting.value = false;
  }
}

// Top-level projects first (no parent, or parent not in this list), each
// followed by its own children - so a parent's rolled-up tile visually sits
// above the child rows it's summing.
const orderedProjects = computed(() => {
  const list = rollup.value?.projects ?? [];
  const byParent = new Map<number | null, typeof list>();
  for (const p of list) {
    const key = p.parentProjectId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(p);
  }
  const ids = new Set(list.map((p) => p.projectId));
  const roots = list.filter((p) => p.parentProjectId === null || !ids.has(p.parentProjectId));
  const out: { project: (typeof list)[number]; depth: number }[] = [];
  const visit = (p: (typeof list)[number], depth: number) => {
    out.push({ project: p, depth });
    for (const child of byParent.get(p.projectId) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return out;
});

const tasksByProject = computed(() => {
  const map = new Map<number, (typeof rollup.value extends null ? never : CostRollup)["tasks"]>();
  for (const t of rollup.value?.tasks ?? []) {
    if (!map.has(t.projectId)) map.set(t.projectId, []);
    map.get(t.projectId)!.push(t);
  }
  for (const list of map.values()) list.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  return map;
});

const expandedProjects = ref<Set<number>>(new Set());
function toggleProject(projectId: number): void {
  const next = new Set(expandedProjects.value);
  if (next.has(projectId)) next.delete(projectId);
  else next.add(projectId);
  expandedProjects.value = next;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const maxDailyCost = computed(() => Math.max(1, ...(summary.value?.daily.map((d) => d.costUsd) ?? [0])));

// The table is a list of what happened, not a calendar - a day with no
// sessions has nothing to report, so skip it rather than padding the table
// with $0.00 rows for the whole 30-day range (the chart still shows every
// day, since a gap in a bar chart's timeline is itself meaningful).
const activeDays = computed(() => [...(summary.value?.daily ?? [])].reverse().filter((d) => d.count > 0));

function barHeightPct(costUsd: number): number {
  return Math.max(2, (costUsd / maxDailyCost.value) * 100);
}

async function triggerDigest(): Promise<void> {
  sendingDigest.value = true;
  digestResult.value = null;
  try {
    const result = await sendDigestNow();
    digestResult.value = result.sent ? "Digest sent." : `Not sent: ${result.reason}`;
  } catch (err) {
    digestResult.value = err instanceof Error ? err.message : String(err);
  } finally {
    sendingDigest.value = false;
  }
}
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <div class="d-flex align-center justify-space-between flex-wrap ga-2">
      <h1 class="text-h5">Usage</h1>
      <div class="d-flex align-center ga-2">
        <v-btn size="small" variant="tonal" :loading="sendingDigest" @click="triggerDigest">
          Send digest now
        </v-btn>
        <v-btn-toggle v-model="view" density="compact" mandatory color="primary" variant="outlined">
          <v-btn value="chart" size="small">Chart</v-btn>
          <v-btn value="table" size="small">Table</v-btn>
        </v-btn-toggle>
      </div>
    </div>

    <v-alert v-if="digestResult" type="info" density="compact" variant="tonal" closable @click:close="digestResult = null">
      {{ digestResult }}
    </v-alert>
    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate />

    <template v-if="summary">
      <div class="d-flex flex-wrap ga-3">
        <v-card class="stat-tile" variant="tonal">
          <v-card-text>
            <div class="text-caption text-medium-emphasis">Today</div>
            <div class="text-h4">{{ formatUsd(summary.todayUsd) }}</div>
          </v-card-text>
        </v-card>
        <v-card class="stat-tile" variant="tonal">
          <v-card-text>
            <div class="text-caption text-medium-emphasis">Since reset ({{ shortDay(summary.resetStart.slice(0, 10)) }})</div>
            <div class="text-h4">{{ formatUsd(summary.sinceResetUsd) }}</div>
          </v-card-text>
        </v-card>
        <v-card class="stat-tile" variant="tonal">
          <v-card-text>
            <div class="text-caption text-medium-emphasis">This month</div>
            <div class="text-h4">{{ formatUsd(summary.monthUsd) }}</div>
          </v-card-text>
        </v-card>
      </div>

      <v-card v-if="view === 'chart'">
        <v-card-item>
          <template #title>Daily cost, last 30 days</template>
        </v-card-item>
        <v-card-text>
          <div class="bar-chart">
            <div v-for="d in summary.daily" :key="d.day" class="bar-col">
              <div class="bar-track">
                <div class="bar" :style="{ height: barHeightPct(d.costUsd) + '%' }" tabindex="0">
                  <v-tooltip activator="parent" location="top">
                    {{ shortDay(d.day) }}: {{ formatUsd(d.costUsd) }} ({{ d.count }} session{{ d.count === 1 ? "" : "s" }})
                  </v-tooltip>
                </div>
              </div>
            </div>
          </div>
          <div class="d-flex justify-space-between text-caption text-medium-emphasis mt-1">
            <span>{{ shortDay(summary.daily[0]?.day ?? "") }}</span>
            <span>{{ shortDay(summary.daily[summary.daily.length - 1]?.day ?? "") }}</span>
          </div>
        </v-card-text>
      </v-card>

      <template v-else>
        <v-table v-if="activeDays.length" density="compact">
          <thead>
            <tr>
              <th>Date</th>
              <th class="text-right">Cost</th>
              <th class="text-right">Sessions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in activeDays" :key="d.day">
              <td>{{ d.day }}</td>
              <td class="text-right tabular-nums">{{ formatUsd(d.costUsd) }}</td>
              <td class="text-right tabular-nums">{{ d.count }}</td>
            </tr>
          </tbody>
        </v-table>
        <v-empty-state v-else icon="mdi-currency-usd-off" title="No sessions in the last 30 days" />
      </template>

      <v-card>
        <v-card-item>
          <template #title>Cost by project</template>
          <template #subtitle>
            Rolled-up total includes each project's own tasks plus every child project's spend
          </template>
        </v-card-item>
        <v-table density="compact">
          <thead>
            <tr>
              <th>Project</th>
              <th class="text-right">Since reset</th>
              <th class="text-right">All-time (own)</th>
              <th class="text-right">All-time (rolled up)</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="{ project, depth } in orderedProjects" :key="project.projectId">
              <tr>
                <td>
                  <v-btn
                    v-if="(tasksByProject.get(project.projectId)?.length ?? 0) > 0"
                    :icon="expandedProjects.has(project.projectId) ? 'mdi-chevron-down' : 'mdi-chevron-right'"
                    size="x-small"
                    variant="text"
                    density="compact"
                    :style="{ marginLeft: depth * 20 + 'px' }"
                    @click="toggleProject(project.projectId)"
                  />
                  <span v-else :style="{ marginLeft: depth * 20 + 24 + 'px' }" />
                  {{ project.name }}
                </td>
                <td class="text-right tabular-nums">{{ formatUsd(project.rolledUpSinceResetCostUsd) }}</td>
                <td class="text-right tabular-nums">{{ formatUsd(project.ownCostUsd) }}</td>
                <td class="text-right tabular-nums">{{ formatUsd(project.rolledUpCostUsd) }}</td>
              </tr>
              <template v-if="expandedProjects.has(project.projectId)">
                <tr v-for="t in tasksByProject.get(project.projectId)" :key="t.taskId">
                  <td class="text-medium-emphasis" :style="{ paddingLeft: (depth + 1) * 20 + 24 + 'px' }">
                    #{{ t.taskId }} {{ t.title }}
                  </td>
                  <td class="text-right tabular-nums text-medium-emphasis">{{ formatUsd(t.sinceResetCostUsd) }}</td>
                  <td class="text-right tabular-nums text-medium-emphasis">{{ formatUsd(t.totalCostUsd) }}</td>
                  <td class="text-right tabular-nums text-medium-emphasis">-</td>
                </tr>
              </template>
            </template>
          </tbody>
        </v-table>
        <v-empty-state v-if="!orderedProjects.length" icon="mdi-folder-outline" title="No projects yet" />
      </v-card>

      <v-card>
        <v-card-item>
          <template #title>Weekly reset</template>
          <template #subtitle>When your plan allowance resets - used to scope "since reset" above</template>
        </v-card-item>
        <v-card-text v-if="resetSetting" class="d-flex align-center ga-3 flex-wrap">
          <v-select
            v-model="resetSetting.dayOfWeek"
            :items="DAY_NAMES.map((name, value) => ({ title: name, value }))"
            label="Day"
            density="compact"
            hide-details
            style="max-width: 180px"
          />
          <v-select
            v-model="resetSetting.hour"
            :items="Array.from({ length: 24 }, (_, h) => ({ title: `${h}:00`, value: h }))"
            label="Hour (server-local time)"
            density="compact"
            hide-details
            style="max-width: 220px"
          />
          <v-btn size="small" color="primary" :loading="savingSetting" @click="saveResetSetting">Save</v-btn>
        </v-card-text>
      </v-card>
    </template>
  </div>
</template>

<style scoped>
.stat-tile {
  min-width: 140px;
  flex: 1;
}

.bar-chart {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 160px;
}

.bar-col {
  flex: 1;
  display: flex;
  align-items: flex-end;
  min-width: 0;
}

.bar-track {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-end;
}

.bar {
  width: 100%;
  max-width: 24px;
  margin: 0 auto;
  border-radius: 4px 4px 0 0;
  background: rgb(var(--v-theme-primary));
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
