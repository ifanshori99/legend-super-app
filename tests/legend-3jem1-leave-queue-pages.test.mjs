// fetchLeaveReviewItems (bead legend-3jem1, Codex 501 P2): the leave queue is
// filtered by the server (flagReason "leave_approved") and read until the API
// says there is no next page, never cut off after a fixed number of pages.
// Expected behaviour comes from docs/briefs/sub-3jem1-filter.md.
//
// apps/web has no vitest setup; like the other web data-layer suites this runs
// in the root node:test suite. `callEndpoint` (@/lib/api/endpoint) is replaced
// by a fake that serves scripted queue pages, so no network and no framework.
//
// Assumptions (the brief leaves these open):
//  - "Stops on a repeated cursor": when the server answers the same non-null
//    cursor it was just asked with, the loop ends instead of spinning, and the
//    rows read so far are returned.
//  - The client keeps filtering on the leave flag as defense: a page row
//    without the flag is dropped from the result.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const calls = [];
let script = () => {
  throw new Error("script not set");
};
globalThis.__leaveQueueFake = async (endpoint, input, options) => {
  calls.push({ endpoint, input, options });
  return script(input, endpoint);
};

const FAKE_ENDPOINT_MODULE =
  "data:text/javascript," +
  encodeURIComponent(
    "export const callEndpoint = (...args) => globalThis.__leaveQueueFake(...args);",
  );

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/api/endpoint")
      return {
        url: FAKE_ENDPOINT_MODULE,
        format: "module",
        shortCircuit: true,
      };
    if (specifier.startsWith("@/"))
      return nextResolve(
        pathToFileURL(resolve("apps/web/src", specifier.slice(2)) + ".ts").href,
        context,
      );
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { fetchLeaveReviewItems } =
  await import("../apps/web/src/features/hr-leave-clockin-review/api.ts");

const OUTLET = "10000000-0000-4000-8000-000000000001";

let sequence = 0;
function reviewItem(flagReasons = ["leave_approved"]) {
  sequence += 1;
  return {
    log: {
      id: `01JBQ7Z8K3M4N5P6Q7R8S9T${String(sequence).padStart(3, "0")}`,
      tenantId: "t",
      employeeId: "e1",
      outletId: OUTLET,
      type: "in",
      method: "selfie_geo",
      occurredAt: "2026-10-26T01:50:00.000Z",
    },
    source: "flagged",
    flagReasons,
    reviewStatus: "pending",
    reviewedBy: null,
  };
}

/** A fake queue: page i answers cursor "c<i>" and points at "c<i+1>", the last at null. */
function pagedQueue(pageCount, makeItem = () => reviewItem()) {
  const pages = Array.from({ length: pageCount }, () => [makeItem()]);
  return {
    pages,
    answer(input) {
      const cursor = input.query.cursor;
      const index = cursor === undefined ? 0 : Number(cursor.slice(1));
      return {
        data: pages[index],
        meta: { nextCursor: index + 1 < pageCount ? `c${index + 1}` : null },
      };
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  sequence = 0;
});

describe("3jem1: fetchLeaveReviewItems reads the leave queue from the server filter", () => {
  test("3jem1: asks the queue for flagReason leave_approved, with outlet, review status and page size", async () => {
    script = () => ({ data: [], meta: { nextCursor: null } });
    const items = await fetchLeaveReviewItems(OUTLET, "accepted");
    assert.deepEqual(items, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint.path, "/api/hris/attendance/review-queue");
    assert.deepEqual(calls[0].input.query, {
      outletId: OUTLET,
      reviewStatus: "accepted",
      flagReason: "leave_approved",
      limit: 100,
    });
  });

  test("3jem1: follows every cursor past 5 pages (7 pages, 7 rows) and stops at nextCursor null", async () => {
    const queue = pagedQueue(7);
    script = (input) => queue.answer(input);
    const items = await fetchLeaveReviewItems(OUTLET, "pending");
    assert.equal(calls.length, 7);
    assert.deepEqual(
      items.map((item) => item.log.id),
      queue.pages.flat().map((item) => item.log.id),
    );
    assert.deepEqual(
      calls.map((call) => call.input.query.cursor),
      [undefined, "c1", "c2", "c3", "c4", "c5", "c6"],
    );
    for (const call of calls)
      assert.equal(call.input.query.flagReason, "leave_approved");
  });

  test("3jem1: a single page with nextCursor null makes one call", async () => {
    const queue = pagedQueue(1);
    script = (input) => queue.answer(input);
    const items = await fetchLeaveReviewItems(OUTLET, "pending");
    assert.equal(calls.length, 1);
    assert.equal(items.length, 1);
  });

  test("3jem1: stops when the server repeats the cursor it was just given", async () => {
    // Page 1 -> cursor "same"; asking with "same" answers "same" again.
    script = () => ({
      data: [reviewItem()],
      meta: { nextCursor: "same" },
    });
    const items = await fetchLeaveReviewItems(OUTLET, "pending");
    assert.ok(calls.length <= 3, `looped ${calls.length} times`);
    assert.ok(items.length >= 1);
    assert.deepEqual(
      calls.slice(0, 2).map((call) => call.input.query.cursor),
      [undefined, "same"],
    );
  });

  test("3jem1: stops on a longer cursor cycle (A, B, A)", async () => {
    script = (input) => ({
      data: [reviewItem()],
      meta: { nextCursor: input.query.cursor === "A" ? "B" : "A" },
    });
    const items = await fetchLeaveReviewItems(OUTLET, "pending");
    assert.ok(calls.length <= 4, `looped ${calls.length} times`);
    assert.ok(items.length >= 1);
  });

  test("3jem1: still drops a row without the leave flag (client defense)", async () => {
    const leave = reviewItem();
    const other = reviewItem(["outside_geofence"]);
    script = () => ({ data: [other, leave], meta: { nextCursor: null } });
    const items = await fetchLeaveReviewItems(OUTLET, "pending");
    assert.deepEqual(
      items.map((item) => item.log.id),
      [leave.log.id],
    );
  });

  test("3jem1: passes the abort signal to every page call", async () => {
    const queue = pagedQueue(3);
    script = (input) => queue.answer(input);
    const controller = new AbortController();
    await fetchLeaveReviewItems(OUTLET, "pending", controller.signal);
    assert.equal(calls.length, 3);
    for (const call of calls)
      assert.equal(call.options.signal, controller.signal);
  });

  test("3jem1: a failing page rejects the read (the screen shows its error state)", async () => {
    let n = 0;
    script = () => {
      n += 1;
      if (n === 2) throw new Error("boom");
      return { data: [reviewItem()], meta: { nextCursor: "c1" } };
    };
    await assert.rejects(fetchLeaveReviewItems(OUTLET, "pending"), /boom/);
  });
});
