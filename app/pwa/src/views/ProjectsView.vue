<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getProjects, updateProject, type Project } from "../api.js";
import ProjectFormDialog from "../components/ProjectFormDialog.vue";
import { renderDescriptionHtml } from "../description-html.js";

const route = useRoute();
const router = useRouter();

const projects = ref<Project[]>([]);
// replaces the old multi-select scope filter with
// a plain free-text search over name/slug, entirely client-side against the
// already-fetched list - same pattern as the Task List screen's `q` search.
// Shows every project by default; persisted to the URL so a bookmark or
// refresh returns to the same search.
const search = ref<string>(typeof route.query.q === "string" ? route.query.q : "");
const showArchived = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const showForm = ref(false);
const editing = ref<Project | null>(null);
const expandedIds = ref<Set<number>>(new Set());

watch(search, () => {
  router.replace({ query: { ...route.query, q: search.value.trim() || undefined } });
});

function toggleContext(id: number): void {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    projects.value = await getProjects({ includeArchived: showArchived.value });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function projectName(id: number | null): string {
  if (id === null) return "";
  return projects.value.find((p) => p.id === id)?.name ?? `#${id}`;
}

const filteredProjects = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return projects.value;
  return projects.value.filter((p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q));
});

function openCreate(): void {
  editing.value = null;
  showForm.value = true;
}

function openEdit(project: Project): void {
  editing.value = project;
  showForm.value = true;
}

async function toggleArchived(project: Project): Promise<void> {
  try {
    await updateProject(project.id, { archived: !project.archived });
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <div class="d-flex align-center ga-2 flex-wrap">
      <h1 class="text-h5 mr-auto">Projects</h1>
      <v-switch v-model="showArchived" label="Show archived" density="comfortable" hide-details @update:model-value="load" />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">New project</v-btn>
    </div>

    <div class="d-flex align-end ga-2 flex-wrap">
      <v-text-field
        v-model="search"
        label="Search projects"
        prepend-inner-icon="mdi-magnify"
        clearable
        density="comfortable"
        hide-details
        style="min-width: 320px; flex: 1"
      />
    </div>

    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate />

    <v-table v-if="filteredProjects.length" density="comfortable">
      <thead>
        <tr>
          <th>Name</th>
          <th>Slug</th>
          <th>Parent</th>
          <th>Repo</th>
          <th>Related repos</th>
          <th>Status</th>
          <th class="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="project in filteredProjects" :key="project.id">
          <tr>
            <td>
              <router-link :to="`/projects/${project.id}`">{{ project.name }}</router-link>
              <div v-if="project.description" class="text-caption text-medium-emphasis">{{ project.description }}</div>
            </td>
            <td><v-chip size="x-small" variant="tonal">{{ project.slug }}</v-chip></td>
            <td>{{ projectName(project.parentProjectId) || "—" }}</td>
            <td>
              <a v-if="project.repoUrl" :href="project.repoUrl" target="_blank" rel="noopener">{{ project.localPath || project.repoUrl }}</a>
              <span v-else-if="project.localPath">{{ project.localPath }}</span>
              <span v-else class="text-medium-emphasis">—</span>
            </td>
            <td>
              <v-chip
                v-for="id in project.relatedProjectIds"
                :key="id"
                size="x-small"
                variant="tonal"
                class="mr-1"
              >
                {{ projectName(id) }}
              </v-chip>
              <span v-if="!project.relatedProjectIds.length" class="text-medium-emphasis">—</span>
            </td>
            <td>
              <v-chip v-if="project.archived" size="x-small" variant="tonal" color="grey">archived</v-chip>
              <v-chip v-if="project.autoDeployAllowed" size="x-small" variant="tonal" color="success" class="ml-1">
                auto-deploy
              </v-chip>
            </td>
            <td class="text-right text-no-wrap">
              <v-btn
                v-if="project.context"
                icon="mdi-text-box-outline"
                variant="text"
                size="small"
                @click="toggleContext(project.id)"
              />
              <v-btn icon="mdi-pencil" variant="text" size="small" @click="openEdit(project)" />
              <v-btn
                :icon="project.archived ? 'mdi-archive-arrow-up-outline' : 'mdi-archive-arrow-down-outline'"
                variant="text"
                size="small"
                @click="toggleArchived(project)"
              />
            </td>
          </tr>
          <tr v-if="expandedIds.has(project.id) && project.context">
            <td colspan="6" class="pb-3">
              <div class="text-body-2 description-html" v-html="renderDescriptionHtml(project.context)" />
            </td>
          </tr>
        </template>
      </tbody>
    </v-table>
    <v-empty-state
      v-else-if="!loading"
      icon="mdi-folder-outline"
      :title="projects.length ? `No name/slug contains '${search}'` : 'No projects yet'"
    />

    <ProjectFormDialog v-model="showForm" :project="editing" :projects="projects" @saved="load" />
  </div>
</template>
