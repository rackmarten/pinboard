<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { getMyTime, updateMySettings, type MyTime, type WaitStat } from "../api.js";
import { setTracking } from "../activity-tracker.js";
import { router, trackedRoute } from "../router.js";

const data = ref<MyTime | null>(null);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    data.value = await getMyTime();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function toggleTracking(enabled: boolean | null): Promise<void> {
  saving.value = true;
  try {
    const s = await updateMySettings(Boolean(enabled));
    setTracking(s.usageTracking, () => trackedRoute(router));
    if (data.value) data.value.usageTracking = s.usageTracking;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

const maxDaily = computed(() => Math.max(1, ...(data.value?.activity.daily.map((d) => d.activeMinutes) ?? [0])));

function barHeightPct(minutes: number): number {
  return Math.max(2, (minutes / maxDaily.value) * 100);
}

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatMinutes(n: number): string {
  return n >= 60 ? `${(n / 60).toFixed(1)} h` : `${Math.round(n)} min`;
}

function formatWait(s: WaitStat): string {
  if (!s.count || s.medianHours === null) return "-";
  const h = s.medianHours;
  return `${h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`} (${s.count})`;
}

const WAIT_COLUMNS = [
  { key: "asks", label: "Questions answered" },
  { key: "review", label: "In review" },
  { key: "defined", label: "Defined, not queued" },
  { key: "humanQueued", label: "Human tasks queued" },
] as const;

// newest week first, like the rest of the tables here
const waitingWeeks = computed(() => [...(data.value?.waiting ?? [])].reverse());
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate />

    <template v-if="data">
      <v-card>
        <v-card-text class="d-flex align-center flex-wrap ga-3">
          <v-switch
            :model-value="data.usageTracking"
            :loading="saving"
            color="primary"
            density="compact"
            hide-details
            label="Track my time in pinboard"
            data-track="toggle-time-tracking"
            @update:model-value="toggleTracking"
          />
          <span class="text-caption text-medium-emphasis">
            Active minutes per screen and clicks on main actions, for {{ data.actor }} only. Raw events are kept 90 days,
            per-minute totals indefinitely.
          </span>
        </v-card-text>
      </v-card>

      <div class="d-flex flex-wrap ga-3">
        <v-card class="stat-tile" variant="tonal">
          <v-card-text>
            <div class="text-caption text-medium-emphasis">Active, last {{ data.days }} days</div>
            <div class="text-h4">{{ formatMinutes(data.activity.totalActiveMinutes) }}</div>
          </v-card-text>
        </v-card>
      </div>

      <v-card>
        <v-card-item>
          <template #title>Active minutes per day</template>
        </v-card-item>
        <v-card-text>
          <div class="bar-chart">
            <div v-for="d in data.activity.daily" :key="d.day" class="bar-col">
              <div class="bar-track">
                <div class="bar" :style="{ height: barHeightPct(d.activeMinutes) + '%' }" tabindex="0">
                  <v-tooltip activator="parent" location="top">{{ shortDay(d.day) }}: {{ formatMinutes(d.activeMinutes) }}</v-tooltip>
                </div>
              </div>
            </div>
          </div>
          <div class="d-flex justify-space-between text-caption text-medium-emphasis mt-1">
            <span>{{ shortDay(data.activity.daily[0]?.day ?? "") }}</span>
            <span>{{ shortDay(data.activity.daily[data.activity.daily.length - 1]?.day ?? "") }}</span>
          </div>
        </v-card-text>
      </v-card>

      <div class="d-flex flex-wrap ga-4">
        <v-card class="flex-1-1">
          <v-card-item><template #title>Top modules</template></v-card-item>
          <v-table v-if="data.activity.modules.length" density="compact">
            <thead>
              <tr>
                <th>Screen</th>
                <th>Module</th>
                <th class="text-right">Active</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in data.activity.modules" :key="m.route + m.module">
                <td>{{ m.route }}</td>
                <td>{{ m.module }}</td>
                <td class="text-right tabular-nums">{{ formatMinutes(m.activeMinutes) }}</td>
              </tr>
            </tbody>
          </v-table>
          <v-card-text v-else class="text-medium-emphasis">Nothing recorded yet.</v-card-text>
        </v-card>

        <v-card class="flex-1-1">
          <v-card-item><template #title>Top features</template></v-card-item>
          <v-table v-if="data.activity.features.length" density="compact">
            <thead>
              <tr>
                <th>Feature</th>
                <th class="text-right">Clicks</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in data.activity.features" :key="f.feature">
                <td>{{ f.feature }}</td>
                <td class="text-right tabular-nums">{{ f.clicks }}</td>
              </tr>
            </tbody>
          </v-table>
          <v-card-text v-else class="text-medium-emphasis">Nothing recorded yet.</v-card-text>
        </v-card>
      </div>

      <v-card>
        <v-card-item>
          <template #title>Waiting on a human</template>
          <template #subtitle>
            Median wait per week (count), from the journal and asks, counted in the week the wait ended. Everyone's, not
            only yours.
          </template>
        </v-card-item>
        <v-table density="compact">
          <thead>
            <tr>
              <th>Week of</th>
              <th v-for="c in WAIT_COLUMNS" :key="c.key" class="text-right">{{ c.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in waitingWeeks" :key="w.weekStart">
              <td>{{ shortDay(w.weekStart) }}</td>
              <td v-for="c in WAIT_COLUMNS" :key="c.key" class="text-right tabular-nums">{{ formatWait(w[c.key]) }}</td>
            </tr>
          </tbody>
        </v-table>
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
