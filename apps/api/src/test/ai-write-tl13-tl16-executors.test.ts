// TL-13 draft_purchase_order and TL-16 draft_shift_schedule write tools
// (bead legend-39d.3; PRD v1.7 §39 TL table, §40 AIG-03 and MCP-04). Fail-first:
// written from the PRD, docs/briefs/sub-ws12-ai.md and the shared contract
// (packages/shared/src/ai tool-io/tools), not from the handlers or executors.
// Real PostgreSQL and the real approval service, like ai-action-requests.test.ts:
// the worker is replaced by direct `settleActionRequest` calls. Targets are read
// through the owner connection (purchase_orders, shift_assignments).
//
// Before the engineer's work both tools refused with AI_TOOL_DISABLED, so every
// case that needs a receipt failed for the right reason (the tool was missing).
//
// Assumptions (the spec leaves these open):
// - Approver is an outlet manager of the outlet (the seeded ai_action policy,
//   migration 0116); the requester differs from the approver (MCP-04).
//   Requesters: `purchasing` (tenant) for TL-13; `hr` (tenant) or
//   `outlet_manager` (assigned outlet) for TL-16 (PRD role table).
// - Same permission as the manual screen: a kitchen lead holds no
//   purchasing.order.create, so TL-13 is refused for them even though the PRD
//   role table lists Kitchen lead (the narrower rule wins; decision for the
//   founder via the CTO).
// - TL-16 executes through the outlet's active shift templates with one
//   segment at the shift's times; the test creates them through the HRIS API.
// - An executed TL-13 creates exactly one purchase_orders row for the supplier
//   and outlet, subtotal_idr = sum(qty * unitCostIdr), whatever its status.
// - An executed TL-16 creates one shift_assignments row per proposed shift for
//   the employee on that business date (draft or published is left open).
// - A foreign-tenant id (supplier, item, employee) is refused either when the
//   request is proposed (AiError) or when it is executed (settle = "failed");
//   in both cases nothing is created in any tenant.
// - A requester who loses the role before execution gets settle = "failed"
//   with no PO or shift (re-check at execution, as for TL-18).
// - Catalog data an executor may need (suppliers, items, units) is plain rows:
//   uoms, inventory_items, suppliers, employees; no supplier price list.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actionRequestReceiptSchema,
  AiError,
  type ActionRequestToolCode,
} from "@starter/shared/ai";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { settleActionRequest } from "../services/ai-action-request.service.ts";
import { writeTools } from "../services/ai-tools/write/index.ts";
import type { AiToolContext } from "../services/ai-tools/types.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver.ts";
import {
  cleanupAcceptance,
  grantTemplateRole,
  originHeader,
  outletA,
  outletB,
  ownerPool,
  removeAssignments,
  signedIn,
  tenantId,
  type Actor,
} from "./ai-acceptance-helpers.ts";
import { createIsolatedTenant } from "./floor-test-helpers.ts";

const tenant = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const workerContext = establishScopedTenantContext(tenant, { kind: "tenant" });

async function ctxOf(actor: Actor): Promise<AiToolContext> {
  const data = await loadTenantAccess(workerContext, actor.userId);
  return {
    access: resolveAccessSnapshot({
      tenant,
      userId: actor.userId,
      ...data,
      mfaVerified: true,
      now: new Date(),
    }),
    channel: "tanya_ai",
    mcpClientId: null,
    now: new Date(),
  };
}

type Receipt = {
  actionRequestId: string;
  approvalRequestId: string;
  toolCode: ActionRequestToolCode;
  status: string;
};

async function propose(
  code: "TL-13" | "TL-16",
  actor: Actor,
  input: unknown,
): Promise<Receipt> {
  const handler = writeTools[code];
  if (!handler) throw new Error(`No handler for ${code}`);
  const receipt = actionRequestReceiptSchema.parse(
    await handler(await ctxOf(actor), input),
  );
  expect(receipt.toolCode).toBe(code);
  expect(receipt.status).toBe("pending");
  return receipt as Receipt;
}

async function decide(
  approver: Actor,
  approvalRequestId: string,
  decision: "approved" | "rejected",
) {
  const res = await approver.client
    .post(`/api/approvals/${approvalRequestId}/decisions`)
    .set(originHeader)
    .send({ decision, reason: "Uji executor TL-13/TL-16" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function eventCount(name: string, actionRequestId: string) {
  const { rows } = await ownerPool.query(
    `SELECT 1 FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = $3`,
    [tenantId, actionRequestId, name],
  );
  return rows.length;
}

// ---- catalog fixtures ------------------------------------------------------

type Catalog = {
  tenantId: string;
  outletId: string;
  supplierId: string;
  itemA: string;
  itemB: string;
  employees: string[];
};

async function seedCatalog(
  forTenant: string,
  outlet: string,
  createdBy: string,
  employeeCount: number,
): Promise<Catalog> {
  const uom = randomUUID();
  const supplierId = randomUUID();
  const itemA = randomUUID();
  const itemB = randomUUID();
  const employees = Array.from({ length: employeeCount }, () => randomUUID());
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [forTenant],
    );
    await client.query(
      `INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, $3, 'Kilogram')`,
      [uom, forTenant, `u${uom.slice(0, 8)}`],
    );
    for (const [id, name] of [
      [itemA, "Kopi Biji W13"],
      [itemB, "Gula W13"],
    ] as const)
      await client.query(
        `INSERT INTO inventory_items (id, tenant_id, name, category, base_uom_id, is_active)
         VALUES ($1, $2, $3, 'bahan', $4, true)`,
        [id, forTenant, name, uom],
      );
    await client.query(
      `INSERT INTO suppliers (id, tenant_id, name, payment_terms_days, created_by)
       VALUES ($1, $2, $3, 14, $4)`,
      // Unique per call: suppliers_tenant_lower_name_idx forbids a repeated name.
      [
        supplierId,
        forTenant,
        `Pemasok W13 ${randomUUID().slice(0, 8)}`,
        createdBy,
      ],
    );
    for (const id of employees)
      await client.query(
        `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status)
         VALUES ($1, $2, NULL, $3, 'Karyawan W16', $4, 'pkwtt', '2025-03-01', 'active')`,
        [id, forTenant, `W16-${id.slice(0, 8).toUpperCase()}`, outlet],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return {
    tenantId: forTenant,
    outletId: outlet,
    supplierId,
    itemA,
    itemB,
    employees,
  };
}

let own: Catalog;
let foreign: Catalog;
let approver: Actor;

beforeAll(async () => {
  approver = await signedIn("Manajer Penyetuju W13");
  await grantTemplateRole(approver.userId, "outlet_manager", {
    type: "outlet",
    id: outletA,
  });
  // Active single-segment shift templates the TL-16 executor maps shifts onto.
  const hr = await signedIn("HR Template W16");
  await grantTemplateRole(hr.userId, "hr", { type: "tenant" });
  for (const [name, startTime, endTime] of [
    ["W16 Pagi", "07:00", "15:00"],
    ["W16 Sore", "15:00", "23:00"],
  ] as const) {
    const res = await hr.client
      .post("/api/hris/shift-templates")
      .set(originHeader)
      .send({
        outletId: outletA,
        name: name,
        segments: [{ startTime, endTime }],
        breakMinutes: 60,
        stationId: null,
        positionId: null,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
  own = await seedCatalog(tenantId, outletA, approver.userId, 3);
  const other = await createIsolatedTenant(
    `w13${randomUUID().replaceAll("-", "").slice(0, 8)}`,
  );
  foreign = await seedCatalog(
    other.tenantId,
    other.outletId,
    approver.userId,
    1,
  );
}, 120_000);

afterAll(async () => {
  await cleanupAcceptance().catch(() => undefined);
  await ownerPool.end();
});

// ---- readers ---------------------------------------------------------------

async function purchaseOrders(forTenant: string, supplierId: string) {
  const { rows } = await ownerPool.query<{
    id: string;
    outlet_id: string;
    subtotal_idr: string | number;
    status: string;
  }>(
    `SELECT id, outlet_id, subtotal_idr, status FROM purchase_orders
      WHERE tenant_id = $1 AND supplier_id = $2`,
    [forTenant, supplierId],
  );
  return rows;
}

async function shiftRows(forTenant: string, employeeIds: string[]) {
  const { rows } = await ownerPool.query<{
    employee_id: string;
    business_date: string | Date;
  }>(
    `SELECT employee_id, business_date FROM shift_assignments
      WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])`,
    [forTenant, employeeIds],
  );
  return rows;
}

// ---- TL-13 -----------------------------------------------------------------

const poInput = (catalog: Catalog = own, supplierId = catalog.supplierId) => ({
  outletId: catalog.outletId,
  supplierId,
  lines: [
    {
      inventoryItemId: catalog.itemA,
      qty: "10.0000",
      unitCostIdr: "25000.0000",
    },
    {
      inventoryItemId: catalog.itemB,
      qty: "4.0000",
      unitCostIdr: "12500.0000",
    },
  ],
  note: "Uji executor TL-13",
});
const PO_SUBTOTAL = 10 * 25_000 + 4 * 12_500;

async function purchasingRequester(): Promise<Actor> {
  const actor = await signedIn("Purchasing W13");
  await grantTemplateRole(actor.userId, "purchasing", { type: "tenant" });
  return actor;
}

describe("TL-13 draft_purchase_order (AIG-03)", () => {
  it("proposing creates a pending request and no purchase order", async () => {
    const requester = await purchasingRequester();
    const receipt = await propose("TL-13", requester, poInput());
    expect(await purchaseOrders(tenantId, own.supplierId)).toHaveLength(0);
    // Chain still open: settling is a no-op.
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("pending");
    expect(await purchaseOrders(tenantId, own.supplierId)).toHaveLength(0);
  }, 60_000);

  it("after approval exactly one PO exists, however often execution is repeated", async () => {
    const catalog = await seedCatalog(tenantId, outletA, approver.userId, 0);
    const requester = await purchasingRequester();
    const receipt = await propose("TL-13", requester, poInput(catalog));
    await decide(approver, receipt.approvalRequestId, "approved");

    const results = await Promise.all([
      settleActionRequest(workerContext, receipt.actionRequestId),
      settleActionRequest(workerContext, receipt.actionRequestId),
    ]);
    expect(results).toEqual(["executed", "executed"]);
    for (let retry = 0; retry < 3; retry += 1)
      expect(
        await settleActionRequest(workerContext, receipt.actionRequestId),
      ).toBe("executed");

    const orders = await purchaseOrders(tenantId, catalog.supplierId);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.outlet_id).toBe(outletA);
    // Nobody is charged more than the lines add up to.
    expect(Number(orders[0]!.subtotal_idr)).toBe(PO_SUBTOTAL);
    expect(
      await eventCount("action_request.executed", receipt.actionRequestId),
    ).toBe(1);
  }, 90_000);

  it("a rejected request never creates a PO", async () => {
    const catalog = await seedCatalog(tenantId, outletA, approver.userId, 0);
    const requester = await purchasingRequester();
    const receipt = await propose("TL-13", requester, poInput(catalog));
    await decide(approver, receipt.approvalRequestId, "rejected");
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("rejected");
    expect(await purchaseOrders(tenantId, catalog.supplierId)).toHaveLength(0);
  }, 60_000);

  it("the requester cannot approve their own draft, so nothing is created", async () => {
    const catalog = await seedCatalog(tenantId, outletA, approver.userId, 0);
    const requester = await purchasingRequester();
    const receipt = await propose("TL-13", requester, poInput(catalog));
    const denied = await requester.client
      .post(`/api/approvals/${receipt.approvalRequestId}/decisions`)
      .set(originHeader)
      .send({ decision: "approved", reason: "Self approval attempt" });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("pending");
    expect(await purchaseOrders(tenantId, catalog.supplierId)).toHaveLength(0);
  }, 60_000);

  it("refuses a user without the purchasing or kitchen lead role", async () => {
    const nobody = await signedIn("Tanpa Peran W13");
    await expect(
      writeTools["TL-13"]!(await ctxOf(nobody), poInput()),
    ).rejects.toMatchObject({ code: "AI_TOOL_FORBIDDEN" });
    // A role that exists but does not cover purchasing.
    const marketing = await signedIn("Marketing W13");
    await grantTemplateRole(marketing.userId, "marketing", { type: "tenant" });
    await expect(
      writeTools["TL-13"]!(await ctxOf(marketing), poInput()),
    ).rejects.toMatchObject({ code: "AI_TOOL_FORBIDDEN" });
    expect(await purchaseOrders(tenantId, own.supplierId)).toHaveLength(0);
  });

  it("refuses an outlet outside a kitchen lead's assigned outlets", async () => {
    const lead = await signedIn("Kitchen Lead W13");
    await grantTemplateRole(lead.userId, "kitchen_lead", {
      type: "outlet",
      id: outletA,
    });
    await expect(
      writeTools["TL-13"]!(await ctxOf(lead), {
        ...poInput(),
        outletId: outletB,
      }),
    ).rejects.toMatchObject({ code: "AI_TOOL_FORBIDDEN" });
    expect(await purchaseOrders(tenantId, own.supplierId)).toHaveLength(0);
  });

  it("a kitchen lead is refused: no purchasing.order.create, same as the manual screen", async () => {
    const lead = await signedIn("Kitchen Lead Own W13");
    await grantTemplateRole(lead.userId, "kitchen_lead", {
      type: "outlet",
      id: outletA,
    });
    await expect(
      writeTools["TL-13"]!(await ctxOf(lead), poInput()),
    ).rejects.toMatchObject({ code: "AI_TOOL_FORBIDDEN" });
    expect(await purchaseOrders(tenantId, own.supplierId)).toHaveLength(0);
  });

  it("a supplier or item of another tenant creates nothing anywhere", async () => {
    const requester = await purchasingRequester();
    for (const input of [
      poInput(own, foreign.supplierId),
      {
        ...poInput(),
        lines: [
          {
            inventoryItemId: foreign.itemA,
            qty: "1.0000",
            unitCostIdr: "1000.0000",
          },
        ],
      },
    ]) {
      const attempt = await propose("TL-13", requester, input).catch(
        (e: unknown) => e,
      );
      if (attempt instanceof Error) {
        expect(attempt).toBeInstanceOf(AiError);
        continue;
      }
      const receipt = attempt as Receipt;
      await decide(approver, receipt.approvalRequestId, "approved");
      expect(
        await settleActionRequest(workerContext, receipt.actionRequestId),
      ).toBe("failed");
    }
    expect(await purchaseOrders(tenantId, foreign.supplierId)).toHaveLength(0);
    expect(
      await purchaseOrders(foreign.tenantId, foreign.supplierId),
    ).toHaveLength(0);
    expect(await purchaseOrders(tenantId, own.supplierId)).toHaveLength(0);
  }, 90_000);

  it("a requester who lost the role before execution gets no PO", async () => {
    const catalog = await seedCatalog(tenantId, outletA, approver.userId, 0);
    const requester = await purchasingRequester();
    const receipt = await propose("TL-13", requester, poInput(catalog));
    await decide(approver, receipt.approvalRequestId, "approved");
    await removeAssignments(requester.userId);
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("failed");
    expect(await purchaseOrders(tenantId, catalog.supplierId)).toHaveLength(0);
  }, 60_000);
});

// ---- TL-16 -----------------------------------------------------------------

/** First Monday of a far-future year, one year per call so weeks never collide. */
let yearCounter = 0;
function freshWeek(): { weekStart: string; day: (offset: number) => string } {
  yearCounter += 1;
  const date = new Date(Date.UTC(2070 + yearCounter, 0, 1));
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    weekStart: iso(date),
    day: (offset) => iso(new Date(date.getTime() + offset * 86_400_000)),
  };
}

function shiftInput(
  catalog: Catalog,
  week: ReturnType<typeof freshWeek>,
  employees: string[] = catalog.employees,
) {
  return {
    outletId: catalog.outletId,
    weekStart: week.weekStart,
    shifts: [
      {
        employeeId: employees[0]!,
        date: week.day(0),
        startTime: "07:00",
        endTime: "15:00",
      },
      {
        employeeId: employees[1] ?? employees[0]!,
        date: week.day(1),
        startTime: "15:00",
        endTime: "23:00",
      },
      {
        employeeId: employees[2] ?? employees[0]!,
        date: week.day(2),
        startTime: "07:00",
        endTime: "15:00",
      },
    ],
  };
}

async function hrRequester(): Promise<Actor> {
  const actor = await signedIn("HR W16");
  await grantTemplateRole(actor.userId, "hr", { type: "tenant" });
  return actor;
}

describe("TL-16 draft_shift_schedule (AIG-03)", () => {
  it("proposing creates a pending request and no shift", async () => {
    const week = freshWeek();
    const requester = await hrRequester();
    const receipt = await propose("TL-16", requester, shiftInput(own, week));
    expect(await shiftRows(tenantId, own.employees)).toHaveLength(0);
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("pending");
    expect(await shiftRows(tenantId, own.employees)).toHaveLength(0);
  }, 60_000);

  it("after approval each shift exists once, however often execution is repeated", async () => {
    const catalog = await seedCatalog(tenantId, outletA, approver.userId, 3);
    const week = freshWeek();
    const requester = await hrRequester();
    const input = shiftInput(catalog, week);
    const receipt = await propose("TL-16", requester, input);
    await decide(approver, receipt.approvalRequestId, "approved");

    const results = await Promise.all([
      settleActionRequest(workerContext, receipt.actionRequestId),
      settleActionRequest(workerContext, receipt.actionRequestId),
    ]);
    expect(results).toEqual(["executed", "executed"]);
    for (let retry = 0; retry < 3; retry += 1)
      expect(
        await settleActionRequest(workerContext, receipt.actionRequestId),
      ).toBe("executed");

    const rows = await shiftRows(tenantId, catalog.employees);
    expect(rows).toHaveLength(input.shifts.length);
    const pairs = rows.map(
      (row) =>
        `${row.employee_id}|${
          row.business_date instanceof Date
            ? // pg parses a DATE at local midnight: read local parts, not UTC.
              `${row.business_date.getFullYear()}-${String(row.business_date.getMonth() + 1).padStart(2, "0")}-${String(row.business_date.getDate()).padStart(2, "0")}`
            : String(row.business_date).slice(0, 10)
        }`,
    );
    expect(pairs.sort()).toEqual(
      input.shifts.map((s) => `${s.employeeId}|${s.date}`).sort(),
    );
    expect(
      await eventCount("action_request.executed", receipt.actionRequestId),
    ).toBe(1);
  }, 90_000);

  it("a rejected request never writes a schedule", async () => {
    const catalog = await seedCatalog(tenantId, outletA, approver.userId, 3);
    const requester = await hrRequester();
    const receipt = await propose(
      "TL-16",
      requester,
      shiftInput(catalog, freshWeek()),
    );
    await decide(approver, receipt.approvalRequestId, "rejected");
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("rejected");
    expect(await shiftRows(tenantId, catalog.employees)).toHaveLength(0);
  }, 60_000);

  it("the requester cannot approve their own draft, so nothing is written", async () => {
    const catalog = await seedCatalog(tenantId, outletA, approver.userId, 3);
    const requester = await hrRequester();
    const receipt = await propose(
      "TL-16",
      requester,
      shiftInput(catalog, freshWeek()),
    );
    const denied = await requester.client
      .post(`/api/approvals/${receipt.approvalRequestId}/decisions`)
      .set(originHeader)
      .send({ decision: "approved", reason: "Self approval attempt" });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("pending");
    expect(await shiftRows(tenantId, catalog.employees)).toHaveLength(0);
  }, 60_000);

  it("refuses a user without the HR or outlet manager role", async () => {
    const week = freshWeek();
    const nobody = await signedIn("Tanpa Peran W16");
    await expect(
      writeTools["TL-16"]!(await ctxOf(nobody), shiftInput(own, week)),
    ).rejects.toMatchObject({ code: "AI_TOOL_FORBIDDEN" });
    const kitchen = await signedIn("Kitchen Lead W16");
    await grantTemplateRole(kitchen.userId, "kitchen_lead", {
      type: "outlet",
      id: outletA,
    });
    await expect(
      writeTools["TL-16"]!(await ctxOf(kitchen), shiftInput(own, week)),
    ).rejects.toMatchObject({ code: "AI_TOOL_FORBIDDEN" });
    expect(await shiftRows(tenantId, own.employees)).toHaveLength(0);
  });

  it("refuses an outlet outside an outlet manager's assigned outlets", async () => {
    const manager = await signedIn("Manajer W16");
    await grantTemplateRole(manager.userId, "outlet_manager", {
      type: "outlet",
      id: outletA,
    });
    await expect(
      writeTools["TL-16"]!(await ctxOf(manager), {
        ...shiftInput(own, freshWeek()),
        outletId: outletB,
      }),
    ).rejects.toMatchObject({ code: "AI_TOOL_FORBIDDEN" });
    expect(await shiftRows(tenantId, own.employees)).toHaveLength(0);
  });

  it("an outlet manager may draft for their own outlet", async () => {
    const manager = await signedIn("Manajer Own W16");
    await grantTemplateRole(manager.userId, "outlet_manager", {
      type: "outlet",
      id: outletA,
    });
    const receipt = await propose(
      "TL-16",
      manager,
      shiftInput(own, freshWeek()),
    );
    expect(receipt.status).toBe("pending");
  }, 60_000);

  it("an employee of another tenant creates no shift in any tenant", async () => {
    const week = freshWeek();
    const requester = await hrRequester();
    const input = {
      outletId: outletA,
      weekStart: week.weekStart,
      shifts: [
        {
          employeeId: foreign.employees[0]!,
          date: week.day(0),
          startTime: "07:00",
          endTime: "15:00",
        },
      ],
    };
    const attempt = await propose("TL-16", requester, input).catch(
      (e: unknown) => e,
    );
    if (attempt instanceof Error) {
      expect(attempt).toBeInstanceOf(AiError);
    } else {
      const receipt = attempt as Receipt;
      await decide(approver, receipt.approvalRequestId, "approved");
      expect(
        await settleActionRequest(workerContext, receipt.actionRequestId),
      ).toBe("failed");
    }
    expect(await shiftRows(tenantId, foreign.employees)).toHaveLength(0);
    expect(await shiftRows(foreign.tenantId, foreign.employees)).toHaveLength(
      0,
    );
  }, 60_000);

  it("a requester who lost the role before execution writes no schedule", async () => {
    const catalog = await seedCatalog(tenantId, outletA, approver.userId, 3);
    const requester = await hrRequester();
    const receipt = await propose(
      "TL-16",
      requester,
      shiftInput(catalog, freshWeek()),
    );
    await decide(approver, receipt.approvalRequestId, "approved");
    await removeAssignments(requester.userId);
    expect(
      await settleActionRequest(workerContext, receipt.actionRequestId),
    ).toBe("failed");
    expect(await shiftRows(tenantId, catalog.employees)).toHaveLength(0);
  }, 60_000);
});
