<script setup lang="ts">
import { ref } from "vue";
import { updateChecklistItem, type ChecklistItem } from "../api.js";

// the handoff's review checklist: a checkbox and an optional short note per
// item. Used on the inbox's review card and on the task page; every change
// is saved at once and the server's merged list replaces the local one.
const props = defineProps<{ taskId: number; items: ChecklistItem[] }>();
const emit = defineEmits<{ "update:items": [items: ChecklistItem[]] }>();

const saving = ref<string | null>(null);
const error = ref<string | null>(null);
const editing = ref<string | null>(null);
const draft = ref("");

async function save(change: { item: string; checked?: boolean; note?: string | null }): Promise<void> {
  saving.value = change.item;
  error.value = null;
  try {
    emit("update:items", (await updateChecklistItem(props.taskId, change)).items);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = null;
  }
}

function editNote(item: ChecklistItem): void {
  editing.value = item.item;
  draft.value = item.note ?? "";
}

async function saveNote(item: ChecklistItem): Promise<void> {
  if (editing.value !== item.item) return;
  editing.value = null;
  if (draft.value.trim() === (item.note ?? "")) return;
  await save({ item: item.item, note: draft.value });
}
</script>

<template>
  <div>
    <v-alert v-if="error" type="error" density="compact" variant="tonal" class="mb-2">{{ error }}</v-alert>
    <div v-for="item in items" :key="item.item" class="mb-1">
      <div class="d-flex align-start">
        <v-checkbox
          :model-value="item.checked"
          :label="item.item"
          :disabled="saving === item.item"
          density="compact"
          hide-details
          class="flex-grow-1"
          @update:model-value="save({ item: item.item, checked: !!$event })"
        />
        <v-btn
          icon="mdi-note-edit-outline"
          size="small"
          variant="text"
          :title="item.note ? 'Edit note' : 'Add note'"
          @click="editNote(item)"
        />
      </div>
      <v-text-field
        v-if="editing === item.item"
        v-model="draft"
        label="Note"
        density="compact"
        maxlength="500"
        hide-details
        autofocus
        class="ml-10 mb-2"
        @keydown.enter="saveNote(item)"
        @blur="saveNote(item)"
      />
      <div v-else-if="item.note" class="ml-10 text-caption text-medium-emphasis">{{ item.note }}</div>
    </div>
  </div>
</template>
