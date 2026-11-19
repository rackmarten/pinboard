// How the operator spends time in the PWA, for the Usage view's "My time"
// tab. Counts *active* seconds per route and module, and clicks on elements
// marked `data-track="<feature>"`. Active means the page is visible, the
// window has focus, and there was mouse, keyboard, touch or scroll input in
// the last IDLE_MS. Counts are kept in memory per minute and flushed to
// POST /api/activity every FLUSH_MS and on pagehide (sendBeacon, which cannot
// set headers, hence `?client=pwa`). Runs only while the operator has opted
// in (GET /api/me/settings); the server drops anything else anyway.
//
// The module is the closest `data-module="<name>"` around whatever the
// operator last touched, so a panel inside a page (a task's review section,
// say) gets its own line; anything outside one counts as the route's own.

export const IDLE_MS = 30_000;
export const TICK_MS = 5_000;
export const FLUSH_MS = 60_000;
export const ACTIVITY_URL = "/api/activity";

export interface ActivityEntry {
  kind: "active" | "click";
  minute: string; // ISO, start of the minute
  route: string;
  name: string;
  value: number;
}

export interface TrackerEnv {
  now(): number;
  isVisible(): boolean;
  hasFocus(): boolean;
  route(): string;
  send(entries: ActivityEntry[], beacon: boolean): void;
}

function minuteOf(ms: number): string {
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

// "/tasks/:id" -> "tasks", "/" -> "dashboard"
export function routeModule(route: string): string {
  return route.split("/").find((s) => s && !s.startsWith(":")) ?? "dashboard";
}

export class ActivityTracker {
  private lastInput = Number.NEGATIVE_INFINITY;
  private lastTick: number;
  private module: string | null = null;
  // ms of active time and click counts, keyed by kind/minute/route/name
  private pending = new Map<string, ActivityEntry & { ms?: number }>();

  constructor(private env: TrackerEnv) {
    this.lastTick = env.now();
  }

  // Any input. `module` is the data-module around its target, if any.
  input(module: string | null = null): void {
    this.tick();
    this.lastInput = this.env.now();
    this.module = module;
  }

  click(feature: string, module: string | null = null): void {
    this.input(module);
    this.add("click", this.env.route(), feature, 1);
  }

  // Credits the time since the last tick that was active: visible, focused,
  // and no later than IDLE_MS after the last input.
  tick(): void {
    const now = this.env.now();
    const from = this.lastTick;
    this.lastTick = now;
    if (!this.env.isVisible() || !this.env.hasFocus()) return;
    const until = Math.min(now, this.lastInput + IDLE_MS);
    if (until <= from) return;
    const route = this.env.route();
    this.add("active", route, this.module ?? routeModule(route), until - from);
  }

  // The page is hidden or blurred: credit what came before, then stop.
  pause(): void {
    this.tick();
  }

  // The page is back: what passed while it was away was not active.
  resume(): void {
    this.lastTick = this.env.now();
  }

  // Clears what was sent. Seconds are whole; a remainder under one second
  // is dropped.
  flush(beacon = false): ActivityEntry[] {
    this.tick();
    const entries: ActivityEntry[] = [];
    for (const e of this.pending.values()) {
      const value = e.kind === "active" ? Math.min(60, Math.round((e.ms ?? 0) / 1000)) : e.value;
      if (value >= 1) entries.push({ kind: e.kind, minute: e.minute, route: e.route, name: e.name, value });
    }
    this.pending.clear();
    if (entries.length) this.env.send(entries, beacon);
    return entries;
  }

  private add(kind: "active" | "click", route: string, name: string, amount: number): void {
    const minute = minuteOf(this.env.now());
    const key = `${kind}\u0000${minute}\u0000${route}\u0000${name}`;
    const found = this.pending.get(key);
    if (kind === "active") {
      if (found) found.ms = (found.ms ?? 0) + amount;
      else this.pending.set(key, { kind, minute, route, name, value: 0, ms: amount });
    } else if (found) found.value += amount;
    else this.pending.set(key, { kind, minute, route, name, value: amount });
  }
}

function moduleOf(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target.closest("[data-module]") : null;
  return el?.getAttribute("data-module") || null;
}

export function sendActivity(entries: ActivityEntry[], beacon: boolean): void {
  const body = JSON.stringify({ entries });
  if (beacon && typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon(`${ACTIVITY_URL}?client=pwa`, new Blob([body], { type: "application/json" }));
    return;
  }
  fetch(ACTIVITY_URL, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json", "x-pinboard-client": "pwa" },
    body,
  }).catch(() => {});
}

const INPUT_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "wheel", "scroll"] as const;

// Wires a tracker to the window. Returns the function that stops it (and
// flushes what it still holds).
export function startTracking(route: () => string, send = sendActivity, win: Window = window): () => void {
  const doc = win.document;
  const tracker = new ActivityTracker({
    now: () => Date.now(),
    isVisible: () => doc.visibilityState === "visible",
    hasFocus: () => doc.hasFocus(),
    route,
    send,
  });
  const onInput = (e: Event) => tracker.input(moduleOf(e.target));
  const onClick = (e: Event) => {
    const el = e.target instanceof Element ? e.target.closest("[data-track]") : null;
    const feature = el?.getAttribute("data-track");
    if (feature) tracker.click(feature, moduleOf(e.target));
    else tracker.input(moduleOf(e.target));
  };
  const onVisibility = () => {
    if (doc.visibilityState === "visible") tracker.resume();
    else tracker.flush(true);
  };
  const onBlur = () => tracker.pause();
  const onFocus = () => tracker.resume();
  const onPageHide = () => tracker.flush(true);
  const opts = { capture: true, passive: true };
  for (const name of INPUT_EVENTS) win.addEventListener(name, onInput, opts);
  win.addEventListener("click", onClick, opts);
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("blur", onBlur);
  win.addEventListener("focus", onFocus);
  win.addEventListener("pagehide", onPageHide);
  const ticker = win.setInterval(() => tracker.tick(), TICK_MS);
  const flusher = win.setInterval(() => tracker.flush(), FLUSH_MS);
  return () => {
    for (const name of INPUT_EVENTS) win.removeEventListener(name, onInput, opts);
    win.removeEventListener("click", onClick, opts);
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("blur", onBlur);
    win.removeEventListener("focus", onFocus);
    win.removeEventListener("pagehide", onPageHide);
    win.clearInterval(ticker);
    win.clearInterval(flusher);
    tracker.flush(true);
  };
}

// The one tracker for the app, started at boot when the operator has opted
// in, and from the My time tab's switch.
let stopCurrent: (() => void) | null = null;

export function setTracking(enabled: boolean, route: () => string): void {
  if (enabled && !stopCurrent) stopCurrent = startTracking(route);
  if (!enabled && stopCurrent) {
    stopCurrent();
    stopCurrent = null;
  }
}
