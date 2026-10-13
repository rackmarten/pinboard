// weekly recurring budget periods per license (seat). Rollover is
// lazy: whenever the planner looks up the period covering `now` and finds
// none, ensureRecurringPeriod inserts the one that does, if the license has
// recurrence enabled. No timer.
//
// The anchor is always the license's latest period's endsAt, so a one-off end
// date set on the current period re-anchors every later week with no extra
// state. The step is exactly 7 days of UTC time (tracks Anthropic's weekly
// cycle; local clock time may shift an hour across DST, accepted).
//
// Same split as asks.ts: the rules run against a RecurrenceStore, so the tests
// use an in-memory one and dbRecurrenceStore is the only part that needs
// Postgres.

import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "./db/client.js";
import { budgetPeriods, licenses } from "./db/schema.js";

export const RECURRENCE_STEP_MS = 7 * 24 * 3_600_000;
export const RECURRENCE_NOTE = "auto (weekly recurrence)";

// The weekly period covering `now`, stepping +7d from `anchorEndsAt`. Only the
// one covering `now` is returned (fast-forward), not every skipped week. Null
// when the anchor is not in the past, i.e. there is nothing to roll over to.
// "Covers" matches getCurrentBudgetPeriod: startsAt < now <= endsAt.
export function nextRecurringPeriod(anchorEndsAt: Date, now: Date): { startsAt: Date; endsAt: Date } | null {
  const diff = now.getTime() - anchorEndsAt.getTime();
  if (diff <= 0) return null;
  const weeks = Math.ceil(diff / RECURRENCE_STEP_MS);
  const startsAt = new Date(anchorEndsAt.getTime() + (weeks - 1) * RECURRENCE_STEP_MS);
  return { startsAt, endsAt: new Date(startsAt.getTime() + RECURRENCE_STEP_MS) };
}

export interface RecurrenceSettings {
  enabled: boolean;
  budgetUsd: number | null;
}

export interface StoredPeriod {
  id: number;
  licenseId: number;
  startsAt: Date;
  endsAt: Date;
}

export interface RecurrenceTx {
  // Locks the license row for the rest of the transaction, so two concurrent
  // plan reads serialize here and the second one sees the first one's insert.
  lockLicense(licenseId: number): Promise<RecurrenceSettings | null>;
  coveringPeriod(licenseId: number, now: Date): Promise<StoredPeriod | null>;
  latestPeriod(licenseId: number): Promise<StoredPeriod | null>;
  insertPeriod(row: { licenseId: number; startsAt: Date; endsAt: Date; budgetUsd: number; note: string }): Promise<StoredPeriod>;
}

export interface RecurrenceStore {
  transaction<T>(fn: (tx: RecurrenceTx) => Promise<T>): Promise<T>;
}

// Returns the period it inserted, or null when nothing was needed or possible
// (a period already covers now, recurrence off, no amount, no anchor yet).
export async function ensureRecurringPeriod(store: RecurrenceStore, licenseId: number, now: Date): Promise<StoredPeriod | null> {
  return store.transaction(async (tx) => {
    const settings = await tx.lockLicense(licenseId);
    if (!settings?.enabled || settings.budgetUsd === null || !(settings.budgetUsd > 0)) return null;
    // Re-checked under the lock: a concurrent caller may have just inserted it.
    if (await tx.coveringPeriod(licenseId, now)) return null;
    const latest = await tx.latestPeriod(licenseId);
    if (!latest) return null;
    const next = nextRecurringPeriod(latest.endsAt, now);
    if (!next) return null;
    return tx.insertPeriod({ licenseId, ...next, budgetUsd: settings.budgetUsd, note: RECURRENCE_NOTE });
  });
}

function toPeriod(row: typeof budgetPeriods.$inferSelect): StoredPeriod {
  return { id: row.id, licenseId: row.licenseId, startsAt: row.startsAt, endsAt: row.endsAt };
}

export const dbRecurrenceStore: RecurrenceStore = {
  transaction: (fn) =>
    db.transaction(async (t) =>
      fn({
        async lockLicense(licenseId) {
          const [row] = await t
            .select({ enabled: licenses.recurrenceEnabled, budgetUsd: licenses.recurrenceBudgetUsd })
            .from(licenses)
            .where(eq(licenses.id, licenseId))
            .for("update");
          if (!row) return null;
          return { enabled: row.enabled, budgetUsd: row.budgetUsd !== null ? Number(row.budgetUsd) : null };
        },
        async coveringPeriod(licenseId, now) {
          const [row] = await t
            .select()
            .from(budgetPeriods)
            .where(and(eq(budgetPeriods.licenseId, licenseId), lt(budgetPeriods.startsAt, now), gte(budgetPeriods.endsAt, now)))
            .limit(1);
          return row ? toPeriod(row) : null;
        },
        async latestPeriod(licenseId) {
          const [row] = await t
            .select()
            .from(budgetPeriods)
            .where(eq(budgetPeriods.licenseId, licenseId))
            .orderBy(desc(budgetPeriods.endsAt))
            .limit(1);
          return row ? toPeriod(row) : null;
        },
        async insertPeriod(v) {
          const [row] = await t
            .insert(budgetPeriods)
            .values({ licenseId: v.licenseId, startsAt: v.startsAt, endsAt: v.endsAt, budgetUsd: String(v.budgetUsd), note: v.note })
            .returning();
          return toPeriod(row);
        },
      }),
    ),
};

// What GET /plan reports as period.recurrence. nextEndsAt is where the period
// after the latest one would end, i.e. the end of the next auto-created week;
// null when recurrence is off or there is no anchor yet.
export function describeRecurrence(
  settings: RecurrenceSettings,
  latestEndsAt: Date | null,
): { enabled: boolean; budgetUsd: number | null; nextEndsAt: string | null } {
  const nextEndsAt = settings.enabled && latestEndsAt ? new Date(latestEndsAt.getTime() + RECURRENCE_STEP_MS).toISOString() : null;
  return { enabled: settings.enabled, budgetUsd: settings.budgetUsd, nextEndsAt };
}

// PATCH /licenses/:id's recurrence fields. A blank amount (the PWA's cleared
// number field) means null. Enabling needs a positive amount, either in the
// same patch or already stored. Throws with a message for a 400.
export function validateRecurrencePatch(
  body: { recurrenceEnabled?: unknown; recurrenceBudgetUsd?: unknown },
  stored: { recurrenceEnabled: boolean; recurrenceBudgetUsd: number | null },
): { recurrenceEnabled?: boolean; recurrenceBudgetUsd?: number | null } {
  const out: { recurrenceEnabled?: boolean; recurrenceBudgetUsd?: number | null } = {};
  if (body.recurrenceBudgetUsd !== undefined) {
    const raw = body.recurrenceBudgetUsd;
    if (raw === null || raw === "") out.recurrenceBudgetUsd = null;
    else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw new Error("recurrenceBudgetUsd must be a positive number");
      out.recurrenceBudgetUsd = n;
    }
  }
  if (body.recurrenceEnabled !== undefined) {
    if (typeof body.recurrenceEnabled !== "boolean") throw new Error("recurrenceEnabled must be a boolean");
    out.recurrenceEnabled = body.recurrenceEnabled;
  }
  // Checked against the stored state too: clearing the amount while
  // recurrence stays on would leave a pattern that can never roll over.
  const enabled = out.recurrenceEnabled ?? stored.recurrenceEnabled;
  const amount = out.recurrenceBudgetUsd !== undefined ? out.recurrenceBudgetUsd : stored.recurrenceBudgetUsd;
  if (enabled && amount === null) throw new Error("recurrenceBudgetUsd must be a positive number while weekly recurrence is on");
  return out;
}
