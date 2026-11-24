<script setup lang="ts">
// Approving with unticked checklist items: the items, and the comment the
// approve needs before it goes ahead (see approve.ts). Used by the review
// queue and a task's own page.
import { ref, watch } from "vue";
import { useBackClose } from "@rackmarten/ui-kit";
import { canConfirmApprove } from "../approve.js";

const open = defineModel<boolean>({ required: true });
defineProps<{ unchecked: string[]; loading?: boolean }>();
const emit = defineEmits<{ confirm: [comment: string] }>();
useBackClose(open);

const comment = ref("");
watch(open, (isOpen) => {
  if (isOpen) comment.value = "";
});
</script>

<template>
  <v-dialog v-model="open" max-width="480">
    <v-card title="Approve with unchecked items?">
      <v-card-text>
        <p class="mb-2">These checklist items are not ticked:</p>
        <ul class="mb-3 ml-5">
          <li v-for="item in unchecked" :key="item">{{ item }}</li>
        </ul>
        <v-textarea v-model="comment" label="Why approve anyway? (posted as a comment)" rows="3" density="comfortable" autofocus />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="open = false">Cancel</v-btn>
        <v-btn
          variant="tonal"
          color="success"
          :disabled="!canConfirmApprove(comment)"
          :loading="loading"
          data-track="approve-unticked"
          @click="emit('confirm', comment)"
        >
          Approve
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
