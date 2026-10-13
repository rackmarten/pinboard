<script setup lang="ts">
// full notification history behind the bell's "See all".
import { onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getNotifications, markAllNotificationsRead, markNotificationRead, sendTestPush, type AppNotification } from "../api.js";
import { notificationColor, notificationIcon, relativeTime } from "../journal-display.js";

const PAGE = 50;
const router = useRouter();
const items = ref<AppNotification[]>([]);
const unreadOnly = ref(false);
const loading = ref(false);
const exhausted = ref(false);

async function load(reset: boolean): Promise<void> {
  loading.value = true;
  try {
    const beforeId = reset ? undefined : items.value.at(-1)?.id;
    const page = await getNotifications({ unread: unreadOnly.value, beforeId, limit: PAGE });
    items.value = reset ? page : [...items.value, ...page];
    exhausted.value = page.length < PAGE;
  } finally {
    loading.value = false;
  }
}

async function openItem(n: AppNotification): Promise<void> {
  if (!n.readAt) await markNotificationRead(n.id);
  if (n.url) await router.push(n.url);
  else n.readAt = new Date().toISOString();
}

async function readAll(): Promise<void> {
  await markAllNotificationsRead();
  await load(true);
}

// phone push goes through ntfy - subscribe to the "pinboard"
// topic in the ntfy app. The button only proves the server can publish.
const pushMessage = ref("");

async function testPush(): Promise<void> {
  pushMessage.value = "";
  try {
    await sendTestPush();
    pushMessage.value = "Published to ntfy - check the phone.";
  } catch (err) {
    pushMessage.value = (err as Error).message;
  }
}

onMounted(() => {
  void load(true);
});
watch(unreadOnly, () => load(true));
</script>

<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-2 mb-2">
      <h1 class="text-h5">Notifications</h1>
      <v-spacer />
      <v-switch v-model="unreadOnly" label="Unread only" density="compact" hide-details color="primary" />
      <v-btn variant="tonal" size="small" @click="readAll">Mark all read</v-btn>
    </div>
    <v-card class="mb-3">
      <v-card-text class="d-flex align-center flex-wrap ga-2 text-body-2">
        <span class="text-medium-emphasis">Phone push goes through ntfy: subscribe to the <code>pinboard</code> topic on your ntfy server in the ntfy app.</span>
        <v-spacer />
        <v-btn variant="text" size="small" @click="testPush">Send test</v-btn>
      </v-card-text>
      <v-card-text v-if="pushMessage" class="pt-0 text-medium-emphasis text-body-2">{{ pushMessage }}</v-card-text>
    </v-card>
    <v-card>
      <v-list lines="two">
        <v-list-item v-if="!loading && items.length === 0" subtitle="Nothing here" />
        <v-list-item v-for="n in items" :key="n.id" :class="{ 'notification--unread': !n.readAt }" @click="openItem(n)">
          <template #prepend>
            <v-icon :color="notificationColor(n.kind)">{{ notificationIcon(n.kind) }}</v-icon>
          </template>
          <v-list-item-title class="text-wrap">{{ n.title }}</v-list-item-title>
          <v-list-item-subtitle>
            <span v-if="n.body">{{ n.body }} · </span>
            <span :title="new Date(n.createdAt).toLocaleString()">{{ relativeTime(n.createdAt) }}</span>
          </v-list-item-subtitle>
        </v-list-item>
      </v-list>
    </v-card>
    <div class="text-center mt-2">
      <v-btn v-if="!exhausted" variant="text" :loading="loading" @click="load(false)">Load more</v-btn>
    </div>
  </v-container>
</template>

<style scoped>
.notification--unread {
  background: rgba(var(--v-theme-primary), 0.08);
}
</style>
