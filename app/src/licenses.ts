// an account/license under a provider - see schema.ts's
// licenses comment for the full rationale on the name and scope. This module
// is the CRUD + fallback-resolution counterpart to settings.ts, one level
// down: settings.ts resolves the appSettings-level default, this resolves a
// specific license's override of that default (the three-tier fallback:
// license override -> appSettings -> config.governor default).

import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { licenses } from "./db/schema.js";
import { getPlannerSettings } from "./settings.js";

export interface License {
  id: number;
  name: string;
  provider: string;
  linuxUser: string;
  tokenEnvVar: string | null;
  sessionBudgetUsd: number | null;
  concurrencyLimit: number | null;
  sessionResetAt: string | null;
  recurrenceEnabled: boolean;
  recurrenceBudgetUsd: number | null;
  enabled: boolean;
  createdAt: string;
}

function rowToLicense(row: typeof licenses.$inferSelect): License {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    linuxUser: row.linuxUser,
    tokenEnvVar: row.tokenEnvVar,
    sessionBudgetUsd: row.sessionBudgetUsd !== null ? Number(row.sessionBudgetUsd) : null,
    concurrencyLimit: row.concurrencyLimit,
    sessionResetAt: row.sessionResetAt ? (row.sessionResetAt as unknown as Date).toISOString() : null,
    recurrenceEnabled: row.recurrenceEnabled,
    recurrenceBudgetUsd: row.recurrenceBudgetUsd !== null ? Number(row.recurrenceBudgetUsd) : null,
    enabled: row.enabled,
    createdAt: (row.createdAt as unknown as Date)?.toISOString?.() ?? String(row.createdAt),
  };
}

export async function listLicenses(): Promise<License[]> {
  const rows = await db.select().from(licenses).orderBy(licenses.name);
  return rows.map(rowToLicense);
}

export async function getLicense(id: number): Promise<License | null> {
  const [row] = await db.select().from(licenses).where(eq(licenses.id, id));
  return row ? rowToLicense(row) : null;
}

// The 0024 migration's backfill target - every agent/budget period/usage
// event created before a second license existed points at this one. Used as
// the fallback licenseId wherever a caller has no agent to resolve one from
// (e.g. a handoff with no agentName) and as the default GET /plan scopes to
// when the PWA doesn't pass ?licenseId= yet.
export async function getDefaultLicenseId(): Promise<number> {
  const [row] = await db.select({ id: licenses.id }).from(licenses).where(eq(licenses.name, "default"));
  if (!row) throw new Error("no 'default' license found - the 0024 migration should have created one");
  return row.id;
}

export interface LicenseInput {
  name: string;
  provider: string;
  linuxUser: string;
  tokenEnvVar?: string | null;
  sessionBudgetUsd?: number | null;
  concurrencyLimit?: number | null;
  recurrenceEnabled?: boolean;
  recurrenceBudgetUsd?: number | null;
  enabled?: boolean;
}

export async function createLicense(input: LicenseInput): Promise<License> {
  const [row] = await db
    .insert(licenses)
    .values({
      name: input.name,
      provider: input.provider,
      linuxUser: input.linuxUser,
      tokenEnvVar: input.tokenEnvVar || null,
      sessionBudgetUsd: input.sessionBudgetUsd != null ? String(input.sessionBudgetUsd) : null,
      concurrencyLimit: input.concurrencyLimit ?? null,
      enabled: input.enabled ?? true,
    })
    .returning();
  return rowToLicense(row);
}

export async function updateLicense(id: number, patch: Partial<LicenseInput>): Promise<License | null> {
  const values: Record<string, unknown> = {};
  if (patch.provider !== undefined) values.provider = patch.provider;
  if (patch.linuxUser !== undefined) values.linuxUser = patch.linuxUser;
  if (patch.tokenEnvVar !== undefined) values.tokenEnvVar = patch.tokenEnvVar || null;
  if (patch.sessionBudgetUsd !== undefined) values.sessionBudgetUsd = patch.sessionBudgetUsd != null ? String(patch.sessionBudgetUsd) : null;
  if (patch.concurrencyLimit !== undefined) values.concurrencyLimit = patch.concurrencyLimit;
  if (patch.recurrenceEnabled !== undefined) values.recurrenceEnabled = patch.recurrenceEnabled;
  if (patch.recurrenceBudgetUsd !== undefined)
    values.recurrenceBudgetUsd = patch.recurrenceBudgetUsd != null ? String(patch.recurrenceBudgetUsd) : null;
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  // name isn't patchable - foreman/routes resolve a license by id, not name,
  // but keeping it stable avoids the same class of surprise agents.name's
  // own "not patchable" precedent guards against.
  if (Object.keys(values).length === 0) {
    const [row] = await db.select().from(licenses).where(eq(licenses.id, id));
    return row ? rowToLicense(row) : null;
  }
  const [row] = await db.update(licenses).set(values).where(eq(licenses.id, id)).returning();
  return row ? rowToLicense(row) : null;
}

export interface LicenseSettings {
  sessionBudgetUsd: number;
  concurrencyLimit: number;
}

// The three-tier fallback used everywhere a per-license budget/concurrency
// figure is needed: this license's own override, else the operator's
// appSettings default, else config.governor's deploy-time default (the
// latter two already resolved by getPlannerSettings).
export async function getLicenseSettings(licenseId: number): Promise<LicenseSettings> {
  const [license, base] = await Promise.all([getLicense(licenseId), getPlannerSettings()]);
  return {
    sessionBudgetUsd: license?.sessionBudgetUsd ?? base.sessionBudgetUsd,
    concurrencyLimit: license?.concurrencyLimit ?? base.concurrencyGlobal,
  };
}

// The Plan screen's "Reset window": tell the planner the estimated session
// spend so far is wrong and the seat may start work again. See
// schema.ts's licenses.sessionResetAt for how the planner uses it.
export async function resetSessionWindow(id: number, at = new Date()): Promise<License | null> {
  const [row] = await db.update(licenses).set({ sessionResetAt: at }).where(eq(licenses.id, id)).returning();
  return row ? rowToLicense(row) : null;
}
