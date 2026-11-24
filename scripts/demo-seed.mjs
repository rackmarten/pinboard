#!/usr/bin/env node
// Seeds a fresh pinboard with fictional demo data for the README
// screenshots (scripts/screenshots.sh), through the HTTP API only.
//
// Usage: node scripts/demo-seed.mjs [base-url]   (default http://localhost:8095)
//
// Run it once against an empty database: nothing here is deduplicated.
// Everything is made up: four small projects, a story with
// children across the pipeline, review cards, an open question, a budget
// period, governor observations and a little spend.

const base = (process.argv[2] ?? process.env.PINBOARD_URL ?? "http://localhost:8095").replace(/\/$/, "");
const OPERATOR = "human:operator";

async function call(method, path, body, actor = OPERATOR) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json", "x-pinboard-actor": actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const get = (path) => call("GET", path);
const post = (path, body, actor) => call("POST", path, body, actor);
const patch = (path, body, actor) => call("PATCH", path, body, actor);
const put = (path, body, actor) => call("PUT", path, body, actor);

const hours = (n) => new Date(Date.now() + n * 3600_000).toISOString();

// --- seat, agents, planner settings ------------------------------------------

const [license] = await get("/licenses");
await patch(`/licenses/${license.id}`, { linuxUser: "demo", sessionBudgetUsd: 25, concurrencyLimit: 2 });
await put("/settings/planner", { sessionBudgetUsd: 25, defaultTaskCostUsd: 2, concurrencyGlobal: 2 });

const atlas = await post("/agents", {
  name: "atlas", role: "general", provider: "anthropic", model: "sonnet", executor: "cli",
  autonomyLevel: 3, licenseId: license.id,
});
await post("/agents", {
  name: "birch", role: "review", provider: "anthropic", model: "opus", executor: "cli",
  autonomyLevel: 2, licenseId: license.id,
});

// --- projects ------------------------------------------------------------------

const project = (slug, name, description) =>
  post("/projects", { slug, name, description, localPath: `example/${slug}`, repoUrl: `https://github.com/example/${slug}` });

const shop = await project("corner-shop", "Corner Shop", "Small online shop: catalogue, cart and checkout.");
const app = await project("trailhead", "Trailhead", "Hiking companion app for iOS and Android.");
const docs = await project("field-guide", "Field Guide", "Public documentation site for the shop and the app.");
const ops = await project("ops-scripts", "Ops scripts", "Backups, deploy helpers and nightly checks.");

// --- tasks -----------------------------------------------------------------------

// Agent tasks entering the queue have to pass the readiness lint: 200+
// characters and an acceptance line.
const describe = (what, acceptance) =>
  `${what}\n\nKeep the change small and follow the existing patterns in the repository. ` +
  `Update the README and the changelog when behaviour changes, and add a test for anything ` +
  `that would otherwise be checked by hand.\n\nAcceptance: ${acceptance}`;

async function task(p, title, fields = {}) {
  const { status, ...rest } = fields;
  const created = await post("/tasks", {
    projectId: p.id, title, executorMode: "agent", autonomyLevel: 2, priority: 3, estimatedEffort: 2,
    ...rest,
  });
  if (status) await patch(`/tasks/${created.id}`, { status, reason: "demo seed" });
  return created;
}
// A system status (review, needs_input) is reached the way a run reaches
// it, since a PATCH only sets the manual ones: a claim, then the pipeline.
// The claim is a person's, so the demo's agent concurrency stays free.
async function viaRun(t, to, fields = {}) {
  await post(`/tasks/${t.id}/claim`, { actorType: "human", actorName: "operator" });
  if (fields.reviewReason) await post(`/tasks/${t.id}/pipeline`, { actorType: "agent", actorName: "foreman-pipeline", to: "awaiting_ci" }, "agent:foreman-pipeline");
  return post(`/tasks/${t.id}/pipeline`, { actorType: "agent", actorName: "foreman-pipeline", to, ...fields }, "agent:foreman-pipeline");
}
const childOf = (child, story) => post(`/tasks/${child.id}/relations`, { toTaskId: story.id, relationType: "parent" });
const dependsOn = (t, on) => post(`/tasks/${t.id}/relations`, { toTaskId: on.id, relationType: "depends_on" });
const comment = (t, authorType, authorName, body) => post(`/tasks/${t.id}/comments`, { authorType, authorName, body });
const handoff = (t, agent, fields) =>
  post(`/tasks/${t.id}/handoff`, { actorType: "agent", actorName: agent, agentName: agent, ...fields }, `agent:${agent}`);
const pr = (t, p, n, state = "open") =>
  post(`/tasks/${t.id}/pull-requests`, {
    url: `https://github.com/example/${p.slug}/pull/${n}`, repoSlug: `example/${p.slug}`, branchName: `demo-${n}`,
  }).then((row) => (state === "open" ? row : patch(`/tasks/${t.id}/pull-requests/${row.id}`, { state })));

// The governor's implied $/% needs a drop in the remaining percentage with
// spend in between, so the first observation goes in before any handoff.
await post("/governor/rates", { usdPerSessionPercent: 0.12, usdPerWeekPercent: 0.9, effectiveFrom: hours(-24 * 21), note: "first estimate" });
await post("/governor/rates", { usdPerSessionPercent: 0.1, usdPerWeekPercent: 0.8, effectiveFrom: hours(-24 * 9), note: "recalibrated" });
await post("/governor/observations", { scope: "week", percentRemaining: 84, note: "start of the week" });
await post("/governor/observations", { scope: "session", percentRemaining: 92 });

// Story: a checkout revamp split into children across the pipeline.
const story = await task(shop, "Checkout revamp", {
  taskType: "story", executorMode: "human", priority: 4, estimatedEffort: 13,
  description:
    "Rework checkout so a first-time buyer can pay in under a minute.\n\n" +
    "- Guest checkout, no account needed\n- Carts survive a closed tab\n" +
    "- Delivery estimate before the payment step\n- Wallet payment buttons\n\n" +
    "Acceptance: a guest can order on a phone without signing up, and the funnel shows fewer drop-offs at the payment step.",
});
await handoff(story, "atlas", {
  summary: "Split the revamp into five children, ordered so the cart work lands before payments.",
  completed: "Broke the story down and queued the first child.",
  costUsd: 0.62, durationMs: 4 * 60_000, numTurns: 18,
  checklist: [
    "Guest checkout works on a phone-sized screen",
    "A cart survives closing and reopening the tab",
    "Delivery estimate matches the carrier table for three sample postcodes",
    "Wallet buttons only show on supported browsers",
  ],
});
await patch(`/tasks/${story.id}`, { status: "defined", reason: "split into children" });
await patch(`/tasks/${story.id}/checklist`, { actorType: "human", actorName: "operator", item: "Guest checkout works on a phone-sized screen", checked: true, note: "checked on a small phone" });

const guest = await task(shop, "Guest checkout without an account", {
  description: describe("Let a buyer finish checkout with only an email address.", "an order can be placed without signing up, and the confirmation mail arrives."),
  estimatedEffort: 3,
});
const cart = await task(shop, "Keep the cart between sessions", {
  description: describe("Persist the cart in local storage and merge it on sign-in.", "closing and reopening the tab keeps the cart, and signing in merges it with the saved one."),
});
const delivery = await task(shop, "Show a delivery estimate on the product page", {
  description: describe("Show the expected delivery date next to the price, from the carrier table.", "the product page shows a delivery date for the default postcode."),
});
const wallets = await task(shop, "Wallet payment buttons", {
  description: describe("Add the wallet payment buttons to the payment step where the browser supports them.", "supported browsers show the buttons and a test payment completes."),
  estimatedEffort: 3,
});
const receipts = await task(shop, "Printable receipts", {
  description: describe("Add a print stylesheet for the order confirmation page.", "printing the confirmation fits on one page with the shop logo."),
  estimatedEffort: 1, priority: 2,
});
for (const c of [guest, cart, delivery, wallets, receipts]) await childOf(c, story);
await dependsOn(wallets, delivery);

// Children through their states.
await handoff(guest, "atlas", {
  summary: "Guest checkout is live behind the existing payment step; accounts are still offered after the order.",
  completed: "Email-only checkout, confirmation mail, tests.", costUsd: 3.4, durationMs: 22 * 60_000, numTurns: 61,
});
await pr(guest, shop, 41, "merged");
await patch(`/tasks/${guest.id}`, { status: "done", reason: "merged" });

await handoff(cart, "atlas", {
  summary: "Carts now live in local storage and merge with the saved cart on sign-in. **Needs you:** try it on a phone.",
  completed: "Persistence, merge on sign-in, unit tests for the merge rules.", costUsd: 2.1, durationMs: 17 * 60_000, numTurns: 44,
  checklist: ["Add two items, close the tab, reopen: both are still there", "Sign in with a saved cart: items are merged, not replaced"],
});
await pr(cart, shop, 43);
await viaRun(cart, "review");

await patch(`/tasks/${wallets.id}`, { status: "queued", reason: "ready" });
await patch(`/tasks/${receipts.id}`, { status: "defined", reason: "later" });
await patch(`/tasks/${delivery.id}`, { status: "queued", reason: "ready" });
await post(`/tasks/${delivery.id}/claim`, { actorType: "agent", actorName: "atlas", leaseSeconds: 6 * 3600 }, "agent:atlas");
await post(`/tasks/${delivery.id}/events`, { actorType: "agent", actorName: "atlas", payload: { kind: "text", text: "Reading the carrier table and the product page template." } }, "agent:atlas");
await comment(delivery, "human", "operator", "Use the slowest carrier for the estimate, not the fastest.");
await comment(delivery, "agent", "atlas", "Will do, and the estimate will say \"up to\" so it never over-promises.");

// Other shop work.
const search = await task(shop, "Search ignores accents in product names", {
  taskType: "bug", priority: 4,
  description: describe("Searching for 'creme' does not find 'crème brûlée'. Normalise accents on both sides.", "a search without accents finds products with accents."),
});
await handoff(search, "atlas", {
  summary: "Search normalises accents on the query and the index; reindex runs on deploy.",
  costUsd: 1.3, durationMs: 9 * 60_000, numTurns: 23,
  checklist: ["Search for 'creme': the brûlée shows up"],
});
await pr(search, shop, 44);
await viaRun(search, "review", { reviewReason: "migration" });
await task(shop, "Gift cards", { executorMode: "human", taskType: "idea", priority: 1, estimatedEffort: 5, status: "idea" });

// Mobile app.
const offline = await task(app, "Offline maps for saved trails", {
  priority: 4, estimatedEffort: 5,
  description: describe("Download map tiles for a saved trail so it works without signal.", "a saved trail opens in airplane mode with its map."),
});
await handoff(offline, "atlas", {
  summary: "Tile download works; stopped to ask how much storage a trail may use.", costUsd: 1.9, durationMs: 14 * 60_000, numTurns: 37,
});
await viaRun(offline, "needs_input");
await post(`/tasks/${offline.id}/asks`, {
  question: "How much storage may one saved trail use for offline tiles?",
  context: "A long trail at full zoom is about 180 MB. Most phones in the analytics have under 8 GB free.",
  options: [
    { label: "Cap at 50 MB per trail", rationale: "Lower zoom on long trails, safe on small phones.", recommended: true },
    { label: "Cap at 200 MB per trail", rationale: "Full detail everywhere, risky on small phones." },
    { label: "Let the user choose", rationale: "Most flexible, one more setting to explain." },
  ],
}, "agent:atlas");
const darkMode = await task(app, "Follow the system dark mode", {
  description: describe("Switch the app theme with the system setting instead of a manual toggle.", "changing the system theme switches the app without a restart."),
});
await handoff(darkMode, "birch", {
  summary: "Theme follows the system setting; the manual toggle is gone from settings.", costUsd: 1.1, durationMs: 8 * 60_000, numTurns: 19,
  checklist: ["Switch the system theme while the app is open: it follows"],
});
await pr(darkMode, app, 18);
await viaRun(darkMode, "review");
await post(`/tasks/${darkMode.id}/asks`, {
  kind: "assumption", question: "Kept the old toggle's value as the default on first launch after the update.",
  context: "So nobody's theme flips unexpectedly.",
}, "agent:birch");
const crash = await task(app, "Crash when a trail has no elevation data", {
  taskType: "bug", priority: 5, estimatedEffort: 1,
  description: describe("Opening a trail imported without elevation data crashes the profile chart.", "a trail without elevation opens and the chart shows a short notice instead."),
});
await handoff(crash, "atlas", { summary: "Chart shows a notice when elevation is missing.", costUsd: 0.7, durationMs: 5 * 60_000, numTurns: 12 });
await pr(crash, app, 17, "merged");
await patch(`/tasks/${crash.id}`, { status: "done", reason: "merged" });
await task(app, "Share a trail as a link", {
  status: "queued", estimatedEffort: 3,
  description: describe("Add a share button that creates a link opening the trail in the app or the web viewer.", "a shared link opens the same trail on another phone."),
});
await task(app, "Step counter widget", { executorMode: "human", taskType: "idea", priority: 1, status: "defined" });

// Docs site.
const docsSearch = await task(docs, "Add site search", {
  description: describe("Add client-side search over the built pages.", "searching for a page title finds it from any page."),
});
await handoff(docsSearch, "atlas", { summary: "Client-side search over the built pages, index built at deploy.", costUsd: 1.6, durationMs: 11 * 60_000, numTurns: 27 });
await pr(docsSearch, docs, 9, "merged");
await patch(`/tasks/${docsSearch.id}`, { status: "done", reason: "merged" });
const shippingDocs = await task(docs, "Document the new checkout", {
  status: "queued", estimatedEffort: 1, priority: 2,
  description: describe("Write the help page for guest checkout and saved carts once both ship.", "the help page covers guest checkout and saved carts with screenshots."),
});
await dependsOn(shippingDocs, cart);
const linkCheck = await task(docs, "Fix broken links after the move", {
  taskType: "bug", estimatedEffort: 1,
  description: describe("The move to the new URL scheme left links to the old paths.", "the link checker reports no broken internal links."),
});
await handoff(linkCheck, "birch", { summary: "Redirects for the old paths, and the link checker runs in CI.", costUsd: 0.9, durationMs: 6 * 60_000, numTurns: 14 });
await patch(`/tasks/${linkCheck.id}`, { status: "rework", reason: "two links still 404" });
await comment(linkCheck, "human", "operator", "The changelog and the FAQ still point at the old paths.");

// Ops.
const backups = await task(ops, "Restore drill for the nightly backup", {
  taskType: "maintenance", estimatedEffort: 2,
  description: describe("Restore last night's backup into a scratch database and compare row counts.", "the drill script restores and reports matching counts."),
});
await handoff(backups, "atlas", { summary: "Drill script restores into a scratch database and compares counts.", costUsd: 1.2, durationMs: 10 * 60_000, numTurns: 21 });
await patch(`/tasks/${backups.id}`, { status: "done", reason: "verified" });
await task(ops, "Nightly dependency audit", {
  taskType: "maintenance", status: "queued", priority: 2,
  description: describe("Run the package audit nightly and open a task when something high or critical shows up.", "a known-vulnerable test package produces a task within a day."),
});
await task(docs, "Getting-started guide for the app", {
  status: "queued", estimatedEffort: 5,
  description: describe("Write a getting-started guide for the mobile app: install, first trail, offline use.", "a new user can follow the guide from install to a saved trail."),
});
await task(ops, "Rotate the deploy key", { executorMode: "human", taskType: "maintenance", priority: 3, status: "defined" });
await task(ops, "Retire the old image cache", { executorMode: "human", taskType: "maintenance", priority: 1, status: "rejected" });

// --- budget and governor ----------------------------------------------------------

await post("/plan/periods", { budgetUsd: 40, startsAt: hours(-24 * 3), endsAt: hours(24 * 4), note: "this week", licenseId: license.id });
await post("/governor/observations", { scope: "week", percentRemaining: 71, note: "after the morning runs" });
await post("/governor/observations", { scope: "session", percentRemaining: 68 });
await post("/usage", { costUsd: 2.4, source: "interactive", linuxUser: "demo", sessionId: "demo-session" });

console.log(`Seeded ${base}: 4 projects, agents ${atlas.name} and birch, a story with 5 children, review cards and an open question.`);
