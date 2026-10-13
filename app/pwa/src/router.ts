import { createHomelabRouter } from "@rackmarten/ui-kit";
import type { Router } from "vue-router";
import DashboardView from "./views/DashboardView.vue";
import TaskListView from "./views/TaskListView.vue";
import TaskDetailView from "./views/TaskDetailView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import ProjectDetailView from "./views/ProjectDetailView.vue";
import InboxView from "./views/InboxView.vue";
import WorkersView from "./views/WorkersView.vue";
import UsageView from "./views/UsageView.vue";
import GovernorView from "./views/GovernorView.vue";
import PlanView from "./views/PlanView.vue";
import ChatListView from "./views/ChatListView.vue";
import ChatNewView from "./views/ChatNewView.vue";
import AgentsView from "./views/AgentsView.vue";
import ActivityView from "./views/ActivityView.vue";
import NotificationsView from "./views/NotificationsView.vue";
import ReleasesView from "./views/ReleasesView.vue";

// clean URLs via homelab-kit's router (web history, old /#/x
// links redirected to /x at boot, back closes the topmost overlay). The
// server answers any page path with index.html (server-kit's spa option).
export const router: Router = createHomelabRouter([
  { path: "/", component: DashboardView },
  { path: "/tasks", component: TaskListView },
  { path: "/tasks/:id", component: TaskDetailView, props: true },
  { path: "/projects", component: ProjectsView },
  { path: "/projects/:id", component: ProjectDetailView, props: true },
  // the review queue became the inbox's Review section.
  { path: "/inbox", component: InboxView },
  { path: "/review", redirect: "/inbox" },
  { path: "/workers", component: WorkersView },
  { path: "/usage", component: UsageView },
  { path: "/plan", component: PlanView },
  { path: "/governor", component: GovernorView },
  // /chat and /chat/:id are the same route record (optional
  // param) so ChatListView - which on desktop (`lg`+) renders the thread
  // list as a persistent sidebar - is never remounted when the selected
  // thread changes. ChatListView embeds ChatThreadView itself (as the
  // desktop right pane, or as the whole mobile page) rather than routing
  // to it as a separate top-level view.
  // /chat/new is its own top-level route (a static segment, so
  // it's matched ahead of the dynamic /chat/:id? below regardless of
  // declaration order) - the compose step for a thread that doesn't exist
  // in the database yet, so it can't be the thread-by-id route.
  { path: "/chat/new", component: ChatNewView },
  { path: "/chat/:id?", component: ChatListView, props: true },
  { path: "/agents", component: AgentsView },
  // the journal and the notification history.
  { path: "/activity", component: ActivityView },
  { path: "/notifications", component: NotificationsView },
  // what is deployed where, what is pending, deploy history.
  { path: "/releases", component: ReleasesView },
]);

// Links inside rendered markdown (v-html, e.g. a `#123` task reference) are
// plain anchors the router never sees. Route same-origin page links through
// it so they don't reload the whole app.
export function installInAppLinks(r: Router): void {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.(".description-html a[href]") as HTMLAnchorElement | null;
    if (!link || (link.target && link.target !== "_self")) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
    event.preventDefault();
    void r.push(url.pathname + url.search + url.hash);
  });
}
