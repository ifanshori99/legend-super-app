// What one roster publish sends, as the idempotency key sees it. The key must
// follow the draft content, not only outlet and week: after a lost response
// the manager may edit the drafts and publish again, and that is a different
// publication that must not replay the old one. Pure so Node tests cover it.
type DraftLike = { id: string; status: string };

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

export function publishAttemptPayload(input: {
  outletId: string;
  weekStart: string;
  rows: readonly DraftLike[];
}) {
  const drafts = input.rows
    .filter((row) => row.status === "draft")
    .map((row) => stable(row))
    .sort((left, right) =>
      (left as DraftLike).id.localeCompare((right as DraftLike).id),
    );
  return { outletId: input.outletId, weekStart: input.weekStart, drafts };
}
