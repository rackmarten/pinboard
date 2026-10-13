// pinboard's data behind ui-kit's NotificationBell and
// GlobalSearch (both lived here as components until ui-kit 0.6.0).
import type { NotificationSource, SearchProvider } from "@rackmarten/ui-kit";
import {
  getNotifications,
  getProjects,
  getTasks,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
} from "./api.js";
import { notificationColor, notificationIcon } from "./journal-display.js";

export const notificationSource: NotificationSource = {
  async list({ limit }) {
    const rows = await getNotifications({ limit });
    return rows.map((n) => ({ ...n, icon: notificationIcon(n.kind), color: notificationColor(n.kind) }));
  },
  async unreadCount() {
    return (await getUnreadNotificationCount()).unread;
  },
  markRead: (id) => markNotificationRead(Number(id)),
  markAllRead: markAllNotificationsRead,
};

// Tasks by ID or keywords (title + description), projects by name (#335).
export const searchProvider: SearchProvider = async (term) => {
  const [tasks, projects] = await Promise.all([getTasks({ q: term }), getProjects({ q: term })]);
  return [
    {
      label: "Tasks",
      results: tasks.slice(0, 20).map((t) => ({ key: t.id, title: t.title, subtitle: `#${t.id} · ${t.status}`, to: `/tasks/${t.id}` })),
    },
    {
      label: "Projects",
      results: projects.slice(0, 10).map((p) => ({ key: `p${p.id}`, title: p.name, subtitle: p.slug, to: `/projects/${p.id}` })),
    },
  ];
};
