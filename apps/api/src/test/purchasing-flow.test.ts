// Purchase request -> purchase order -> approval flow (PRD v1.7 §3.18, §3.7
// "Matriks Approval", §4 Alur I; bead legend-9yz slice D). Needs the
// disposable PostgreSQL database; the migration owner seeds fixtures, the
// restricted legend_app login checks RLS, and the services run as the
// runtime role under real role assignments.
//
// Acceptance ids used in test names:
// - 9yz-FLOW-1 happy path PR -> PO -> approved, integer IDR totals, events
// - 9yz-FLOW-2 self-approval refused (409 with the contract code)
// - 9yz-FLOW-3 reject PR needs a note; PO reject returns to draft
// - 9yz-FLOW-4 matrix chain: module approve refused, consumer applies outcome
// - 9yz-FLOW-5 PR estimate from supplier prices tiers the matrix
// - 9yz-FLOW-6 idempotency, draft-only update, stale expectedUpdatedAt
// - 9yz-ISO-2 tenant and outlet isolation
// - 25a7-PO-1 updatedAt on the order DTO is the PATCH precondition
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { approvalResolvedEvent } from "@starter/shared/identity";
import { purchaseOrderLineTotalIdr } from "@starter/shared/inventory";
import { setAuditWriter } from "../services/audit-writer.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import { handlePurchasingApprovalResolved } from "../services/purchasing-approval-consumer.ts";
import {
  getPublicPurchaseOrderPdf,
  purchaseOrderLinkTokenHash,
} from "../services/purchasing-send.service.ts";
import {
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  transitionPurchaseOrderStatus,
  updatePurchaseOrder,
} from "../services/purchasing-order.service.ts";
import {
  createPurchaseRequest,
  getPurchaseRequest,
  listPurchaseRequests,
  transitionPurchaseRequestStatus,
} from "../services/purchasing-request.service.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletB = cafeLegendPlatformFixtures.outlets[1]!.id;
const tenantB = randomUUID();
const POLICY_ACTIONS = ["purchase_order", "purchase_request"];

const app = createApp();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});

const createdUserIds: string[] = [];
const createdItemIds: string[] = [];
const createdUomIds: string[] = [];
const createdSupplierIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];

const tenant = establishTenantContext({
  tenantId: tenantA,
  brandId: null,
  source: "domain",
});

function tenantContext(
  outletIds: readonly string[] | null = null,
): ScopedTenantContext {
  return establishScopedTenantContext(
    tenant,
    outletIds === null
      ? { kind: "tenant" }
      : {
          kind: "outlets",
          outletIds: outletIds.map(
            (id) => outletIdSchema.parse(id) as OutletId,
          ),
        },
  );
}

async function asTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    return await run(client as unknown as Client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function failure(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => null,
    (caught: unknown) => caught,
  );
}

async function rejectsWith(
  run: Promise<unknown>,
  expected: { status?: number; code: string },
): Promise<void> {
  const error = (await failure(run)) as {
    status?: number;
    code?: string;
  } | null;
  expect(error).not.toBeNull();
  expect(error?.code).toBe(expected.code);
  if (expected.status !== undefined)
    expect(error?.status).toBe(expected.status);
}

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant ${tenantA}`);
  return rows[0].id;
}

type Grant = { role: string; outletId: string | null };

async function grantRoles(userId: string, grants: Grant[]): Promise<void> {
  for (const grant of grants)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenantA,
        userId,
        await roleIdOf(grant.role),
        grant.outletId === null ? "tenant" : "outlet",
        grant.outletId,
      ],
    );
}

async function newUser(label: string, grants: Grant[]): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, `Purchasing ${label}`, `${id}@example.com`],
  );
  createdUserIds.push(id);
  await grantRoles(id, grants);
  return id;
}

/** A real session user (cookie agent) holding `grants`. */
async function signedIn(name: string, grants: Grant[]) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  await grantRoles(userId, grants);
  return { client, userId };
}

async function resetPolicies(): Promise<void> {
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])",
    [tenantA, POLICY_ACTIONS],
  );
}

async function setPolicy(
  actionType: string,
  thresholdIdr: number | null,
  level = 1,
): Promise<void> {
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      tenantA,
      actionType,
      thresholdIdr,
      await roleIdOf("general_manager"),
      level,
    ],
  );
}

async function insertUom(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
  );
  createdUomIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function insertItem(baseUomId: string, name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id",
    [tenantA, `${name} ${randomUUID().slice(0, 6)}`, baseUomId],
  );
  createdItemIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function insertSupplier(name: string, isActive = true): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO suppliers (tenant_id, name, payment_terms_days, is_active, created_by)
     VALUES ($1, $2, 30, $3, $4) RETURNING id`,
    [tenantA, `${name} ${randomUUID().slice(0, 6)}`, isActive, requester],
  );
  createdSupplierIds.push(rows[0]!.id);
  return rows[0]!.id;
}

let requester: string;
let purchaser: string;
let approver: string;
let approver2: string;
let selfApprover: string;
let outsiderB: string;
let uomKg: string;
let itemFlour: string;
let itemSugar: string;
let supplier: string;

const key = () => `k-${randomUUID()}`;

function prInput(overrides: Record<string, unknown> = {}) {
  return {
    outletId: outletA,
    neededBy: "2026-12-01",
    lines: [{ inventoryItemId: itemFlour, quantity: "2.5000", uomId: uomKg }],
    note: "Stok tipis",
    idempotencyKey: key(),
    ...overrides,
  } as never;
}

function poInput(overrides: Record<string, unknown> = {}) {
  return {
    outletId: outletA,
    supplierId: supplier,
    purchaseRequestId: null,
    expectedDate: "2026-12-02",
    source: "ai",
    lines: [
      {
        inventoryItemId: itemFlour,
        quantity: "2.5000",
        uomId: uomKg,
        unitPriceIdr: "10000.0000",
      },
      {
        inventoryItemId: itemSugar,
        quantity: "1.3333",
        uomId: uomKg,
        unitPriceIdr: "7500.0000",
      },
    ],
    note: null,
    idempotencyKey: key(),
    ...overrides,
  } as never;
}

const act = (action: string, note?: string) =>
  ({ action, note: note ?? null, idempotencyKey: key() }) as never;

async function pendingPo(creator = purchaser) {
  const detail = await createPurchaseOrder(tenantContext(), creator, poInput());
  const id = detail.purchaseOrder.id as string;
  await transitionPurchaseOrderStatus(
    tenantContext(),
    creator,
    id,
    act("submit"),
  );
  return id;
}

async function poRow(id: string) {
  const { rows } = await owner.query(
    "SELECT * FROM purchase_orders WHERE id = $1",
    [id],
  );
  return rows[0] as Record<string, unknown>;
}

async function eventsOf(aggregateId: string, name: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = $3`,
    [tenantA, aggregateId, name],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter({ record: async () => {} });
  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])",
      [tenantA, POLICY_ACTIONS],
    )
  ).rows;
  await resetPolicies();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Purchasing Flow Tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `purch-flow-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  requester = await newUser("requester", [
    { role: "kitchen_lead", outletId: outletA },
  ]);
  purchaser = await newUser("purchaser", [
    { role: "purchasing", outletId: outletA },
  ]);
  approver = await newUser("approver", [
    { role: "general_manager", outletId: null },
  ]);
  approver2 = await newUser("approver two", [
    { role: "general_manager", outletId: null },
  ]);
  selfApprover = await newUser("self", [
    { role: "purchasing", outletId: outletA },
    { role: "general_manager", outletId: null },
  ]);
  outsiderB = await newUser("outsider", [
    { role: "kitchen_lead", outletId: outletB },
    { role: "purchasing", outletId: outletB },
  ]);
  uomKg = await insertUom("kg");
  itemFlour = await insertItem(uomKg, "Tepung Flow");
  itemSugar = await insertItem(uomKg, "Gula Flow");
  supplier = await insertSupplier("Supplier Flow");
});

afterAll(async () => {
  const tables = [
    "purchase_order_share_links",
    "purchase_order_lines",
    "purchase_orders",
    "purchase_request_lines",
    "purchase_requests",
    "purchasing_idempotency",
    "supplier_prices",
  ];
  for (const table of tables)
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantA]);
  await owner.query(
    "DELETE FROM purchasing_document_sequences WHERE tenant_id = $1",
    [tenantA],
  );
  await owner.query("DELETE FROM suppliers WHERE id = ANY($1::uuid[])", [
    createdSupplierIds,
  ]);
  await owner.query(
    "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])",
    [tenantA, createdUserIds],
  );
  await resetPolicies();
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
    );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantA, createdUserIds],
  );
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUserIds,
  ]);
  await owner.query("DELETE FROM inventory_items WHERE id = ANY($1::uuid[])", [
    createdItemIds,
  ]);
  await owner.query("DELETE FROM uoms WHERE id = ANY($1::uuid[])", [
    createdUomIds,
  ]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.end();
  await appPool.end();
});

describe("9yz-FLOW purchase request and order flow", () => {
  it("[9yz-FLOW-1] PR draft -> submit -> approve -> PO from PR -> PR converted -> PO approved with integer IDR totals", async () => {
    const created = await createPurchaseRequest(
      tenantContext(),
      requester,
      prInput(),
    );
    const prId = created.request.id as string;
    expect(created.request.status).toBe("draft");
    expect(created.lines).toHaveLength(1);

    const submitted = await transitionPurchaseRequestStatus(
      tenantContext(),
      requester,
      prId,
      act("submit"),
    );
    expect(submitted.status).toBe("pending_approval");
    const approved = await transitionPurchaseRequestStatus(
      tenantContext(),
      approver,
      prId,
      act("approve"),
    );
    expect(approved).toMatchObject({ status: "approved", decidedBy: approver });

    const po = await createPurchaseOrder(
      tenantContext(),
      purchaser,
      poInput({ purchaseRequestId: prId }),
    );
    expect(po.purchaseOrder.number).toMatch(/^PO\/\d{6}\/\d{4}$/);
    // The client-declared source is overwritten from the actor.
    expect(po.purchaseOrder.source).toBe("user");
    expect(po.purchaseOrder.purchaseRequestId).toBe(prId);
    const lineTotals = [
      purchaseOrderLineTotalIdr(
        "2.5000" as never,
        "10000.0000" as never,
        "half_up",
      ),
      purchaseOrderLineTotalIdr(
        "1.3333" as never,
        "7500.0000" as never,
        "half_up",
      ),
    ];
    expect(lineTotals).toEqual([25000, 10000]);
    expect(po.lines.map((line) => line.lineTotalIdr)).toEqual(lineTotals);
    expect(po.purchaseOrder).toMatchObject({
      subtotalIdr: 35000,
      taxIdr: 0,
      totalIdr: 35000,
      status: "draft",
    });
    expect(
      (await getPurchaseRequest(tenantContext(), approver, prId)).request
        .status,
    ).toBe("converted");

    const poId = po.purchaseOrder.id as string;
    expect(await eventsOf(poId, "purchase_order.created")).toBe(1);
    const submittedPo = await transitionPurchaseOrderStatus(
      tenantContext(),
      purchaser,
      poId,
      act("submit"),
    );
    expect(submittedPo.status).toBe("pending_approval");
    const approvedPo = await transitionPurchaseOrderStatus(
      tenantContext(),
      approver,
      poId,
      act("approve"),
    );
    expect(approvedPo).toMatchObject({
      status: "approved",
      approvedBy: approver,
      totalIdr: 35000,
    });
    expect(await eventsOf(poId, "purchase_order.approved")).toBe(1);

    // A second PO number of the same month increments the counter.
    const second = await createPurchaseOrder(
      tenantContext(),
      purchaser,
      poInput(),
    );
    const seq = (n: string) => Number(n.split("/")[2]);
    expect(seq(second.purchaseOrder.number)).toBe(
      seq(po.purchaseOrder.number) + 1,
    );
  });

  it("[9yz-FLOW-2] self-approval of a PR and a PO is refused with the contract code", async () => {
    const pr = await createPurchaseRequest(
      tenantContext(),
      selfApprover,
      prInput(),
    );
    const prId = pr.request.id as string;
    await transitionPurchaseRequestStatus(
      tenantContext(),
      selfApprover,
      prId,
      act("submit"),
    );
    await rejectsWith(
      transitionPurchaseRequestStatus(
        tenantContext(),
        selfApprover,
        prId,
        act("approve"),
      ),
      { status: 409, code: "PURCHASE_REQUEST_SELF_APPROVAL" },
    );
    const poId = await pendingPo(selfApprover);
    await rejectsWith(
      transitionPurchaseOrderStatus(
        tenantContext(),
        selfApprover,
        poId,
        act("approve"),
      ),
      { status: 409, code: "PURCHASE_ORDER_SELF_APPROVAL" },
    );
    expect((await poRow(poId)).status).toBe("pending_approval");
    // Approving before submit is a different contract code.
    const draft = await createPurchaseOrder(
      tenantContext(),
      purchaser,
      poInput(),
    );
    await rejectsWith(
      transitionPurchaseOrderStatus(
        tenantContext(),
        approver,
        draft.purchaseOrder.id as string,
        act("approve"),
      ),
      { status: 409, code: "PURCHASE_ORDER_NOT_PENDING_APPROVAL" },
    );
    // Creating a PO from a PR that is not approved is refused.
    await rejectsWith(
      createPurchaseOrder(
        tenantContext(),
        purchaser,
        poInput({ purchaseRequestId: prId }),
      ),
      { status: 409, code: "PURCHASE_REQUEST_INVALID_TRANSITION" },
    );
  });

  it("[9yz-FLOW-3] rejecting a PR needs a note; rejecting a PO returns it to draft", async () => {
    const pr = await createPurchaseRequest(
      tenantContext(),
      requester,
      prInput(),
    );
    const prId = pr.request.id as string;
    await transitionPurchaseRequestStatus(
      tenantContext(),
      requester,
      prId,
      act("submit"),
    );
    await rejectsWith(
      transitionPurchaseRequestStatus(
        tenantContext(),
        approver,
        prId,
        act("reject"),
      ),
      { status: 400, code: "VALIDATION_ERROR" },
    );
    const rejected = await transitionPurchaseRequestStatus(
      tenantContext(),
      approver,
      prId,
      act("reject", "Stok masih cukup"),
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      decisionNote: "Stok masih cukup",
      decidedBy: approver,
    });

    const poId = await pendingPo();
    const back = await transitionPurchaseOrderStatus(
      tenantContext(),
      approver,
      poId,
      act("reject", "Harga terlalu tinggi"),
    );
    expect(back).toMatchObject({ status: "draft", approvedBy: null });
    expect((await poRow(poId)).approval_chain_id).toBeNull();
    // A draft PO can be submitted again after the fix.
    const again = await transitionPurchaseOrderStatus(
      tenantContext(),
      purchaser,
      poId,
      act("submit"),
    );
    expect(again.status).toBe("pending_approval");
  });

  it("[9yz-FLOW-4] a matrix chain refuses module approval; the consumer applies the inbox decision", async () => {
    await setPolicy("purchase_order", null);
    try {
      const poId = await pendingPo();
      const row = await poRow(poId);
      expect(row.status).toBe("pending_approval");
      const chainId = row.approval_chain_id as string;
      expect(chainId).toBeTruthy();
      await rejectsWith(
        transitionPurchaseOrderStatus(
          tenantContext(),
          approver,
          poId,
          act("approve"),
        ),
        { status: 409, code: "CONFLICT" },
      );
      await rejectsWith(
        transitionPurchaseOrderStatus(
          tenantContext(),
          approver,
          poId,
          act("reject"),
        ),
        { status: 409, code: "CONFLICT" },
      );

      await decideApprovalRequest(
        tenant,
        approver,
        chainId,
        { decision: "approved", reason: "Sesuai anggaran bulan ini." },
        { mfaVerified: true, idempotencyKey: null },
      );
      // The decision alone changes nothing in the PO: the consumer applies it.
      expect((await poRow(poId)).status).toBe("pending_approval");
      const resolved = await resolvedEventOf(chainId);
      await handlePurchasingApprovalResolved(tenantContext(), resolved);
      expect(await poRow(poId)).toMatchObject({
        status: "approved",
        approved_by: approver,
      });
      expect(await eventsOf(poId, "purchase_order.approved")).toBe(1);
      // Replay of the same event records nothing twice.
      await handlePurchasingApprovalResolved(tenantContext(), resolved);
      expect(await eventsOf(poId, "purchase_order.approved")).toBe(1);

      // Rejected in the inbox: back to draft, chain cleared.
      const rejectedId = await pendingPo();
      const rejectedChain = (await poRow(rejectedId))
        .approval_chain_id as string;
      await decideApprovalRequest(
        tenant,
        approver,
        rejectedChain,
        { decision: "rejected", reason: "Supplier lain lebih murah." },
        { mfaVerified: true, idempotencyKey: null },
      );
      await handlePurchasingApprovalResolved(
        tenantContext(),
        await resolvedEventOf(rejectedChain),
      );
      expect(await poRow(rejectedId)).toMatchObject({
        status: "draft",
        approval_chain_id: null,
      });
      // Another module's chain and a pending chain are ignored / not applied.
      const stillPending = await pendingPo();
      const pendingChain = (await poRow(stillPending))
        .approval_chain_id as string;
      const forged = {
        ...(await resolvedEventOf(chainId)),
        payload: {
          ...(await resolvedEventOf(chainId)).payload,
          chainId: pendingChain,
          objectId: stillPending,
          outcome: "approved",
        },
      };
      await handlePurchasingApprovalResolved(tenantContext(), forged as never);
      expect((await poRow(stillPending)).status).toBe("pending_approval");
    } finally {
      await resetPolicies();
    }
  });

  it("[9yz-FLOW-5] the PR estimate from supplier prices decides whether the matrix asks for approval", async () => {
    await setPolicy("purchase_request", 100_000);
    try {
      await owner.query(
        `INSERT INTO supplier_prices (tenant_id, supplier_id, inventory_item_id, purchase_uom_id, price_idr, effective_from, created_by)
         VALUES ($1, $2, $3, $4, 10000, '2026-01-01', $5)`,
        [tenantA, supplier, itemFlour, uomKg, purchaser],
      );
      const cheap = await createPurchaseRequest(
        tenantContext(),
        requester,
        prInput(),
      );
      await transitionPurchaseRequestStatus(
        tenantContext(),
        requester,
        cheap.request.id as string,
        act("submit"),
      );
      // 2.5 x 10.000 = 25.000 < 100.000: no chain, manual approval applies.
      const cheapRow = (
        await owner.query(
          "SELECT approval_chain_id FROM purchase_requests WHERE id = $1",
          [cheap.request.id],
        )
      ).rows[0];
      expect(cheapRow.approval_chain_id).toBeNull();

      // No price for sugar: the estimate is unknown, every tier applies.
      const unknown = await createPurchaseRequest(
        tenantContext(),
        requester,
        prInput({
          lines: [
            { inventoryItemId: itemSugar, quantity: "1.0000", uomId: uomKg },
          ],
        }),
      );
      await transitionPurchaseRequestStatus(
        tenantContext(),
        requester,
        unknown.request.id as string,
        act("submit"),
      );
      const unknownRow = (
        await owner.query(
          "SELECT approval_chain_id FROM purchase_requests WHERE id = $1",
          [unknown.request.id],
        )
      ).rows[0];
      expect(unknownRow.approval_chain_id).not.toBeNull();
      await rejectsWith(
        transitionPurchaseRequestStatus(
          tenantContext(),
          approver,
          unknown.request.id as string,
          act("approve"),
        ),
        { status: 409, code: "CONFLICT" },
      );
      // Cancelling a PR with an open chain withdraws the chain.
      const cancelled = await transitionPurchaseRequestStatus(
        tenantContext(),
        requester,
        unknown.request.id as string,
        act("cancel"),
      );
      expect(cancelled.status).toBe("cancelled");
      const chain = await owner.query(
        "SELECT status FROM approval_requests WHERE id = $1",
        [unknownRow.approval_chain_id],
      );
      expect(chain.rows[0].status).toBe("cancelled");
    } finally {
      await resetPolicies();
    }
  });

  it("[9yz-FLOW-6] retries replay, a reused key conflicts, only a draft PO changes, stale updates are refused", async () => {
    const input = poInput();
    const first = await createPurchaseOrder(tenantContext(), purchaser, input);
    const replay = await createPurchaseOrder(tenantContext(), purchaser, input);
    expect(replay.purchaseOrder.id).toBe(first.purchaseOrder.id);
    await rejectsWith(
      createPurchaseOrder(tenantContext(), purchaser, {
        ...(input as object),
        note: "lain",
      } as never),
      { status: 409, code: "IDEMPOTENCY_KEY_REUSED" },
    );
    const id = first.purchaseOrder.id as string;
    const updatedAt = ((await poRow(id)).updated_at as Date).toISOString();
    const changed = await updatePurchaseOrder(tenantContext(), purchaser, id, {
      lines: [
        {
          inventoryItemId: itemFlour,
          quantity: "4.0000",
          uomId: uomKg,
          unitPriceIdr: "9999.9999",
        },
      ],
      expectedUpdatedAt: updatedAt,
    } as never);
    // 4 x 9999.9999 = 39999.9996 -> 40000
    expect(changed.purchaseOrder.totalIdr).toBe(40000);
    expect(changed.lines).toHaveLength(1);
    await rejectsWith(
      updatePurchaseOrder(tenantContext(), purchaser, id, {
        note: "stale",
        expectedUpdatedAt: updatedAt,
      } as never),
      { status: 412, code: "PRECONDITION_FAILED" },
    );
    await transitionPurchaseOrderStatus(
      tenantContext(),
      purchaser,
      id,
      act("submit"),
    );
    const freshAt = ((await poRow(id)).updated_at as Date).toISOString();
    await rejectsWith(
      updatePurchaseOrder(tenantContext(), purchaser, id, {
        note: "late",
        expectedUpdatedAt: freshAt,
      } as never),
      { status: 409, code: "PURCHASE_ORDER_INVALID_TRANSITION" },
    );
    // Inactive suppliers and unknown items are refused.
    const inactive = await insertSupplier("Supplier Mati", false);
    await rejectsWith(
      createPurchaseOrder(
        tenantContext(),
        purchaser,
        poInput({ supplierId: inactive }),
      ),
      { status: 409, code: "SUPPLIER_INACTIVE" },
    );
    await rejectsWith(
      createPurchaseOrder(
        tenantContext(),
        purchaser,
        poInput({
          lines: [
            {
              inventoryItemId: randomUUID(),
              quantity: "1.0000",
              uomId: uomKg,
              unitPriceIdr: "1.0000",
            },
          ],
        }),
      ),
      { status: 404, code: "NOT_FOUND" },
    );
    // Lists page by cursor, newest first.
    const page = await listPurchaseOrders(tenantContext(), purchaser, {
      outletId: outletA,
      limit: 2,
    } as never);
    expect(page.data).toHaveLength(2);
    expect(page.meta.nextCursor).not.toBeNull();
    const next = await listPurchaseOrders(tenantContext(), purchaser, {
      outletId: outletA,
      limit: 2,
      cursor: page.meta.nextCursor,
    } as never);
    expect(next.data[0]!.id).not.toBe(page.data[0]!.id);
    const prs = await listPurchaseRequests(tenantContext(), requester, {
      outletId: outletA,
      limit: 50,
    } as never);
    expect(prs.data.length).toBeGreaterThan(0);
  });
});

describe("25a7-PO updatedAt", () => {
  it("[25a7-PO-1] GET returns updatedAt, PATCH with it succeeds and moves it, the old value is refused", async () => {
    const created = await createPurchaseOrder(
      tenantContext(),
      purchaser,
      poInput(),
    );
    const id = created.purchaseOrder.id as string;
    const read = await getPurchaseOrder(tenantContext(), purchaser, id);
    const first = read.purchaseOrder.updatedAt;
    expect(first).toBe(((await poRow(id)).updated_at as Date).toISOString());
    const changed = await updatePurchaseOrder(tenantContext(), purchaser, id, {
      note: "first edit",
      expectedUpdatedAt: first,
    } as never);
    const second = changed.purchaseOrder.updatedAt;
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
    await rejectsWith(
      updatePurchaseOrder(tenantContext(), purchaser, id, {
        note: "stale edit",
        expectedUpdatedAt: first,
      } as never),
      { status: 412, code: "PRECONDITION_FAILED" },
    );
    // The new value is accepted, and a transition moves it again.
    await updatePurchaseOrder(tenantContext(), purchaser, id, {
      note: "second edit",
      expectedUpdatedAt: second,
    } as never);
    const submitted = await transitionPurchaseOrderStatus(
      tenantContext(),
      purchaser,
      id,
      act("submit"),
    );
    expect(Date.parse(submitted.updatedAt)).toBeGreaterThan(Date.parse(second));
    expect(submitted.emailDeliveryStatus).toBeNull();
  });

  it("[25a7-PO-3] updatedAt strictly increases after approve, reject, cancel and an approval-consumer settle", async () => {
    const stamp = async (id: string) =>
      ((await poRow(id)).updated_at as Date).getTime();
    const moved = async (
      id: string,
      change: () => Promise<unknown>,
    ): Promise<void> => {
      const before = await stamp(id);
      await change();
      expect(await stamp(id)).toBeGreaterThan(before);
    };

    const approvedId = await pendingPo();
    await moved(approvedId, () =>
      transitionPurchaseOrderStatus(
        tenantContext(),
        approver,
        approvedId,
        act("approve"),
      ),
    );

    const rejectedId = await pendingPo();
    await moved(rejectedId, () =>
      transitionPurchaseOrderStatus(
        tenantContext(),
        approver,
        rejectedId,
        act("reject", "Harga terlalu tinggi"),
      ),
    );

    const cancelledId = await pendingPo();
    await moved(cancelledId, () =>
      transitionPurchaseOrderStatus(
        tenantContext(),
        purchaser,
        cancelledId,
        act("cancel"),
      ),
    );

    await setPolicy("purchase_order", null);
    try {
      for (const decision of ["approved", "rejected"] as const) {
        const settledId = await pendingPo();
        const chainId = (await poRow(settledId)).approval_chain_id as string;
        await decideApprovalRequest(
          tenant,
          approver,
          chainId,
          { decision, reason: "Keputusan inbox." },
          { mfaVerified: true, idempotencyKey: null },
        );
        const resolved = await resolvedEventOf(chainId);
        await moved(settledId, () =>
          handlePurchasingApprovalResolved(tenantContext(), resolved),
        );
      }
    } finally {
      await resetPolicies();
    }
  });
});

describe("9yz-FLOW separation of duties", () => {
  it("[9yz-FLOW-7] only the creator can change or submit a PO, only the requester can submit a PR", async () => {
    const draft = await createPurchaseOrder(
      tenantContext(),
      purchaser,
      poInput(),
    );
    const poId = draft.purchaseOrder.id as string;
    const updatedAt = ((await poRow(poId)).updated_at as Date).toISOString();
    // selfApprover holds the same permissions as the creator (purchasing).
    await rejectsWith(
      updatePurchaseOrder(tenantContext(), selfApprover, poId, {
        note: "diubah orang lain",
        expectedUpdatedAt: updatedAt,
      } as never),
      { status: 403, code: "PERMISSION_DENIED" },
    );
    await rejectsWith(
      transitionPurchaseOrderStatus(
        tenantContext(),
        selfApprover,
        poId,
        act("submit"),
      ),
      { status: 403, code: "PERMISSION_DENIED" },
    );
    expect(await poRow(poId)).toMatchObject({ status: "draft", note: null });
    // The creator still can.
    const changed = await updatePurchaseOrder(
      tenantContext(),
      purchaser,
      poId,
      {
        note: "diubah pembuat",
        expectedUpdatedAt: updatedAt,
      } as never,
    );
    expect(changed.purchaseOrder.note).toBe("diubah pembuat");
    expect(
      (
        await transitionPurchaseOrderStatus(
          tenantContext(),
          purchaser,
          poId,
          act("submit"),
        )
      ).status,
    ).toBe("pending_approval");

    const pr = await createPurchaseRequest(
      tenantContext(),
      requester,
      prInput(),
    );
    const prId = pr.request.id as string;
    await rejectsWith(
      transitionPurchaseRequestStatus(
        tenantContext(),
        selfApprover,
        prId,
        act("submit"),
      ),
      { status: 403, code: "PERMISSION_DENIED" },
    );
    expect(
      (await getPurchaseRequest(tenantContext(), requester, prId)).request
        .status,
    ).toBe("draft");
    expect(
      (
        await transitionPurchaseRequestStatus(
          tenantContext(),
          requester,
          prId,
          act("submit"),
        )
      ).status,
    ).toBe("pending_approval");
  });

  it("[9yz-FLOW-8] a creator who decided any level of a 2-level chain never gets the PO approved", async () => {
    await setPolicy("purchase_order", null, 1);
    await setPolicy("purchase_order", null, 2);
    const decide = async (userId: string, requestId: string) =>
      decideApprovalRequest(
        tenant,
        userId,
        requestId,
        { decision: "approved", reason: "Sesuai anggaran bulan ini." },
        { mfaVerified: true, idempotencyKey: null },
      );
    const levelTwoOf = async (chainId: string) =>
      (
        await owner.query<{ id: string }>(
          "SELECT id FROM approval_requests WHERE chain_id = $1 AND level = 2",
          [chainId],
        )
      ).rows[0]!.id;
    try {
      // Control: a clean 2-level chain approves.
      const cleanId = await pendingPo();
      const cleanChain = (await poRow(cleanId)).approval_chain_id as string;
      await decide(approver, cleanChain);
      await decide(approver2, await levelTwoOf(cleanChain));
      await handlePurchasingApprovalResolved(
        tenantContext(),
        await resolvedEventOf(cleanChain),
      );
      expect(await poRow(cleanId)).toMatchObject({
        status: "approved",
        approved_by: approver2,
      });

      // Tainted: a forged level-1 row says the creator decided it (the DB
      // distinct-actor check only compares with the row's own requester, so
      // the requester is rewritten too).
      const taintedId = await pendingPo();
      const taintedChain = (await poRow(taintedId)).approval_chain_id as string;
      await decide(approver, taintedChain);
      await decide(approver2, await levelTwoOf(taintedChain));
      await owner.query(
        "UPDATE approval_requests SET decided_by = $2, requested_by = $3 WHERE chain_id = $1 AND level = 1",
        [taintedChain, purchaser, approver2],
      );
      await handlePurchasingApprovalResolved(
        tenantContext(),
        await resolvedEventOf(taintedChain),
      );
      expect(await poRow(taintedId)).toMatchObject({
        status: "draft",
        approved_by: null,
        approval_chain_id: null,
      });
      expect(await eventsOf(taintedId, "purchase_order.approved")).toBe(0);
    } finally {
      await resetPolicies();
    }
  });
});

describe("9yz-HTTP purchasing API", () => {
  const post = (
    client: ReturnType<typeof agent>,
    path: string,
    body: unknown,
  ) =>
    client
      .post(`/api/inventory${path}`)
      .set(originHeader)
      .send(body as object);

  it("[9yz-HTTP-1] PR -> transitions -> PO -> list and detail over HTTP; 401, 403 and strict bodies", async () => {
    const asRequester = await signedIn("HTTP requester", [
      { role: "kitchen_lead", outletId: outletA },
    ]);
    const asBuyer = await signedIn("HTTP buyer", [
      { role: "purchasing", outletId: outletA },
    ]);
    const asApprover = await signedIn("HTTP approver", [
      { role: "general_manager", outletId: null },
    ]);
    const nobody = await signedIn("HTTP nobody", []);

    // 401 without a session, 403 without a purchasing permission.
    expect(
      (
        await agent(app).get(
          `/api/inventory/purchase-orders?outletId=${outletA}&limit=5`,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await nobody.client.get(
          `/api/inventory/purchase-orders?outletId=${outletA}&limit=5`,
        )
      ).status,
    ).toBe(403);
    expect(
      (await post(nobody.client, "/purchase-requests", prInput())).status,
    ).toBe(403);
    // A kitchen lead requests but cannot create a PO.
    expect(
      (await post(asRequester.client, "/purchase-orders", poInput())).status,
    ).toBe(403);
    // No Origin header on a cookie-authenticated mutation.
    expect(
      (
        await asRequester.client
          .post("/api/inventory/purchase-requests")
          .send(prInput() as object)
      ).status,
    ).toBe(403);

    // Strict bodies: an unknown (tenant) field is a validation error.
    const strict = await post(asRequester.client, "/purchase-requests", {
      ...(prInput() as object),
      tenantId: tenantB,
    });
    expect(strict.status).toBe(422);

    const created = await post(
      asRequester.client,
      "/purchase-requests",
      prInput(),
    );
    expect(created.status).toBe(201);
    const prId = created.body.data.request.id as string;
    const submit = await post(
      asRequester.client,
      `/purchase-requests/${prId}/transitions`,
      act("submit"),
    );
    expect(submit.status).toBe(200);
    expect(submit.body.data.status).toBe("pending_approval");
    // The requester cannot approve (no approve permission); the approver can.
    expect(
      (
        await post(
          asRequester.client,
          `/purchase-requests/${prId}/transitions`,
          act("approve"),
        )
      ).status,
    ).toBe(403);
    const approve = await post(
      asApprover.client,
      `/purchase-requests/${prId}/transitions`,
      act("approve"),
    );
    expect(approve.status).toBe(200);
    expect(approve.body.data.status).toBe("approved");

    const po = await post(
      asBuyer.client,
      "/purchase-orders",
      poInput({ purchaseRequestId: prId }),
    );
    expect(po.status).toBe(201);
    const poId = po.body.data.purchaseOrder.id as string;
    expect(po.body.data.purchaseOrder).toMatchObject({
      status: "draft",
      subtotalIdr: 35000,
      totalIdr: 35000,
      source: "user",
    });
    expect(
      (
        await post(
          asBuyer.client,
          `/purchase-orders/${poId}/transitions`,
          act("submit"),
        )
      ).status,
    ).toBe(200);
    const approvedPo = await post(
      asApprover.client,
      `/purchase-orders/${poId}/transitions`,
      act("approve"),
    );
    expect(approvedPo.status).toBe(200);
    expect(approvedPo.body.data.status).toBe("approved");

    const list = await asBuyer.client.get(
      `/api/inventory/purchase-orders?outletId=${outletA}&limit=50`,
    );
    expect(list.status).toBe(200);
    expect(list.body.meta.limit).toBe(50);
    expect(
      (list.body.data as { id: string }[]).some((order) => order.id === poId),
    ).toBe(true);
    const detail = await asBuyer.client.get(
      `/api/inventory/purchase-orders/${poId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.lines).toHaveLength(2);
    const prDetail = await asRequester.client.get(
      `/api/inventory/purchase-requests/${prId}`,
    );
    expect(prDetail.status).toBe(200);
    expect(prDetail.body.data.request.status).toBe("converted");
    const prList = await asRequester.client.get(
      `/api/inventory/purchase-requests?outletId=${outletA}&limit=50&status=converted`,
    );
    expect(prList.status).toBe(200);
    // Unknown ids and malformed ids.
    expect(
      (
        await asBuyer.client.get(
          `/api/inventory/purchase-orders/${randomUUID()}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await asBuyer.client.get("/api/inventory/purchase-orders/not-a-uuid"))
        .status,
    ).toBeGreaterThanOrEqual(400);
    // An outlet B only user cannot see the outlet A order.
    const otherOutlet = await signedIn("HTTP outlet B", [
      { role: "purchasing", outletId: outletB },
    ]);
    expect(
      (await otherOutlet.client.get(`/api/inventory/purchase-orders/${poId}`))
        .status,
    ).toBe(404);
    expect(
      (
        await otherOutlet.client.get(
          `/api/inventory/purchase-orders?outletId=${outletA}&limit=5`,
        )
      ).status,
    ).toBe(403);
  });

  it("[9yz-HTTP-2] a read by id merges the reach of every purchasing permission the caller holds", async () => {
    const poId = (
      await createPurchaseOrder(tenantContext(), purchaser, poInput())
    ).purchaseOrder.id as string;
    // Supplier management at outlet B, requesting at outlet A: neither grant
    // alone reaches both, together they reach the outlet A order.
    const mixed = await signedIn("HTTP mixed", [
      { role: "purchasing", outletId: outletB },
      { role: "kitchen_lead", outletId: outletA },
    ]);
    const response = await mixed.client.get(
      `/api/inventory/purchase-orders/${poId}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.data.purchaseOrder.id).toBe(poId);
  });
});

describe("9yz-ISO purchasing isolation", () => {
  it("[9yz-ISO-2] another tenant sees no rows; another outlet and unassigned users cannot read or transition", async () => {
    const poId = await pendingPo();
    const pr = await createPurchaseRequest(
      tenantContext(),
      requester,
      prInput(),
    );
    for (const table of [
      "suppliers",
      "purchase_requests",
      "purchase_request_lines",
      "purchase_orders",
      "purchase_order_lines",
      "purchasing_idempotency",
    ]) {
      const seen = await asTenant(tenantB, (client) =>
        client.query(`SELECT 1 FROM ${table}`),
      );
      expect(seen.rows, table).toHaveLength(0);
    }

    // Outlet B scope: RLS hides the outlet A documents (404, no leak).
    const scopedB = tenantContext([outletB]);
    await rejectsWith(getPurchaseOrder(scopedB, outsiderB, poId), {
      status: 404,
      code: "NOT_FOUND",
    });
    await rejectsWith(
      transitionPurchaseOrderStatus(scopedB, outsiderB, poId, act("approve")),
      { status: 404, code: "NOT_FOUND" },
    );
    await rejectsWith(
      getPurchaseRequest(scopedB, outsiderB, pr.request.id as string),
      { status: 404, code: "NOT_FOUND" },
    );
    await rejectsWith(
      listPurchaseOrders(scopedB, outsiderB, {
        outletId: outletA,
        limit: 10,
      } as never),
      { code: "OUTLET_OUT_OF_SCOPE" },
    );

    // Tenant-wide scope with a role of the other outlet only: permission
    // denied against the document's own outlet, nothing changes.
    for (const run of [
      () => getPurchaseOrder(tenantContext(), outsiderB, poId),
      () =>
        transitionPurchaseOrderStatus(
          tenantContext(),
          outsiderB,
          poId,
          act("approve"),
        ),
      () =>
        transitionPurchaseRequestStatus(
          tenantContext(),
          outsiderB,
          pr.request.id as string,
          act("submit"),
        ),
      () =>
        createPurchaseOrder(
          tenantContext(),
          outsiderB,
          poInput({ outletId: outletA }),
        ),
    ])
      await rejectsWith(run(), { code: "PERMISSION_DENIED" });
    expect((await poRow(poId)).status).toBe("pending_approval");

    // A kitchen lead may read and request but not create or approve a PO.
    await rejectsWith(
      createPurchaseOrder(tenantContext(), requester, poInput()),
      { code: "PERMISSION_DENIED" },
    );
    await rejectsWith(
      transitionPurchaseOrderStatus(
        tenantContext(),
        requester,
        poId,
        act("approve"),
      ),
      { code: "PERMISSION_DENIED" },
    );
    expect(
      (await getPurchaseOrder(tenantContext(), requester, poId)).purchaseOrder
        .id,
    ).toBe(poId);
  });
});

/** The `approval.resolved` envelope the approval service appended. */
async function resolvedEventOf(chainId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [tenantA, chainId],
  );
  expect(rows).toHaveLength(1);
  return approvalResolvedEvent.envelopeSchema.parse(rows[0]!.event);
}

describe("legend-50 architect fixes (slice B)", () => {
  const linkOf = async (poId: string, outletId = outletA) => {
    const token = randomBytes(24).toString("base64url");
    await owner.query(
      `INSERT INTO purchase_order_share_links
         (tenant_id, outlet_id, purchase_order_id, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, now() + interval '1 day', $5)`,
      [tenantA, outletId, poId, purchaseOrderLinkTokenHash(token), purchaser],
    );
    return token;
  };
  const revokedOf = async (token: string) =>
    (
      await owner.query<{ revoked_at: Date | null }>(
        "SELECT revoked_at FROM purchase_order_share_links WHERE token_hash = $1",
        [purchaseOrderLinkTokenHash(token)],
      )
    ).rows[0]!.revoked_at;

  // A PR requested by `selfApprover`, approved by `approver`, and a PO made
  // from it by `purchaser` (the PO creator is not the PR requester).
  async function poFromRequesterPr(): Promise<string> {
    const pr = await createPurchaseRequest(
      tenantContext(),
      selfApprover,
      prInput(),
    );
    const prId = pr.request.id as string;
    await transitionPurchaseRequestStatus(
      tenantContext(),
      selfApprover,
      prId,
      act("submit"),
    );
    await transitionPurchaseRequestStatus(
      tenantContext(),
      approver,
      prId,
      act("approve"),
    );
    const detail = await createPurchaseOrder(
      tenantContext(),
      purchaser,
      poInput({ purchaseRequestId: prId }),
    );
    const id = detail.purchaseOrder.id as string;
    await transitionPurchaseOrderStatus(
      tenantContext(),
      purchaser,
      id,
      act("submit"),
    );
    return id;
  }

  it("[50-F2] cancelling or closing a PO revokes its share links", async () => {
    const draft = await createPurchaseOrder(
      tenantContext(),
      purchaser,
      poInput(),
    );
    const cancelId = draft.purchaseOrder.id as string;
    const cancelToken = await linkOf(cancelId);
    await transitionPurchaseOrderStatus(
      tenantContext(),
      purchaser,
      cancelId,
      act("cancel"),
    );
    expect(await revokedOf(cancelToken)).not.toBeNull();
    await rejectsWith(getPublicPurchaseOrderPdf(tenantContext(), cancelToken), {
      status: 404,
      code: "NOT_FOUND",
    });

    const closing = await createPurchaseOrder(
      tenantContext(),
      purchaser,
      poInput(),
    );
    const closeId = closing.purchaseOrder.id as string;
    await owner.query(
      `UPDATE purchase_orders
          SET status = 'received', approved_by = $2, approved_at = now(),
              sent_at = now(), sent_to = 'supplier@example.com'
        WHERE id = $1`,
      [closeId, approver],
    );
    const closeToken = await linkOf(closeId);
    await transitionPurchaseOrderStatus(
      tenantContext(),
      purchaser,
      closeId,
      act("close"),
    );
    expect(await revokedOf(closeToken)).not.toBeNull();
    await rejectsWith(getPublicPurchaseOrderPdf(tenantContext(), closeToken), {
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("[50-F3] the requester of the source PR cannot approve the PO (manual and chain)", async () => {
    const manualId = await poFromRequesterPr();
    await rejectsWith(
      transitionPurchaseOrderStatus(
        tenantContext(),
        selfApprover,
        manualId,
        act("approve"),
      ),
      { status: 409, code: "PURCHASE_ORDER_SELF_APPROVAL" },
    );
    expect((await poRow(manualId)).status).toBe("pending_approval");

    await setPolicy("purchase_order", null, 1);
    try {
      const chainPo = await poFromRequesterPr();
      const chainId = (await poRow(chainPo)).approval_chain_id as string;
      await decideApprovalRequest(
        tenant,
        selfApprover,
        chainId,
        { decision: "approved", reason: "Sesuai anggaran bulan ini." },
        { mfaVerified: true, idempotencyKey: null },
      );
      await handlePurchasingApprovalResolved(
        tenantContext(),
        await resolvedEventOf(chainId),
      );
      expect(await poRow(chainPo)).toMatchObject({
        status: "draft",
        approved_by: null,
      });
    } finally {
      await resetPolicies();
    }
  });

  it("[50-F4] money overflow in a PO or PR estimate is a 422, not a 500", async () => {
    const huge = poInput({
      lines: [
        {
          inventoryItemId: itemFlour,
          quantity: "99999999.0000",
          uomId: uomKg,
          unitPriceIdr: "99999999.0000",
        },
      ],
    });
    await rejectsWith(createPurchaseOrder(tenantContext(), purchaser, huge), {
      status: 422,
      code: "VALIDATION_ERROR",
    });
    const draft = await createPurchaseOrder(
      tenantContext(),
      purchaser,
      poInput(),
    );
    await rejectsWith(
      updatePurchaseOrder(
        tenantContext(),
        purchaser,
        draft.purchaseOrder.id as string,
        {
          expectedUpdatedAt: draft.purchaseOrder.updatedAt,
          lines: (huge as { lines: unknown }).lines,
        } as never,
      ),
      { status: 422, code: "VALIDATION_ERROR" },
    );

    // PR estimate: a supplier price so large that quantity x price overflows.
    const uom = await insertUom("big");
    const item = await insertItem(uom, "Mahal Flow");
    await owner.query(
      `INSERT INTO supplier_prices
         (tenant_id, supplier_id, inventory_item_id, purchase_uom_id, price_idr, effective_from, is_active, created_by)
       VALUES ($1, $2, $3, $4, '99999999.0000', '2026-01-01', true, $5)`,
      [tenantA, supplier, item, uom, requester],
    );
    const pr = await createPurchaseRequest(
      tenantContext(),
      requester,
      prInput({
        lines: [
          { inventoryItemId: item, quantity: "99999999.0000", uomId: uom },
        ],
      }),
    );
    await rejectsWith(
      transitionPurchaseRequestStatus(
        tenantContext(),
        requester,
        pr.request.id as string,
        act("submit"),
      ),
      { status: 422, code: "VALIDATION_ERROR" },
    );
  });

  it("[50-F5] a replayed transition by a caller without access is refused, not answered from the stored response", async () => {
    const temp = await newUser("temp", [
      { role: "purchasing", outletId: outletA },
      { role: "kitchen_lead", outletId: outletA },
    ]);
    const po = await createPurchaseOrder(tenantContext(), temp, poInput());
    const poId = po.purchaseOrder.id as string;
    const poCancel = act("cancel");
    await transitionPurchaseOrderStatus(tenantContext(), temp, poId, poCancel);
    const pr = await createPurchaseRequest(tenantContext(), temp, prInput());
    const prId = pr.request.id as string;
    const prCancel = act("cancel");
    await transitionPurchaseRequestStatus(
      tenantContext(),
      temp,
      prId,
      prCancel,
    );

    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
      [tenantA, temp],
    );
    await rejectsWith(
      transitionPurchaseOrderStatus(tenantContext(), temp, poId, poCancel),
      { status: 403, code: "PERMISSION_DENIED" },
    );
    await rejectsWith(
      transitionPurchaseRequestStatus(tenantContext(), temp, prId, prCancel),
      { status: 403, code: "PERMISSION_DENIED" },
    );
  });

  it("[50-F6] a transition idempotency row carries the real outlet id", async () => {
    const po = await createPurchaseOrder(tenantContext(), purchaser, poInput());
    const poKey = key();
    await transitionPurchaseOrderStatus(
      tenantContext(),
      purchaser,
      po.purchaseOrder.id as string,
      { action: "cancel", note: null, idempotencyKey: poKey } as never,
    );
    const pr = await createPurchaseRequest(
      tenantContext(),
      requester,
      prInput(),
    );
    const prKey = key();
    await transitionPurchaseRequestStatus(
      tenantContext(),
      requester,
      pr.request.id as string,
      { action: "cancel", note: null, idempotencyKey: prKey } as never,
    );
    for (const idempotencyKey of [poKey, prKey]) {
      const { rows } = await owner.query<{ outlet_id: string | null }>(
        "SELECT outlet_id FROM purchasing_idempotency WHERE tenant_id = $1 AND idempotency_key = $2",
        [tenantA, idempotencyKey],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outlet_id).toBe(outletA);
    }
  });
});
