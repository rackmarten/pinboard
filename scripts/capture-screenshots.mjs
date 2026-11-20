// Captures the README screenshots from a seeded pinboard. Runs inside the
// Playwright image (scripts/screenshots.sh installs playwright and sharp next
// to it); not meant to be run on the host.
//
// Usage: node capture-screenshots.mjs <base-url> <out-dir>

import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import sharp from "sharp";

const [base = "http://pinboard-demo:8095", outDir = "out"] = process.argv.slice(2);

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };

const res = await fetch(`${base}/api/tasks`);
if (!res.ok) throw new Error(`GET /api/tasks -> ${res.status}`);
const tasks = await res.json();
const story = tasks.find((t) => t.taskType === "story");
if (!story) throw new Error("no story in the seeded data; run demo-seed.mjs first");

// Dark first: it is the default theme and the README's hero.
const shots = [
  { name: "task-list-dark", path: "/tasks", viewport: desktop, scheme: "dark" },
  { name: "task-list-light", path: "/tasks", viewport: desktop, scheme: "light" },
  { name: "task-detail-dark", path: `/tasks/${story.id}`, viewport: desktop, scheme: "dark" },
  { name: "inbox-dark", path: "/inbox", viewport: desktop, scheme: "dark" },
  { name: "plan-dark", path: "/plan", viewport: desktop, scheme: "dark" },
  { name: "governor-dark", path: "/governor", viewport: desktop, scheme: "dark" },
  { name: "phone-task-list-dark", path: "/tasks", viewport: phone, scheme: "dark" },
  { name: "phone-inbox-dark", path: "/inbox", viewport: phone, scheme: "dark" },
];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const shot of shots) {
    // ui-kit picks the theme from localStorage, else prefers-color-scheme,
    // so a fresh context with colorScheme set is all the switch needs.
    const context = await browser.newContext({
      viewport: shot.viewport,
      deviceScaleFactor: 2,
      colorScheme: shot.scheme,
      reducedMotion: "reduce",
      serviceWorkers: "block",
      locale: "en-GB",
      timezoneId: "UTC",
      // The app's CSP says upgrade-insecure-requests, which would send every
      // asset to https on this plain-http stack.
      bypassCSP: true,
    });
    const page = await context.newPage();
    await page.goto(base + shot.path, { waitUntil: "networkidle" });
    // Let late renders (charts, chips filled from a second request) settle.
    await page.waitForTimeout(1500);
    const png = await page.screenshot({ animations: "disabled" });
    const optimised = await sharp(png).png({ palette: true, quality: 80, dither: 0.4, effort: 10, compressionLevel: 9 }).toBuffer();
    await writeFile(`${outDir}/${shot.name}.png`, optimised);
    console.log(`${shot.name}.png ${Math.round(optimised.length / 1024)} KB`);
    await context.close();
  }
} finally {
  await browser.close();
}
