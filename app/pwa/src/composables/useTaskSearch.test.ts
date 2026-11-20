import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { SEARCH_DEBOUNCE_MS, useTaskSearch } from "./useTaskSearch.js";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify([{ id: 7, title: "Found" }]), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function requestedUrls(): URL[] {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url), "http://pwa"));
}

describe("useTaskSearch", () => {
  it("asks the server once, debounced, with the term, the filter and the summary view", async () => {
    const scope = effectScope();
    const term = ref("");
    const { results } = scope.run(() => useTaskSearch(term, () => ({ projectId: 3 })))!;

    term.value = "dep";
    await nextTick();
    term.value = "deploy";
    await nextTick();
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(results.value).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = requestedUrls();
    expect(url.pathname).toBe("/api/tasks");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "deploy", projectId: "3", view: "summary" });
    expect(results.value).toEqual([{ id: 7, title: "Found" }]);
    scope.stop();
  });

  it("drops the previous term's hits as soon as the term changes, and asks nothing for an empty term", async () => {
    const scope = effectScope();
    const term = ref<string | null>("deploy");
    const { results } = scope.run(() => useTaskSearch(term))!;
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(results.value).toHaveLength(1);

    term.value = "deploys";
    await nextTick();
    expect(results.value).toBeNull();

    term.value = null;
    await nextTick();
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.value).toBeNull();
    scope.stop();
  });
});
