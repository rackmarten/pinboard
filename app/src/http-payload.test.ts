import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "@rackmarten/server-kit";
import { etagMatches, registerApiPayloadHooks, registerCompression, registerHttpLayer, stripServerOnly } from "./http-payload.js";

// A task list big enough to cross compress's default threshold.
const rows = Array.from({ length: 200 }, (_, i) => ({
  id: i + 1,
  title: `Task ${i + 1}`,
  description: "Some longer description text that repeats a fair bit. ".repeat(4),
  keywords: "'longer':3 'repeat':8 'task':1",
}));

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // Routes registered before compression don't get it, which is why
  // index.ts registers the PWA itself, after registerCompression.
  app.get("/early", async () => ({ text: "x".repeat(4096) }));
  await registerCompression(app);
  app.get("/late", async () => ({ text: "x".repeat(4096) }));
  await app.register(
    async (api) => {
      registerApiPayloadHooks(api);
      api.get("/tasks", async () => rows.map((r) => ({ ...r })));
      api.get("/tasks/1", async () => ({ ...rows[0] }));
      api.get("/missing", async (_req, reply) => reply.code(404).send({ error: "no such task" }));
      api.patch("/tasks/1", async () => ({ ...rows[0] }));
      api.get("/plan", async () => ({ startable: { tasks: [{ ...rows[0] }] }, projects: [{ id: 1, keywords: "'x':1" }] }));
      api.get("/cached", async (_req, reply) => {
        reply.header("cache-control", "max-age=60");
        return { ok: true };
      });
      // Same shape as routes.ts's openSseStream: raw writes, no return value.
      api.get("/events", (req, reply) => {
        reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" });
        reply.raw.write(": connected\n\n");
        const timer = setInterval(() => reply.raw.write("data: ping\n\n"), 20);
        req.raw.on("close", () => clearInterval(timer));
      });
    },
    { prefix: "/api" },
  );
  return app;
}

test("stripServerOnly removes keywords from rows, nested rows and arrays, and leaves other values alone", () => {
  const payload = {
    keywords: "a",
    list: [{ id: 1, keywords: "b", nested: { keywords: "c", keep: 1 } }],
    when: new Date(0),
    text: "keywords",
  };
  stripServerOnly(payload);
  assert.deepEqual(payload, { list: [{ id: 1, nested: { keep: 1 } }], when: new Date(0), text: "keywords" });
  assert.equal(stripServerOnly(null), null);
  assert.equal(stripServerOnly("x"), "x");
});

test("stripServerOnly stops at its depth limit", () => {
  const shallow = { a: { b: { c: [{ keywords: "x" }] } } };
  stripServerOnly(shallow);
  assert.deepEqual(shallow, { a: { b: { c: [{}] } } });
  // Documents the limit: a row nested deeper than MAX_DEPTH keeps the key.
  const deep = { a: { b: { c: { d: [{ keywords: "x" }] } } } };
  stripServerOnly(deep);
  assert.equal(deep.a.b.c.d[0].keywords, "x");
});

test("API responses never carry keywords: list, detail and embedded rows", async () => {
  const app = await buildApp();
  for (const url of ["/api/tasks", "/api/tasks/1", "/api/plan"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes("keywords"), `${url} leaked keywords`);
  }
  const list = (await app.inject({ method: "GET", url: "/api/tasks" })).json();
  assert.equal(list.length, 200);
  assert.equal(list[0].title, rows[0].title);
  await app.close();
});

test("responses are gzip/brotli compressed when the client accepts it, on routes registered after it", async () => {
  const app = await buildApp();
  const gz = await app.inject({ method: "GET", url: "/api/tasks", headers: { "accept-encoding": "gzip" } });
  assert.equal(gz.headers["content-encoding"], "gzip");
  const body = JSON.parse(gunzipSync(gz.rawPayload).toString("utf8"));
  assert.equal(body.length, 200);
  assert.ok(gz.rawPayload.length < JSON.stringify(body).length / 3);

  const br = await app.inject({ method: "GET", url: "/api/tasks", headers: { "accept-encoding": "br, gzip" } });
  assert.equal(br.headers["content-encoding"], "br");

  const plain = await app.inject({ method: "GET", url: "/api/tasks" });
  assert.equal(plain.headers["content-encoding"], undefined);

  const late = await app.inject({ method: "GET", url: "/late", headers: { "accept-encoding": "gzip" } });
  assert.equal(late.headers["content-encoding"], "gzip");
  const early = await app.inject({ method: "GET", url: "/early", headers: { "accept-encoding": "gzip" } });
  assert.equal(early.headers["content-encoding"], undefined);
  await app.close();
});

test("an unchanged response is an empty 304 when the client sends its ETag back", async () => {
  const app = await buildApp();
  const first = await app.inject({ method: "GET", url: "/api/tasks", headers: { "accept-encoding": "gzip" } });
  const tag = first.headers.etag;
  assert.ok(typeof tag === "string" && tag.startsWith('W/"'), `expected a weak ETag, got ${tag}`);
  assert.equal(first.headers["cache-control"], "no-cache");

  const again = await app.inject({ method: "GET", url: "/api/tasks", headers: { "accept-encoding": "gzip", "if-none-match": tag } });
  assert.equal(again.statusCode, 304);
  assert.equal(again.rawPayload.length, 0);

  // The ETag is of the uncompressed body, so it doesn't depend on encoding.
  const plain = await app.inject({ method: "GET", url: "/api/tasks" });
  assert.equal(plain.headers.etag, tag);

  const stale = await app.inject({ method: "GET", url: "/api/tasks", headers: { "if-none-match": '"something-else"' } });
  assert.equal(stale.statusCode, 200);
  await app.close();
});

test("a route's own cache-control is kept", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/cached" });
  assert.equal(res.headers["cache-control"], "max-age=60");
  await app.close();
});

test("SSE streams are not compressed or buffered", async () => {
  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const firstChunk = await new Promise<{ headers: http.IncomingHttpHeaders; chunk: string }>((resolve, reject) => {
    const req = http.get({ port, host: "127.0.0.1", path: "/api/events", headers: { "accept-encoding": "gzip" } }, (res) => {
      res.once("data", (chunk: Buffer) => {
        resolve({ headers: res.headers, chunk: chunk.toString("utf8") });
        req.destroy();
      });
    });
    req.on("error", reject);
  });
  assert.equal(firstChunk.headers["content-encoding"], undefined);
  assert.equal(firstChunk.headers["content-type"], "text/event-stream");
  assert.match(firstChunk.chunk, /: connected/);
  await app.close();
});

test("the app wired like index.ts compresses the PWA: index, deep links and assets", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pinboard-pwa-"));
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "index.html"), `<!doctype html><title>t</title>${"<div></div>".repeat(500)}`);
  writeFileSync(path.join(root, "assets", "app.js"), `console.log(${JSON.stringify("x".repeat(5000))});`);
  const app = await createApp({ auth: { strategy: "tailnet-trust" }, logger: false });
  await registerHttpLayer(app, root);
  await app.register(
    async (api) => {
      registerApiPayloadHooks(api);
      api.get("/tasks", async () => rows.map((r) => ({ ...r })));
    },
    { prefix: "/api" },
  );
  try {
    for (const url of ["/", "/tasks/12", "/assets/app.js", "/api/tasks"]) {
      const res = await app.inject({ method: "GET", url, headers: { "accept-encoding": "br, gzip" } });
      assert.equal(res.statusCode, 200, url);
      assert.equal(res.headers["content-encoding"], "br", `${url} not compressed`);
    }
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("etagMatches: weak comparison, lists and *", () => {
  assert.equal(etagMatches(undefined, 'W/"a"'), false);
  assert.equal(etagMatches('W/"a"', 'W/"a"'), true);
  assert.equal(etagMatches('"a"', 'W/"a"'), true);
  assert.equal(etagMatches('"b", W/"a"', 'W/"a"'), true);
  assert.equal(etagMatches("*", 'W/"a"'), true);
  assert.equal(etagMatches('"b"', 'W/"a"'), false);
});

test("only a successful GET/HEAD becomes a 304, never an error or a write", async () => {
  const app = await buildApp();
  const missing = await app.inject({ method: "GET", url: "/api/missing" });
  assert.equal(missing.statusCode, 404);
  const missingAgain = await app.inject({ method: "GET", url: "/api/missing", headers: { "if-none-match": missing.headers.etag as string } });
  assert.equal(missingAgain.statusCode, 404);
  assert.match(missingAgain.body, /no such task/);

  const got = await app.inject({ method: "GET", url: "/api/tasks/1" });
  const patched = await app.inject({ method: "PATCH", url: "/api/tasks/1", payload: {}, headers: { "if-none-match": got.headers.etag as string } });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().id, 1);

  const head = await app.inject({ method: "HEAD", url: "/api/tasks/1", headers: { "if-none-match": got.headers.etag as string } });
  assert.equal(head.statusCode, 304);
  await app.close();
});
