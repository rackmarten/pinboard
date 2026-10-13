<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  getBudgetRateHistory,
  getBudgetRates,
  getGovernorStatus,
  getObservations,
  recordBudgetRate,
  recordObservation,
  type BudgetRate,
  type BudgetRateHistoryEntry,
  type GovernorStatus,
  type Observation,
  type Scope,
} from "../api.js";
import { usePolling } from "../composables/usePolling.js";

const status = ref<GovernorStatus | null>(null);
const history = ref<Observation[]>([]);
const currentRate = ref<BudgetRate | null>(null);
const rateHistory = ref<BudgetRateHistoryEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const formScope = ref<Scope>("week");
const formPercent = ref<number | null>(null);
const formNote = ref("");
const submitting = ref(false);
const submitError = ref<string | null>(null);

const rateFormSessionUsd = ref<number | null>(null);
const rateFormWeekUsd = ref<number | null>(null);
const rateFormNote = ref("");
const rateSubmitting = ref(false);
const rateSubmitError = ref<string | null>(null);

async function load(): Promise<void> {
  error.value = null;
  try {
    const [s, h, rates, rateHist] = await Promise.all([
      getGovernorStatus(),
      getObservations(undefined, 20),
      getBudgetRates(1),
      getBudgetRateHistory(20),
    ]);
    status.value = s;
    history.value = h;
    currentRate.value = rates[0] ?? null;
    rateHistory.value = rateHist;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(async () => {
  loading.value = true;
  await load();
  loading.value = false;
});
usePolling(load);

async function submitObservation(): Promise<void> {
  if (formPercent.value === null) return;
  submitting.value = true;
  submitError.value = null;
  try {
    await recordObservation(formScope.value, formPercent.value, formNote.value || undefined);
    formPercent.value = null;
    formNote.value = "";
    await load();
  } catch (err) {
    submitError.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}

const STATE_COLOR: Record<string, string> = {
  healthy: "success",
  unconfigured: "grey",
  over_rate: "warning",
  danger: "orange-darken-2",
  critical: "error",
};

const STATE_LABEL: Record<string, string> = {
  healthy: "Healthy",
  unconfigured: "Unconfigured",
  over_rate: "Over rate",
  danger: "Danger",
  critical: "Critical",
};

function formatAge(ms: number | null): string {
  if (ms === null) return "never recorded";
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m ago`;
  if (hours < 48) return `${hours.toFixed(1)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatUsd(n: number | null): string {
  return n === null ? "-" : `$${n.toFixed(2)}`;
}

function formatDollarsPerPercent(n: number | null): string {
  return n === null ? "not enough data yet" : `~$${n.toFixed(2)}/1%`;
}

function formatEstimatedPercent(n: number | null): string {
  return n === null ? "no rate recorded yet" : `~${n.toFixed(1)}% (estimate)`;
}

async function submitRate(): Promise<void> {
  if (rateFormSessionUsd.value === null || rateFormWeekUsd.value === null) return;
  rateSubmitting.value = true;
  rateSubmitError.value = null;
  try {
    await recordBudgetRate(rateFormSessionUsd.value, rateFormWeekUsd.value, rateFormNote.value || undefined);
    rateFormSessionUsd.value = null;
    rateFormWeekUsd.value = null;
    rateFormNote.value = "";
    await load();
  } catch (err) {
    rateSubmitError.value = err instanceof Error ? err.message : String(err);
  } finally {
    rateSubmitting.value = false;
  }
}
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <div class="d-flex align-center justify-space-between flex-wrap ga-2">
      <h1 class="text-h5">Governor</h1>
      <v-chip v-if="status" :color="STATE_COLOR[status.state]" variant="flat" size="large">
        {{ STATE_LABEL[status.state] }}
      </v-chip>
    </div>

    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate />

    <template v-if="status">
      <div class="d-flex flex-wrap ga-3">
        <v-card v-for="scope in [status.week, status.session]" :key="scope.scope" class="scope-card">
          <v-card-item>
            <template #title>{{ scope.scope === "week" ? "Weekly allowance" : "5h session allowance" }}</template>
            <template #subtitle>{{ formatAge(scope.ageMs) }}</template>
          </v-card-item>
          <v-card-text>
            <template v-if="scope.latestObservation">
              <div class="d-flex align-center ga-2">
                <div class="text-h4">{{ scope.latestObservation.percentRemaining }}%</div>
                <v-chip size="x-small" :color="scope.latestObservation.source === 'manual' ? 'primary' : 'grey'" variant="tonal">
                  {{ scope.latestObservation.source === "manual" ? "manual" : "auto-derived" }}
                </v-chip>
              </div>
              <div class="text-caption text-medium-emphasis">
                {{ scope.availablePercent }}% available after reserve
              </div>
              <div class="text-caption text-medium-emphasis mt-2">
                Spent by agents since last check: {{ formatUsd(scope.costSinceObservationUsd) }}
              </div>
              <div class="text-caption text-medium-emphasis">
                Implied rate: {{ formatDollarsPerPercent(scope.impliedDollarsPerPercent) }}
              </div>
              <div class="text-caption text-medium-emphasis">
                Estimated %-used since last check: {{ formatEstimatedPercent(scope.estimatedPercentUsedSinceObservation) }}
              </div>
              <div v-if="scope.latestObservation.note" class="text-caption text-medium-emphasis mt-1">
                "{{ scope.latestObservation.note }}"
              </div>
            </template>
            <div v-else class="text-medium-emphasis">No observation recorded yet.</div>
          </v-card-text>
        </v-card>
      </div>

      <v-card>
        <v-card-item>
          <template #title>Record an allowance check</template>
          <template #subtitle>Punch in the whole-number % Claude's own UI currently shows.</template>
        </v-card-item>
        <v-card-text>
          <v-alert v-if="submitError" type="error" density="compact" variant="tonal" class="mb-3">{{ submitError }}</v-alert>
          <div class="d-flex flex-wrap ga-2 align-start">
            <v-select
              v-model="formScope"
              :items="[
                { title: 'Week', value: 'week' },
                { title: '5h session', value: 'session' },
              ]"
              label="Scope"
              density="compact"
              variant="outlined"
              style="max-width: 160px"
            />
            <v-text-field
              v-model.number="formPercent"
              type="number"
              min="0"
              max="100"
              label="% remaining"
              density="compact"
              variant="outlined"
              style="max-width: 140px"
            />
            <v-text-field v-model="formNote" label="Note (optional)" density="compact" variant="outlined" style="flex: 1; min-width: 160px" />
            <v-btn color="primary" :loading="submitting" :disabled="formPercent === null" @click="submitObservation">Record</v-btn>
          </div>
        </v-card-text>
      </v-card>

      <v-card>
        <v-card-item>
          <template #title>Budget rate</template>
          <template #subtitle>
            $-to-% conversion, so real costUsd can be turned into an estimated %-of-window without a fresh allowance reading.
          </template>
        </v-card-item>
        <v-card-text>
          <div v-if="currentRate" class="text-caption text-medium-emphasis mb-3">
            Current: ${{ currentRate.usdPerSessionPercent.toFixed(2) }}/1% (session), ${{ currentRate.usdPerWeekPercent.toFixed(2) }}/1% (week) - effective
            {{ new Date(currentRate.effectiveFrom).toLocaleString() }}
          </div>
          <div v-else class="text-medium-emphasis mb-3">No rate recorded yet.</div>
          <v-alert v-if="rateSubmitError" type="error" density="compact" variant="tonal" class="mb-3">{{ rateSubmitError }}</v-alert>
          <div class="d-flex flex-wrap ga-2 align-start">
            <v-text-field
              v-model.number="rateFormSessionUsd"
              type="number"
              step="0.01"
              min="0"
              label="$ per 1% (session)"
              density="compact"
              variant="outlined"
              style="max-width: 180px"
            />
            <v-text-field
              v-model.number="rateFormWeekUsd"
              type="number"
              step="0.01"
              min="0"
              label="$ per 1% (week)"
              density="compact"
              variant="outlined"
              style="max-width: 180px"
            />
            <v-text-field v-model="rateFormNote" label="Note (optional)" density="compact" variant="outlined" style="flex: 1; min-width: 160px" />
            <v-btn
              color="primary"
              :loading="rateSubmitting"
              :disabled="rateFormSessionUsd === null || rateFormWeekUsd === null"
              @click="submitRate"
            >
              Record
            </v-btn>
          </div>
        </v-card-text>
      </v-card>

      <v-card>
        <v-card-item>
          <template #title>Concurrency</template>
        </v-card-item>
        <v-card-text>
          <div class="d-flex flex-wrap ga-3 mb-2">
            <div class="text-body-2">
              Global: {{ status.concurrency.executing.length }}/{{ status.concurrency.limits.global }}
            </div>
            <div class="text-body-2">Per project: limit {{ status.concurrency.limits.perProject }}</div>
            <div class="text-body-2">Per agent: limit {{ status.concurrency.limits.perAgent }}</div>
            <div class="text-body-2">Per provider: limit {{ status.concurrency.limits.perProvider }}</div>
          </div>
          <v-table v-if="status.concurrency.executing.length" density="compact">
            <thead>
              <tr>
                <th>Task</th>
                <th>Project</th>
                <th>Agent</th>
                <th>Provider</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in status.concurrency.executing" :key="t.taskId">
                <td><router-link :to="`/tasks/${t.taskId}`">#{{ t.taskId }}</router-link></td>
                <td>{{ t.projectId }}</td>
                <td>{{ t.actorName ?? "-" }}</td>
                <td>{{ t.provider ?? "-" }}</td>
              </tr>
            </tbody>
          </v-table>
          <div v-else class="text-medium-emphasis">Nothing currently executing.</div>
        </v-card-text>
      </v-card>

      <div class="text-caption text-medium-emphasis">
        Next weekly reset: {{ new Date(status.nextWeeklyResetAt).toLocaleString() }} (in
        {{ status.hoursUntilWeeklyReset.toFixed(1) }}h)
      </div>

      <v-card v-if="history.length">
        <v-card-item>
          <template #title>Observation history</template>
        </v-card-item>
        <v-table density="compact">
          <thead>
            <tr>
              <th>When</th>
              <th>Scope</th>
              <th>Source</th>
              <th class="text-right">%</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in history" :key="o.id">
              <td>{{ new Date(o.observedAt).toLocaleString() }}</td>
              <td>{{ o.scope }}</td>
              <td>{{ o.source }}</td>
              <td class="text-right tabular-nums">{{ o.percentRemaining }}%</td>
              <td>{{ o.note ?? "" }}</td>
            </tr>
          </tbody>
        </v-table>
      </v-card>

      <v-card v-if="rateHistory.length">
        <v-card-item>
          <template #title>Budget rate history</template>
          <template #subtitle>Every recorded $-to-% rate, oldest to newest, to see how it drifts over time.</template>
        </v-card-item>
        <v-table density="compact">
          <thead>
            <tr>
              <th>When</th>
              <th class="text-right">$/1% (session)</th>
              <th class="text-right">$/1% (week)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rateHistory" :key="r.id">
              <td>{{ new Date(r.recordedAt).toLocaleString() }}</td>
              <td class="text-right tabular-nums">${{ r.usdPerSessionPercent.toFixed(2) }}</td>
              <td class="text-right tabular-nums">${{ r.usdPerWeekPercent.toFixed(2) }}</td>
            </tr>
          </tbody>
        </v-table>
      </v-card>
    </template>
  </div>
</template>

<style scoped>
.scope-card {
  min-width: 260px;
  flex: 1;
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
