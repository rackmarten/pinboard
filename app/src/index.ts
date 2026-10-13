import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "@rackmarten/server-kit";
import { config } from "./config.js";
import { sql } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { backfillKeywords } from "./keywords.js";
import { API_PREFIX, registerRoutes } from "./routes.js";
import { registerReleaseRoutes } from "./releases-routes.js";
import { registerAlertRoutes } from "./alerts.js";
import { registerAskRoutes } from "./asks.js";
import { scheduleDailyAt } from "./schedule.js";
import { runDailyDigest } from "./usage.js";
import { pruneJournal } from "./journal.js";
import { integrationStatus } from "./integrations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The built PWA (app/pwa) - see Dockerfile's pwa-build stage, which copies
// its dist/ here as ./public. pages at clean URLs, the JSON API
// under /api (homelab-kit's convention).
const app = await createApp({
  auth: { strategy: "tailnet-trust" },
  healthCheck: async () => {
    await sql`select 1`;
  },
  spa: { root: path.join(__dirname, "../public") },
});

for (const { line } of integrationStatus(config)) app.log.info(line);

await app.register(
  async (api) => {
    await registerRoutes(api);
    await registerReleaseRoutes(api);
    await registerAlertRoutes(api);
    await registerAskRoutes(api);
  },
  { prefix: API_PREFIX },
);

await runMigrations();
const backfilled = await backfillKeywords();
if (backfilled) app.log.info({ backfilled }, "keywords backfilled");

// PLAN.md's I5 daily digest - logs and moves on if SMTP isn't configured
// yet rather than failing to boot, see mailer.ts's getTransport.
scheduleDailyAt(config.digest.hour, async () => {
  const result = await runDailyDigest();
  if (!result.sent) app.log.warn(`daily digest not sent: ${result.reason}`);
});

// journal payloads and read notifications older than the
// retention window, once a night at 03:00.
scheduleDailyAt(3, async () => {
  const pruned = await pruneJournal();
  app.log.info(`journal pruned: ${pruned.payloads} payloads, ${pruned.notifications} notifications`);
});

app.listen({ port: config.port, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
