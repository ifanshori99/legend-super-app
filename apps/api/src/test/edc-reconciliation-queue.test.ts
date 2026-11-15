// EDC reconciliation queue (bead legend-p98qi, card 868; PRD EDC-02/03/06;
// founder rule "jangan sampai rugi"). GET /api/payments/admin/edc/reconciliation-queue
// lists the flagged / unknown ECR sale rows for Owner and Finance
// (permission `payment.reconcile`); the screen derives which answers are
// allowed from the returned fields, so they must match the POST resolve rules.
//
// Written from docs/briefs/868-shared-context.md, the shared contract
// `listEdcReconciliationQueue` (packages/shared/src/payment/admin.ts) and the
// POST behaviour already fixed by edc-reconciliation.test.ts, not from the
// implementation. Fixtures mirror edc-reconciliation.test.ts.
//
// Assumptions (the brief is not final on these):
// - Invalid query (limit 0, unknown field, bad status, q > 100 chars) answers
//   422 (strict shared validator, as the POS routes); 400 is also accepted.
// - A user with `payment.reconcile` at ONE outlet only: asking for that outlet
//   is 200 with its rows; asking for another outlet, or for no outlet, must
//   never leak the other outlet's rows. Whether those answer 403 or a 200
//   limited to the allowed outlets is left open (both are leak-free).
// - Same for another tenant's outlet id in `outletId`: 403/404 or an empty 200.
// - `terminalLabel` is "<terminal code> · <BANK>" ("TID-RECON · BCA").
// - A flagged `pending` row is listed (flag = true) but nothing can be done to
//   it (POST 409), like the screen's "not-eligible" gate.
// - Declining an `approved` flagged row (no tender) is refused 409: the only
//   answer for an approved row is the "approved" clear (the screen's gate).
// - `cashierName` has no known source in the fixtures: only its type
//   (string | null) is asserted.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  encodeCursor,
  idr,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { roleTemplate } from "@starter/shared/access";
import type { PosReceipt } from "@starter/shared/pos";
import type { EdcReconciliationQueueItem } from "@starter/shared/payment/admin";
import {
  cafeLegendPlatformFixtures,
  DEVICE_TOKEN_HEADER,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { EDC_LATE_RESPONSE_WINDOW_MS } from "../edge/edc/late-response.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const QUEUE = "/api/payments/admin/edc/reconciliation-queue";
const WINDOW_MS = EDC_LATE_RESPONSE_WINDOW_MS;

const ids = {
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  ownerRole: randomUUID(),
  financeRole: randomUUID(),
  outletRole: randomUUID(),
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  device: randomUUID(),
  outletB: randomUUID(),
  brand2: randomUUID(),
  outletC: randomUUID(),
  brandRole: randomUUID(),
  outletCashierRole: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant; // outlet A lives here, outlet B is added below
let other: IsolatedTenant; // a second tenant that must never leak
let headers: { Host: string };
type Member = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
};
let cashier: Member;
let supervisor: Member;
let ownerUser: Member;
let financeUser: Member;
let outletAOnly: Member; // payment.reconcile at outlet A only
// payment.reconcile at brand 1 (outlets A and B) plus a cashier-only grant at
// outlet C of brand 2, which does not carry payment.reconcile.
let brandFinance: Member;
let terminalA: string;
let terminalB: string;
let terminalC: string;
let terminalOther: string;
let outletAName = "";
let outletBName = "";

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a string");
  return value;
}

// ---- Receipt numbering double (same as edc-reconciliation.test.ts) -----------

function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  const next = new Map<string, number>();
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      const sequenceNumber = (next.get(input.outletId) ?? 0) + 1;
      next.set(input.outletId, sequenceNumber);
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? ids.device,
        number: `POS1-${String(sequenceNumber).padStart(6, "0")}`,
        sequenceNumber,
        status: "issued",
        issuedAt: input.at.toISOString(),
        voidedAt: null,
        voidReason: null,
        voidedBy: null,
        reprintCount: 0,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, receipt);
      return receipt;
    },
    async findForOrder(_tx, _context, orderId) {
      return byOrder.get(orderId) ?? null;
    },
    async voidForOrder(_tx, _context, input) {
      const found = byOrder.get(input.orderId);
      if (!found) return null;
      const voided = {
        ...found,
        status: "voided",
        voidedAt: input.at.toISOString(),
        voidReason: input.reason,
        voidedBy: input.voidedBy,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, voided);
      return voided;
    },
  };
}

// ---- Fixtures ---------------------------------------------------------------------

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function member(
  roleId: string,
  label: string,
  scope:
    | { type: "tenant" }
    | { type: "brand"; id: string }
    | { type: "outlet"; id: string } = {
    type: "tenant",
  },
  extra: { roleId: string; outletId: string }[] = [],
): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = text(session.body.user.id);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenant.tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "tenant" ? null : scope.id,
    ],
  );
  for (const grant of extra)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
      [tenant.tenantId, userId, grant.roleId, grant.outletId],
    );
  await verifySessionMfa(email);
  return { client, userId, email };
}

function pos(who: Member = cashier) {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
  const deviceToken = () =>
    signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: tenant.tenantId,
      brandId: null,
      deviceId: ids.device,
    });
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken())
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    create: () =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
      }),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
  };
}

type Order = { orderId: string; number: string; totalIdr: number };

async function newOrder(): Promise<Order> {
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = text(created.body.data.id);
  if (created.body.data.status === "draft") {
    const submitted = await pos().submit(orderId, "draft");
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  }
  return {
    orderId,
    number: text(created.body.data.number),
    totalIdr: created.body.data.totalIdr as number,
  };
}

type Where = { tenantId: string; outletId: string; terminalId: string };
const inA = (): Where => ({
  tenantId: tenant.tenantId,
  outletId: tenant.outletId,
  terminalId: terminalA,
});
const inB = (): Where => ({
  tenantId: tenant.tenantId,
  outletId: ids.outletB,
  terminalId: terminalB,
});
const inC = (): Where => ({
  tenantId: tenant.tenantId,
  outletId: ids.outletC,
  terminalId: terminalC,
});
const inOtherTenant = (): Where => ({
  tenantId: other.tenantId,
  outletId: other.outletId,
  terminalId: terminalOther,
});

/** One ledger row of the EDC table (default: a flagged, old ECR sale in outlet A). */
async function ledgerRow(input: {
  reference: string;
  amountIdr: number;
  status: string;
  flagged?: boolean;
  type?: "sale" | "void" | "refund";
  where?: Where;
  dispatchedAt?: Date;
  message?: string;
  invoiceNo?: string;
  maskedPan?: string;
}): Promise<string> {
  const id = randomUUID();
  const where = input.where ?? inA();
  const final = ["approved", "declined", "cancelled", "failed"].includes(
    input.status,
  );
  await asOwnerTenant(where.tenantId, (client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          completed_at, needs_reconciliation, dispatched_at,
          message, invoice_no, masked_pan)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', $8, $9, 'ecr', $10,
               $11, $12, $13, $14, $15, $16)`,
      [
        id,
        where.tenantId,
        where.outletId,
        where.terminalId,
        input.reference,
        randomUUID(),
        input.amountIdr,
        input.status,
        input.type ?? "sale",
        randomUUID().replaceAll("-", "").slice(0, 12),
        final ? new Date() : null,
        input.flagged ?? true,
        input.dispatchedAt ?? new Date(Date.now() - WINDOW_MS - 60_000),
        input.message ?? null,
        input.invoiceNo ?? null,
        input.maskedPan ?? null,
      ],
    ),
  );
  return id;
}

async function setWireOpen(edcTransactionId: string) {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `UPDATE edc_transactions SET sale_wire_open_at = now() WHERE id = $1`,
      [edcTransactionId],
    ),
  );
}

async function row(edcTransactionId: string) {
  const { rows } = await owner.query<{
    status: string;
    needs_reconciliation: boolean;
  }>(
    `SELECT status, needs_reconciliation FROM edc_transactions WHERE id = $1`,
    [edcTransactionId],
  );
  return rows[0]!;
}

// ---- HTTP helpers -----------------------------------------------------------------

function getQueue(who: Member, query: Record<string, string | number> = {}) {
  return who.client.get(QUEUE).query(query).set(headers).set(originHeader);
}

/** Follows the cursor to the end; every page must answer 200. */
async function fetchAll(
  who: Member,
  query: Record<string, string | number> = {},
): Promise<EdcReconciliationQueueItem[]> {
  const items: EdcReconciliationQueueItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const res = await getQueue(who, {
      limit: 100,
      ...query,
      ...(cursor === null ? {} : { cursor }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    items.push(...(res.body.data as EdcReconciliationQueueItem[]));
    cursor = (res.body.meta?.nextCursor as string | null) ?? null;
    if (cursor === null) return items;
  }
  throw new Error("the queue never ended");
}

const idsOf = (items: EdcReconciliationQueueItem[]) =>
  items.map((item) => item.transaction.id);

async function itemFor(
  edcTransactionId: string,
): Promise<EdcReconciliationQueueItem> {
  const found = (await fetchAll(ownerUser)).find(
    (item) => item.transaction.id === edcTransactionId,
  );
  expect(found, `row ${edcTransactionId} is in the queue`).toBeDefined();
  return found!;
}

function resolve(
  who: Member,
  edcTransactionId: string,
  outcome: "approved" | "declined",
  amountIdr: number,
) {
  return who.client
    .post(
      `/api/payments/admin/edc/transactions/${encodeURIComponent(edcTransactionId)}/reconciliation`,
    )
    .set(headers)
    .set(originHeader)
    .send({
      outcome,
      evidence: {
        source: "inquiry",
        note: "Dicek ke mesin EDC: status transaksi sudah dipastikan",
        ...(outcome === "approved" ? { chargedAmountIdr: amountIdr } : {}),
      },
    });
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`eq-${randomUUID().slice(0, 6)}`);
  other = await createIsolatedTenant(`eo-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.device
      ? tenant.outletId
      : null,
  );
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: ids.device,
  });
  const roles: [string, string, readonly string[], string][] = [
    [
      ids.cashierRole,
      "EDC Antrian Kasir",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "shift.cash.operate",
      ],
      '["tenant"]',
    ],
    [
      ids.supervisorRole,
      "EDC Antrian Supervisor",
      roleTemplate("supervisor").permissions,
      '["tenant"]',
    ],
    [
      ids.ownerRole,
      "EDC Antrian Owner",
      roleTemplate("owner").permissions,
      '["tenant"]',
    ],
    [
      ids.financeRole,
      "EDC Antrian Finance",
      roleTemplate("finance").permissions,
      '["tenant"]',
    ],
    [
      ids.outletRole,
      "EDC Antrian Outlet",
      roleTemplate("owner").permissions,
      '["tenant","outlet"]',
    ],
    [
      ids.brandRole,
      "EDC Antrian Brand",
      roleTemplate("finance").permissions,
      '["tenant","brand"]',
    ],
    [
      ids.outletCashierRole,
      "EDC Antrian Kasir Outlet",
      ["order.view", "pos.sale.create"],
      '["outlet"]',
    ],
  ];
  for (const [id, name, permissions, scopes] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
      [id, tenant.tenantId, name, JSON.stringify(permissions), scopes],
    );
  cashier = await member(ids.cashierRole, "Antrian Kasir");
  supervisor = await member(ids.supervisorRole, "Antrian Supervisor");
  ownerUser = await member(ids.ownerRole, "Antrian Owner");
  financeUser = await member(ids.financeRole, "Antrian Finance");
  outletAOnly = await member(ids.outletRole, "Antrian Outlet A", {
    type: "outlet",
    id: tenant.outletId,
  });
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand Dua')",
    [ids.brand2, tenant.tenantId, `brand2-${randomUUID().slice(0, 6)}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet C Antrian', 'Jl. Uji 3', 'Asia/Jakarta', $6, 'active')`,
    [
      ids.outletC,
      tenant.tenantId,
      ids.brand2,
      tenant.legalEntityId,
      `OUTC-${randomUUID().slice(0, 6)}`.toUpperCase(),
      JSON.stringify(cafeLegendPlatformFixtures.outlets[0].openingHours),
    ],
  );
  brandFinance = await member(
    ids.brandRole,
    "Antrian Brand",
    { type: "brand", id: tenant.brandId },
    [{ roleId: ids.outletCashierRole, outletId: ids.outletC }],
  );
  await openPosShift(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    ),
    { userId: userIdSchema.parse(cashier.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  terminalA = randomUUID();
  terminalB = randomUUID();
  terminalC = randomUUID();
  terminalOther = randomUUID();
  outletBName = "Outlet B Antrian";
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 2', 'Asia/Jakarta', $7, 'active')`,
    [
      ids.outletB,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `OUTB-${randomUUID().slice(0, 6)}`.toUpperCase(),
      outletBName,
      JSON.stringify(cafeLegendPlatformFixtures.outlets[0].openingHours),
    ],
  );
  const { rows: named } = await owner.query<{ name: string }>(
    "SELECT name FROM outlets WHERE id = $1",
    [tenant.outletId],
  );
  outletAName = named[0]!.name;
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Antrian Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-POS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await client.query(
      `INSERT INTO pos_approval_policies (tenant_id, outlet_id, discount_threshold_bp)
       VALUES ($1, NULL, 1000)`,
      [tenant.tenantId],
    );
    for (const [terminal, outlet, code] of [
      [terminalA, tenant.outletId, "TID-RECON"],
      [terminalB, ids.outletB, "TID-OUTB"],
      [terminalC, ids.outletC, "TID-OUTC"],
    ] as const)
      await client.query(
        `INSERT INTO payment_edc_terminals
           (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
            connection, ip_address, supported_methods, status)
         VALUES ($1, $2, $3, 'bca', $4, 'MID-RECON', 'Test EDC', 'lan',
                 '10.0.0.8', ARRAY['card','qris'], 'active')`,
        [terminal, tenant.tenantId, outlet, code],
      );
  });
  await asOwnerTenant(other.tenantId, (client) =>
    client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-OTHER', 'MID-OTHER', 'Test EDC', 'lan',
               '10.0.0.9', ARRAY['card','qris'], 'active')`,
      [terminalOther, other.tenantId, other.outletId],
    ),
  );
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  for (const t of [tenant, other])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- 3. Access -------------------------------------------------------------------

describe("EDC-06 who may read the reconciliation queue", () => {
  it("an anonymous caller gets 401", async () => {
    const res = await agent(app).get(QUEUE).set(headers).set(originHeader);
    expect(res.status, JSON.stringify(res.body)).toBe(401);
  });

  it("a cashier and a supervisor (no payment.reconcile) get 403 and no rows", async () => {
    await ledgerRow({
      reference: `ACC-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
    });
    for (const who of [cashier, supervisor]) {
      const res = await getQueue(who);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.data).toBeUndefined();
    }
  });

  it.each([
    ["owner", () => ownerUser],
    ["finance manager", () => financeUser],
  ])("a %s reads the queue and sees a flagged row", async (_label, who) => {
    const id = await ledgerRow({
      reference: `ACC-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
    });
    expect(idsOf(await fetchAll(who()))).toContain(id);
  });
});

// ---- 1. Tenant isolation --------------------------------------------------------

describe("EDC-06 the queue never shows another tenant's rows", () => {
  it("rows of the other tenant (even flagged and unknown) are absent, own rows are present", async () => {
    const mine = await ledgerRow({
      reference: `TEN-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
    });
    const theirs = await ledgerRow({
      reference: `TEN-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
      where: inOtherTenant(),
    });
    const listed = idsOf(await fetchAll(ownerUser));
    expect(listed).toContain(mine);
    expect(listed).not.toContain(theirs);
    expect(JSON.stringify(listed)).not.toContain(other.outletId);
  });

  it("asking for the other tenant's outlet id leaks nothing", async () => {
    const theirs = await ledgerRow({
      reference: `TEN-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
      where: inOtherTenant(),
    });
    const res = await getQueue(ownerUser, { outletId: other.outletId });
    expect([200, 403, 404], JSON.stringify(res.body)).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.data).toEqual([]);
    }
    expect(JSON.stringify(res.body)).not.toContain(theirs);
  });
});

// ---- 2. Outlet isolation --------------------------------------------------------

describe("EDC-06 outlet scope: payment.reconcile at outlet A only", () => {
  it("sees outlet A rows, never outlet B rows", async () => {
    const a = await ledgerRow({
      reference: `OUT-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
    });
    const b = await ledgerRow({
      reference: `OUT-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
      where: inB(),
    });

    // Asking for outlet A: the legitimate path.
    const forA = await fetchAll(outletAOnly, { outletId: tenant.outletId });
    expect(idsOf(forA)).toContain(a);
    expect(idsOf(forA)).not.toContain(b);

    // Asking for outlet B: refused, or an empty answer. Never B's rows.
    const forB = await getQueue(outletAOnly, { outletId: ids.outletB });
    expect([200, 403, 404], JSON.stringify(forB.body)).toContain(forB.status);
    if (forB.status === 200) expect(forB.body.data).toEqual([]);
    expect(JSON.stringify(forB.body)).not.toContain(b);

    // Asking for nothing: refused, or limited to outlet A.
    const none = await getQueue(outletAOnly, { limit: 100 });
    expect([200, 403], JSON.stringify(none.body)).toContain(none.status);
    if (none.status === 200) {
      const listed = none.body.data as EdcReconciliationQueueItem[];
      expect(idsOf(listed)).not.toContain(b);
      expect(
        listed.every((i) => i.transaction.outletId === tenant.outletId),
      ).toBe(true);
    }
  });

  it("a brand-scoped finance without outletId gets 200 with only the outlets its payment.reconcile grant reaches", async () => {
    const a = await ledgerRow({
      reference: `BRD-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
    });
    const b = await ledgerRow({
      reference: `BRD-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
      where: inB(),
    });
    // Outlet C: another brand, and the caller holds only a cashier grant there.
    const c = await ledgerRow({
      reference: `BRD-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
      where: inC(),
    });
    const res = await getQueue(brandFinance, { limit: 100 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const listed = await fetchAll(brandFinance);
    expect(idsOf(listed)).toContain(a);
    expect(idsOf(listed)).toContain(b);
    expect(idsOf(listed)).not.toContain(c);
    expect(listed.every((i) => i.transaction.outletId !== ids.outletC)).toBe(
      true,
    );

    // With an explicit outlet the outlet gate still holds.
    const forC = await getQueue(brandFinance, { outletId: ids.outletC });
    expect(forC.status, JSON.stringify(forC.body)).toBe(403);
    expect(JSON.stringify(forC.body)).not.toContain(c);
    const forB = await fetchAll(brandFinance, { outletId: ids.outletB });
    expect(idsOf(forB)).toContain(b);
    expect(idsOf(forB)).not.toContain(a);
  });

  it("a tenant-wide owner sees both outlets and can filter by outletId", async () => {
    const a = await ledgerRow({
      reference: `OUT-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
    });
    const b = await ledgerRow({
      reference: `OUT-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
      where: inB(),
    });
    const all = idsOf(await fetchAll(ownerUser));
    expect(all).toContain(a);
    expect(all).toContain(b);
    const onlyB = idsOf(await fetchAll(ownerUser, { outletId: ids.outletB }));
    expect(onlyB).toContain(b);
    expect(onlyB).not.toContain(a);
  });
});

// ---- 6. What is listed -----------------------------------------------------------

describe("EDC-02 which rows are in the queue", () => {
  it("flagged rows and unknown rows are listed; finished and non-sale rows are not", async () => {
    const tag = randomUUID().slice(0, 8);
    const ref = (n: string) => `LST-${tag}-${n}`;
    const flaggedApproved = await ledgerRow({
      reference: ref("1"),
      amountIdr: 10_000,
      status: "approved",
    });
    const flaggedDeclined = await ledgerRow({
      reference: ref("2"),
      amountIdr: 10_000,
      status: "declined",
    });
    const unknownNoFlag = await ledgerRow({
      reference: ref("3"),
      amountIdr: 10_000,
      status: "unknown",
      flagged: false,
    });
    const doneApproved = await ledgerRow({
      reference: ref("4"),
      amountIdr: 10_000,
      status: "approved",
      flagged: false,
    });
    const doneDeclined = await ledgerRow({
      reference: ref("5"),
      amountIdr: 10_000,
      status: "declined",
      flagged: false,
    });
    const flaggedVoid = await ledgerRow({
      reference: ref("6"),
      amountIdr: 10_000,
      status: "unknown",
      type: "void",
    });
    const flaggedRefund = await ledgerRow({
      reference: ref("7"),
      amountIdr: 10_000,
      status: "approved",
      type: "refund",
    });
    const listed = idsOf(await fetchAll(ownerUser, { q: `LST-${tag}` }));
    expect(listed).toContain(flaggedApproved);
    expect(listed).toContain(flaggedDeclined);
    expect(listed).toContain(unknownNoFlag);
    for (const hidden of [
      doneApproved,
      doneDeclined,
      flaggedVoid,
      flaggedRefund,
    ])
      expect(listed).not.toContain(hidden);
  });

  it("the unknown row without a flag keeps its status and dispatch time in the item", async () => {
    const dispatchedAt = new Date(Date.now() - 2 * 60_000);
    const id = await ledgerRow({
      reference: `LST-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
      flagged: false,
      dispatchedAt,
    });
    const item = await itemFor(id);
    expect(item.transaction.status).toBe("unknown");
    expect(item.transaction.needsReconciliation).toBe(false);
    expect(item.transaction.dispatchedAt).not.toBeNull();
    expect(
      Math.abs(
        new Date(item.transaction.dispatchedAt!).getTime() -
          dispatchedAt.getTime(),
      ),
    ).toBeLessThan(2_000);
  });

  it("an empty tenant queue is an empty page, not an error", async () => {
    const res = await getQueue(ownerUser, { q: `NOSUCH-${randomUUID()}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.nextCursor).toBeNull();
  });
});

// ---- 4 + 5. Parity with the POST resolve rules ---------------------------------------

// What the screen's reconciliationGate allows per row (features/
// edc-reconciliation/lib.ts, mirrored from the POST rules): an unknown sale can
// go either way, an approved one is only cleared, a declined/cancelled/failed
// one is only declared declined, a pending one nothing.
type Outcome = "approved" | "declined";
const parityCases: {
  label: string;
  status: string;
  flagged: boolean;
  allowed: Outcome[];
}[] = [
  {
    label: "unknown, past 10 min, flagged",
    status: "unknown",
    flagged: true,
    allowed: ["approved", "declined"],
  },
  {
    label: "unknown, past 10 min, no flag",
    status: "unknown",
    flagged: false,
    allowed: ["approved", "declined"],
  },
  {
    label: "approved, flagged",
    status: "approved",
    flagged: true,
    allowed: ["approved"],
  },
  {
    label: "declined, flagged",
    status: "declined",
    flagged: true,
    allowed: ["declined"],
  },
  {
    label: "cancelled, flagged",
    status: "cancelled",
    flagged: true,
    allowed: ["declined"],
  },
  {
    label: "failed, flagged",
    status: "failed",
    flagged: true,
    allowed: ["declined"],
  },
  { label: "pending, flagged", status: "pending", flagged: true, allowed: [] },
];

describe("EDC-03 the queue and the POST resolve agree on what is allowed", () => {
  for (const c of parityCases)
    for (const outcome of ["approved", "declined"] as const)
      it(`${c.label}: ${outcome} is ${c.allowed.includes(outcome) ? "accepted" : "refused"}`, async () => {
        const order = await newOrder();
        const id = await ledgerRow({
          reference: order.number,
          amountIdr: order.totalIdr,
          status: c.status,
          flagged: c.flagged,
        });
        const item = await itemFor(id);
        expect(item.transaction.status).toBe(c.status);
        expect(item.transaction.needsReconciliation).toBe(c.flagged);
        expect(item.saleWireOpenAt).toBeNull();

        const res = await resolve(ownerUser, id, outcome, order.totalIdr);
        if (c.allowed.includes(outcome)) {
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expect((await row(id)).needs_reconciliation).toBe(false);
        } else {
          expect(res.status, JSON.stringify(res.body)).toBe(409);
          expect((await row(id)).status).toBe(c.status);
          expect((await row(id)).needs_reconciliation).toBe(c.flagged);
        }
      });

  it("unknown within 10 minutes of dispatch: listed with status and dispatchedAt, and both answers are refused CONFLICT (locked)", async () => {
    const order = await newOrder();
    const dispatchedAt = new Date(Date.now() - 2 * 60_000);
    const id = await ledgerRow({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
      dispatchedAt,
    });
    const item = await itemFor(id);
    expect(item.transaction.status).toBe("unknown");
    expect(item.transaction.dispatchedAt).not.toBeNull();
    expect(item.saleWireOpenAt).toBeNull();
    for (const outcome of ["declined", "approved"] as const) {
      const res = await resolve(ownerUser, id, outcome, order.totalIdr);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error?.code, JSON.stringify(res.body)).toBe("CONFLICT");
    }
    expect(await row(id)).toMatchObject({
      status: "unknown",
      needs_reconciliation: true,
    });
  });

  it("unknown past 10 minutes without a flag: listed, and declined is accepted", async () => {
    const order = await newOrder();
    const id = await ledgerRow({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
      flagged: false,
      dispatchedAt: new Date(Date.now() - WINDOW_MS - 60_000),
    });
    const item = await itemFor(id);
    expect(item.transaction).toMatchObject({
      status: "unknown",
      needsReconciliation: false,
    });
    const res = await resolve(ownerUser, id, "declined", order.totalIdr);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await row(id)).status).toBe("declined");
  });

  it.each(["unknown", "approved", "declined"])(
    "a %s flagged row whose terminal call is still open shows saleWireOpenAt and no answer is accepted",
    async (status) => {
      const order = await newOrder();
      const id = await ledgerRow({
        reference: order.number,
        amountIdr: order.totalIdr,
        status,
      });
      await setWireOpen(id);
      const item = await itemFor(id);
      expect(item.saleWireOpenAt).not.toBeNull();
      for (const outcome of ["declined", "approved"] as const) {
        const res = await resolve(ownerUser, id, outcome, order.totalIdr);
        expect(res.status, JSON.stringify(res.body)).toBe(409);
      }
      expect((await row(id)).needs_reconciliation).toBe(true);
    },
  );
});

// ---- 7. No card data --------------------------------------------------------------

describe("EDC-06 the queue never exposes a full card number", () => {
  it("a 16-digit number stored in message, invoice no or masked pan never reaches the response", async () => {
    const id = await ledgerRow({
      reference: `PAN-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "declined",
      message: "Kartu 4111111111111111 ditolak bank",
      invoiceNo: "4111111111111111",
      maskedPan: "411111******1111",
    });
    const res = await getQueue(ownerUser, { limit: 100 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/\d{13,19}/);
    const item = (res.body.data as EdcReconciliationQueueItem[]).find(
      (i) => i.transaction.id === id,
    );
    expect(item, "the row is listed").toBeDefined();
    expect(item!.transaction.maskedPan).toMatch(/^\d{0,6}[*Xx]{2,}\d{4}$/);
    expect(item!.transaction.invoiceNo ?? "").not.toMatch(/\d{13,}/);
    expect(item!.transaction.message ?? "").not.toMatch(/\d{13,}/);
  });
});

// ---- 8. Pagination and query validation -------------------------------------------------

describe("EDC-06 queue paging, filters and strict query", () => {
  it("limit + cursor return every row exactly once, newest first", async () => {
    const tag = randomUUID().slice(0, 8);
    const seeded: string[] = [];
    for (let i = 0; i < 5; i += 1)
      seeded.push(
        await ledgerRow({
          reference: `PG-${tag}-${i}`,
          amountIdr: 10_000,
          status: "unknown",
        }),
      );
    const seen: EdcReconciliationQueueItem[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await getQueue(ownerUser, {
        q: `PG-${tag}`,
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.meta.limit).toBe(2);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...(res.body.data as EdcReconciliationQueueItem[]));
      cursor = res.body.meta.nextCursor as string | null;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(idsOf(seen).sort()).toEqual([...seeded].sort());
    expect(new Set(idsOf(seen)).size).toBe(5);
    const sorted = [...seen].sort((x, y) => {
      const a = x.transaction;
      const b = y.transaction;
      if (a.createdAt !== b.createdAt)
        return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });
    expect(idsOf(seen)).toEqual(idsOf(sorted));
  });

  it("a malformed cursor answers 422, never 500", async () => {
    const goodId = randomUUID();
    const goodDate = new Date().toISOString();
    const cursors = [
      "!!!not-a-cursor!!!",
      "aGVsbG8gd29ybGQ", // base64url of plain text, not JSON
      encodeCursor([goodDate, "not-a-uuid"]),
      encodeCursor(["not-a-date", goodId]),
      encodeCursor([goodDate]),
      encodeCursor([12, 34]),
    ];
    for (const cursor of cursors) {
      const res = await getQueue(ownerUser, { cursor });
      expect(res.status, `${cursor}: ${JSON.stringify(res.body)}`).toBe(422);
    }
  });

  it("filters by status and by search text", async () => {
    const tag = randomUUID().slice(0, 8);
    const declinedId = await ledgerRow({
      reference: `FLT-${tag}-d`,
      amountIdr: 10_000,
      status: "declined",
    });
    const unknownId = await ledgerRow({
      reference: `FLT-${tag}-u`,
      amountIdr: 10_000,
      status: "unknown",
    });
    const byQ = idsOf(await fetchAll(ownerUser, { q: `FLT-${tag}` }));
    expect(byQ.sort()).toEqual([declinedId, unknownId].sort());
    const byStatus = idsOf(
      await fetchAll(ownerUser, { q: `FLT-${tag}`, status: "declined" }),
    );
    expect(byStatus).toEqual([declinedId]);
  });

  it.each([
    ["limit 0", { limit: 0 }],
    ["limit above the maximum", { limit: 101 }],
    ["an unknown query field", { owner: "someone" }],
    ["an unknown status", { status: "bogus" }],
    ["a search text over 100 characters", { q: "x".repeat(101) }],
  ])("%s is refused as an invalid request", async (_label, query) => {
    const res = await getQueue(ownerUser, query);
    expect([400, 422], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body.data).toBeUndefined();
  });
});

// ---- 9. Labels --------------------------------------------------------------------

describe("EDC-02 each queue item carries the labels the screen shows", () => {
  it("outlet name, terminal label, bill number and what is still unpaid", async () => {
    const order = await newOrder();
    const id = await ledgerRow({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    const item = await itemFor(id);
    expect(item.outletName).toBe(outletAName);
    expect(item.terminalLabel).toContain("TID-RECON");
    expect(item.terminalLabel.toUpperCase()).toContain("BCA");
    expect(item.billNumber).toBe(order.number);
    expect(item.remainingIdr).toBe(order.totalIdr);
    expect(item.saleWireOpenAt).toBeNull();
    expect(
      item.cashierName === null || typeof item.cashierName === "string",
    ).toBe(true);
    expect(item.transaction).toMatchObject({
      id,
      reference: order.number,
      amountIdr: order.totalIdr,
      outletId: tenant.outletId,
    });
  });

  it("an outlet B row shows outlet B's name and terminal", async () => {
    const id = await ledgerRow({
      reference: `LBL-${randomUUID().slice(0, 8)}`,
      amountIdr: 10_000,
      status: "unknown",
      where: inB(),
    });
    const item = await itemFor(id);
    expect(item.outletName).toBe(outletBName);
    expect(item.terminalLabel).toContain("TID-OUTB");
  });

  it("a reference with no bill has no bill number and no remaining amount", async () => {
    const id = await ledgerRow({
      reference: `NOBILL-${randomUUID().slice(0, 8)}`,
      amountIdr: 55_000,
      status: "unknown",
    });
    const item = await itemFor(id);
    expect(item.billNumber).toBeNull();
    expect(item.remainingIdr).toBeNull();
  });
});
