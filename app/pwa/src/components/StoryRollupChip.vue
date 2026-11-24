<script setup lang="ts">
// what a story shows where any other task shows its status chip: a story has
// no workflow status of its own, so this is its phase derived from its
// children, with their counts per phase (the API's `rollup`). Extra
// attributes (a menu activator's props, an append icon) fall through to the
// chip, the same as TaskStatusChip.
import type { StoryRollup } from "../api.js";
import { phaseColor, phaseIcon, phaseLabel } from "../display.js";
import { rollupCountsText } from "../story.js";

defineProps<{ rollup: StoryRollup }>();
</script>

<template>
  <v-chip size="small" variant="tonal" :color="phaseColor(rollup.phase)" :prepend-icon="phaseIcon(rollup.phase)">
    {{ phaseLabel(rollup.phase) }}
    <span v-if="rollupCountsText(rollup.counts)" class="ml-1 text-medium-emphasis">· {{ rollupCountsText(rollup.counts) }}</span>
  </v-chip>
</template>
