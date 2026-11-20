import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEvents } from "./api.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function requestedUrl(): URL {
  return new URL(String(fetchMock.mock.calls[0][0]), "http://pwa");
}

describe("getEvents", () => {
  it("asks for the whole history by default", async () => {
    await getEvents(7);
    expect(requestedUrl().pathname).toBe("/api/tasks/7/events");
    expect(requestedUrl().search).toBe("");
  });

  it("asks the server for just the tail of one event type", async () => {
    await getEvents(7, { type: "activity", limit: 50 });
    expect(Object.fromEntries(requestedUrl().searchParams)).toEqual({ type: "activity", limit: "50" });
  });
});
