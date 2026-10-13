// push to the phone only when a human is needed. Every
// notification still lands on the bell (journal.ts); this decides which of
// them also go to ntfy, and when. Pure - clock, sender and time zone are
// injected - so the rules are unit tested without ntfy or a timer, the same
// split push.ts uses. The wiring (one gate, a 30s tick) lives in push.ts.
//
// - Immediate (daytime) push only for a question, a permission request, a
//   failure parked for the human, and a health check that starts failing.
//   Done, handoffs, reviews, recoveries never push on their own.
// - Coalescing: the first push goes out at once; anything else within the
//   next 10 minutes is held and sent as one "N things need you" push.
// - Quiet hours: nothing pushes. At digest time one push summarizes what
//   piled up overnight (reviews included), health failures only if still
//   failing then. Nothing piled up means no digest.
//
// State is in memory: a restart during quiet hours loses that night's digest,
// which is fine since the bell and /inbox still have every item.

import type { JournalEventForNotification, NotificationDraft } from "./notifications.js";

export type PushCategory = "decision" | "failure" | "health" | "review";

export interface PushItem {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
}

export interface PushGateOptions {
  send: (n: PushItem) => void;
  quietStart: number; // hour, inclusive
  quietEnd: number; // hour, exclusive
  digestAt: number; // hour
  timeZone: string;
  coalesceMs?: number;
}

export const COALESCE_MS = 10 * 60_000;

// Which bell notifications may reach the phone, and as what. `review` never
// pushes by itself; it only counts in the morning digest.
export function pushCategory(event: JournalEventForNotification, draft: NotificationDraft): PushCategory | null {
  const p = event.payload ?? {};
  if (event.eventType === "chat_permission_request") return "decision";
  if (draft.kind === "question") return "decision";
  if (draft.kind === "review" || draft.kind === "approval") return "review";
  if (draft.kind !== "failure") return null;
  switch (event.eventType) {
    // a repair routed back to "rework" is parked for the human
    // (human+agent tasks); one handed to another agent needs nobody.
    case "pipeline":
      return p.to === "rework" ? "failure" : null;
    case "deploy":
    case "backup":
      return "failure";
    case "health":
      return "health";
    default:
      return null;
  }
}

// Health checks are identified by reporter + check, matching the transition
// events foreman sends.
export function healthKey(event: JournalEventForNotification): string | null {
  if (event.eventType !== "health") return null;
  const check = typeof event.payload?.check === "string" ? event.payload.check : "?";
  return `${event.actorName}:${check}`;
}

export function localClock(now: Date, timeZone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function digestText(counts: { decisions: number; reviews: number; failures: number }): string | null {
  const parts: string[] = [];
  if (counts.decisions) parts.push(plural(counts.decisions, "decision"));
  if (counts.reviews) parts.push(plural(counts.reviews, "review"));
  if (counts.failures) parts.push(plural(counts.failures, "failure"));
  return parts.length ? `${parts.join(", ")} overnight` : null;
}

interface Overnight {
  category: PushCategory;
  healthKey: string | null;
}

export class PushGate {
  private readonly coalesceMs: number;
  private windowEndsAt: number | null = null;
  private held: PushItem[] = [];
  private overnight: Overnight[] = [];
  private failingHealth = new Set<string>();
  private lastDigestDay: string | null = null;

  constructor(private readonly opts: PushGateOptions) {
    this.coalesceMs = opts.coalesceMs ?? COALESCE_MS;
  }

  // Every bell notification goes through here; `category` null means it
  // never reaches the phone.
  offer(item: PushItem, category: PushCategory | null, health: string | null, now: Date): void {
    if (category === null) {
      // A recovery clears a failure that hasn't been reported yet.
      if (health) this.failingHealth.delete(health);
      return;
    }
    if (health) this.failingHealth.add(health);
    if (this.quiet(now)) {
      this.overnight.push({ category, healthKey: health });
      return;
    }
    if (category === "review") return;
    this.flushDue(now);
    if (this.windowEndsAt === null) {
      this.opts.send(item);
      this.windowEndsAt = now.getTime() + this.coalesceMs;
    } else {
      this.held.push(item);
    }
  }

  // Call periodically: closes an elapsed coalescing window and sends the
  // digest once quiet hours are over.
  tick(now: Date): void {
    this.flushDue(now);
    this.maybeDigest(now);
  }

  private quiet(now: Date): boolean {
    return inQuietHours(localClock(now, this.opts.timeZone).hour, this.opts.quietStart, this.opts.quietEnd);
  }

  private flushDue(now: Date): void {
    if (this.windowEndsAt === null || now.getTime() < this.windowEndsAt) return;
    const held = this.held;
    this.held = [];
    if (held.length === 0) {
      this.windowEndsAt = null;
      return;
    }
    // The held pushes are themselves a push, so they open the next window.
    this.opts.send(held.length === 1 ? held[0] : { id: 0, kind: "question", title: `${held.length} things need you`, body: held.map((h) => h.title).join("\n"), url: "/inbox" });
    this.windowEndsAt = now.getTime() + this.coalesceMs;
  }

  private maybeDigest(now: Date): void {
    const { day, hour } = localClock(now, this.opts.timeZone);
    if (this.lastDigestDay === day || hour < this.opts.digestAt || this.quiet(now)) return;
    this.lastDigestDay = day;
    const items = this.overnight;
    this.overnight = [];
    const counts = { decisions: 0, reviews: 0, failures: 0 };
    const seenHealth = new Set<string>();
    for (const i of items) {
      if (i.category === "decision") counts.decisions++;
      else if (i.category === "review") counts.reviews++;
      else if (i.category === "failure") counts.failures++;
      else if (i.healthKey && this.failingHealth.has(i.healthKey) && !seenHealth.has(i.healthKey)) {
        seenHealth.add(i.healthKey);
        counts.failures++;
      }
    }
    const text = digestText(counts);
    if (!text) return;
    this.opts.send({ id: 0, kind: counts.failures ? "failure" : "question", title: "Pinboard: overnight", body: text, url: "/inbox" });
    this.windowEndsAt = now.getTime() + this.coalesceMs;
  }
}
