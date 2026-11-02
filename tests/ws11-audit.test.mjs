// WS-11 audit log viewer + settings hub (bead legend-max2; PRD v1.7 §3 F36
// "Audit Log Viewer", "Pengaturan"). Runs with the root node:test suite and no
// database: it loads the audit contract, the web app's mock runtime, the
// feature's local list endpoint and its pure rules with Node type stripping.
// The screens themselves are exercised in e2e/legend-max2.mock.spec.ts.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  AUDIT_REDACTED,
  auditEventSchema,
} from "../packages/shared/src/audit/index.ts";
import { messagesId } from "../packages/shared/src/i18n/index.ts";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import "../apps/web/src/features/ws11-audit/mock.ts";
import { mockAuditEvents } from "../apps/web/src/features/ws11-audit/mock.ts";
import { listAuditEventsEndpoint } from "../apps/web/src/features/ws11-audit/contract.ts";
import * as lib from "../apps/web/src/features/ws11-audit/lib.ts";
import {
  HUB_ITEMS,
  groupAvailable,
} from "../apps/web/src/features/ws11-audit/hub.ts";

const list = (query) =>
  dispatchMock({ method: "GET", path: "/api/audit/events", query });

afterEach(() => {
  setScenario("normal");
  resetMocks();
});

describe("AUDIT-VIEW-01 list and filters", () => {
  test("AUDIT-VIEW-01: the list endpoint is GET /api/audit/events and the mock serves it", async () => {
    assert.equal(listAuditEventsEndpoint.id, "GET /api/audit/events");
    const page = await list({ limit: "10" });
    assert.equal(page.data.length, 10);
    assert.ok(page.meta.nextCursor);
    for (const row of page.data) auditEventSchema.parse(row.event);
  });

  test("AUDIT-VIEW-01: every actor kind appears (user, AI, MCP, system, device)", () => {
    const kinds = new Set(mockAuditEvents.map((row) => row.event.actorType));
    assert.deepEqual([...kinds].sort(), [
      "ai",
      "device",
      "mcp_client",
      "system",
      "user",
    ]);
  });

  test("AUDIT-VIEW-01: cursor pagination walks every row exactly once", async () => {
    const seen = [];
    let cursor;
    do {
      const page = await list({ limit: "20", ...(cursor ? { cursor } : {}) });
      seen.push(...page.data.map((row) => row.event.id));
      cursor = page.meta.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(seen.length, mockAuditEvents.length);
    assert.equal(new Set(seen).size, seen.length);
  });

  test("AUDIT-VIEW-01: filters by actor kind, module, action, outlet and date range", async () => {
    const ai = await list({ actorType: "ai", limit: "100" });
    assert.ok(ai.data.length > 0);
    assert.ok(ai.data.every((row) => row.event.actorType === "ai"));

    const price = await list({ objectType: "price", limit: "100" });
    assert.ok(price.data.every((row) => row.event.objectType === "price"));

    const action = await list({ action: "order.voided", limit: "100" });
    assert.ok(action.data.length > 0);
    assert.ok(action.data.every((row) => row.event.action === "order.voided"));

    const outletId = mockAuditEvents.find((row) => row.event.outletId)?.event
      .outletId;
    const byOutlet = await list({ outletId, limit: "100" });
    assert.ok(byOutlet.data.every((row) => row.event.outletId === outletId));

    const newestDay = lib
      .formatWhen(mockAuditEvents[0].event.createdAt, "Asia/Jakarta")
      .split(",")[0];
    const day = await list({
      from: "2026-11-02",
      to: "2026-11-02",
      limit: "100",
    });
    assert.ok(day.data.length > 0, newestDay);
    assert.ok(day.data.length < mockAuditEvents.length);
  });

  test("AUDIT-VIEW-01: a reversed date range is rejected like the real API", async () => {
    await assert.rejects(() => list({ from: "2026-11-03", to: "2026-11-01" }));
    assert.deepEqual(
      lib.filterIssues({
        ...lib.EMPTY_FILTERS,
        from: "2026-11-03",
        to: "2026-11-01",
      }),
      ["invalidRange"],
    );
    assert.deepEqual(
      lib.filterIssues({ ...lib.EMPTY_FILTERS, action: "Role Updated" }),
      ["invalidAction"],
    );
  });

  test("AUDIT-VIEW-01: the wire query leaves empty filters out", () => {
    assert.deepEqual(lib.toQuery(lib.EMPTY_FILTERS), {
      limit: lib.AUDIT_PAGE_SIZE,
    });
    assert.deepEqual(
      lib.toQuery(
        { ...lib.EMPTY_FILTERS, actorType: "mcp_client", action: " a.b " },
        "c1",
      ),
      {
        limit: lib.AUDIT_PAGE_SIZE,
        cursor: "c1",
        actorType: "mcp_client",
        action: "a.b",
      },
    );
  });
});

describe("AUDIT-VIEW-02 states", () => {
  test("AUDIT-VIEW-02: ?mock=empty returns an empty last page", async () => {
    setScenario("empty");
    const page = await list({ limit: "25" });
    assert.deepEqual(page.data, []);
    assert.equal(page.meta.nextCursor, null);
  });

  test("AUDIT-VIEW-02: ?mock=error fails the call so the screen shows its error state", async () => {
    setScenario("error");
    await assert.rejects(() => list({ limit: "25" }));
  });
});

describe("AUDIT-VIEW-03 masking, time and IP", () => {
  test("AUDIT-VIEW-03: personal fields in the mock rows are masked by the contract", () => {
    const row = mockAuditEvents.find(
      (view) => view.event.action === "role.assigned",
    );
    assert.equal(row.event.maskedChanges.after.phone, AUDIT_REDACTED);
    assert.equal(row.event.maskedChanges.after.roleCode, "outlet_manager");
  });

  test("AUDIT-VIEW-03: the display layer redacts a sensitive field even if a row slipped one through", () => {
    const rows = lib.diffRows({
      before: { phone: "0812", status: "old" },
      after: { email: "a@b.id", status: "new", nested: { token: "x", ok: 1 } },
    });
    const byField = Object.fromEntries(rows.map((row) => [row.field, row]));
    assert.equal(byField.phone.before, AUDIT_REDACTED);
    assert.equal(byField.email.after, AUDIT_REDACTED);
    assert.equal(byField.status.after, "new");
    assert.ok(!JSON.stringify(rows).includes("0812"));
    assert.ok(!JSON.stringify(rows).includes("a@b.id"));
    assert.ok(byField.nested.after.includes(AUDIT_REDACTED));
  });

  test("AUDIT-VIEW-03: only a short prefix of the keyed IP hash is shown, never an address", () => {
    const row = mockAuditEvents.find((view) => view.event.ipHash);
    const trace = lib.ipTrace(row.event.ipHash);
    assert.equal(trace.length, 8);
    assert.ok(row.event.ipHash.startsWith(trace));
    assert.equal(lib.ipTrace(null), null);
  });

  test("AUDIT-VIEW-03: time renders in the outlet time zone (WIB, UTC+7)", () => {
    assert.match(
      lib.formatWhen("2026-11-01T22:30:00.000Z", "Asia/Jakarta"),
      /2 Nov 2026.*05[.:]30/,
    );
    assert.match(
      lib.formatWhen("2026-11-01T22:30:00.000Z", "Asia/Makassar"),
      /06[.:]30/,
    );
    assert.equal(
      lib.retainedUntil("2026-11-01T05:12:00.000Z").slice(0, 10),
      "2028-11-01",
    );
  });
});

describe("SETTINGS-HUB-01 settings hub", () => {
  test("SETTINGS-HUB-01: groups by tenant, brand and outlet and hides screens that do not exist", () => {
    const groups = groupAvailable(HUB_ITEMS, (path) =>
      ["/audit", "/kelola/menu", "/kelola/meja"].includes(path),
    );
    assert.deepEqual(
      groups.map((group) => [
        group.scope,
        group.items.map((entry) => entry.to),
      ]),
      [
        ["tenant", ["/audit"]],
        ["brand", ["/kelola/menu"]],
        ["outlet", ["/kelola/meja"]],
      ],
    );
    assert.deepEqual(
      groupAvailable(HUB_ITEMS, () => false),
      [],
    );
  });

  test("SETTINGS-HUB-01: every hub card has catalog text (no hardcoded labels)", () => {
    for (const entry of HUB_ITEMS) {
      const name = entry.nameKey
        .split(".")
        .reduce((node, part) => node?.[part], messagesId);
      const hint = entry.hintKey
        .split(".")
        .reduce((node, part) => node?.[part], messagesId);
      assert.equal(typeof name, "string", entry.nameKey);
      assert.equal(typeof hint, "string", entry.hintKey);
    }
  });

  test("SETTINGS-HUB-01: the audit viewer sits at exactly /audit (dashboards link there)", () => {
    assert.ok(HUB_ITEMS.some((entry) => entry.to === "/audit"));
  });
});
