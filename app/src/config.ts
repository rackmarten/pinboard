function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8095),
  databaseUrl: required("DATABASE_URL"),
  // Optional: the daily digest (PLAN.md's I5) logs a warning and skips
  // sending instead of crashing the app when these are unset - see mailer.ts.
  smtp: {
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    // Name to verify the mail server's certificate against when SMTP_HOST is an
    // IP. Empty = SMTP_HOST.
    tlsServername: process.env.SMTP_TLS_SERVERNAME ?? "",
  },
  // phone push via ntfy. Optional like smtp - unset
  // means nothing is published.
  ntfy: {
    url: process.env.NTFY_URL ?? "",
    token: process.env.NTFY_TOKEN_PINBOARD ?? "",
    topic: process.env.NTFY_TOPIC ?? "pinboard",
  },
  // no phone pushes between these hours (local to pushTimeZone),
  // then one digest at digestAt. See push-policy.ts.
  push: {
    quietStart: Number(process.env.PUSH_QUIET_START ?? 1),
    quietEnd: Number(process.env.PUSH_QUIET_END ?? 9),
    digestAt: Number(process.env.PUSH_DIGEST_AT ?? 9),
    timeZone: process.env.PUSH_TIME_ZONE ?? "Europe/Bratislava",
  },
  // Where a tapped phone notification opens.
  publicUrl: process.env.PINBOARD_PUBLIC_URL ?? "http://localhost:8095",
  digest: {
    // Empty = the SMTP account itself.
    to: process.env.DIGEST_TO || process.env.SMTP_USER || "",
    hour: Number(process.env.DIGEST_HOUR ?? 9),
  },
  // PLAN.md's I6 governor. All tunable without a migration - see governor.ts
  // and .env.example for what each one means. reserveFloorPercent is human
  // reserve + emergency reserve combined (idea-task-management.md's
  // "Autonomous Budget" default: 20% + 10%): the governor never treats
  // allowance below this floor as available to autonomous work.
  governor: {
    reserveFloorPercent: Number(process.env.GOVERNOR_RESERVE_FLOOR_PERCENT ?? 30),
    overRateThresholdPercent: Number(process.env.GOVERNOR_OVER_RATE_THRESHOLD_PERCENT ?? 25),
    dangerThresholdPercent: Number(process.env.GOVERNOR_DANGER_THRESHOLD_PERCENT ?? 10),
    criticalThresholdPercent: Number(process.env.GOVERNOR_CRITICAL_THRESHOLD_PERCENT ?? 0),
    priorityGate: Number(process.env.GOVERNOR_PRIORITY_GATE ?? 5),
    // Weekly reset day/hour (0=Sunday, server-local time) - the operator has
    // observed this as Friday 16:00; adjust here if that turns out wrong.
    resetDayOfWeek: Number(process.env.GOVERNOR_RESET_DAY_OF_WEEK ?? 5),
    resetHour: Number(process.env.GOVERNOR_RESET_HOUR ?? 16),
    // $-based planner defaults, overridable per-install from the
    // Plan screen (app_settings) - see settings.ts's getPlannerSettings.
    // sessionBudgetUsd is the operator's own reading of what one 5h window is
    // worth in $; defaultTaskCostUsd is only used before there is any history
    // to average (measured mean was ~$1.25 on 2026-09-16).
    sessionBudgetUsd: Number(process.env.GOVERNOR_SESSION_BUDGET_USD ?? 15),
    defaultTaskCostUsd: Number(process.env.GOVERNOR_DEFAULT_TASK_COST_USD ?? 1.25),
    concurrency: {
      global: Number(process.env.GOVERNOR_CONCURRENCY_GLOBAL ?? 1),
      perAgent: Number(process.env.GOVERNOR_CONCURRENCY_PER_AGENT ?? 1),
      perProject: Number(process.env.GOVERNOR_CONCURRENCY_PER_PROJECT ?? 1),
      perProvider: Number(process.env.GOVERNOR_CONCURRENCY_PER_PROVIDER ?? 2),
    },
  },
  // who may grant a `root-access` task. Both unset disables grants
  // entirely (fail closed) - see root-grants.ts for why it is these two.
  rootGrants: {
    proxySecret: process.env.PINBOARD_PROXY_SECRET ?? "",
    // Space- or comma-separated tailnet IPs of the operators' own devices.
    operatorIps: (process.env.OPERATOR_DEVICE_IPS ?? "").split(/[\s,]+/).filter(Boolean),
  },
};
