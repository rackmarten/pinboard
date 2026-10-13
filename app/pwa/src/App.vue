<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useDisplay } from "vuetify";
import { AppShell, GlobalSearch, NotificationBell, type NavItem } from "@rackmarten/ui-kit";
import { notificationSource, searchProvider } from "./app-bar.js";
import { getAsks, getTasks } from "./api.js";
import { REVIEW_STATUSES } from "./inbox.js";
import { usePolling } from "./composables/usePolling.js";

// desktop breakpoint at Vuetify's `lg` (1280px+). Other desktop
// tasks (chat sidebar, task table) key off this same `lgAndUp` signal.
const { lgAndUp } = useDisplay();

// Where account avatars live, as `<base><user id>`; empty shows initials.
// A build-time setting (AVATAR_BASE_URL, passed through as a build arg).
const avatarBaseUrl = import.meta.env.VITE_AVATAR_BASE_URL ?? "";

// I4b/I4c added the review queue and running-workers screens, so this is
// the first real nav list - task list stayed the single surface through I1b.
// "Needs you" leads the nav. AppShell's NavItem has no badge
// slot, so the count (open questions + tasks awaiting review) rides in the
// label.
const needsYou = ref(0);
async function refreshNeedsYou(): Promise<void> {
  const [asks, review] = await Promise.all([getAsks(["open"]), getTasks({ status: REVIEW_STATUSES })]);
  needsYou.value = asks.filter((a) => a.kind === "question").length + review.length;
}
onMounted(() => refreshNeedsYou().catch(() => {}));
usePolling(() => refreshNeedsYou().catch(() => {}), 30_000);

const navItems = computed<NavItem[]>(() => [
  {
    label: needsYou.value ? `Needs you (${needsYou.value})` : "Needs you",
    shortLabel: needsYou.value ? `Inbox ${needsYou.value}` : "Inbox",
    icon: "mdi-inbox-arrow-down-outline",
    to: "/inbox",
  },
  // dashboard is the default landing page ("/").
  { label: "Dashboard", icon: "mdi-view-dashboard-outline", to: "/" },
  { label: "Tasks", icon: "mdi-format-list-checks", to: "/tasks" },
  { label: "Projects", icon: "mdi-folder-outline", to: "/projects" },
  { label: "Workers", icon: "mdi-robot-outline", to: "/workers" },
  { label: "Chat", icon: "mdi-chat-outline", to: "/chat" },
  // the journal - who changed what, when, across everything.
  { label: "Activity", icon: "mdi-timeline-clock-outline", to: "/activity" },
  // deployed vs pending per project, Deploy now, deploy history.
  { label: "Releases", icon: "mdi-rocket-launch-outline", to: "/releases" },
  // the $-based work plan. Sits above Usage/Governor because it
  // is the screen that answers "what happens next"; those two are history.
  { label: "Plan", icon: "mdi-calendar-clock-outline", to: "/plan" },
  { label: "Usage", icon: "mdi-currency-usd", to: "/usage" },
  { label: "Governor", icon: "mdi-speedometer", to: "/governor" },
  // I12a: agent management + routing rules.
  { label: "Agents", icon: "mdi-account-cog-outline", to: "/agents" },
]);
</script>

<template>
  <AppShell title="Pinboard" :nav-items="navItems" :avatar-base-url="avatarBaseUrl">
    <template #app-bar-actions>
      <GlobalSearch
        :provider="searchProvider"
        label="Search tasks"
        placeholder="Search tasks by ID or title..."
        empty-text="No matching tasks"
      />
      <NotificationBell :source="notificationSource" see-all-to="/notifications" />
    </template>
    <!-- I4c: the PWA was built mobile-first (I1b) and stretched full-width
         looks wrong on a wide desktop monitor - center content instead.
         at `lg` (1280px+) the cap widens to ~1800px instead of
         staying at the original mobile-first 1100px. -->
    <div class="pinboard-content" :class="{ 'pinboard-content--desktop': lgAndUp }">
      <router-view />
    </div>
  </AppShell>
</template>

<style scoped>
.pinboard-content {
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
}

.pinboard-content--desktop {
  max-width: 1800px;
}
</style>
