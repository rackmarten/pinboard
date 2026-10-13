<script setup lang="ts">
// I17: markdown editing for task descriptions, replacing I11's Tiptap
// WYSIWYG editor - plain textarea + toolbar buttons that wrap the current
// selection in markdown syntax, plus a Preview toggle since raw markdown
// is hard to judge blind. Rendering uses the same `renderDescriptionHtml`
// TaskDetailView.vue uses, so the preview matches what actually gets shown.
import { computed, ref } from "vue";
import { renderDescriptionHtml } from "../description-html.js";

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const textarea = ref<HTMLTextAreaElement | null>(null);
const showPreview = ref(false);

const previewHtml = computed(() => renderDescriptionHtml(props.modelValue));

function update(value: string): void {
  emit("update:modelValue", value);
}

// Wraps the current selection in `before`/`after` (or inserts a placeholder
// if nothing is selected), then restores focus and a sensible selection so
// repeated toolbar clicks keep working naturally.
function wrapSelection(before: string, after: string, placeholder = ""): void {
  const el = textarea.value;
  if (!el) return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const value = props.modelValue;
  const selected = value.slice(start, end) || placeholder;
  const next = value.slice(0, start) + before + selected + after + value.slice(end);
  update(next);
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(start + before.length, start + before.length + selected.length);
  });
}

// Inserts `prefix` at the start of each selected line (or the current line
// if nothing is selected) - used for list items and blockquotes.
function prefixLines(prefix: string): void {
  const el = textarea.value;
  if (!el) return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const value = props.modelValue;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = end === start ? value.indexOf("\n", start) : end;
  const block = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);
  const prefixed = block
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
  const next = value.slice(0, lineStart) + prefixed + value.slice(lineEnd === -1 ? value.length : lineEnd);
  update(next);
  requestAnimationFrame(() => el.focus());
}

function insertLink(): void {
  const url = window.prompt("Link URL", "https://");
  if (!url) return;
  wrapSelection("[", `](${url})`, "link text");
}
</script>

<template>
  <div class="description-editor">
    <div class="description-editor__toolbar">
      <v-btn icon="mdi-format-bold" size="small" variant="text" @click="wrapSelection('**', '**', 'bold text')" />
      <v-btn icon="mdi-format-italic" size="small" variant="text" @click="wrapSelection('*', '*', 'italic text')" />
      <v-btn icon="mdi-format-strikethrough" size="small" variant="text" @click="wrapSelection('~~', '~~', 'strikethrough')" />
      <v-btn icon="mdi-format-list-bulleted" size="small" variant="text" @click="prefixLines('- ')" />
      <v-btn icon="mdi-format-list-numbered" size="small" variant="text" @click="prefixLines('1. ')" />
      <v-btn icon="mdi-format-quote-close" size="small" variant="text" @click="prefixLines('> ')" />
      <v-btn icon="mdi-code-tags" size="small" variant="text" @click="wrapSelection('`', '`', 'code')" />
      <v-btn icon="mdi-link-variant" size="small" variant="text" @click="insertLink" />
      <v-spacer />
      <v-btn-toggle v-model="showPreview" density="compact" mandatory variant="outlined" divided>
        <v-btn :value="false" size="small">Edit</v-btn>
        <v-btn :value="true" size="small">Preview</v-btn>
      </v-btn-toggle>
    </div>
    <textarea
      v-if="!showPreview"
      ref="textarea"
      :value="modelValue"
      class="description-editor__textarea"
      placeholder="Markdown supported: **bold**, *italic*, lists, links, `code`..."
      @input="update(($event.target as HTMLTextAreaElement).value)"
    />
    <div v-else class="description-editor__preview" v-html="previewHtml" />
  </div>
</template>

<style scoped>
.description-editor {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 4px;
}

.description-editor__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 4px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.description-editor__textarea {
  display: block;
  width: 100%;
  min-height: 200px;
  max-height: 60vh;
  padding: 8px 12px;
  border: none;
  outline: none;
  resize: vertical;
  font-family: inherit;
  font-size: 0.9rem;
  background: transparent;
  color: inherit;
}

.description-editor__preview {
  padding: 8px 12px;
  min-height: 200px;
  max-height: 60vh;
  overflow-y: auto;
}

.description-editor__preview :deep(p) {
  margin: 0 0 0.5em;
}

.description-editor__preview :deep(p:last-child) {
  margin-bottom: 0;
}
</style>
