// phone push goes through ntfy
// instead of pinboard's own Web Push (#137, removed). Every notification
// journal.ts derives is published to pinboard's ntfy topic; the phone
// subscribes in the ntfy app, so there's no per-device state here. The
// message shape is pure and unit tested; the ntfy client wiring is the thin
// part at the bottom.

import { createNtfyClient, type NtfyMessage } from "@rackmarten/server-kit";
import { config } from "./config.js";
import { PushGate } from "./push-policy.js";

export interface PushNotificationInput {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
}

// Bodies are free-form (a rework reason, a chat preview); the in-app history
// has the full text, so a phone notification only needs the start of it.
export const MAX_BODY_CHARS = 300;

// Failures and anything waiting on the operator ring louder than "done".
const PRIORITY: Record<string, NtfyMessage["priority"]> = {
  alert: "high",
  failure: "high",
  question: "high",
  approval: "default",
  review: "default",
  completed: "low",
};

// Emoji shortcodes ntfy shows in front of the title.
const TAGS: Record<string, string> = {
  alert: "warning",
  failure: "rotating_light",
  question: "question",
  approval: "white_check_mark",
  review: "eyes",
  completed: "heavy_check_mark",
};

// A clean absolute URL (https://pinboard.example.com/tasks/12, a past task's
// router) - the ntfy app opens it in the browser. Only in-app paths, so a
// tap can never lead to some other origin.
export function clickUrl(baseUrl: string, path: string | null): string {
  const safe = path && path.startsWith("/") && !path.startsWith("//") ? path : "/notifications";
  return `${baseUrl.replace(/\/+$/, "")}${safe}`;
}

export function buildNtfyMessage(n: PushNotificationInput, opts: { topic: string; baseUrl: string }): NtfyMessage {
  let body = n.body ?? "";
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS - 1)}…`;
  const tag = TAGS[n.kind];
  return {
    topic: opts.topic,
    title: n.title,
    // ntfy rejects an empty message; the title alone says it all for most kinds.
    message: body || n.title,
    clickUrl: clickUrl(opts.baseUrl, n.url),
    priority: PRIORITY[n.kind] ?? "default",
    ...(tag ? { tags: [tag] } : {}),
  };
}

export function pushConfigured(): boolean {
  return Boolean(config.ntfy.url && config.ntfy.token);
}

const ntfy = createNtfyClient({ url: config.ntfy.url, token: config.ntfy.token });

// Resolves false (never rejects) when unconfigured or the publish failed;
// server-kit logs the failure.
export function pushNotification(n: PushNotificationInput): Promise<boolean> {
  if (!pushConfigured()) return Promise.resolve(false);
  return ntfy.notify(buildNtfyMessage(n, { topic: config.ntfy.topic, baseUrl: config.publicUrl }));
}

// bell notifications reach the phone only through this gate
// (filter, 10-minute coalescing, quiet hours, morning digest).
export const pushGate = new PushGate({
  send: (n) => void pushNotification(n),
  ...config.push,
});
setInterval(() => pushGate.tick(new Date()), 30_000).unref();

// The Notifications page's "Send test" button - proves the path to the
// phone's ntfy app without inventing a fake task event.
export function sendTestPush(): Promise<boolean> {
  return pushNotification({ id: 0, kind: "review", title: "Pinboard test notification", body: "ntfy delivery works.", url: "/notifications" });
}
