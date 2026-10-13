<script setup lang="ts">
// one timeline for the journal, used globally (Activity), per
// project and per task. Newest first, paged backwards with "Load more".
// Runner "activity" rows are left to the task page's own live activity
// list - they would drown everything else here.
import { computed, onMounted, ref, watch } from "vue";
import { getJournal, type JournalEvent } from "../api.js";
import { actorIcon, describeEvent, relativeTime } from "../journal-display.js";

const props = withDefaults(defineProps<{ taskId?: number; projectId?: number; pageSize?: number; showTask?: boolean; types?: string }>(), {
  pageSize: 50,
  showTask: true,
});

const events = ref<JournalEvent[]>([]);
const loading = ref(false);
const exhausted = ref(false);
const error = ref("");

const visible = computed(() => events.value.filter((e) => e.eventType !== "activity"));

async function load(reset: boolean): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const beforeId = reset ? undefined : events.value.at(-1)?.id;
    const page = await getJournal({ taskId: props.taskId, projectId: props.projectId, beforeId, limit: props.pageSize, types: props.types });
    events.value = reset ? page : [...events.value, ...page];
    exhausted.value = page.length < props.pageSize;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => load(true));
watch(() => [props.taskId, props.projectId, props.types], () => load(true));

defineExpose({ reload: () => load(true) });
</script>

<template>
  <div>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-2">{{ error }}</v-alert>
    <v-list density="compact" lines="two">
      <v-list-item v-if="!loading && visible.length === 0" subtitle="No history yet" />
      <v-list-item v-for="e in visible" :key="e.id">
        <template #prepend>
          <v-icon size="small">{{ actorIcon(e.actorType) }}</v-icon>
        </template>
        <v-list-item-title class="text-wrap">
          <strong>{{ e.actorName }}</strong> {{ describeEvent(e) }}
        </v-list-item-title>
        <v-list-item-subtitle>
          <span :title="new Date(e.createdAt).toLocaleString()">{{ relativeTime(e.createdAt) }}</span>
          <template v-if="showTask && e.taskId">
            · <router-link :to="`/tasks/${e.taskId}`">#{{ e.taskId }} {{ e.taskTitle }}</router-link>
          </template>
          <template v-if="!projectId && e.projectSlug"> · {{ e.projectSlug }}</template>
        </v-list-item-subtitle>
      </v-list-item>
    </v-list>
    <div class="text-center">
      <v-btn v-if="!exhausted" variant="text" size="small" :loading="loading" @click="load(false)">Load more</v-btn>
    </div>
  </div>
</template>
