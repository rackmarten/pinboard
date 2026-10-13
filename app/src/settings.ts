import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { appSettings } from "./db/schema.js";

export interface WeeklyResetSetting {
  dayOfWeek: number; // 0=Sunday..6=Saturday
  hour: number; // 0-23, server-local time
}

const SETTINGS_ROW_ID = 1;

export function validateDayOfWeek(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error("dayOfWeek must be an integer 0-6 (0=Sunday)");
  return n;
}

export function validateHour(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 23) throw new Error("hour must be an integer 0-23");
  return n;
}

// Falls back to config.governor's deploy-time default until the operator
// sets this from the Usage screen - see schema.ts's appSettings note.
export async function getWeeklyResetSetting(): Promise<WeeklyResetSetting> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, SETTINGS_ROW_ID)).limit(1);
  return {
    dayOfWeek: row?.weeklyResetDayOfWeek ?? config.governor.resetDayOfWeek,
    hour: row?.weeklyResetHour ?? config.governor.resetHour,
  };
}

export async function updateWeeklyResetSetting(dayOfWeek: number, hour: number): Promise<WeeklyResetSetting> {
  await db
    .insert(appSettings)
    .values({ id: SETTINGS_ROW_ID, weeklyResetDayOfWeek: dayOfWeek, weeklyResetHour: hour })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { weeklyResetDayOfWeek: dayOfWeek, weeklyResetHour: hour, updatedAt: new Date() },
    });
  return { dayOfWeek, hour };
}

// standing planner configuration. Same fallback precedent as the
// weekly-reset setting above - a null column means "never set from the UI",
// so config.governor's deploy-time default still applies and changing any of
// these is a UI edit rather than a redeploy.
export interface PlannerSettings {
  // $ ceiling for one 5h session window.
  sessionBudgetUsd: number;
  // Cold-start per-task estimate, used only when there's no usable history -
  // see cost-model.ts on why this is a per-task mean, not a $/effort rate.
  defaultTaskCostUsd: number;
  // How many agent tasks may execute at once.
  concurrencyGlobal: number;
  // Scale a task's estimate by its effort (cost-model.ts). On by default; an
  // operator switch rather than a deploy if effort stops predicting cost.
  useEffortScaling: boolean;
}

export const DEFAULT_USE_EFFORT_SCALING = true;

export function resolveUseEffortScaling(stored: boolean | null | undefined): boolean {
  return stored ?? DEFAULT_USE_EFFORT_SCALING;
}

export function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be true or false`);
  return value;
}

export function validatePositiveNumber(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} must be a positive number`);
  return n;
}

export function validatePositiveInteger(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${field} must be a positive integer`);
  return n;
}

export async function getPlannerSettings(): Promise<PlannerSettings> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, SETTINGS_ROW_ID)).limit(1);
  return {
    sessionBudgetUsd: row?.sessionBudgetUsd ? Number(row.sessionBudgetUsd) : config.governor.sessionBudgetUsd,
    defaultTaskCostUsd: row?.defaultTaskCostUsd ? Number(row.defaultTaskCostUsd) : config.governor.defaultTaskCostUsd,
    concurrencyGlobal: row?.concurrencyGlobal ?? config.governor.concurrency.global,
    useEffortScaling: resolveUseEffortScaling(row?.useEffortScaling),
  };
}

export async function updatePlannerSettings(patch: Partial<PlannerSettings>): Promise<PlannerSettings> {
  // Only the fields actually present in the patch are written, so updating
  // one setting never silently resets the others back to their config
  // defaults.
  const set = {
    ...(patch.sessionBudgetUsd !== undefined ? { sessionBudgetUsd: String(patch.sessionBudgetUsd) } : {}),
    ...(patch.defaultTaskCostUsd !== undefined ? { defaultTaskCostUsd: String(patch.defaultTaskCostUsd) } : {}),
    ...(patch.concurrencyGlobal !== undefined ? { concurrencyGlobal: patch.concurrencyGlobal } : {}),
    ...(patch.useEffortScaling !== undefined ? { useEffortScaling: patch.useEffortScaling } : {}),
    updatedAt: new Date(),
  };
  await db
    .insert(appSettings)
    .values({ id: SETTINGS_ROW_ID, ...set })
    .onConflictDoUpdate({ target: appSettings.id, set });
  return getPlannerSettings();
}
