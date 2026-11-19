// Keeps API responses small on the wire. With a thousand-plus tasks the
// task list was several megabytes per request, polled every few seconds,
// and most of it was a search index no client reads.
//
// - `keywords` (the tsvector search index on tasks and projects, see
//   keywords.ts) is server-only: it is stripped from every JSON response
//   here, in one place, so a new route doesn't leak it by accident. The
//   strip walks MAX_DEPTH levels deep; a row nested deeper keeps it.
// - Responses are gzip/brotli compressed (@fastify/compress).
// - JSON responses carry an ETag (@fastify/etag) and `cache-control:
//   no-cache`, so the browser revalidates every poll and an unchanged list
//   comes back as an empty 304.
//
// The SSE endpoints write to reply.raw and bypass Fastify's send pipeline,
// so none of this touches them. A side effect of @fastify/compress: a
// request body sent with a Content-Encoding header is now inflated (or a
// 415 for an unknown encoding). No client sends one today.
import compress from "@fastify/compress";
import etag from "@fastify/etag";
import { registerSpa } from "@rackmarten/server-kit";
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

/** RFC 9110 weak comparison of an If-None-Match header against one tag. */
export function etagMatches(ifNoneMatch: string | undefined, tag: string): boolean {
  if (!ifNoneMatch) return false;
  const opaque = (t: string) => t.trim().replace(/^W\//, "");
  const want = opaque(tag);
  return ifNoneMatch.split(",").some((t) => t.trim() === "*" || opaque(t) === want);
}

/** Compression and ETags, for every route registered after this call. */
export async function registerCompression(app: FastifyInstance): Promise<void> {
  // etag first: its onSend hook has to hash the serialized body before
  // compress turns it into a stream (a stream gets no ETag). Weak, because
  // the same tag covers the br, gzip and identity encodings of one body.
  // Its own 304 is off: it would answer 304 for any method and status. The
  // hook below does it for successful GET/HEAD only.
  await app.register(etag, { weak: true, replyWith304: false });
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.method !== "GET" && req.method !== "HEAD") return payload;
    if (reply.statusCode !== 200) return payload;
    const tag = reply.getHeader("etag");
    if (typeof tag !== "string" || !etagMatches(req.headers["if-none-match"], tag)) return payload;
    reply.code(304);
    // "" rather than null: Fastify's HEAD handler throws on a null payload.
    // Either way Fastify sends no body with a 304.
    return "";
  });
  await app.register(compress, { global: true, encodings: ["br", "gzip"] });
}

/**
 * Compression, then the built PWA. Compression only applies to routes
 * registered after it, which is why index.ts registers the PWA through
 * this rather than createApp's `spa` option. Call it before the API routes.
 */
export async function registerHttpLayer(app: FastifyInstance, publicRoot: string): Promise<void> {
  await registerCompression(app);
  await registerSpa(app, { root: publicRoot });
}

/** Server-only keys out, and revalidate-every-time caching for the JSON API. */
export function registerApiPayloadHooks(api: FastifyInstance): void {
  api.addHook("preSerialization", async (_req, _reply, payload) => stripServerOnly(payload));
  api.addHook("onSend", async (_req, reply, payload) => {
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-cache");
    return payload;
  });
}
