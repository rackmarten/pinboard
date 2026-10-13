// the task detail's Relations card groups related tasks under one
// heading per kind, read from this task's side ("Parent", "Blocks", ...). Pure
// so it can be unit-tested (relations.test.ts) away from the view.

export interface GroupableRelation {
  relationType: "parent" | "child" | "related" | "depends_on";
  direction: "from" | "to";
}

export interface RelationGroup<R> {
  label: string;
  relations: R[];
}

// Display order of the groups; also the full set of labels groupOf returns.
export const RELATION_GROUP_LABELS = ["Parent", "Children", "Depends on", "Blocks", "Related"] as const;

// What the other task is to this one. "from" rows read as stored (this task
// depends_on the other), "to" rows are the inverse, the same reading as
// api.ts's RELATION_INVERSE and the view's findParentId.
export function groupOf(r: GroupableRelation): (typeof RELATION_GROUP_LABELS)[number] {
  const from = r.direction === "from";
  switch (r.relationType) {
    case "parent":
      return from ? "Parent" : "Children";
    case "child":
      return from ? "Children" : "Parent";
    case "depends_on":
      return from ? "Depends on" : "Blocks";
    default:
      return "Related";
  }
}

/** Groups relations in RELATION_GROUP_LABELS order, dropping empty groups. */
export function groupRelations<R extends GroupableRelation>(relations: readonly R[]): RelationGroup<R>[] {
  return RELATION_GROUP_LABELS.map((label) => ({
    label,
    relations: relations.filter((r) => groupOf(r) === label),
  })).filter((g) => g.relations.length > 0);
}
