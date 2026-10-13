<script setup lang="ts">
// one open question from a task (a structured ask, a past task) on
// the inbox's Decide section. Chat's AskUserQuestion prompts stay on
// QuestionCard.vue: different shape (several questions, multi-select, an
// expiry), different endpoint.
//
// Mobile first: options are full-width radio rows (big tap targets) and the
// submit button sits at the bottom of the card, within thumb reach.
import { ref } from "vue";
import type { Ask } from "../api.js";
import { renderDescriptionHtml } from "../description-html.js";
import { recommendedIndex } from "../inbox.js";

// `selected` is the card's "Resolve in chat" checkbox.
const props = defineProps<{ ask: Ask; busy: boolean; selected?: boolean }>();

const emit = defineEmits<{
  (event: "answer", value: { option: number | null; text: string }): void;
  (event: "update:selected", value: boolean): void;
}>();

const option = ref<number | null>(recommendedIndex(props.ask));
const text = ref("");
</script>

<template>
  <v-card variant="tonal" color="info" density="compact" class="ask-card">
    <v-card-item class="pb-1">
      <div class="d-flex align-center ga-1">
        <v-checkbox-btn
          :model-value="selected"
          density="compact"
          aria-label="Select for Resolve in chat"
          @update:model-value="emit('update:selected', !!$event)"
        />
        <v-card-subtitle class="px-0">
          <router-link :to="`/tasks/${ask.taskId}`" class="text-decoration-none">#{{ ask.taskId }}</router-link>
          {{ ask.taskTitle }}
        </v-card-subtitle>
      </div>
    </v-card-item>
    <v-card-text class="pt-0 d-flex flex-column ga-2">
      <div v-if="ask.context" class="text-body-2 text-medium-emphasis description-html" v-html="renderDescriptionHtml(ask.context)" />
      <div class="text-body-1 font-weight-medium description-html" v-html="renderDescriptionHtml(ask.question)" />

      <v-radio-group v-model="option" hide-details density="comfortable" class="ask-options">
        <v-radio v-for="(o, i) in ask.options" :key="i" :value="i" class="ask-option align-start">
          <template #label>
            <div class="py-1">
              <span class="text-body-2 font-weight-medium">{{ o.label }}</span>
              <v-chip v-if="o.recommended" size="x-small" color="success" label class="ms-2">Recommended</v-chip>
              <div
                v-if="o.rationale"
                class="text-caption text-medium-emphasis description-html"
                v-html="renderDescriptionHtml(o.rationale)"
              />
            </div>
          </template>
        </v-radio>
      </v-radio-group>

      <v-textarea
        v-model="text"
        label="Anything to add (optional)"
        rows="1"
        auto-grow
        density="compact"
        variant="outlined"
        hide-details
      />
    </v-card-text>
    <v-card-actions class="px-4 pb-3 pt-0">
      <v-btn
        block
        color="primary"
        variant="flat"
        size="large"
        prepend-icon="mdi-send"
        :loading="busy"
        :disabled="option === null && !text.trim()"
        @click="emit('answer', { option, text })"
      >
        Answer
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<style scoped>
.ask-card {
  width: 100%;
}
.ask-options :deep(.v-selection-control) {
  align-items: flex-start;
}
.description-html :deep(p) {
  margin: 0;
}
</style>
