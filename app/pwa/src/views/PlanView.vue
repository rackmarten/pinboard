<script setup lang="ts">
// the work plan as a segment timeline - a vertical list of 5h
// session windows from now to the end of the budget period, each showing what
// it can spend and what is planned into it.
//
// Vertical rather than a horizontal Gantt deliberately: this screen is read on
// a phone as often as on a desktop, and a time axis running left-to-right
// either scrolls sideways or squeezes every slot into an unreadable sliver.
// A list of cards degrades to one column and stays legible.

import { computed, onMounted, ref } from "vue";
import { useBackClose } from "@rackmarten/ui-kit";
import {
  createBudgetPeriod,
  getLicenses,
  getPlan,
  getPlannerSettings,
  getProjects,
  resetSessionWindow,
  updateBudgetPeriod,
  updateLicense,
  updatePlannerSettings,
  type License,
  type Plan,
  type PlannerSettings,
  type PlanSlot,
  type PlannedTask,
  type Project,
} from "../api.js";
import { usePolling } from "../composables/usePolling.js";

// one plan per seat. Each license has its own budget period and its
// own 5h session window, and foreman's dispatcher now polls every one of them,
// so a screen that could only ever show the default license was showing half
// of what actually decides whether work starts.
const plans = ref<Record<number, Plan>>({});
const licenses = ref<License[]>([]);
const selectedLicenseId = ref<number | null>(null);
const projects = ref<Project[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const plan = computed<Plan | null>(() =>
  selectedLicenseId.value === null ? null : (plans.value[selectedLicenseId.value] ?? null),
);

const settingsOpen = ref(false);
useBackClose(settingsOpen);
const globalSettings = ref<PlannerSettings | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);

const formBudgetUsd = ref<number | string | null>(null);
const formEndsAt = ref("");
const formSessionBudgetUsd = ref<number | string | null>(null);
const formConcurrency = ref<number | string | null>(null);
const formDefaultTaskCostUsd = ref<number | string | null>(null);
// this seat's own overrides of the two global defaults above.
// null/blank means "inherit the global default", which is what the field's
// hint spells out rather than leaving the operator to guess what empty does.
const formSeatSessionBudgetUsd = ref<number | string | null>(null);
const formSeatConcurrency = ref<number | string | null>(null);
// this seat's weekly recurrence. The amount is the pattern's own,
// separate from the current period's budget above.
const formRecurrenceEnabled = ref(false);
const formRecurrenceBudgetUsd = ref<number | string | null>(null);

// The derived session window is only pinboard's estimate from its own cost
// figures, and it can disagree with Claude's real limit. Resetting it lets
// dispatch try again; a real limit gets reported by the first run that hits it.
const resetting = ref(false);
async function resetWindow(): Promise<void> {
  if (selectedLicenseId.value === null) return;
  resetting.value = true;
  try {
    await resetSessionWindow(selectedLicenseId.value);
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    resetting.value = false;
  }
}

const selectedLicense = computed<License | null>(
  () => licenses.value.find((l) => l.id === selectedLicenseId.value) ?? null,
);
const multiSeat = computed(() => licenses.value.length > 1);

async function load(): Promise<void> {
  error.value = null;
  try {
    const [seats, projs] = await Promise.all([
      getLicenses(),
      projects.value.length ? Promise.resolve(projects.value) : getProjects(),
    ]);
    projects.value = projs;
    const enabled = seats.filter((l) => l.enabled);
    licenses.value = enabled;

    // Settled rather than all: one seat's plan failing should grey out that
    // seat's card, not blank the screen for the other one. A seat that fails
    // keeps whatever it last showed.
    const loaded = await Promise.allSettled(enabled.map((l) => getPlan(l.id)));
    const next: Record<number, Plan> = {};
    const failed: string[] = [];
    enabled.forEach((l, i) => {
      const result = loaded[i];
      if (result.status === "fulfilled") next[l.id] = result.value;
      else {
        const kept = plans.value[l.id];
        if (kept) next[l.id] = kept;
        failed.push(l.name);
      }
    });
    plans.value = next;
    if (failed.length === enabled.length) throw new Error(`Could not load the plan for ${failed.join(", ")}`);
    error.value = failed.length ? `Could not refresh the plan for ${failed.join(", ")}` : null;

    // Keep whatever seat the operator is looking at across a poll; fall back to
    // the first one when it disappears (disabled mid-session) or on first load.
    if (selectedLicenseId.value === null || !(selectedLicenseId.value in plans.value)) {
      selectedLicenseId.value = enabled[0]?.id ?? null;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

const seatSummary = computed(() =>
  licenses.value.map((l) => {
    const p = plans.value[l.id];
    return {
      id: l.id,
      name: l.name,
      linuxUser: l.linuxUser,
      tokenEnvVar: l.tokenEnvVar,
      configured: p?.period.configured ?? false,
      remainingUsd: p?.period.remainingUsd ?? 0,
      budgetUsd: p?.period.budgetUsd ?? 0,
      sessionRemainingUsd: p?.sessionWindow.remainingUsd ?? 0,
      runningCount: p?.concurrency.seatRunning ?? 0,
      concurrency: p?.concurrency.seat ?? 0,
      repeatsWeekly: l.recurrenceEnabled,
    };
  }),
);

onMounted(async () => {
  loading.value = true;
  await load();
  loading.value = false;
});
usePolling(load);

const projectName = (id: number): string => projects.value.find((p) => p.id === id)?.slug ?? `project ${id}`;

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `$${value.toFixed(2)}`;
}

function clockRange(slot: PlanSlot): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = new Date(slot.startsAt).toLocaleDateString(undefined, { weekday: "short" });
  return `${day} ${fmt(slot.startsAt)} → ${fmt(slot.endsAt)}`;
}

function relativeHours(iso: string | null): string {
  if (!iso) return "-";
  const hours = (new Date(iso).getTime() - Date.now()) / 3_600_000;
  if (hours < 0) return "now";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${hours.toFixed(1)}h`;
}

// The open window is the only slot whose numbers are real; everything after it
// is a forecast that assumes work keeps being started. Labelled rather than
// styled identically so the distinction isn't lost.
const slotSubtitle = (slot: PlanSlot): string =>
  slot.hypothetical ? "projected window" : "open window";

const periodProgress = computed(() => {
  const p = plan.value?.period;
  if (!p || p.budgetUsd <= 0) return 0;
  return Math.min(100, (p.spentUsd / p.budgetUsd) * 100);
});

const LOAD_COLOR: Record<string, string> = {
  underloaded: "warning",
  balanced: "success",
  overloaded: "info",
  unknown: "grey",
};

const LOAD_HEADLINE: Record<string, string> = {
  underloaded: "Not enough queued work to spend the budget",
  balanced: "Queue and budget are a reasonable match",
  overloaded: "More queued work than the budget can cover",
  unknown: "No budget period set",
};

const BINDING_LABEL: Record<string, string> = {
  budget: "Budget is the limit",
  time: "Time is the limit",
  queue: "Queue is the limit",
  none: "Nothing planned",
};

const BASIS_LABEL: Record<string, string> = {
  effort: "from effort",
  "project-mean": "project average",
  "global-mean": "overall average",
  default: "cold-start guess",
};

function slotBarPercent(slot: PlanSlot): number {
  const total = slot.capUsd + slot.spentUsd;
  if (total <= 0) return 0;
  return Math.min(100, ((slot.spentUsd + slot.plannedUsd) / total) * 100);
}

async function openSettings(): Promise<void> {
  const p = plan.value;
  if (!p) return;
  formBudgetUsd.value = p.period.configured ? p.period.budgetUsd : null;
  formEndsAt.value = p.period.endsAt ? toLocalInput(p.period.endsAt) : "";
  formDefaultTaskCostUsd.value = p.settings.defaultTaskCostUsd;
  formSeatSessionBudgetUsd.value = selectedLicense.value?.sessionBudgetUsd ?? null;
  formSeatConcurrency.value = selectedLicense.value?.concurrencyLimit ?? null;
  formRecurrenceEnabled.value = selectedLicense.value?.recurrenceEnabled ?? false;
  formRecurrenceBudgetUsd.value = selectedLicense.value?.recurrenceBudgetUsd ?? null;
  // The global defaults come from /settings/planner, not from the plan: the
  // plan reports this seat's *effective* session budget, so prefilling the
  // global field from it would quietly overwrite the global default with a
  // seat's override the first time anyone saved.
  globalSettings.value = await getPlannerSettings().catch(() => null);
  formSessionBudgetUsd.value = globalSettings.value?.sessionBudgetUsd ?? p.settings.sessionBudgetUsd;
  formConcurrency.value = globalSettings.value?.concurrencyGlobal ?? p.concurrency.global;
  saveError.value = null;
  settingsOpen.value = true;
}

// <input type="datetime-local"> wants a local wall-clock string, not an ISO
// instant - converting via the epoch keeps the displayed time the one the
// operator actually sees elsewhere in the app.
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Vuetify's VTextField only special-cases the `trim` modifier in its own
// onInput, never `number`, so a field the operator blanks by backspacing
// holds "" rather than null - only its clear (X) button yields a real null.
// Both have to mean the same thing here ("inherit the global default"), and
// an unguarded "" would reach an integer column as a PATCH body.
function blankToNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function saveSettings(): Promise<void> {
  const p = plan.value;
  if (!p) return;
  saving.value = true;
  saveError.value = null;
  try {
    const budgetUsd = blankToNull(formBudgetUsd.value);
    const recurrenceBudgetUsd = blankToNull(formRecurrenceBudgetUsd.value);
    // Checked up front so a refused switch doesn't leave the period half-saved.
    // A weekly pattern repeats from the latest period's end, so it needs one.
    if (formRecurrenceEnabled.value) {
      if (recurrenceBudgetUsd === null || recurrenceBudgetUsd <= 0) {
        throw new Error("Enter the weekly budget amount to repeat this seat's period.");
      }
      if (!p.period.configured && !formEndsAt.value) {
        throw new Error("Set a first period (budget and end date) for the weekly repeat to start from.");
      }
    }
    // Budget amount and end date used to be saved only when both were filled
    // in, with no feedback otherwise - leaving just one blank (most often the
    // end date, when setting a budget for the first time) silently dropped
    // the whole period instead of saving it or saying why not.
    if (budgetUsd !== null || formEndsAt.value) {
      if (budgetUsd === null || !formEndsAt.value) {
        throw new Error("Enter both a budget amount and an end date to set the period.");
      }
      const endsAt = new Date(formEndsAt.value).toISOString();
      if (p.period.configured && p.period.id !== null) {
        await updateBudgetPeriod(p.period.id, { budgetUsd, endsAt });
      } else {
        // a new period belongs to the seat being looked at, not to
        // pinboard's default license.
        await createBudgetPeriod({
          budgetUsd,
          endsAt,
          ...(selectedLicenseId.value !== null ? { licenseId: selectedLicenseId.value } : {}),
        });
      }
    }
    // The global defaults have no "unset" state - a blank field there means
    // "leave it alone", not "clear it", so a null is skipped rather than sent.
    const patch: Record<string, number> = {};
    const globalSession = blankToNull(formSessionBudgetUsd.value);
    const globalConcurrency = blankToNull(formConcurrency.value);
    const defaultTaskCost = blankToNull(formDefaultTaskCostUsd.value);
    if (globalSession !== null) patch.sessionBudgetUsd = globalSession;
    if (globalConcurrency !== null) patch.concurrencyGlobal = globalConcurrency;
    if (defaultTaskCost !== null) patch.defaultTaskCostUsd = defaultTaskCost;
    if (Object.keys(patch).length) await updatePlannerSettings(patch);

    // a blank seat field clears the override (back to the global
    // default) rather than being skipped - "I want this seat back on the
    // default" has to be expressible, and an empty number input is how.
    if (multiSeat.value && selectedLicenseId.value !== null) {
      await updateLicense(selectedLicenseId.value, {
        sessionBudgetUsd: blankToNull(formSeatSessionBudgetUsd.value),
        concurrencyLimit: blankToNull(formSeatConcurrency.value),
      });
    }

    const seat = selectedLicense.value;
    if (
      seat &&
      (seat.recurrenceEnabled !== formRecurrenceEnabled.value || seat.recurrenceBudgetUsd !== recurrenceBudgetUsd)
    ) {
      await updateLicense(seat.id, { recurrenceEnabled: formRecurrenceEnabled.value, recurrenceBudgetUsd });
    }

    settingsOpen.value = false;
    await load();
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

const taskHref = (task: PlannedTask): string => `/tasks/${task.taskId}`;
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">Plan</h1>
      <v-spacer />
      <v-btn variant="text" icon="mdi-cog-outline" aria-label="Plan settings" @click="openSettings" />
    </div>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate class="mb-4" />

    <!-- both seats' budgets at once, since the dispatcher polls
         both and either one having money is enough for work to start. Hidden
         entirely on a single-license install so nothing changes there. -->
    <div v-if="seatSummary.length > 1" class="d-flex flex-wrap ga-3 mb-4">
      <v-card
        v-for="seat in seatSummary"
        :key="seat.id"
        :variant="seat.id === selectedLicenseId ? 'tonal' : 'outlined'"
        :color="seat.id === selectedLicenseId ? 'primary' : undefined"
        class="flex-grow-1"
        style="min-width: 220px; cursor: pointer"
        @click="selectedLicenseId = seat.id"
      >
        <v-card-text class="py-3">
          <div class="d-flex align-center ga-2">
            <v-icon icon="mdi-account-key-outline" size="small" />
            <span class="text-subtitle-2 font-weight-medium">{{ seat.name }}</span>
            <v-chip v-if="seat.runningCount" size="x-small" variant="flat">
              {{ seat.runningCount }} running
            </v-chip>
            <v-spacer />
            <span class="text-caption text-medium-emphasis">max {{ seat.concurrency }}</span>
          </div>
          <div class="text-h6 mt-1">
            <template v-if="seat.configured">{{ usd(seat.remainingUsd) }}</template>
            <template v-else>no budget</template>
          </div>
          <div class="text-caption text-medium-emphasis">
            <template v-if="seat.configured">
              of {{ usd(seat.budgetUsd) }} · {{ usd(seat.sessionRemainingUsd) }} this window
            </template>
            <template v-else>runs as {{ seat.linuxUser }} · set a period to let it start work</template>
          </div>
          <div v-if="seat.repeatsWeekly" class="text-caption text-medium-emphasis">repeats weekly</div>
          <div class="text-caption text-medium-emphasis">
            token: {{ seat.tokenEnvVar ?? "foreman's own login" }}
          </div>
        </v-card-text>
      </v-card>
    </div>

    <template v-if="plan">
      <v-alert
        v-if="!plan.period.configured"
        type="info"
        variant="tonal"
        class="mb-4"
        text="No budget period covers right now. Set a budget and an end date to build a plan."
      >
        <template #append>
          <v-btn size="small" variant="tonal" @click="openSettings">Set budget</v-btn>
        </template>
      </v-alert>

      <!-- Header strip: the four numbers that decide everything below. -->
      <v-card variant="tonal" class="mb-4">
        <v-card-text>
          <div class="d-flex flex-wrap ga-6">
            <div>
              <div class="text-caption text-medium-emphasis">Budget left</div>
              <div class="text-h5">{{ usd(plan.period.remainingUsd) }}</div>
              <div class="text-caption text-medium-emphasis">of {{ usd(plan.period.budgetUsd) }}</div>
            </div>
            <div>
              <div class="text-caption text-medium-emphasis">Period ends</div>
              <div class="text-h5">{{ relativeHours(plan.period.endsAt) }}</div>
              <div class="text-caption text-medium-emphasis">
                {{ plan.period.endsAt ? new Date(plan.period.endsAt).toLocaleString() : "not set" }}
              </div>
              <div v-if="plan.period.recurrence.enabled" class="text-caption text-medium-emphasis">
                repeats weekly ({{ usd(plan.period.recurrence.budgetUsd) }})<template
                  v-if="plan.period.recurrence.nextEndsAt"
                  >, next to {{ new Date(plan.period.recurrence.nextEndsAt).toLocaleDateString() }}</template
                >
              </div>
            </div>
            <div>
              <div class="text-caption text-medium-emphasis">This 5h window</div>
              <div class="text-h5">{{ usd(plan.sessionWindow.remainingUsd) }}</div>
              <div class="text-caption text-medium-emphasis">
                <template v-if="plan.sessionWindow.endsAt">
                  resets in {{ relativeHours(plan.sessionWindow.endsAt) }}
                </template>
                <template v-else>no window open</template>
              </div>
            </div>
            <div>
              <div class="text-caption text-medium-emphasis">Pace</div>
              <div class="text-h5">{{ usd(plan.pace.perSlotUsd) }}</div>
              <div class="text-caption text-medium-emphasis">
                per window, {{ plan.pace.mode === "throttled" ? "throttled" : "not throttled" }}
              </div>
            </div>
          </div>
          <v-progress-linear :model-value="periodProgress" height="6" rounded class="mt-4" />
        </v-card-text>
      </v-card>

      <!-- The load signal: the thing that tells the operator to go file more
           tasks, which is the common case here rather than the exception. -->
      <v-card :color="LOAD_COLOR[plan.load.verdict]" variant="tonal" class="mb-4">
        <v-card-text>
          <div class="d-flex align-center flex-wrap ga-2">
            <v-icon icon="mdi-scale-balance" />
            <span class="text-subtitle-1 font-weight-medium">{{ LOAD_HEADLINE[plan.load.verdict] }}</span>
            <v-spacer />
            <v-chip size="small" variant="flat">{{ BINDING_LABEL[plan.binding] }}</v-chip>
          </div>
          <div class="text-body-2 mt-2">
            {{ plan.load.runnableTaskCount }} runnable task(s) worth about
            {{ usd(plan.load.queueCostUsd) }} against {{ usd(plan.load.remainingBudgetUsd) }} left.
            <template v-if="plan.load.verdict === 'underloaded'">
              About {{ usd(plan.load.unspendableUsd) }} has no queued work to spend it on, across
              {{ plan.load.idleSlots }} empty window(s).
            </template>
            <template v-else-if="plan.load.deferredTaskCount > 0">
              {{ plan.load.deferredTaskCount }} task(s) will not fit before the period ends.
            </template>
          </div>
          <!-- Without this, a queue that is entirely blocked behind one
               running task reads as "0 runnable" next to a visibly non-empty
               task list, which looks like a bug rather than the normal state
               it is. The remedy is also different: unblock, not file more. -->
          <div v-if="plan.load.blockedTaskCount > 0" class="text-body-2 mt-1">
            <v-icon icon="mdi-lock-outline" size="small" class="mr-1" />
            {{ plan.load.blockedTaskCount }} more queued task(s) are waiting on an unfinished
            dependency, so they can't be planned yet.
          </div>
        </v-card-text>
      </v-card>

      <v-alert
        v-if="plan.startable.waitUntil"
        type="warning"
        variant="tonal"
        class="mb-4"
        :text="`${plan.startable.reason?.startsWith('Claude') ? 'Claude reported the session limit' : 'Session window budget is spent'} - waiting until ${new Date(plan.startable.waitUntil).toLocaleTimeString()} for it to reset.`"
      >
        <template #append>
          <v-btn size="small" variant="tonal" :loading="resetting" @click="resetWindow">Reset window</v-btn>
        </template>
      </v-alert>
      <v-alert
        v-else-if="plan.startable.reason"
        type="info"
        variant="tonal"
        class="mb-4"
        :text="plan.startable.reason"
      />

      <!-- The timeline itself. -->
      <v-card v-for="(slot, index) in plan.slots" :key="slot.startsAt" class="mb-3" :variant="slot.hypothetical ? 'outlined' : 'elevated'">
        <v-card-text>
          <div class="d-flex align-center flex-wrap ga-2 mb-2">
            <v-chip v-if="index === 0" size="x-small" color="primary" variant="flat">NOW</v-chip>
            <span class="text-subtitle-1 font-weight-medium">{{ clockRange(slot) }}</span>
            <span class="text-caption text-medium-emphasis">{{ slotSubtitle(slot) }}</span>
            <v-spacer />
            <span class="text-body-2">
              {{ usd(slot.plannedUsd) }} planned
              <span class="text-medium-emphasis">/ {{ usd(slot.capUsd) }} available</span>
            </span>
          </div>

          <v-progress-linear :model-value="slotBarPercent(slot)" height="6" rounded class="mb-3" />

          <v-list v-if="slot.tasks.length" density="compact" class="pa-0 bg-transparent">
            <v-list-item v-for="t in slot.tasks" :key="t.taskId" :to="taskHref(t)" class="px-0">
              <template #prepend>
                <v-icon
                  :icon="t.running ? 'mdi-cog-sync-outline' : 'mdi-tray-full'"
                  :color="t.running ? 'primary' : undefined"
                  size="small"
                  class="mr-2"
                />
              </template>
              <v-list-item-title class="text-body-2">
                #{{ t.taskId }} {{ t.title }}
              </v-list-item-title>
              <v-list-item-subtitle class="text-caption">
                {{ projectName(t.projectId) }} · p{{ t.priority }} ·
                {{ usd(t.estimatedCostUsd) }} ({{ BASIS_LABEL[t.estimateBasis] }})
                <template v-if="t.running"> · running</template>
              </v-list-item-subtitle>
            </v-list-item>
          </v-list>

          <div v-else class="text-caption text-medium-emphasis">
            Nothing planned - {{ usd(slot.availableUsd) }} unused.
          </div>
        </v-card-text>
      </v-card>

      <v-card v-if="!plan.slots.length" variant="tonal">
        <v-card-text class="text-medium-emphasis">
          No time left in this period to plan against.
        </v-card-text>
      </v-card>

      <!-- How the estimates were arrived at. Kept visible rather than hidden:
           a plan built entirely on "cold-start guess" deserves less trust than
           one built on real per-project averages. -->
      <div class="text-caption text-medium-emphasis mt-4">
        Estimates from {{ plan.costModel.sampleCount }} completed task(s).
        Overall average {{ usd(plan.costModel.globalMeanUsd) }} per task.
        <template v-if="plan.costModel.meanDurationMs">
          Mean run {{ (plan.costModel.meanDurationMs / 60000).toFixed(0) }} min.
        </template>
        <template v-if="multiSeat">
          Concurrency {{ plan.concurrency.seat }} for this seat, {{ plan.concurrency.global }} across all seats.
        </template>
        <template v-else>Concurrency {{ plan.concurrency.global }}.</template>
        Effort scaling {{ plan.costModel.useEffortScaling ? "on" : "off" }}.
      </div>
    </template>

    <v-dialog v-model="settingsOpen" max-width="520">
      <v-card>
        <v-card-title>Plan settings</v-card-title>
        <v-card-text>
          <v-alert v-if="saveError" type="error" variant="tonal" class="mb-3">{{ saveError }}</v-alert>
          <v-text-field
            v-model.number="formBudgetUsd"
            label="Budget for this period ($)"
            type="number"
            step="1"
            min="0"
            density="comfortable"
          />
          <v-text-field
            v-model="formEndsAt"
            label="Period ends"
            type="datetime-local"
            density="comfortable"
            :hint="formRecurrenceEnabled ? 'Later weeks repeat from this date' : 'Normally the weekly allowance reset'"
            persistent-hint
          />
          <v-switch
            v-model="formRecurrenceEnabled"
            :label="multiSeat ? `Repeat weekly (${selectedLicense?.name})` : 'Repeat weekly'"
            color="primary"
            density="comfortable"
            hide-details
            class="mt-2"
          />
          <v-text-field
            v-if="formRecurrenceEnabled"
            v-model.number="formRecurrenceBudgetUsd"
            label="Budget for each repeated week ($)"
            type="number"
            step="1"
            min="0"
            density="comfortable"
            hint="A new period starts when this one ends. Editing the period above doesn't change this."
            persistent-hint
          />
          <template v-if="multiSeat">
            <div class="text-subtitle-2 mt-4 mb-1">{{ selectedLicense?.name }} only</div>
            <v-text-field
              v-model.number="formSeatSessionBudgetUsd"
              label="5h session window budget ($)"
              type="number"
              step="1"
              min="0"
              density="comfortable"
              clearable
              :hint="`Blank = the global default (${usd(blankToNull(formSessionBudgetUsd))})`"
              persistent-hint
            />
            <v-text-field
              v-model.number="formSeatConcurrency"
              label="Max tasks running at once"
              type="number"
              step="1"
              min="1"
              density="comfortable"
              class="mt-3"
              clearable
              :hint="`Blank = the global default (${blankToNull(formConcurrency) ?? '-'}). Still capped by it.`"
              persistent-hint
            />
            <div class="text-subtitle-2 mt-5 mb-1">All seats</div>
          </template>
          <v-text-field
            v-model.number="formSessionBudgetUsd"
            :label="multiSeat ? 'Default 5h session window budget ($)' : '5h session window budget ($)'"
            type="number"
            step="1"
            min="0"
            density="comfortable"
            class="mt-3"
          />
          <v-text-field
            v-model.number="formConcurrency"
            :label="multiSeat ? 'Max tasks running at once, all seats' : 'Max tasks running at once'"
            type="number"
            step="1"
            min="1"
            density="comfortable"
            hint="Never two tasks sharing a project or a related project"
            persistent-hint
          />
          <v-text-field
            v-model.number="formDefaultTaskCostUsd"
            label="Cold-start cost per task ($)"
            type="number"
            step="0.25"
            min="0"
            density="comfortable"
            class="mt-3"
            hint="Only used for a project with no completed tasks yet"
            persistent-hint
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="saving" @click="settingsOpen = false">Cancel</v-btn>
          <v-btn color="primary" variant="flat" :loading="saving" @click="saveSettings">Save</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
