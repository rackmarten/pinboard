// Task list and dashboard grouping by phase, kept out of the views so it is
// testable without mounting them.
import { TASK_PHASES, type TaskCount, type TaskFilter, type TaskPhase } from "./api.js";

// Whether a task the server returned for these filters is listed. Done
// tasks are left out unless the Done phase or the done status is asked
// for, and rejected ones unless the exact-status filter names rejected:
// they stay in the database, just out of the way.
export function visibleInList(status: string, filter: Pick<TaskFilter, "status" | "phase">): boolean {
  if (filter.status?.includes(status)) return true;
  if (status === "rejected") return false;
  if (status === "done") return !!filter.phase?.includes("done");
  return true;
}

export interface PhaseGroup {
  phase: TaskPhase;
  count: number;
  // the statuses in it that have tasks, with their counts
  statuses: { status: string; count: number }[];
  byProject: { projectId: number; count: number }[];
}

// GET /tasks/counts rows summed per phase, in phase order, leaving out
// phases with no tasks and the ones listed in `skip`.
export function phaseGroups(counts: readonly TaskCount[], skip: readonly TaskPhase[] = []): PhaseGroup[] {
  return TASK_PHASES.filter((p) => !skip.includes(p))
    .map((phase) => {
      const rows = counts.filter((c) => c.phase === phase);
      const sum = (key: "status" | "projectId") => {
        const totals = new Map<string | number, number>();
        for (const r of rows) totals.set(r[key], (totals.get(r[key]) ?? 0) + r.count);
        return [...totals].sort((a, b) => b[1] - a[1]);
      };
      return {
        phase,
        count: rows.reduce((n, r) => n + r.count, 0),
        statuses: sum("status").map(([status, count]) => ({ status: status as string, count })),
        byProject: sum("projectId").map(([projectId, count]) => ({ projectId: projectId as number, count })),
      };
    })
    .filter((g) => g.count > 0);
}
