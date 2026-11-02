import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectAllPages,
  MAX_CATALOG_PAGES,
} from "../apps/web/src/features/ws06-inventory/pages.ts";

// Review fix (legend-qdc): the back office filters whole catalogs in memory,
// so it must follow the cursor (D-CORE-5) instead of stopping at 100 rows.

const pageOf = (rows, nextCursor) => ({
  data: rows,
  meta: { limit: 2, nextCursor },
});

test("legend-qdc · D-CORE-5 catalog lists follow nextCursor to the last page", async () => {
  const pages = {
    start: pageOf([1, 2], "c1"),
    c1: pageOf([3, 4], "c2"),
    c2: pageOf([5], null),
  };
  const seen = [];
  const result = await collectAllPages(async (cursor) => {
    seen.push(cursor);
    return pages[cursor ?? "start"];
  });
  assert.deepEqual(seen, [undefined, "c1", "c2"]);
  assert.deepEqual(result.data, [1, 2, 3, 4, 5]);
  assert.equal(result.meta.nextCursor, null);
});

test("legend-qdc · D-CORE-5 a runaway cursor stops at the page cap", async () => {
  let calls = 0;
  await assert.rejects(
    collectAllPages(async () => {
      calls += 1;
      return pageOf([calls], "again");
    }, 3),
    /more than 3 pages/,
  );
  assert.equal(calls, 3);
  assert.equal(MAX_CATALOG_PAGES, 50);
});
