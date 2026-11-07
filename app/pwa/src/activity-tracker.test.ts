// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityTracker, FLUSH_MS, IDLE_MS, routeModule, startTracking, TICK_MS, type ActivityEntry } from "./activity-tracker.js";

function setup() {
  const state = { now: Date.UTC(2026, 10, 7, 12, 0, 0), visible: true, focus: true, route: "/inbox" };
  const sent: { entries: ActivityEntry[]; beacon: boolean }[] = [];
  const tracker = new ActivityTracker({
    now: () => state.now,
    isVisible: () => state.visible,
    hasFocus: () => state.focus,
    route: () => state.route,
    send: (entries, beacon) => sent.push({ entries, beacon }),
  });
  const advance = (ms: number) => {
    for (let left = ms; left > 0; left -= TICK_MS) {
      state.now += Math.min(TICK_MS, left);
      tracker.tick();
    }
  };
  return { state, sent, tracker, advance };
}

const active = (entries: ActivityEntry[]) => entries.filter((e) => e.kind === "active").reduce((s, e) => s + e.value, 0);

describe("ActivityTracker", () => {
  it("counts nothing before any input", () => {
    const { tracker, advance } = setup();
    advance(20_000);
    expect(tracker.flush()).toEqual([]);
  });

  it("stops counting IDLE_MS after the last input", () => {
    const { tracker, advance } = setup();
    tracker.input();
    advance(50_000);
    expect(active(tracker.flush())).toBe(IDLE_MS / 1000);
  });

  it("keeps counting while input continues", () => {
    const { tracker, advance } = setup();
    for (let i = 0; i < 4; i++) {
      tracker.input();
      advance(20_000);
    }
    expect(active(tracker.flush())).toBe(80);
  });

  it("counts nothing while hidden or unfocused", () => {
    const { state, tracker, advance } = setup();
    tracker.input();
    state.visible = false;
    advance(10_000);
    state.visible = true;
    state.focus = false;
    tracker.input();
    advance(10_000);
    expect(tracker.flush()).toEqual([]);
  });

  it("credits time up to a blur, not after it", () => {
    const { state, tracker, advance } = setup();
    tracker.input();
    advance(10_000);
    state.focus = false;
    tracker.pause();
    advance(10_000);
    state.focus = true;
    tracker.resume();
    expect(active(tracker.flush())).toBe(10);
  });

  it("attributes time to the route and the module of the last input", () => {
    const { state, tracker, advance } = setup();
    state.route = "/tasks/:id";
    tracker.input("review");
    advance(10_000);
    tracker.input(null);
    advance(5_000);
    const entries = tracker.flush();
    expect(entries.find((e) => e.name === "review")?.value).toBe(10);
    expect(entries.find((e) => e.name === "tasks")?.value).toBe(5);
    expect(entries.every((e) => e.route === "/tasks/:id")).toBe(true);
  });

  it("counts clicks per feature and buckets by minute", () => {
    const { state, tracker } = setup();
    tracker.click("approve");
    tracker.click("approve");
    state.now += 60_000;
    tracker.click("approve");
    const clicks = tracker.flush().filter((e) => e.kind === "click");
    expect(clicks.map((e) => e.value)).toEqual([2, 1]);
    expect(clicks[0].minute).toBe("2026-11-07T12:00:00.000Z");
    expect(clicks[1].minute).toBe("2026-11-07T12:01:00.000Z");
  });

  it("flush sends once and empties the batch", () => {
    const { sent, tracker } = setup();
    tracker.click("queue");
    tracker.flush(true);
    tracker.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].beacon).toBe(true);
  });
});

describe("routeModule", () => {
  it("names a route by its first static segment", () => {
    expect(routeModule("/tasks/:id")).toBe("tasks");
    expect(routeModule("/chat/:id?")).toBe("chat");
    expect(routeModule("/")).toBe("dashboard");
  });
});

describe("startTracking", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("counts data-track clicks, flushes every minute and on pagehide", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 7, 12, 0, 0));
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    document.body.innerHTML = `<section data-module="review"><button data-track="approve"><span id="label">Approve</span></button></section>`;
    const sent: { entries: ActivityEntry[]; beacon: boolean }[] = [];
    const stop = startTracking(() => "/tasks/:id", (entries, beacon) => sent.push({ entries, beacon }));

    document.getElementById("label")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    vi.advanceTimersByTime(FLUSH_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0].beacon).toBe(false);
    expect(sent[0].entries).toContainEqual(expect.objectContaining({ kind: "click", name: "approve", route: "/tasks/:id" }));
    expect(sent[0].entries).toContainEqual(expect.objectContaining({ kind: "active", name: "review", value: IDLE_MS / 1000 }));

    window.dispatchEvent(new KeyboardEvent("keydown"));
    vi.advanceTimersByTime(TICK_MS * 2);
    window.dispatchEvent(new Event("pagehide"));
    expect(sent).toHaveLength(2);
    expect(sent[1].beacon).toBe(true);
    stop();
  });

  it("sends nothing after it is stopped", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const send = vi.fn();
    const stop = startTracking(() => "/", send);
    stop();
    window.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    vi.advanceTimersByTime(FLUSH_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });
});
