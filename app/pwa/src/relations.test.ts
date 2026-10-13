import { describe, expect, it } from "vitest";
import { groupOf, groupRelations, type GroupableRelation } from "./relations.js";

function r(id: number, relationType: GroupableRelation["relationType"], direction: "from" | "to") {
  return { id, relationType, direction };
}

describe("groupOf", () => {
  it("reads each type and direction from this task's side", () => {
    expect(groupOf(r(1, "parent", "from"))).toBe("Parent");
    expect(groupOf(r(1, "parent", "to"))).toBe("Children");
    expect(groupOf(r(1, "child", "from"))).toBe("Children");
    expect(groupOf(r(1, "child", "to"))).toBe("Parent");
    expect(groupOf(r(1, "depends_on", "from"))).toBe("Depends on");
    expect(groupOf(r(1, "depends_on", "to"))).toBe("Blocks");
    expect(groupOf(r(1, "related", "from"))).toBe("Related");
    expect(groupOf(r(1, "related", "to"))).toBe("Related");
  });
});

describe("groupRelations", () => {
  it("groups in display order and drops empty groups", () => {
    const groups = groupRelations([
      r(1, "related", "to"),
      r(2, "depends_on", "from"),
      r(3, "child", "to"),
      r(4, "depends_on", "from"),
    ]);
    expect(groups.map((g) => [g.label, g.relations.map((x) => x.id)])).toEqual([
      ["Parent", [3]],
      ["Depends on", [2, 4]],
      ["Related", [1]],
    ]);
  });

  it("returns nothing for no relations", () => {
    expect(groupRelations([])).toEqual([]);
  });
});
