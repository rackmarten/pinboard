// Keeps API responses small on the wire. With a thousand-plus tasks the
// task list was several megabytes per request, polled every few seconds,
// and most of it was a search index no client reads.
//
// - `keywords` (the tsvector search index on tasks and projects, see
//   keywords.ts) is server-only: it is stripped from every JSON response
//   here, in one place, so a new route doesn't leak it by accident. The
//   strip walks MAX_DEPTH levels deep; a row nested deeper keeps it.
// - API responses get `cache-control: no-cache` unless the route set one,
//   so the browser revalidates every poll.
//
// Compression (br/gzip), the weak ETag and the empty 304 for an unchanged
// GET/HEAD come from server-kit's createApp, for the PWA and the API alike.
// The SSE endpoints write to reply.raw and bypass Fastify's send pipeline,
// so none of this touches them.
import type { FastifyInstance } from "fastify";

export const SERVER_ONLY_KEYS = ["keywords"] as const;

// Deep enough for every response shape in routes.ts (a list of rows, rows
// embedded one or two levels down in plan/review payloads) without walking
// arbitrarily large JSON blobs such as journal payloads.
const MAX_DEPTH = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Removes server-only keys from a response payload in place and returns it. */
export function stripServerOnly<T>(payload: T, depth = 0): T {
  if (depth > MAX_DEPTH) return payload;
  if (Array.isArray(payload)) {
    for (const item of payload) stripServerOnly(item, depth + 1);
  } else if (isPlainObject(payload)) {
    for (const key of SERVER_ONLY_KEYS) delete payload[key];
    for (const value of Object.values(payload)) {
      if (value !== null && typeof value === "object") stripServerOnly(value, depth + 1);
    }
  }
  return payload;
}

/** Server-only keys out, and revalidate-every-time caching for the JSON API. */
export function registerApiPayloadHooks(api: FastifyInstance): void {
  api.addHook("preSerialization", async (_req, _reply, payload) => stripServerOnly(payload));
  api.addHook("onSend", async (_req, reply, payload) => {
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-cache");
    return payload;
  });
}
