// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h } from "vue";
import { usePolling } from "./usePolling.js";

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

function mountPolling(callback: () => void) {
  const app = createApp(defineComponent({ setup: () => (usePolling(callback, 1000), () => h("div")) }));
  app.mount(document.createElement("div"));
  return app;
}

describe("usePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs on every tick while the page is visible", () => {
    const callback = vi.fn();
    const app = mountPolling(callback);
    vi.advanceTimersByTime(3000);
    expect(callback).toHaveBeenCalledTimes(3);
    app.unmount();
  });

  it("skips ticks while hidden and runs once on becoming visible again", () => {
    const callback = vi.fn();
    const app = mountPolling(callback);
    setHidden(true);
    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
    setHidden(false);
    expect(callback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(2);
    app.unmount();
  });

  it("stops polling and listening once unmounted", () => {
    const callback = vi.fn();
    mountPolling(callback).unmount();
    vi.advanceTimersByTime(3000);
    setHidden(true);
    setHidden(false);
    expect(callback).not.toHaveBeenCalled();
  });
});
