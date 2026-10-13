<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getProject, getProjects, getTasks, type Project, type Task } from "../api.js";
import ProjectFormDialog from "../components/ProjectFormDialog.vue";
import JournalTimeline from "../components/JournalTimeline.vue";
import TaskList from "../components/TaskList.vue";
import { renderDescriptionHtml } from "../description-html.js";

const props = defineProps<{ id: string }>();
const router = useRouter();

const projectId = computed(() => Number(props.id));

const project = ref<Project | null>(null);
const allProjects = ref<Project[]>([]);
const tasks = ref<Task[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const showEdit = ref(false);

// breadcrumb of ancestor projects (root -> immediate parent),
// same pattern a past task built for the task detail view's project chain.
const ancestorChain = computed(() => {
  const chain: Project[] = [];
  let current = project.value
    ? (allProjects.value.find((p) => p.id === project.value!.parentProjectId) ?? null)
    : null;
  const seen = new Set<number>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentProjectId !== null ? (allProjects.value.find((p) => p.id === current!.parentProjectId) ?? null) : null;
  }
  return chain;
});

const subprojects = computed(() => allProjects.value.filter((p) => p.parentProjectId === projectId.value));

function projectName(id: number): string {
  return allProjects.value.find((p) => p.id === id)?.name ?? `#${id}`;
}

const descriptionHtml = computed(() => {
  const description = project.value?.description;
  if (!description) return null;
  return renderDescriptionHtml(description);
});

const contextHtml = computed(() => {
  const context = project.value?.context;
  if (!context) return null;
  return renderDescriptionHtml(context);
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    [project.value, allProjects.value, tasks.value] = await Promise.all([
      getProject(projectId.value),
      getProjects({ includeArchived: true }),
      getTasks({ projectId: projectId.value }),
    ]);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(projectId, load);
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <v-btn variant="text" prepend-icon="mdi-arrow-left" class="align-self-start" @click="router.push('/projects')">
      Back to projects
    </v-btn>

    <v-breadcrumbs v-if="project" density="compact" class="pa-0">
      <template v-for="ancestor in ancestorChain" :key="ancestor.id">
        <v-breadcrumbs-item :to="`/projects/${ancestor.id}`">{{ ancestor.name }}</v-breadcrumbs-item>
        <v-breadcrumbs-divider>/</v-breadcrumbs-divider>
      </template>
      <v-breadcrumbs-item disabled>{{ project.name }}</v-breadcrumbs-item>
    </v-breadcrumbs>

    <v-progress-linear v-if="loading" indeterminate />
    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>

    <template v-if="project">
      <div class="d-flex align-center ga-2 flex-wrap">
        <h1 class="text-h5 mr-auto">{{ project.name }}</h1>
        <v-chip size="small" variant="tonal">{{ project.slug }}</v-chip>
        <v-chip v-if="project.archived" size="small" variant="tonal" color="grey">archived</v-chip>
        <v-chip v-if="project.autoDeployAllowed" size="small" variant="tonal" color="success">auto-deploy</v-chip>
        <v-btn variant="tonal" prepend-icon="mdi-pencil" @click="showEdit = true">Edit</v-btn>
      </div>

      <div v-if="project.repoUrl || project.localPath || project.relatedProjectIds.length" class="d-flex align-center ga-2 flex-wrap">
        <span class="text-caption text-medium-emphasis">Repos:</span>
        <a v-if="project.repoUrl" :href="project.repoUrl" target="_blank" rel="noopener">
          <v-chip size="small" variant="tonal" prepend-icon="mdi-source-repository">{{ project.localPath || project.repoUrl }}</v-chip>
        </a>
        <v-chip v-else-if="project.localPath" size="small" variant="tonal" prepend-icon="mdi-source-repository">
          {{ project.localPath }}
        </v-chip>
        <v-chip v-for="id in project.relatedProjectIds" :key="id" size="small" variant="tonal">{{ projectName(id) }}</v-chip>
      </div>

      <div v-if="descriptionHtml" class="text-body-1 description-html" v-html="descriptionHtml" />

      <template v-if="contextHtml">
        <v-divider />
        <h2 class="text-h6">Context</h2>
        <div class="text-body-1 description-html" v-html="contextHtml" />
      </template>

      <v-divider />

      <template v-if="subprojects.length">
        <h2 class="text-h6">Subprojects</h2>
        <v-list lines="one">
          <v-list-item
            v-for="sub in subprojects"
            :key="sub.id"
            :to="`/projects/${sub.id}`"
            rounded="lg"
            class="mb-1"
            :title="sub.name"
          >
            <template #append>
              <v-chip v-if="sub.archived" size="small" variant="tonal" color="grey">archived</v-chip>
            </template>
          </v-list-item>
        </v-list>
        <v-divider />
      </template>

      <div class="d-flex align-center ga-2">
        <h2 class="text-h6 mr-auto">Tasks</h2>
        <v-btn size="small" variant="tonal" :to="`/tasks?projectId=${project.id}`">View in task list</v-btn>
      </div>
      <TaskList v-if="tasks.length" :tasks="tasks" />
      <p v-else class="text-medium-emphasis">No tasks under this project yet.</p>

      <!-- everything journaled against this project and its tasks. -->
      <v-expansion-panels variant="accordion" class="mt-4">
        <v-expansion-panel title="History">
          <v-expansion-panel-text>
            <JournalTimeline :project-id="project.id" :page-size="30" />
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>

      <ProjectFormDialog v-model="showEdit" :project="project" :projects="allProjects" @saved="load" />
    </template>
  </div>
</template>

<style scoped>
.description-html :deep(p) {
  margin: 0 0 0.5em;
}
.description-html :deep(p:last-child) {
  margin-bottom: 0;
}
.description-html :deep(ul),
.description-html :deep(ol) {
  margin: 0 0 0.5em;
  padding-left: 1.5em;
}
.description-html :deep(blockquote) {
  margin: 0 0 0.5em;
  padding-left: 0.75em;
  border-left: 3px solid rgba(var(--v-border-color), var(--v-border-opacity));
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.description-html :deep(code) {
  background: rgba(var(--v-theme-on-surface), 0.08);
  border-radius: 4px;
  padding: 0 4px;
}
</style>
