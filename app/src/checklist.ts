// A handoff's review checklist and the reviewer's ticks on it. The items come
// from the latest handoff; ticks are stored per (task, item text), so a new
// handoff keeps every tick whose item text is unchanged and an item that
// left the list drops out of what is shown. Pure, so it is unit-tested
// without a database.

export const MAX_CHECKLIST_ITEMS = 50;
export const MAX_ITEM_LENGTH = 500;
export const MAX_NOTE_LENGTH = 500;

export type ChecklistTick = {
  item: string;
  checked: boolean;
  note: string | null;
  checkedAt: Date | null;
  checkedBy: string | null;
};

export type ChecklistItem = ChecklistTick;

function badRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// The handoff body's optional `checklist`: absent or null means none, so
// older clients keep working. Items are trimmed; blanks and repeats dropped.
export function parseChecklist(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw badRequest("checklist must be an array of strings");
  const items: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw badRequest("checklist must be an array of strings");
    const item = raw.trim();
    if (!item || items.includes(item)) continue;
    if (item.length > MAX_ITEM_LENGTH) throw badRequest(`checklist items are at most ${MAX_ITEM_LENGTH} characters`);
    items.push(item);
  }
  if (items.length > MAX_CHECKLIST_ITEMS) throw badRequest(`checklist has at most ${MAX_CHECKLIST_ITEMS} items`);
  return items.length ? items : null;
}

// The latest handoff's items, in its order, each with its stored tick or
// an unticked default.
export function mergeChecklist(items: readonly string[] | null | undefined, ticks: readonly ChecklistTick[]): ChecklistItem[] {
  const byItem = new Map(ticks.map((t) => [t.item, t]));
  return (items ?? []).map((item) => {
    const tick = byItem.get(item);
    return {
      item,
      checked: tick?.checked ?? false,
      note: tick?.note ?? null,
      checkedAt: tick?.checkedAt ?? null,
      checkedBy: tick?.checkedBy ?? null,
    };
  });
}

export type ChecklistPatch = { item: string; checked?: boolean; note?: string | null };

// PATCH /tasks/:id/checklist's body: which item, and a new checked state,
// note, or both. An empty note clears it.
export function parseChecklistPatch(body: Record<string, unknown>): ChecklistPatch {
  const item = typeof body.item === "string" ? body.item.trim() : "";
  if (!item) throw badRequest("item is required");
  const patch: ChecklistPatch = { item };
  if ("checked" in body) {
    if (typeof body.checked !== "boolean") throw badRequest("checked must be a boolean");
    patch.checked = body.checked;
  }
  if ("note" in body) {
    if (body.note !== null && typeof body.note !== "string") throw badRequest("note must be a string or null");
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > MAX_NOTE_LENGTH) throw badRequest(`note is at most ${MAX_NOTE_LENGTH} characters`);
    patch.note = note || null;
  }
  if (patch.checked === undefined && patch.note === undefined) throw badRequest("send checked, note, or both");
  return patch;
}
