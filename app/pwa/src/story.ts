// stories in the PWA - pure helpers for grouping a task list
// under its stories and ordering a story's children, kept out of the views
// so they can be unit-tested (story.test.ts).

export interface GroupableTask {
  id: number;
  taskType: string;
  status: string;
  priority: number;
  parentTaskId?: number | null;
}

export interface GroupedRow<T> {
  task: T;
  // 0 = top level (a story or an unparented task), 1 = child of a story.
  depth: 0 | 1;
  // Set on story rows: how many of its children are done, out of how many
  // (counted over every loaded child, not just the ones matching filters).
  progress?: { done: number; total: number };
  // Set on story rows: number of children shown under it after filtering.
  childCount?: number;
}

// Children count as finished the same way the backend's story auto-close does (#405).
export function isResolved(status: string): boolean {
  return status === "done" || status === "rejected";
}

/**
 * Flattens `visible` (already filtered and sorted) into rows where each
 * story's children follow it. `all` is every loaded task, used to count
 * progress and to pull in a story that is itself filtered out while one of
 * its children matches. Only children of a `story` parent are grouped - a
 * child of any other task type stays a top-level row, as before.
 */
export function groupTasks<T extends GroupableTask>(
  visible: T[],
  all: T[],
  collapsed: ReadonlySet<number> = new Set(),
): GroupedRow<T>[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  const storyOf = (t: T): number | null => {
    const p = t.parentTaskId != null ? byId.get(t.parentTaskId) : undefined;
    return p && p.taskType === "story" ? p.id : null;
  };

  const progress = new Map<number, { done: number; total: number }>();
  for (const t of all) {
    const s = storyOf(t);
    if (s == null) continue;
    const p = progress.get(s) ?? { done: 0, total: 0 };
    p.total += 1;
    if (isResolved(t.status)) p.done += 1;
    progress.set(s, p);
  }

  const visibleChildren = new Map<number, T[]>();
  const topLevel: T[] = [];
  const seenTop = new Set<number>();
  const addTop = (t: T): void => {
    if (seenTop.has(t.id)) return;
    seenTop.add(t.id);
    topLevel.push(t);
  };
  for (const t of visible) {
    const s = storyOf(t);
    if (s == null) {
      addTop(t);
      continue;
    }
    const list = visibleChildren.get(s) ?? [];
    list.push(t);
    visibleChildren.set(s, list);
    // A story stays visible when any of its children match, placed where
    // its first matching child would have been.
    addTop(byId.get(s)!);
  }

  const rows: GroupedRow<T>[] = [];
  for (const t of topLevel) {
    const children = visibleChildren.get(t.id) ?? [];
    const isStory = t.taskType === "story";
    rows.push({
      task: t,
      depth: 0,
      ...(isStory ? { progress: progress.get(t.id) ?? { done: 0, total: 0 }, childCount: children.length } : {}),
    });
    if (collapsed.has(t.id)) continue;
    for (const c of children) rows.push({ task: c, depth: 1 });
  }
  return rows;
}

function byPriority<T extends GroupableTask>(a: T, b: T): number {
  return b.priority - a.priority || a.id - b.id;
}

/**
 * Orders a story's children so every task comes after the siblings it
 * depends on (`dependsOn` maps a child id to the ids it depends on; ids
 * outside `children` are ignored), breaking ties by priority (higher first)
 * then id. A dependency cycle can't be ordered, so whatever is left once no
 * task is free falls back to plain priority order instead of looping.
 */
export function orderChildren<T extends GroupableTask>(children: T[], dependsOn: ReadonlyMap<number, number[]>): T[] {
  const ids = new Set(children.map((c) => c.id));
  const pending = new Map<number, Set<number>>();
  for (const c of children) {
    pending.set(c.id, new Set((dependsOn.get(c.id) ?? []).filter((d) => d !== c.id && ids.has(d))));
  }
  const remaining = [...children].sort(byPriority);
  const ordered: T[] = [];
  while (remaining.length) {
    const idx = remaining.findIndex((c) => pending.get(c.id)!.size === 0);
    if (idx === -1) {
      ordered.push(...remaining);
      break;
    }
    const [next] = remaining.splice(idx, 1);
    ordered.push(next);
    for (const deps of pending.values()) deps.delete(next.id);
  }
  return ordered;
}

// Ids a child is still blocked by: known depends_on targets the server says
// aren't satisfied yet (done/rejected, or review with every PR
// merged - the relations endpoint's otherTask.dependencySatisfied).
export function openBlockers(
  dependsOn: number[] | undefined,
  satisfiedOf: (id: number) => boolean | undefined,
): number[] {
  return (dependsOn ?? []).filter((id) => satisfiedOf(id) === false);
}
