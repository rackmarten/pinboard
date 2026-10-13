<script setup lang="ts">
// releases. Active = per project, what each deploy step has
// running (reported by foreman's probe) against the default branch, plus
// "Deploy now", which queues a request foreman runs. History = deploys,
// deploy requests, agent runs and reviews from the journal.
// a production release target (the declaration's `release` block)
// never deploys from Deploy now; its row has its own Release menu instead.
import { computed, onMounted, ref } from "vue";
import { useBackClose } from "@rackmarten/ui-kit";
import {
  bumpedVersion,
  getProjects,
  getReleases,
  requestDeploy,
  requestRelease,
  type DeployRequest,
  type DeployTarget,
  type Project,
  type ReleaseBump,
  type ReleaseProject,
} from "../api.js";
import JournalTimeline from "../components/JournalTimeline.vue";
import { usePolling } from "../composables/usePolling.js";
import { relativeTime } from "../journal-display.js";

// which target's Release menu is open (one at a time), so back
// closes it instead of leaving the page.
const releaseMenuFor = ref<number | null>(null);
useBackClose(
  computed({
    get: () => releaseMenuFor.value !== null,
    set: (v: boolean) => {
      if (!v) releaseMenuFor.value = null;
    },
  }),
);

const HISTORY_TYPES = "deploy,deploy_requested,release_requested,handoff,complete,reject";
const BUMPS: ReleaseBump[] = ["patch", "minor", "major"];

const tab = ref<"active" | "history">("active");
const releases = ref<ReleaseProject[]>([]);
const projects = ref<Project[]>([]);
const historyProjectId = ref<number | undefined>(undefined);
const loading = ref(true);
const error = ref("");
const busy = ref<number | null>(null);
const expanded = ref<Record<number, boolean>>({});

function pendingOf(p: ReleaseProject): number {
  return p.targets.reduce((sum, t) => sum + (t.pendingCount ?? 0), 0);
}

// What Deploy now would change: every target except a production release.
function deployPendingOf(p: ReleaseProject): number {
  return p.targets.reduce((sum, t) => sum + (t.release ? 0 : (t.pendingCount ?? 0)), 0);
}

function deployTargetsOf(p: ReleaseProject): DeployTarget[] {
  return p.targets.filter((t) => !t.release);
}

const sorted = computed(() => [...releases.value].sort((a, b) => pendingOf(b) - pendingOf(a) || a.name.localeCompare(b.name)));
const pendingProjects = computed(() => releases.value.filter((p) => pendingOf(p) > 0).length);

async function load(): Promise<void> {
  try {
    releases.value = await getReleases();
    error.value = "";
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  projects.value = await getProjects();
});
usePolling(load, 10_000);

function isActive(r: DeployRequest | null): boolean {
  return r?.status === "queued" || r?.status === "running";
}

async function deploy(p: ReleaseProject): Promise<void> {
  busy.value = p.id;
  try {
    await requestDeploy(p.id);
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = null;
  }
}

async function release(p: ReleaseProject, bump: ReleaseBump): Promise<void> {
  busy.value = p.id;
  try {
    await requestRelease(p.id, bump);
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = null;
  }
}

function requestLabel(r: DeployRequest): string {
  if (r.kind !== "release") return `deploy #${r.id}`;
  return `release #${r.id}${r.version ? ` ${r.version}` : r.bump ? ` (${r.bump})` : ""}`;
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

function commitUrl(p: ReleaseProject, sha: string): string | null {
  return p.localPath ? `https://github.com/${p.localPath}/commit/${sha}` : null;
}

function targetLabel(t: DeployTarget): string {
  return t.app ? `${t.app} on ${t.host}` : t.host;
}

function targetState(t: DeployTarget): { text: string; color: string } {
  if (t.probeError) return { text: "unknown", color: "error" };
  if (t.pendingCount === null) return { text: "unknown", color: "grey" };
  if (t.pendingCount === 0) return { text: "up to date", color: "success" };
  return { text: `${t.pendingCount} ${t.release ? "unreleased" : "pending"}`, color: "warning" };
}

const REQUEST_COLORS: Record<string, string> = { queued: "info", running: "info", succeeded: "success", failed: "error" };
</script>

<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-2 mb-2">
      <h1 class="text-h5">Releases</h1>
      <v-spacer />
      <v-btn-toggle v-model="tab" mandatory density="compact" variant="outlined" divided>
        <v-btn value="active">Active</v-btn>
        <v-btn value="history">History</v-btn>
      </v-btn-toggle>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-2" closable @click:close="error = ''">{{ error }}</v-alert>

    <template v-if="tab === 'active'">
      <p class="text-body-2 text-medium-emphasis mb-3">
        What each deploy step is running against the default branch, checked by foreman every few minutes.
        <template v-if="!loading">{{ pendingProjects }} of {{ releases.length }} projects have undeployed commits.</template>
      </p>
      <v-progress-linear v-if="loading" indeterminate class="mb-2" />
      <v-alert v-else-if="releases.length === 0" type="info" variant="tonal" density="compact">
        Nothing probed yet. foreman's pipeline loop reports deploy targets here.
      </v-alert>

      <v-card v-for="p in sorted" :key="p.id" class="mb-3">
        <v-card-title class="d-flex align-center flex-wrap ga-2">
          <router-link :to="`/projects/${p.id}`" class="text-decoration-none">{{ p.name }}</router-link>
          <v-chip v-if="pendingOf(p) > 0" size="small" color="warning" variant="tonal">{{ pendingOf(p) }} pending</v-chip>
          <v-spacer />
          <v-chip
            v-if="p.lastRequest"
            size="small"
            variant="tonal"
            :color="REQUEST_COLORS[p.lastRequest.status]"
            :title="p.lastRequest.output ?? undefined"
          >
            {{ requestLabel(p.lastRequest) }} {{ p.lastRequest.status }} · {{ relativeTime(p.lastRequest.finishedAt ?? p.lastRequest.createdAt) }}
          </v-chip>
          <v-btn
            size="small"
            :color="deployPendingOf(p) > 0 ? 'primary' : undefined"
            :variant="deployPendingOf(p) > 0 ? 'flat' : 'outlined'"
            prepend-icon="mdi-rocket-launch-outline"
            :loading="busy === p.id || isActive(p.lastRequest)"
            :disabled="isActive(p.lastRequest) || deployTargetsOf(p).length === 0"
            @click="deploy(p)"
          >
            Deploy now
          </v-btn>
        </v-card-title>

        <v-list density="compact">
          <template v-for="t in p.targets" :key="t.id">
            <v-list-item>
              <v-list-item-title class="d-flex align-center flex-wrap ga-2">
                <span class="font-weight-medium">{{ targetLabel(t) }}</span>
                <v-chip size="x-small" variant="tonal" :color="targetState(t).color">{{ targetState(t).text }}</v-chip>
                <v-chip v-if="t.release" size="x-small" variant="outlined" prepend-icon="mdi-lock-outline">release on click</v-chip>
                <v-menu v-if="t.release" :model-value="releaseMenuFor === t.id" @update:model-value="(v) => (releaseMenuFor = v ? t.id : null)">
                  <template #activator="{ props: menu }">
                    <v-btn
                      v-bind="menu"
                      size="x-small"
                      :color="(t.pendingCount ?? 0) > 0 ? 'primary' : undefined"
                      :variant="(t.pendingCount ?? 0) > 0 ? 'flat' : 'outlined'"
                      prepend-icon="mdi-tag-arrow-up-outline"
                      :loading="busy === p.id || isActive(p.lastRequest)"
                      :disabled="isActive(p.lastRequest)"
                    >
                      Release
                    </v-btn>
                  </template>
                  <v-list density="compact">
                    <v-list-subheader>Release {{ t.deployedVersion ?? "" }} to {{ t.host }} as</v-list-subheader>
                    <v-list-item v-for="b in BUMPS" :key="b" @click="release(p, b)">
                      <v-list-item-title>{{ bumpedVersion(t.deployedVersion, b) ?? b }}</v-list-item-title>
                      <v-list-item-subtitle>{{ b }}</v-list-item-subtitle>
                    </v-list-item>
                  </v-list>
                </v-menu>
              </v-list-item-title>
              <v-list-item-subtitle class="text-wrap">
                <template v-if="t.release">release <code>{{ t.deployedVersion ?? "—" }}</code> =</template>
                <!-- an npm package, whose newest tag is what is published. -->
                <template v-if="t.host === 'npm'">published <code>{{ t.deployedVersion ?? "—" }}</code> from</template>
                <template v-else>running</template>
                <a v-if="t.deployedSha && commitUrl(p, t.deployedSha)" :href="commitUrl(p, t.deployedSha)!" target="_blank" rel="noopener"><code>{{ short(t.deployedSha) }}</code></a>
                <code v-else>{{ short(t.deployedSha) }}</code>
                · main <code>{{ short(t.mainSha) }}</code>
                · checked <span :title="new Date(t.checkedAt).toLocaleString()">{{ relativeTime(t.checkedAt) }}</span>
                <div v-if="t.probeError" class="text-error">{{ t.probeError }}</div>
              </v-list-item-subtitle>
              <template v-if="t.pendingCommits?.length" #append>
                <v-btn size="small" variant="text" @click="expanded[t.id] = !expanded[t.id]">
                  {{ expanded[t.id] ? "Hide" : "Commits" }}
                </v-btn>
              </template>
            </v-list-item>
            <v-list v-if="expanded[t.id]" density="compact" class="pl-6">
              <v-list-item v-for="c in t.pendingCommits ?? []" :key="c.sha" :href="commitUrl(p, c.sha) ?? undefined" target="_blank">
                <v-list-item-title class="text-wrap text-body-2"><code>{{ short(c.sha) }}</code> {{ c.subject }}</v-list-item-title>
              </v-list-item>
              <v-list-item
                v-if="(t.pendingCount ?? 0) > (t.pendingCommits?.length ?? 0)"
                :subtitle="`and ${(t.pendingCount ?? 0) - (t.pendingCommits?.length ?? 0)} more`"
              />
            </v-list>
          </template>
        </v-list>
      </v-card>
    </template>

    <template v-else>
      <div class="d-flex mb-2">
        <v-autocomplete
          v-model="historyProjectId"
          :items="projects"
          item-title="name"
          item-value="id"
          label="Project"
          density="compact"
          hide-details
          clearable
          style="max-width: 280px; min-width: 200px"
        />
      </div>
      <v-card>
        <JournalTimeline :project-id="historyProjectId ?? undefined" :types="HISTORY_TYPES" />
      </v-card>
    </template>
  </v-container>
</template>
