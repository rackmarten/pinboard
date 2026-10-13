import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { integrationStatus } from "./integrations.js";

// with only POSTGRES_PASSWORD in .env, docker-compose.yml hands the
// app PORT, DATABASE_URL and the integration variables as empty strings. That
// environment must load and leave every integration off, not throw.
const COMPOSE_ENV_WITH_ONLY_PASSWORD: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  PORT: "8095",
  DATABASE_URL: "postgresql://pinboard:only-this@db:5432/pinboard",
  PINBOARD_PROXY_SECRET: "",
  SMTP_HOST: "",
  SMTP_TLS_SERVERNAME: "",
  NTFY_URL: "",
  NTFY_TOKEN_PINBOARD: "",
  PUSH_QUIET_START: "1",
  PUSH_QUIET_END: "9",
  PUSH_DIGEST_AT: "9",
};

test("config loads with only a database password and every integration is off", () => {
  const script = [
    'const { config } = await import("./config.ts");',
    'const { integrationStatus } = await import("./integrations.ts");',
    "console.log(JSON.stringify(integrationStatus(config)));",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: import.meta.dirname,
    env: COMPOSE_ENV_WITH_ONLY_PASSWORD,
    encoding: "utf8",
  });
  const status = JSON.parse(out.trim().split("\n").at(-1)!) as { name: string; enabled: boolean; line: string }[];
  assert.deepEqual(
    status.map((s) => [s.name, s.enabled]),
    [
      ["mail", false],
      ["push", false],
      ["root-grants", false],
    ],
  );
  for (const s of status) assert.match(s.line, /: off \(/);
});

test("config without DATABASE_URL still fails loudly", () => {
  assert.throws(() =>
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'await import("./config.ts");'], {
      cwd: import.meta.dirname,
      env: { PATH: process.env.PATH ?? "" },
      stdio: "pipe",
    }),
  );
});

test("each integration turns on only when all of its values are set", () => {
  const off = { smtp: { host: "", user: "", pass: "" }, ntfy: { url: "", token: "" }, rootGrants: { proxySecret: "", operatorIps: [] } };
  const on = {
    smtp: { host: "mail", user: "u", pass: "p" },
    ntfy: { url: "http://ntfy", token: "t" },
    rootGrants: { proxySecret: "s", operatorIps: ["100.64.0.1"] },
  };
  assert.ok(integrationStatus(off).every((s) => !s.enabled));
  assert.ok(integrationStatus(on).every((s) => s.enabled));
  assert.equal(integrationStatus({ ...on, smtp: { ...on.smtp, pass: "" } })[0].enabled, false);
  assert.equal(integrationStatus({ ...on, rootGrants: { proxySecret: "s", operatorIps: [] } })[2].enabled, false);
});
