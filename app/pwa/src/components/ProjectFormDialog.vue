<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useBackClose } from "@rackmarten/ui-kit";
import { createProject, updateProject, type Project } from "../api.js";
import DescriptionEditor from "./DescriptionEditor.vue";

const props = defineProps<{
  modelValue: boolean;
  project?: Project | null;
  projects?: Project[];
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [project: Project];
}>();

// back closes the dialog instead of leaving the page.
const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});
useBackClose(open);

const slug = ref("");
const name = ref("");
const description = ref("");
const localPath = ref("");
const repoUrl = ref("");
const parentProjectId = ref<number | null>(null);
const autoDeployAllowed = ref(false);
const context = ref("");
const relatedProjectIds = ref<number[]>([]);
const saving = ref(false);
const error = ref<string | null>(null);

// A project can't be its own parent, and the API rejects any deeper cycle -
// dropping the project being edited from the picker catches the obvious
// case client-side before that round trip.
const parentOptions = computed(() => (props.projects ?? []).filter((p) => p.id !== props.project?.id));

// a project reference (id under the hood, name/slug shown),
// not a repo path string - a project is what's actually being related, and
// its localPath is only resolved from the id when an actual filesystem
// path is needed. Excludes this project itself, which is already implied.
const relatedProjectOptions = computed(() => (props.projects ?? []).filter((p) => p.id !== props.project?.id));

function reset(): void {
  const p = props.project;
  slug.value = p?.slug ?? "";
  name.value = p?.name ?? "";
  description.value = p?.description ?? "";
  localPath.value = p?.localPath ?? "";
  repoUrl.value = p?.repoUrl ?? "";
  parentProjectId.value = p?.parentProjectId ?? null;
  autoDeployAllowed.value = p?.autoDeployAllowed ?? false;
  context.value = p?.context ?? "";
  relatedProjectIds.value = p?.relatedProjectIds ?? [];
  error.value = null;
}

watch(() => props.modelValue, (open) => {
  if (open) reset();
});

async function save(): Promise<void> {
  if (!slug.value.trim() || !name.value.trim()) {
    error.value = "Slug and name are required";
    return;
  }
  saving.value = true;
  error.value = null;
  const input = {
    slug: slug.value.trim(),
    name: name.value.trim(),
    description: description.value.trim() || undefined,
    localPath: localPath.value.trim() || undefined,
    repoUrl: repoUrl.value.trim() || undefined,
    parentProjectId: parentProjectId.value,
    autoDeployAllowed: autoDeployAllowed.value,
    context: context.value || undefined,
    relatedProjectIds: relatedProjectIds.value,
  };
  try {
    const saved = props.project ? await updateProject(props.project.id, input) : await createProject(input);
    emit("saved", saved);
    emit("update:modelValue", false);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="700">
    <v-card :title="project ? 'Edit project' : 'New project'">
      <v-card-text class="d-flex flex-column ga-3">
        <v-text-field
          v-model="slug"
          label="Slug"
          density="comfortable"
          :disabled="!!project"
          :hint="project ? undefined : 'e.g. my-app, my-api - matches the sibling repo directory name'"
          persistent-hint
          autofocus
        />
        <v-text-field v-model="name" label="Name" density="comfortable" />
        <v-textarea v-model="description" label="Description" rows="2" density="comfortable" />
        <v-select
          v-model="parentProjectId"
          label="Parent project"
          :items="parentOptions"
          item-title="name"
          item-value="id"
          clearable
          density="comfortable"
          hint="File this project under another (e.g. a sub-service under its parent's umbrella project). Leave blank for a top-level project."
          persistent-hint
        />
        <div>
          <div class="text-caption text-medium-emphasis mb-1">
            Context - current state only (decisions, what's in flight, what a new task needs to know). Reference
            tasks with #id instead of restating their history; keep shipped-work history in the repo's own
            CHANGELOG.md.
          </div>
          <DescriptionEditor v-model="context" />
        </div>
        <v-text-field
          v-model="localPath"
          label="Local path"
          density="comfortable"
          hint="Path to the local checkout, relative to `work`'s workspace root (default ~/projects) - lets `work plan sync` find it, e.g. my-org/pinboard or uncik-projects/foo. Leave blank for a cross-cutting project with no checkout of its own."
          persistent-hint
        />
        <v-text-field
          v-model="repoUrl"
          label="Repo URL"
          density="comfortable"
          hint="Full clone/browse URL, e.g. https://github.com/my-org/pinboard"
          persistent-hint
        />
        <v-select
          v-model="relatedProjectIds"
          label="Related projects"
          :items="relatedProjectOptions"
          item-title="name"
          item-value="id"
          multiple
          chips
          closable-chips
          density="comfortable"
          hint="Other projects whose repos an agent run for this project needs write access to, beyond its own (e.g. reverse-proxy, glance, tower)"
          persistent-hint
        />
        <v-switch
          v-model="autoDeployAllowed"
          label="Auto-deploy"
          color="primary"
          density="comfortable"
          hide-details="auto"
          hint="Let a green-CI PR from an agent be merged and deployed automatically, no human review. Never applies to the production project regardless of this flag."
          persistent-hint
        />
        <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" :loading="saving" @click="save">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
