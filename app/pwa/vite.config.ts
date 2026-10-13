/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    // Load-bearing for local dev via `npm link @rackmarten/ui-kit` (see
    // ui-kit's README):
    // without this, Vite resolves vue/vuetify from ui-kit's *real* linked
    // directory instead of this project's node_modules, loading a second
    // copy of each - which breaks Vuetify's provide/inject wiring. Also
    // harmless (a no-op) against the normal registry-installed dependency.
    dedupe: ["vue", "vuetify"],
  },
  test: {
    // component tests import Vuetify, whose components import
    // their own .css files - inlining lets Vite handle those instead of Node.
    server: { deps: { inline: ["vuetify"] } },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // Dev-only: the API isn't part of this Vite project (it's the sibling
    // Fastify app in ../src, normally served from the same origin in
    // production - see ../Dockerfile). Proxying to the real pinboard LXC
    // means `npm run dev` here works against real data without also
    // running Postgres locally.
    // the whole API is under /api (SSE streams included; Vite
    // proxies text/event-stream without buffering), so one entry covers it
    // and every other path stays a page for Vite's own history fallback.
    proxy: {
      "/api": "http://192.168.0.110:8095",
    },
  },
});
