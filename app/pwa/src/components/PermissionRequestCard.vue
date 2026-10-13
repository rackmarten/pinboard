<script setup lang="ts">
// a permission request rendered as a card the operator can act on
// with one thumb, replacing a past task's three buttons under a markdown code
// block in a chat bubble.
//
// The correctness requirement here is `suppressAlwaysAllowRule`: the Agent
// SDK sets it when the rule a "don't ask again" would write grants more than
// the single call being approved. Rendering the button anyway would hand out
// a broader standing permission than the operator thinks they are approving,
// so it is hidden outright rather than disabled. An empty `suggestions` array
// hides it for the same reason from the other direction - there would be no
// SDK-authored rule to send back, and inventing one here is exactly what the
// contract forbids.
import { computed } from "vue";
import { prettyJson, toolSummary, type PermissionDecision, type PermissionRequest } from "../chat-transcript.js";

const props = defineProps<{
  request: PermissionRequest;
  decision: PermissionDecision | null;
  /** Ticking clock from the parent, so the expiry countdown is live. */
  now: number;
  busy: boolean;
  disabled: boolean;
}>();

const emit = defineEmits<{
  (event: "decide", value: { behavior: "allow" | "deny"; updatedPermissions: unknown[] | null }): void;
}>();

const summary = computed(() => toolSummary(props.request.toolName, props.request.input));

const canRemember = computed(
  () => !props.request.suppressAlwaysAllowRule && props.request.suggestions.length > 0,
);

const expiresInMs = computed(() => {
  if (!props.request.expiresAt) return null;
  return new Date(props.request.expiresAt).getTime() - props.now;
});

// The session denies by default when its wait runs out, so an expired card
// is not merely stale - the tool call has already been refused.
const expired = computed(() => expiresInMs.value !== null && expiresInMs.value <= 0);

const expiresLabel = computed(() => {
  const ms = expiresInMs.value;
  if (ms === null || ms <= 0) return "";
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return minutes > 0 ? `${minutes}m ${seconds}s left` : `${seconds}s left`;
});

const actionable = computed(() => props.decision === null && !expired.value && !props.disabled);
</script>

<template>
  <v-card
    :color="decision ? undefined : 'warning'"
    :variant="decision ? 'outlined' : 'tonal'"
    density="compact"
    class="permission-card"
  >
    <v-card-item class="pb-2">
      <template #prepend>
        <v-icon :icon="decision === null ? 'mdi-shield-alert-outline' : 'mdi-shield-check-outline'" />
      </template>
      <v-card-title class="text-subtitle-2">
        {{ request.title ?? `Allow ${request.displayName ?? request.toolName}?` }}
      </v-card-title>
      <v-card-subtitle v-if="request.reason ?? request.decisionReason" class="text-wrap">
        {{ request.reason ?? request.decisionReason }}
      </v-card-subtitle>
    </v-card-item>

    <v-card-text class="pt-0">
      <p v-if="request.description" class="text-body-2 mb-2">{{ request.description }}</p>
      <pre v-if="summary" class="permission-command">{{ summary }}</pre>
      <p v-if="request.blockedPath" class="text-caption text-medium-emphasis mb-0">
        blocked path: {{ request.blockedPath }}
      </p>

      <v-expansion-panels v-if="request.input" variant="accordion" class="mt-2">
        <v-expansion-panel elevation="0">
          <v-expansion-panel-title class="text-caption">Full tool input</v-expansion-panel-title>
          <v-expansion-panel-text>
            <pre class="permission-input">{{ prettyJson(request.input) }}</pre>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
    </v-card-text>

    <v-card-actions v-if="actionable" class="flex-wrap ga-2 px-4 pb-4 pt-0">
      <v-btn
        color="success"
        variant="flat"
        :loading="busy"
        prepend-icon="mdi-check"
        @click="emit('decide', { behavior: 'allow', updatedPermissions: null })"
      >
        Approve
      </v-btn>
      <v-btn
        v-if="canRemember"
        color="success"
        variant="tonal"
        :loading="busy"
        prepend-icon="mdi-check-all"
        @click="emit('decide', { behavior: 'allow', updatedPermissions: request.suggestions })"
      >
        Don't ask again
      </v-btn>
      <v-btn
        color="error"
        variant="tonal"
        :loading="busy"
        prepend-icon="mdi-close"
        @click="emit('decide', { behavior: 'deny', updatedPermissions: null })"
      >
        Deny
      </v-btn>
      <span v-if="expiresLabel" class="text-caption text-medium-emphasis ms-auto">{{ expiresLabel }}</span>
    </v-card-actions>

    <v-card-text v-else class="pt-0 text-caption text-medium-emphasis">
      <template v-if="decision">
        {{ decision.behavior === "allow" ? "Approved" : "Denied" }}
        <template v-if="decision.remembered"> - won't ask again this thread</template>
        <template v-if="decision.message"> - {{ decision.message }}</template>
      </template>
      <template v-else-if="expired">No reply in time - the session denied this by default.</template>
      <template v-else>This thread is closed.</template>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.permission-card {
  width: 100%;
}
.permission-command,
.permission-input {
  background: rgba(var(--v-theme-on-surface), 0.08);
  border-radius: 4px;
  padding: 8px;
  margin: 0 0 8px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.8125rem;
}
.permission-input {
  max-height: 40vh;
  overflow-y: auto;
}
</style>
