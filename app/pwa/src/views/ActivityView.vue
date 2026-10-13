<script setup lang="ts">
// the global journal - everything that happened across pinboard,
// newest first, optionally narrowed to one project.
import { onMounted, ref } from "vue";
import { getProjects, type Project } from "../api.js";
import JournalTimeline from "../components/JournalTimeline.vue";

const projects = ref<Project[]>([]);
const projectId = ref<number | undefined>(undefined);

onMounted(async () => {
  projects.value = await getProjects();
});
</script>

<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-2 mb-2">
      <h1 class="text-h5">Activity</h1>
      <v-spacer />
      <v-autocomplete
        v-model="projectId"
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
      <JournalTimeline :project-id="projectId ?? undefined" />
    </v-card>
  </v-container>
</template>
