// HRIS requests data layer (539-U4 row A, legend-ydf2): queue normalisation,
// decision planning and the decision call. Like the other web data-layer
// suites it runs in the root node:test suite; `callEndpoint` is replaced by a
// fake that records the call, so there is no network and no framework.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const calls = [];
globalThis.__hrisRequestsFake = async (endpoint, input) => {
  calls.push({ endpoint, input });
  return { data: { id: "decided" } };
};

const FAKE_ENDPOINT_MODULE =
  "data:text/javascript," +
  encodeURIComponent(
    "export const callEndpoint = (...args) => globalThis.__hrisRequestsFake(...args);",
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

const {
  buildSwapCandidates,
  isFinalClientError,
  needsOverrideReason,
  pickOutletId,
  normalizeRequestQueue,
  OverrideReasonRequiredError,
  planDecision,
} = await import("../apps/web/src/features/hris-requests/queue.ts");
const { postDecision, fetchQueueSource } =
  await import("../apps/web/src/features/hris-requests/api.ts");

// Catalog stand-in: the key plus its variables, so a test sees what was asked.
const t = (key, vars) =>
  vars === undefined ? key : `${key}${JSON.stringify(vars)}`;

const ids = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const issue = {
  code: "insufficient_rest",
  employeeId: ids(1005),
  assignmentId: ids(7301),
  relatedAssignmentId: null,
  limit: 660,
  actual: 300,
};

function swap(n, over = {}) {
  return {
    id: ids(7400 + n),
    outletId: ids(1),
    fromAssignmentId: ids(7301),
    toAssignmentId: null,
    requestedBy: ids(1003),
    toEmployeeId: ids(1005),
    status: "pending",
    complianceIssues: [],
    overrideReason: null,
    approvedBy: null,
    requestedAt: "2026-10-25T01:00:00.000Z",
    decidedAt: null,
    ...over,
  };
}
const leave = {
  id: ids(8301),
  employeeId: ids(1004),
  leaveTypeId: ids(8101),
  startDate: "2026-10-25",
  endDate: "2026-10-27",
  days: "3.0000",
  status: "pending",
  requestedAt: "2026-10-26T01:00:00.000Z",
};
const overtime = {
  id: ids(8401),
  employeeId: ids(1008),
  date: "2026-10-30",
  minutes: 120,
  status: "approved",
  requestedAt: "2026-10-24T01:00:00.000Z",
};
const source = {
  swaps: [
    swap(1, { complianceIssues: [issue] }),
    swap(2, {
      toAssignmentId: ids(7302),
      requestedAt: "2026-10-27T01:00:00.000Z",
    }),
  ],
  leaves: [leave],
  overtimes: [overtime],
  employees: [
    { id: ids(1003), fullName: "Rina" },
    { id: ids(1004), fullName: "Dewi" },
  ],
  leaveTypes: [{ id: ids(8101), name: "Cuti tahunan" }],
  assignments: [
    { id: ids(7301), businessDate: "2026-11-02" },
    { id: ids(7302), businessDate: "2026-11-04" },
  ],
};

describe("normalizeRequestQueue", () => {
  test("one shape for all kinds, newest submission first", () => {
    const items = normalizeRequestQueue(source, t);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["swap", "leave", "cover", "overtime"],
    );
    const [first] = items;
    assert.equal(first.employeeName, "Rina");
    assert.equal(first.raw, source.swaps[1]);
  });

  test("swap and cover differ by toAssignmentId; period comes from the shifts", () => {
    const items = normalizeRequestQueue(source, t);
    const cover = items.find((item) => item.id === source.swaps[0].id);
    const exchange = items.find((item) => item.id === source.swaps[1].id);
    assert.equal(cover.kind, "cover");
    assert.equal(cover.period, "2026-11-02");
    assert.equal(exchange.kind, "swap");
    assert.match(exchange.period, /period\.range/);
    assert.match(exchange.period, /2026-11-02/);
    assert.match(exchange.period, /2026-11-04/);
  });

  test("leave title is the leave type name, period its date range", () => {
    const item = normalizeRequestQueue(source, t).find(
      (row) => row.kind === "leave",
    );
    assert.equal(item.title, "Cuti tahunan");
    assert.match(item.period, /2026-10-25/);
    assert.match(item.period, /2026-10-27/);
  });

  test("unknown employee and undated swap fall back to catalog text", () => {
    const [item] = normalizeRequestQueue(
      {
        ...source,
        swaps: [swap(3)],
        leaves: [],
        overtimes: [],
        employees: [],
        assignments: [],
      },
      t,
    );
    assert.equal(item.employeeName, "hrisRequestsCommon.unknownEmployee");
    assert.equal(item.period, "hrisRequestsCommon.period.unknown");
  });

  test("status filter keeps only that status", () => {
    const items = normalizeRequestQueue(source, t, { status: "approved" });
    assert.deepEqual(
      items.map((item) => item.kind),
      ["overtime"],
    );
  });
});

describe("planDecision", () => {
  const items = normalizeRequestQueue(source, t);
  const byId = (id) => items.find((item) => item.id === id);
  const withIssues = byId(source.swaps[0].id);
  const clean = byId(source.swaps[1].id);

  test("needsOverrideReason only for swaps with compliance issues", () => {
    assert.equal(needsOverrideReason(withIssues), true);
    assert.equal(needsOverrideReason(clean), false);
    assert.equal(needsOverrideReason(byId(leave.id)), false);
  });

  test("swap with issues: approve is an override and needs a reason", () => {
    assert.throws(
      () => planDecision(withIssues, "approve"),
      OverrideReasonRequiredError,
    );
    assert.throws(
      () => planDecision(withIssues, "approve", "   "),
      OverrideReasonRequiredError,
    );
    assert.deepEqual(planDecision(withIssues, "approve", "  Stok kurang  "), {
      kind: "swap",
      body: { action: "approve_with_override", overrideReason: "Stok kurang" },
    });
  });

  test("swap: rejection carries its reason", () => {
    assert.deepEqual(planDecision(clean, "approve", "tidak dipakai"), {
      kind: "swap",
      body: { action: "approve", overrideReason: null },
    });
    assert.deepEqual(planDecision(withIssues, "reject", "alasan"), {
      kind: "swap",
      body: {
        action: "reject",
        overrideReason: null,
        rejectionReason: "alasan",
      },
    });
  });

  test("leave rejection carries reason and approval does not", () => {
    assert.deepEqual(planDecision(byId(leave.id), "reject", "alasan"), {
      kind: "leave",
      body: { action: "reject", rejectionReason: "alasan" },
    });
    assert.deepEqual(planDecision(byId(overtime.id), "approve", "alasan"), {
      kind: "overtime",
      body: { action: "approve" },
    });
  });
});

describe("postDecision", () => {
  beforeEach(() => {
    calls.length = 0;
  });
  const items = normalizeRequestQueue(source, t);

  test("leave decision sends the rejection reason", async () => {
    const item = items.find((row) => row.kind === "leave");
    await postDecision(
      item,
      planDecision(item, "reject", "alasan"),
      "key-12345678",
    );
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].endpoint.path,
      "/api/hris/leave/requests/:leaveRequestId/decision",
    );
    assert.deepEqual(calls[0].input.params, { leaveRequestId: leave.id });
    assert.deepEqual(calls[0].input.body, {
      action: "reject",
      rejectionReason: "alasan",
      idempotencyKey: "key-12345678",
    });
  });

  test("swap override sends approve_with_override and the reason", async () => {
    const item = items.find((row) => row.id === source.swaps[0].id);
    await postDecision(
      item,
      planDecision(item, "approve", "Stok kurang"),
      "key-12345678",
    );
    assert.equal(
      calls[0].endpoint.path,
      "/api/hris/shift-swaps/:swapId/decision",
    );
    assert.deepEqual(calls[0].input.body, {
      action: "approve_with_override",
      overrideReason: "Stok kurang",
      idempotencyKey: "key-12345678",
    });
  });

  test("a plan of the wrong kind is refused before any call", async () => {
    const item = items.find((row) => row.kind === "leave");
    await assert.rejects(() =>
      postDecision(
        item,
        { kind: "overtime", body: { action: "approve" } },
        "key-12345678",
      ),
    );
    assert.equal(calls.length, 0);
  });
});

describe("buildSwapCandidates", () => {
  const employee = (n, name, status = "active") => ({
    id: ids(n),
    fullName: name,
    status,
  });
  const shift = (n, employeeId, businessDate, status = "published") => ({
    id: ids(n),
    employeeId,
    businessDate,
    status,
  });

  test("excludes me and inactive staff, sorts by name and by shift date", () => {
    const result = buildSwapCandidates({
      meId: ids(1003),
      employees: [
        employee(1003, "Rina"),
        employee(1005, "Budi"),
        employee(1004, "Agus"),
        employee(1006, "Cici", "suspended"),
      ],
      assignments: [
        shift(2, ids(1005), "2026-11-05"),
        shift(1, ids(1005), "2026-11-03"),
        shift(3, ids(1005), "2026-11-04", "draft"),
      ],
    });
    assert.deepEqual(
      result.map((row) => row.employeeName),
      ["Agus", "Budi"],
    );
    assert.deepEqual(result[0].assignments, []);
    assert.deepEqual(
      result[1].assignments.map((row) => row.businessDate),
      ["2026-11-03", "2026-11-05"],
    );
  });
});

describe("request attempt rules", () => {
  test("outlet comes from the payload, the employee's outlet only as fallback", () => {
    assert.equal(pickOutletId("outlet-shift", "outlet-home"), "outlet-shift");
    assert.equal(pickOutletId(undefined, "outlet-home"), "outlet-home");
    assert.equal(pickOutletId("", "outlet-home"), "outlet-home");
  });

  test("only 4xx drops the stored key; network failure and 5xx keep it", () => {
    assert.equal(isFinalClientError(409), true);
    assert.equal(isFinalClientError(400), true);
    assert.equal(isFinalClientError(0), false);
    assert.equal(isFinalClientError(500), false);
    assert.equal(isFinalClientError(503), false);
  });
});

test("Supervisor queue calls only the permitted swap endpoint", async () => {
  const previous = globalThis.__hrisRequestsFake;
  const seen = [];
  globalThis.__hrisRequestsFake = async (endpoint, input) => {
    seen.push({ endpoint, input });
    return { data: [], meta: { nextCursor: null } };
  };
  try {
    const result = await fetchQueueSource({
      outletId: ids(1),
      shiftsFrom: "2026-01-01",
      shiftsTo: "2026-02-01",
      permissions: ["hr.shift_swap.approve"],
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].endpoint.path, "/api/hris/shift-swaps");
    assert.equal(seen[0].input.query.outletId, ids(1));
    assert.deepEqual(result.leaves, []);
    assert.deepEqual(result.overtimes, []);
  } finally {
    globalThis.__hrisRequestsFake = previous;
  }
});
