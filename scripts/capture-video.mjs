// Records the README demo clip from a seeded pinboard: a scripted walk
// through the task list, a story with its review checklist and children, the
// inbox and the plan, dark theme at 1440x900, written as demo.gif.
// Frames come from Chromium's screencast through a Playwright CDP session,
// not Playwright's recordVideo: that goes through a low-bitrate VP9 encode
// which leaves blocky noise all over the dark theme and bloats the GIF.
// sharp scales the frames and packs them. Runs inside the Playwright image
// (scripts/screenshots.sh --video installs playwright and sharp next to it);
// not meant to be run on the host.
//
// Usage: node capture-video.mjs <base-url> <out-dir>

import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const [base = "http://pinboard-demo:8095", outDir = "out"] = process.argv.slice(2);

const viewport = { width: 1440, height: 900 };
const fps = 12.5;
const gifWidth = 1200;

const res = await fetch(`${base}/api/tasks`);
if (!res.ok) throw new Error(`GET /api/tasks -> ${res.status}`);
const tasks = await res.json();
const story = tasks.find((t) => t.taskType === "story");
if (!story) throw new Error("no story in the seeded data; run demo-seed.mjs first");
const projectsRes = await fetch(`${base}/api/projects`);
if (!projectsRes.ok) throw new Error(`GET /api/projects -> ${projectsRes.status}`);
const projectName = (await projectsRes.json()).find((p) => p.id === story.projectId)?.name;
if (!projectName) throw new Error(`story ${story.id} has no project in GET /api/projects`);

// Headless Chromium draws no pointer, so the page gets a fake one that
// follows mouse events, plus a ring on each click, to show what is clicked.
function pointer() {
  addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = `
      #demo-pointer { position: fixed; z-index: 99999; pointer-events: none; width: 22px; height: 22px;
        margin: -3px 0 0 -3px; transition: transform .12s; left: -40px; top: -40px; }
      #demo-pointer.down { transform: scale(.85); }
      .demo-ring { position: fixed; z-index: 99998; pointer-events: none; width: 36px; height: 36px;
        margin: -18px 0 0 -18px; border-radius: 50%; border: 3px solid rgba(255,255,255,.8);
        animation: demo-ring .5s ease-out forwards; }
      @keyframes demo-ring { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }`;
    document.head.append(style);
    const el = document.createElement("div");
    el.id = "demo-pointer";
    el.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 2l7 19 2.6-8.4L21 10z"
      fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    document.body.append(el);
    const last = JSON.parse(sessionStorage.getItem("demo-pointer") ?? "null");
    if (last) Object.assign(el.style, { left: `${last.x}px`, top: `${last.y}px` });
    addEventListener("mousemove", (e) => {
      Object.assign(el.style, { left: `${e.clientX}px`, top: `${e.clientY}px` });
      sessionStorage.setItem("demo-pointer", JSON.stringify({ x: e.clientX, y: e.clientY }));
    }, true);
    addEventListener("mousedown", (e) => {
      el.classList.add("down");
      const ring = document.createElement("div");
      ring.className = "demo-ring";
      Object.assign(ring.style, { left: `${e.clientX}px`, top: `${e.clientY}px` });
      document.body.append(ring);
      setTimeout(() => ring.remove(), 600);
    }, true);
    addEventListener("mouseup", () => el.classList.remove("down"), true);
  });
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const shots = [];
let stoppedAt;
try {
  const context = await browser.newContext({
    viewport,
    colorScheme: "dark",
    serviceWorkers: "block",
    locale: "en-GB",
    timezoneId: "UTC",
    // The app's CSP says upgrade-insecure-requests, which would send every
    // asset to https on this plain-http stack.
    bypassCSP: true,
  });
  await context.addInitScript(pointer);
  const page = await context.newPage();
  const hold = (ms) => page.waitForTimeout(ms);
  // Glide to the middle of a locator, then click it.
  async function glideClick(locator, steps = 25) {
    const box = await locator.boundingBox();
    if (!box) throw new Error(`not visible: ${locator}`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
    await hold(250);
    await page.mouse.down();
    await hold(80);
    await page.mouse.up();
  }
  // Wheel-scroll until the locator's top edge sits at y.
  async function scrollTo(locator, y, steps = 20) {
    const box = await locator.boundingBox();
    if (!box) throw new Error(`not found: ${locator}`);
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, (box.y - y) / steps);
      await hold(30);
    }
    await hold(300);
  }
  const nav = (label) => page.locator(".v-navigation-drawer .v-list-item").filter({ hasText: label }).first();
  const settle = async () => {
    await page.waitForLoadState("networkidle");
    await hold(600);
  };

  await page.goto(`${base}/tasks`, { waitUntil: "networkidle" });
  await page.mouse.move(760, 420);
  await hold(1000);

  // A lossless PNG every time the page repaints, with its time.
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    shots.push({ t: metadata.timestamp * 1000, png: Buffer.from(data, "base64") });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: viewport.width, maxHeight: viewport.height });

  // Task list, with the story and its children grouped under it.
  await hold(2000);
  // Narrow it to the story's project, so its children fit on screen.
  await glideClick(page.locator(".v-select").filter({ hasText: "Project" }).first());
  await hold(600);
  await glideClick(page.locator(".v-overlay .v-list-item").filter({ hasText: projectName }).first(), 15);
  await settle();
  await hold(1200);
  // Fold the story's children away and back, to show the grouping.
  const storyRow = page.locator("tr").filter({ hasText: story.title }).first();
  await glideClick(storyRow.locator("button").first());
  await hold(900);
  await glideClick(storyRow.locator("button").first(), 5);
  await hold(1500);

  // The story: handoff, review checklist, children in run order.
  await glideClick(storyRow.getByText(story.title, { exact: true }));
  await settle();
  await hold(2000);
  const unticked = page.locator(".v-selection-control").filter({ has: page.locator("input[type=checkbox]:not(:checked)") });
  await glideClick(unticked.first());
  await hold(2000);

  // Needs you: the open question, then the review queue.
  await glideClick(nav("Needs you"));
  await settle();
  await hold(3000);
  await scrollTo(page.getByText("Review", { exact: true }).first(), 90);
  await hold(2500);

  // Plan: budget left, the session window, queued work across windows.
  await glideClick(nav("Plan"));
  await settle();
  await hold(3500);

  stoppedAt = Date.now();
  await cdp.send("Page.stopScreencast");
  await context.close();
} finally {
  await browser.close();
}
if (!shots.length) throw new Error("the screencast delivered no frames");
// Frame timestamps are wall-clock seconds in this Chromium; if a later one
// changes that, fail here rather than resample over a bogus span.
const span = stoppedAt - shots[0].t;
if (!(span > 0 && span < 120_000)) throw new Error(`screencast timestamps look off: ${span} ms from first frame to stop`);

// Resample the irregular repaints onto a fixed frame clock: each tick shows
// the last repaint before it, and a run of ticks on the same repaint becomes
// one GIF frame with a longer delay.
const tick = 1000 / fps;
const frames = [];
const end = Math.max(stoppedAt, shots.at(-1).t + tick);
for (let t = shots[0].t, i = 0; t < end; t += tick) {
  while (i + 1 < shots.length && shots[i + 1].t <= t) i++;
  if (frames.at(-1)?.shot === i) frames.at(-1).ticks++;
  else frames.push({ shot: i, ticks: 1 });
}
// One tall raw strip, a frame per page, filled frame by frame so only the
// strip and one decoded frame are in memory at once.
const width = gifWidth;
const height = Math.round((viewport.height * gifWidth) / viewport.width);
const frameBytes = width * height * 3;
const strip = Buffer.alloc(frameBytes * frames.length);
for (const [n, { shot }] of frames.entries()) {
  const data = await sharp(shots[shot].png).resize(width, height).removeAlpha().raw().toBuffer();
  data.copy(strip, n * frameBytes);
}
const gif = join(outDir, "demo.gif");
// The strip is far taller than sharp's default pixel limit allows.
await sharp(strip, { limitInputPixels: false, raw: { width, height: height * frames.length, channels: 3, pageHeight: height } })
  .gif({ delay: frames.map((f) => Math.round(f.ticks * tick)), loop: 0, effort: 10, colours: 128, dither: 0, interFrameMaxError: 4, reuse: true })
  .toFile(gif);

const seconds = frames.reduce((n, f) => n + f.ticks, 0) / fps;
console.log(`demo.gif ${Math.round((await stat(gif)).size / 1024)} KB, ${seconds.toFixed(1)} s, ${frames.length} frames from ${shots.length} repaints`);
