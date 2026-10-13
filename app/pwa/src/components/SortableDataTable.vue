<script setup lang="ts" generic="T extends Record<string, unknown>">
// Generic sortable-datatable wrapper around Vuetify's v-data-table: headers,
// items, loading and an empty state as props, every item/header slot the
// caller passes forwarded through untouched. this is meant to
// become @rackmarten/ui-kit's shared datatable helper - it couldn't be
// built directly in homelab-kit from this pinboard-only worktree, so it
// lives here first and should move over (with TaskListView switched to the
// published version) the next time a session has a homelab-kit checkout.
import type { PropType } from "vue";

export interface SortableDataTableHeader {
  title: string;
  key: string;
  sortable?: boolean;
  align?: "start" | "center" | "end";
  width?: string | number;
  // Vuetify's per-header raw-item comparator; `() => 0` turns the table's
  // own sort into a stable no-op for a caller that pre-sorts.
  sortRaw?: (a: unknown, b: unknown) => number;
}

export interface SortItem {
  key: string;
  order?: "asc" | "desc";
}

defineProps({
  headers: { type: Array as PropType<SortableDataTableHeader[]>, required: true },
  items: { type: Array as PropType<T[]>, required: true },
  itemKey: { type: String, default: "id" },
  loading: { type: Boolean, default: false },
  sortBy: { type: Array as PropType<SortItem[]>, default: () => [] },
  emptyIcon: { type: String, default: "mdi-table-off" },
  emptyTitle: { type: String, default: "No data" },
  emptyText: { type: String, default: undefined },
  // bulk-edit row selection - opt-in per caller, forwarded
  // straight to v-data-table's own show-select/model-value.
  showSelect: { type: Boolean, default: false },
  modelValue: { type: Array as PropType<unknown[]>, default: () => [] },
  // every table defaults to 25 rows/page; page itself is a
  // caller-controlled v-model so it can be persisted to the URL like sort
  // and filters are.
  page: { type: Number, default: 1 },
  itemsPerPage: { type: Number, default: 25 },
});

defineEmits<{
  "update:sortBy": [SortItem[]];
  "update:modelValue": [unknown[]];
  "update:page": [number];
  "update:itemsPerPage": [number];
}>();
</script>

<template>
  <v-data-table
    :headers="headers"
    :items="items"
    :item-value="itemKey"
    :loading="loading"
    :sort-by="sortBy"
    :show-select="showSelect"
    :model-value="modelValue"
    :page="page"
    :items-per-page="itemsPerPage"
    density="comfortable"
    @update:sort-by="$emit('update:sortBy', $event)"
    @update:model-value="$emit('update:modelValue', $event)"
    @update:page="$emit('update:page', $event)"
    @update:items-per-page="$emit('update:itemsPerPage', $event)"
  >
    <template v-if="!$slots['no-data']" #no-data>
      <v-empty-state :icon="emptyIcon" :title="emptyTitle" :text="emptyText" />
    </template>
    <template v-for="(_, slot) in $slots" #[slot]="scope">
      <slot :name="slot" v-bind="scope ?? {}" />
    </template>
  </v-data-table>
</template>
