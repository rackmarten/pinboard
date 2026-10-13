<script setup lang="ts">
// the companion to TaskStatusChip - one definition of what a task's
// priority looks like, instead of the same flag chip rebuilt in three views.
//
// `labelled` is the one real difference between the call sites: the task detail
// page reads "priority 7" because it sits in a row of unlabelled chips where a
// bare number would be ambiguous, while a list row already has the flag icon
// for context and only needs the number.
//
// Whether a zero priority is worth showing at all stays with the caller (a
// plain `v-if`), not here - the list views hide it as noise, the detail page
// shows it because that page is where you go to see every field, and burying
// that decision inside a shared component would make both behaviours look like
// accidents.
import { priorityColor } from "../display.js";

withDefaults(defineProps<{ priority: number; labelled?: boolean }>(), { labelled: false });
</script>

<template>
  <v-chip size="small" variant="tonal" :color="priorityColor(priority)" prepend-icon="mdi-flag-outline">
    <template v-if="labelled">priority {{ priority }}</template>
    <template v-else>{{ priority }}</template>
  </v-chip>
</template>
