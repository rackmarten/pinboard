<script setup lang="ts">
// one definition of what a task's status looks like. Five views
// were each building this same chip by hand from display.ts's statusColor/
// statusIcon - the helpers were shared but the markup around them was not, so
// the chips had already drifted apart (one had no icon, another a different
// size) and any change to how a status reads meant editing five files.
//
// Deliberately presentational and dumb: it takes a status string, not a task,
// because two of its callers only have a status to hand (the dashboard's
// per-status counts, and the task list's select-selection slot). Anything else
// a caller needs - a dropdown's menu props, an append icon, a class, disabled -
// falls through as a normal attribute, which is why there is no prop for any of
// them.
import { statusColor, statusIcon } from "../display.js";

withDefaults(defineProps<{ status: string; icon?: boolean }>(), { icon: true });
</script>

<template>
  <v-chip
    size="small"
    variant="tonal"
    :color="statusColor(status)"
    :prepend-icon="icon ? statusIcon(status) : undefined"
  >
    {{ status }}
  </v-chip>
</template>
