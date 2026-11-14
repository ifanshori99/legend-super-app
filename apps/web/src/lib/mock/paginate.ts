import {
  decodeCursor,
  encodeCursor,
  type CursorPage,
} from "@starter/shared/core";
import { ApiError } from "../api/errors.ts";
import type { MockScenario } from "./control.ts";

/**
 * Cursor-paginates a fixture array the way the real API does (D-CORE-5): the
 * cursor is opaque and encodes the id of the last row returned. The "empty"
 * scenario returns an empty last page.
 */
export function paginateFixture<T>(
  items: readonly T[],
  query: { cursor?: string; limit: number },
  idOf: (item: T) => string,
  scenario: MockScenario = "normal",
): CursorPage<T> {
  if (scenario === "empty" || scenario === "wa-unverified-empty")
    return { data: [], meta: { limit: query.limit, nextCursor: null } };
  let start = 0;
  if (query.cursor !== undefined) {
    let lastId: unknown;
    try {
      lastId = decodeCursor(query.cursor)[0];
    } catch {
      throw new ApiError(400, "VALIDATION_ERROR", "Cursor tidak valid.", [
        { field: "cursor", message: "Cursor tidak valid." },
      ]);
    }
    const index = items.findIndex((item) => idOf(item) === lastId);
    if (index === -1)
      throw new ApiError(400, "VALIDATION_ERROR", "Cursor tidak valid.", [
        { field: "cursor", message: "Cursor tidak dikenal." },
      ]);
    start = index + 1;
  }
  const data = items.slice(start, start + query.limit);
  const last = data.at(-1);
  const hasMore = start + data.length < items.length;
  return {
    data,
    meta: {
      limit: query.limit,
      nextCursor: hasMore && last ? encodeCursor([idOf(last)]) : null,
    },
  };
}
