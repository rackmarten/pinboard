// Claude's short "session" limit is a 5-hour window that *opens*
// on the first billable action and runs for 5 hours, after which it simply
// ends - the next action taken after that opens a fresh window. It is not a
// trailing rolling sum, and it is not a fixed calendar grid: the boundaries
// are entirely determined by when money was actually spent.
//
// That makes the whole thing derivable from a plain time-ordered list of
// cost events (usage_events - see schema.ts on why that table exists), with
// no state to keep in sync and no writer that can get it wrong. Deriving
// rather than storing also means the full history comes back for free, so
// past windows are readable the moment this ships rather than only
// accumulating from now on.
//
// Everything here is pure on purpose: the DB read lives in plan.ts, so all
// the boundary reasoning is unit-testable without a database.

export const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

export interface CostEvent {
  occurredAt: Date;
  costUsd: number;
}

export interface SessionWindow {
  startsAt: Date;
  endsAt: Date;
  spentUsd: number;
  eventCount: number;
}

// Windows in chronological order. Input need not be sorted.
//
// A window covers [startsAt, startsAt + windowMs). An event exactly at a
// window's endsAt starts the next window rather than landing in the old one,
// matching the half-open interval - at that instant the previous window has
// already expired.
export function deriveSessionWindows(events: readonly CostEvent[], windowMs = SESSION_WINDOW_MS): SessionWindow[] {
  const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const windows: SessionWindow[] = [];

  for (const event of sorted) {
    const at = event.occurredAt.getTime();
    const current = windows[windows.length - 1];
    if (current && at < current.endsAt.getTime()) {
      current.spentUsd += event.costUsd;
      current.eventCount += 1;
      continue;
    }
    windows.push({
      startsAt: new Date(at),
      endsAt: new Date(at + windowMs),
      spentUsd: event.costUsd,
      eventCount: 1,
    });
  }

  return windows;
}

// The window currently open, or null when none is - i.e. when the last
// window has already expired, or nothing has ever been spent. A null here is
// not an error state: it means the next billable action is free to start and
// will open a new window at that moment.
export function openWindowAt(windows: readonly SessionWindow[], now: Date): SessionWindow | null {
  const last = windows[windows.length - 1];
  if (!last) return null;
  return now.getTime() < last.endsAt.getTime() ? last : null;
}

export interface SessionWindowState {
  // null when no window is open right now.
  open: SessionWindow | null;
  capUsd: number;
  // How much may still be spent before the session cap bites. With no window
  // open this is the full cap, since starting something opens a fresh one.
  remainingUsd: number;
  // When the open window expires and a fresh cap becomes available. null
  // when no window is open (nothing to wait for).
  resetsAt: Date | null;
  // True when the cap is spent but the window has not expired yet - the one
  // case where the right move is to wait rather than to run something
  // cheaper. The planner turns this into a `waitUntil`.
  exhausted: boolean;
}

// `reportedResetAt` is ground truth, everything else here is
// inference. The window boundary is normally derived as "first billable
// action + 5h", which is only ever an estimate of where Claude actually drew
// it; when a run fails with "You've hit your session limit - resets <time>
// (UTC)", Claude has told us the real boundary outright. A live report wins
// over the derivation, including the case the derivation gets most wrong -
// believing no window is open (because the last recorded cost event is more
// than 5h old) while the real one is still running. That happened on
// 2026-09-16: tasks #117 and #115 kept being started into an exhausted
// window, each burning its whole attempt cap on $0 failures.
export function sessionWindowState(
  windows: readonly SessionWindow[],
  capUsd: number,
  now: Date,
  reportedResetAt: Date | null = null,
): SessionWindowState {
  if (reportedResetAt && now.getTime() < reportedResetAt.getTime()) {
    const reported = openWindowAt(windows, now);
    return {
      // Keep the derived window's start (the only source for it) but take the
      // end from the report, so the plan timeline draws the real boundary.
      open: reported ? { ...reported, endsAt: reportedResetAt } : null,
      capUsd,
      remainingUsd: 0,
      resetsAt: reportedResetAt,
      exhausted: true,
    };
  }
  const open = openWindowAt(windows, now);
  if (!open) {
    return { open: null, capUsd, remainingUsd: capUsd, resetsAt: null, exhausted: false };
  }
  const remainingUsd = Math.max(0, capUsd - open.spentUsd);
  return {
    open,
    capUsd,
    remainingUsd,
    resetsAt: open.endsAt,
    exhausted: remainingUsd <= 0,
  };
}

// The window boundaries the plan should draw between `now` and `until`.
//
// The first slot is the real open window when there is one (so the plan's
// first card matches the actual cap the next task will be charged against);
// every slot after that is hypothetical, since a future window only truly
// opens when something is actually spent. Hypothetical slots are laid end to
// end from the previous one's expiry, which is what happens in practice when
// there is a queue deep enough to keep starting work.
//
// A final partial slot (one that would run past `until`) is kept and
// truncated rather than dropped - the time before the period ends is real
// and usable, it just holds less work.
export interface PlannedSlot {
  startsAt: Date;
  endsAt: Date;
  // False for the real, already-open window - its cap is partly spent.
  hypothetical: boolean;
  // Spend already charged to this slot. Only ever non-zero for the open one.
  spentUsd: number;
}

export function planSlots(
  state: SessionWindowState,
  now: Date,
  until: Date,
  windowMs = SESSION_WINDOW_MS,
): PlannedSlot[] {
  if (until.getTime() <= now.getTime()) return [];

  const slots: PlannedSlot[] = [];
  let cursor = now.getTime();

  if (state.open) {
    slots.push({
      startsAt: state.open.startsAt,
      endsAt: new Date(Math.min(state.open.endsAt.getTime(), until.getTime())),
      hypothetical: false,
      spentUsd: state.open.spentUsd,
    });
    cursor = state.open.endsAt.getTime();
  }

  while (cursor < until.getTime()) {
    slots.push({
      startsAt: new Date(cursor),
      endsAt: new Date(Math.min(cursor + windowMs, until.getTime())),
      hypothetical: true,
      spentUsd: 0,
    });
    cursor += windowMs;
  }

  return slots;
}
