// POS receipts (bead legend-93a; PRD v1.7 §3 F8/F11 "Struk & Kuitansi" and
// "Nomor Struk Berurutan"). Acceptance: POS-06 (gapless receipt numbers per
// outlet and device, a void keeps its number, offline runs merge without
// regression) and POS-07 (every e-receipt/kuitansi carries outlet name and
// address, items, tax and payment methods), plus TEN-01/TEN-03 isolation of
// the five receipt tables.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable
// server from `pnpm test`) in a fresh isolated tenant. The REAL receipt port
// is installed (no in-memory double). Each scenario uses its own outlet so
// "first receipt is #1" does not depend on test order.
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/pos-receipt.test.ts" heavy pnpm test
//
// Assumptions (spec/brief ambiguous):
//  - HTTP cash sales carry a verified device and the cashier's open shift (pos-shift),
//    so they use that device's sequence (first device of an outlet: prefix P1); the
//    cloud sequence (prefix C, device key = outlet id) is exercised through the service.
//  - Cash tender lines on a document carry the amount applied to the bill
//    (the contract requires tenders to sum to the total).
//  - Domain errors map to HTTP 409 (CONFLICT / RECEIPT_ALREADY_VOIDED) and a
//    rejected body to 4xx; unknown/expired public tokens answer 404.
//  - The receipt/email copy mentions the printed receipt number.
//  - receiptGapsForOutlet may omit gap-free sequences; absence == no holes.
//  - Review round 1 (brief "Review fixes (round 1)"): the e-receipt URL is
//    `${WEB_URL}/r/<token>` (the public API path stays /api/public/receipts/<token>);
//    merge refusals use RECEIPT_PREFIX_MISMATCH / RECEIPT_SEQUENCE_REGRESSION /
//    VALIDATION_ERROR as listed in the brief; a cash tender may carry a
//    reference, and staff documents keep it while public ones hide it.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  tenantIdSchema,
  outletIdSchema,
  ulidToUuid,
  uuidToUlid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  FakeEmailProvider,
  type EmailProvider,
} from "@starter/shared/adapters";
import {
  formatReceiptNumber,
  invoiceDocumentSchema,
  posReceiptIssueResultSchema,
  receiptDocumentSchema,
  type PosReceipt,
} from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { createPrintAgent } from "../edge/print/agent.ts";
import * as printRuntime from "../edge/print/runtime.ts";
import { createDbPrintStore } from "../edge/print/store.ts";
import { FakePrinterTransport } from "../edge/print/transport.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { setPosReceiptPort } from "../services/pos-order-ports.ts";
import {
  allocateReceipt,
  createPosReceiptPort,
  findReceiptById,
  findReceiptByNumber,
  findReceiptForOrder,
  mergeDeviceReceiptRun,
  provisionReceiptSequence,
  receiptGapsForOutlet,
  voidReceiptForOrder,
} from "../services/pos-receipt.service.ts";
import { runPosReceiptEmailJob } from "../worker/pos-receipt-email.job.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { seedEconomicDepositRefund } from "./dp-economic-refund-fixture.ts";
import { issueReceiptDeliveries } from "../services/pos-receipt-delivery.service.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  seededHostname,
  seededTenantId,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
// Same default as the test helpers; the e-receipt link starts with it.
const WEB_URL = (process.env.WEB_URL ?? "http://localhost:3101").replace(
  /\/+$/,
  "",
);
const OUTLET_NAME = "Cafe Legend Senopati";
const OUTLET_ADDRESS = "Jl. Kopi Legenda No. 12, Jakarta Selatan";
// Frozen outlet copy a receipt row carries (R2 P2); owner-SQL seeds must set it.
const SEED_SNAPSHOT = JSON.stringify({
  outletName: OUTLET_NAME,
  outletAddress: OUTLET_ADDRESS,
  legalName: null,
  npwpLast4: null,
});
const RECEIPT_TABLES = [
  "receipt_sequences",
  "pos_receipts",
  "pos_receipt_links",
  "pos_receipt_deliveries",
  "pos_invoices",
] as const;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  cashierRole: randomUUID(),
  readerRole: randomUUID(),
  viewerRole: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let reader: Member;
let viewer: Member;
let approver: Member;

/** A run clock past the email backoff window (2..16 min). */
const hoursLater = (hours: number) => new Date(Date.now() + hours * 3_600_000);

// ---- Fixtures -----------------------------------------------------------------

/** Owner-side access sets the tenant local, because RLS is FORCED. */
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

async function rows<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(text, params);
    return result.rows as T[];
  });
}

function tenantContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

async function member(
  roleId: string,
  label: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string } = {
    type: "tenant",
  },
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenant.tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
  return { client, userId };
}

/** An outlet with its own price list: first receipt there is always #1. */
async function freshOutlet(
  input: { name?: string; address?: string } = {},
): Promise<string> {
  const outletId = randomUUID();
  const priceListId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Asia/Jakarta', $8, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `R${outletId.slice(0, 8)}`.toUpperCase(),
      input.name ?? OUTLET_NAME,
      input.address ?? OUTLET_ADDRESS,
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [priceListId, tenant.tenantId, outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, priceListId, ids.kopi, KOPI_IDR],
    );
  });
  return outletId;
}

function api(outletId: string, who: Member = cashier) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos`;
  return {
    base,
    get: (path: string) =>
      who.client.get(`${base}${path}`).set(headers).set(originHeader),
    post: (path: string, body: Record<string, unknown> = {}) =>
      who.client
        .post(`${base}${path}`)
        .set(headers)
        .set(originHeader)
        .send({ idempotencyKey: randomUUID(), ...body }),
  };
}

type CashDevice = { deviceId: string; headers: Record<string, string> };
/** One registered device per (outlet, cashier), each with the cashier's open shift. */
const cashDevices = new Map<string, Promise<CashDevice>>();

/**
 * A cash tender needs a verified device and the paying cashier's open shift on
 * it (pos-shift), so HTTP cash sales take the device sequence (prefix P1), not C.
 */
function cashDeviceFor(outletId: string, who: Member): Promise<CashDevice> {
  const key = `${outletId}:${who.userId}`;
  let device = cashDevices.get(key);
  if (!device) {
    device = (async () => {
      const deviceId = randomUUID();
      const issuedAt = Math.floor(Date.now() / 1000);
      await asOwnerTenant(tenant.tenantId, async (client) => {
        await client.query(
          `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
           VALUES ($1, $2, $3, 'pos', 'Kasir uji', $4)`,
          [deviceId, tenant.tenantId, outletId, new Date(issuedAt * 1000)],
        );
      });
      const token = signDeviceToken({
        version: 1,
        tenantId: tenant.tenantId,
        brandId: tenant.brandId,
        deviceId,
        issuedAt,
      });
      const headers = { Host: "localhost", [DEVICE_TOKEN_HEADER]: token };
      const opened = await who.client
        .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/shifts`)
        .set(headers)
        .set(originHeader)
        .send({ openingFloatIdr: 100_000, idempotencyKey: randomUUID() });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      return { deviceId, headers };
    })();
    cashDevices.set(key, device);
  }
  return device;
}

/** `api` for the sale flow: sends the device token after opening the shift. */
function cashApi(outletId: string, who: Member = cashier) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos`;
  return {
    post: async (path: string, body: Record<string, unknown> = {}) => {
      const { headers: deviceHeaders } = await cashDeviceFor(outletId, who);
      return who.client
        .post(`${base}${path}`)
        .set(deviceHeaders)
        .set(originHeader)
        .send({ idempotencyKey: randomUUID(), ...body });
    },
  };
}

/** Parse a binary body (PDF) instead of letting superagent guess. */
function binary(
  res: NodeJS.ReadableStream,
  done: (error: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => done(null, Buffer.concat(chunks)));
}

function errorCode(body: { error?: { code?: string }; code?: string }) {
  return body.error?.code ?? body.code;
}

/** Order created, submitted and fully paid in cash; not yet completed. */
async function paidOrder(
  outletId: string,
  tenderReference?: string,
): Promise<{ orderId: string; status: string; totalIdr: number }> {
  const created = await cashApi(outletId).post("/orders", {
    channel: "pos",
    serviceType: "takeaway",
    items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await cashApi(outletId).post(
      `/orders/${orderId}/submit`,
      {
        expectedStatus: status,
      },
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const totalIdr = created.body.data.totalIdr as number;
  const paid = await cashApi(outletId).post(`/orders/${orderId}/tenders`, {
    method: "cash",
    receivedIdr: totalIdr + 5_000,
    ...(tenderReference ? { reference: tenderReference } : {}),
    expectedStatus: status,
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  return { orderId, status: paid.body.data.order.status as string, totalIdr };
}

/** A completed sale: this is where the real port allocates the number. */
async function completedSale(
  outletId: string,
  tenderReference?: string,
): Promise<{ orderId: string; totalIdr: number }> {
  const { orderId, status, totalIdr } = await paidOrder(
    outletId,
    tenderReference,
  );
  const completed = await cashApi(outletId).post(
    `/orders/${orderId}/complete`,
    {
      expectedStatus: status,
    },
  );
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  expect(completed.body.data.status).toBe("completed");
  return { orderId, totalIdr };
}

/** A draft order: enough for the service-level allocator (FK to pos_orders). */
async function draftOrder(outletId: string): Promise<string> {
  const created = await api(outletId).post("/orders", {
    channel: "pos",
    serviceType: "takeaway",
    items: [{ menuItemId: ids.kopi, quantity: 1, modifierIds: [] }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

async function drafts(outletId: string, count: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(await draftOrder(outletId));
  return out;
}

/**
 * A merge-ready order: owned by `deviceId` and completed, with no receipt yet.
 * Built from a draft (still editable) with owner SQL; a final order is immutable.
 */
async function deviceOrders(
  outletId: string,
  deviceId: string,
  count: number,
): Promise<string[]> {
  const out = await drafts(outletId, count);
  await asOwnerTenant(tenant.tenantId, async (client) => {
    for (const orderId of out) {
      await client.query(
        `UPDATE pos_orders SET device_id = $3 WHERE tenant_id = $1 AND order_id = $2::uuid`,
        [tenant.tenantId, ulidToUuid(orderId), deviceId],
      );
      await client.query(
        `UPDATE orders SET status = 'completed' WHERE tenant_id = $1 AND id = $2::uuid`,
        [tenant.tenantId, ulidToUuid(orderId)],
      );
    }
  });
  return out;
}

/** The cloud side of a void: the linked correction row (order stays completed). */
async function cloudVoid(
  outletId: string,
  orderId: string,
  receiptNumber: string,
  reason = "wrong_order",
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_voids
         (tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason, reason_note,
          requested_by, approved_by, override_id, voided_at)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, 'Pelanggan batal', $7, $8, $9, now())`,
      [
        tenant.tenantId,
        outletId,
        ulidToUuid(orderId),
        receiptNumber,
        KOPI_IDR,
        reason,
        cashier.userId,
        approver.userId,
        randomUUID(),
      ],
    ),
  );
}

// ---- Service access (inside a tenant transaction, like the order service) ---------

type ServiceTx = Parameters<typeof allocateReceipt>[0];

function inTx<T>(
  run: (tx: ServiceTx, context: ScopedTenantContext) => Promise<T>,
  context = tenantContext(tenant.tenantId),
): Promise<T> {
  return withTenant(db, context, (tx) => run(tx as ServiceTx, context));
}

function allocate(
  outletId: string,
  orderId: string,
  deviceId: string | null,
): Promise<PosReceipt> {
  return inTx((tx, context) =>
    allocateReceipt(tx, context, {
      orderId,
      outletId,
      deviceId,
      at: new Date(),
    }),
  );
}

type ReceiptRow = {
  id: string;
  number: string;
  sequence_number: number;
  device_id: string;
  status: string;
  reprint_count: number;
  void_reason: string | null;
};

function receiptRows(outletId: string): Promise<ReceiptRow[]> {
  return rows<ReceiptRow>(
    `SELECT id, number, sequence_number, device_id, status, reprint_count, void_reason
     FROM pos_receipts WHERE tenant_id = $1 AND outlet_id = $2
     ORDER BY number, sequence_number`,
    [tenant.tenantId, outletId],
  );
}

type SequenceRow = {
  id: string;
  prefix: string;
  last_number: number;
  device_id: string;
};

function sequenceRows(outletId: string): Promise<SequenceRow[]> {
  return rows<SequenceRow>(
    `SELECT id, prefix, last_number, device_id FROM receipt_sequences
     WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix`,
    [tenant.tenantId, outletId],
  );
}

/** What an offline device sends: its own run of receipts for the outlet. */
function offlineReceipt(input: {
  outletId: string;
  deviceId: string;
  orderId: string;
  prefix: string;
  ordinal: number;
  voided?: boolean;
}): PosReceipt {
  const at = new Date().toISOString();
  return {
    id: randomUUID(),
    tenantId: tenant.tenantId,
    outletId: input.outletId,
    orderId: input.orderId,
    deviceId: input.deviceId,
    number: formatReceiptNumber(input.prefix, input.ordinal),
    sequenceNumber: input.ordinal,
    status: input.voided ? "voided" : "issued",
    issuedAt: at,
    voidedAt: input.voided ? at : null,
    voidReason: input.voided ? "wrong_order" : null,
    voidedBy: input.voided ? cashier.userId : null,
    reprintCount: 0,
  } as unknown as PosReceipt;
}

function mergeRun(
  outletId: string,
  deviceId: string,
  prefix: string,
  lastNumber: number,
  receipts: PosReceipt[],
) {
  return inTx((tx, context) =>
    mergeDeviceReceiptRun(tx, context, {
      sequence: { outletId, deviceId, prefix, lastNumber },
      receipts,
    }),
  );
}

/** The cloud gives the device its prefix first; a merge needs that row. */
function provision(outletId: string, deviceId: string, prefix: string) {
  return inTx((tx, c) =>
    provisionReceiptSequence(tx, c, { outletId, deviceId, prefix }),
  );
}

// ---- Showcase: one finished sale with everything issued on it ------------------

type Showcase = Awaited<ReturnType<typeof buildShowcase>>;
let showcasePromise: Promise<Showcase> | undefined;
const showcase = () => (showcasePromise ??= buildShowcase());

async function buildShowcase() {
  const outletId = await freshOutlet();
  const { orderId, totalIdr } = await completedSale(outletId);
  const issueKey = randomUUID();
  const issued = await api(outletId).post(`/orders/${orderId}/receipts`, {
    deliveries: ["print", "link"],
    idempotencyKey: issueKey,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBeLessThan(300);
  const invoiceKey = randomUUID();
  const invoiceBody = {
    billedTo: {
      name: "PT Kopi Nusantara",
      address: "Jl. Sudirman No. 1, Jakarta Pusat",
      npwp: "01.234.567.8-901.234",
    },
    dueDate: "2026-12-31",
    notes: "Pesanan acara kantor",
    idempotencyKey: invoiceKey,
  };
  const invoice = await api(outletId).post(
    `/orders/${orderId}/invoices`,
    invoiceBody,
  );
  expect(invoice.status, JSON.stringify(invoice.body)).toBeLessThan(300);
  return {
    outletId,
    orderId,
    totalIdr,
    issueKey,
    issued: issued.body.data,
    invoiceBody,
    invoice: invoice.body.data,
  };
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(createPosReceiptPort());
  tenant = await createIsolatedTenant(`rcp-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  // Production resolver: a shift opens only on a device row in `devices` (pos-shift).
  setDeviceOutletResolver(createDeviceOutletResolver());
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "Receipt Kasir Uji",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "shift.cash.operate",
      ],
    ],
    [ids.readerRole, "Receipt Pembaca Uji", ["order.view"]],
    [ids.viewerRole, "Receipt Tanpa POS", ["floor.table.view"]],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "Receipt Kasir");
  reader = await member(ids.readerRole, "Receipt Pembaca");
  viewer = await member(ids.viewerRole, "Receipt Tamu");
  approver = await member(ids.cashierRole, "Receipt Supervisor");
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Receipt Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    // PBJT 10% on F&B, menu prices exclude tax: 2 x Rp25.000 is billed
    // Rp55.000 (Rp5.000 tax), no service charge rule.
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
       VALUES ($1, $2, NULL, 'PBJT-RCP', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
  });
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  // Receipts, links and final orders are append-only, so the isolated tenant
  // stays in the disposable database; give it a valid creator so the platform
  // tenant list still parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- POS-06: numbering ----------------------------------------------------------

describe("POS-06 gapless receipt numbers (legend-93a)", () => {
  it("POS-06 completed sales get numbers 1..n on the device sequence, with no gap", async () => {
    const outletId = await freshOutlet();
    const orderIds: string[] = [];
    for (let i = 0; i < 4; i += 1)
      orderIds.push((await completedSale(outletId)).orderId);

    const receipts = await receiptRows(outletId);
    expect(receipts.map((row) => row.number)).toEqual([
      "P1-000001",
      "P1-000002",
      "P1-000003",
      "P1-000004",
    ]);
    // A cash sale over HTTP carries a verified device (pos-shift), so it takes
    // that device's sequence, not the outlet's cloud one.
    const { deviceId } = await cashDeviceFor(outletId, cashier);
    for (const row of receipts) expect(row.device_id).toBe(deviceId);
    const sequences = await sequenceRows(outletId);
    expect(sequences).toHaveLength(1);
    expect(sequences[0]).toMatchObject({
      prefix: "P1",
      device_id: deviceId,
      last_number: 4,
    });

    // The cashier screen shows the number of each order, in sale order.
    const detail = await api(outletId).get(`/orders/${orderIds[2]}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.receipt).toMatchObject({
      number: "P1-000003",
      status: "issued",
    });
    expect(
      await inTx((tx, c) => receiptGapsForOutlet(tx, c, outletId)),
    ).toEqual([]);
  });

  it("POS-06 concurrent completions stay gapless and unique", async () => {
    const outletId = await freshOutlet();
    const pending = [];
    for (let i = 0; i < 6; i += 1) pending.push(await paidOrder(outletId));
    const results = await Promise.all(
      pending.map(({ orderId, status }) =>
        cashApi(outletId).post(`/orders/${orderId}/complete`, {
          expectedStatus: status,
        }),
      ),
    );
    for (const result of results)
      expect(result.status, JSON.stringify(result.body)).toBe(200);

    const receipts = await receiptRows(outletId);
    expect(receipts.map((row) => row.sequence_number)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(new Set(receipts.map((row) => row.number)).size).toBe(6);
    // The first sale of a fresh outlet provisioned exactly one sequence even
    // though six completions raced for it.
    expect(await sequenceRows(outletId)).toHaveLength(1);
  });

  it("POS-06 two devices in one outlet get distinct prefixes and their own runs from 1", async () => {
    const outletId = await freshOutlet();
    const [a1, a2, b1] = await drafts(outletId, 3);
    const deviceA = randomUUID();
    const deviceB = randomUUID();

    const first = await allocate(outletId, a1!, deviceA);
    const second = await allocate(outletId, a2!, deviceA);
    const other = await allocate(outletId, b1!, deviceB);

    expect(first).toMatchObject({
      number: "P1-000001",
      sequenceNumber: 1,
      deviceId: deviceA,
      status: "issued",
    });
    expect(second).toMatchObject({ number: "P1-000002", sequenceNumber: 2 });
    expect(other).toMatchObject({
      number: "P2-000001",
      sequenceNumber: 1,
      deviceId: deviceB,
    });
    expect(other.number).not.toBe(first.number);
  });

  it("POS-06 devices racing in one outlet each keep a gapless run", async () => {
    const outletId = await freshOutlet();
    const orderIds = await drafts(outletId, 6);
    const deviceA = randomUUID();
    const deviceB = randomUUID();
    const received = await Promise.all(
      orderIds.map((orderId, index) =>
        allocate(outletId, orderId, index % 2 === 0 ? deviceA : deviceB),
      ),
    );
    const numbers = received.map((receipt) => receipt.number);
    expect(new Set(numbers).size).toBe(6);
    for (const device of [deviceA, deviceB]) {
      const run = received
        .filter((receipt) => receipt.deviceId === device)
        .map((receipt) => receipt.sequenceNumber)
        .sort((x, y) => x - y);
      expect(run).toEqual([1, 2, 3]);
    }
    const prefixes = (await sequenceRows(outletId)).map((row) => row.prefix);
    expect(new Set(prefixes).size).toBe(2);
  });

  it("POS-06 a sale without a device uses the outlet's own sequence", async () => {
    const outletId = await freshOutlet();
    const [one, two] = await drafts(outletId, 2);
    const first = await allocate(outletId, one!, null);
    const second = await allocate(outletId, two!, null);
    expect(first.deviceId).toBe(outletId);
    expect(first.number).toBe("C-000001");
    expect(second.number).toBe("C-000002");
    const sequences = await sequenceRows(outletId);
    expect(sequences).toHaveLength(1);
    expect(sequences[0]).toMatchObject({ device_id: outletId, last_number: 2 });
  });

  it("POS-06 ordinal 1,000,000 is stored in full as <prefix>-1000000, not truncated", async () => {
    const outletId = await freshOutlet();
    const [one, two] = await drafts(outletId, 2);
    const device = randomUUID();
    await inTx((tx, c) =>
      provisionReceiptSequence(tx, c, {
        outletId,
        deviceId: device,
        prefix: "BIG1",
      }),
    );
    // Advance the counter as if 999,999 receipts were already printed.
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `UPDATE receipt_sequences SET last_number = 999999
         WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3`,
        [tenant.tenantId, outletId, device],
      ),
    );

    const millionth = await allocate(outletId, one!, device);
    expect(millionth).toMatchObject({
      number: "BIG1-1000000",
      sequenceNumber: 1_000_000,
      deviceId: device,
    });
    const next = await allocate(outletId, two!, device);
    expect(next.number).toBe("BIG1-1000001");

    const stored = await receiptRows(outletId);
    expect(stored.map((row) => [row.number, row.sequence_number])).toEqual([
      ["BIG1-1000000", 1_000_000],
      ["BIG1-1000001", 1_000_001],
    ]);
    expect((await sequenceRows(outletId))[0]).toMatchObject({
      last_number: 1_000_001,
    });
  });

  it("POS-06 asking again for the same order returns the same receipt and uses no new number", async () => {
    const outletId = await freshOutlet();
    const orderId = await draftOrder(outletId);
    const first = await allocate(outletId, orderId, null);
    const again = await allocate(outletId, orderId, null);
    expect(again).toEqual(first);
    expect((await sequenceRows(outletId))[0]?.last_number).toBe(1);
    expect(await receiptRows(outletId)).toHaveLength(1);
    // The order lookup finds it, by id and by number too.
    expect(await inTx((tx, c) => findReceiptForOrder(tx, c, orderId))).toEqual(
      first,
    );
    expect(await inTx((tx, c) => findReceiptById(tx, c, first.id))).toEqual(
      first,
    );
    expect(
      await inTx((tx, c) => findReceiptByNumber(tx, c, outletId, first.number)),
    ).toEqual(first);
  });

  it("POS-06 a rolled-back sale does not consume a number", async () => {
    const outletId = await freshOutlet();
    const [one, lost, two, first] = await drafts(outletId, 4);
    const device = randomUUID();
    expect((await allocate(outletId, one!, device)).number).toBe("P1-000001");

    await expect(
      inTx(async (tx, context) => {
        const receipt = await allocateReceipt(tx, context, {
          orderId: lost!,
          outletId,
          deviceId: device,
          at: new Date(),
        });
        expect(receipt.number).toBe("P1-000002");
        throw new Error("sale failed after numbering");
      }),
    ).rejects.toThrow("sale failed after numbering");

    expect((await allocate(outletId, two!, device)).number).toBe("P1-000002");
    expect((await sequenceRows(outletId))[0]?.last_number).toBe(2);
    // The lost order has no receipt.
    expect(await inTx((tx, c) => findReceiptForOrder(tx, c, lost!))).toBeNull();

    // Even the sequence created by a rolled-back first sale is rolled back.
    const fresh = randomUUID();
    await expect(
      inTx(async (tx, context) => {
        await allocateReceipt(tx, context, {
          orderId: first!,
          outletId,
          deviceId: fresh,
          at: new Date(),
        });
        throw new Error("rollback first sale");
      }),
    ).rejects.toThrow("rollback first sale");
    expect(
      (await sequenceRows(outletId)).filter((row) => row.device_id === fresh),
    ).toHaveLength(0);
  });

  it("POS-06 a voided receipt keeps its number, is not reused, and a second void is refused", async () => {
    const outletId = await freshOutlet();
    const [one, two] = await drafts(outletId, 2);
    const issued = await allocate(outletId, one!, null);
    const voidedBy = userIdSchema.parse(cashier.userId);

    const voided = await inTx((tx, c) =>
      voidReceiptForOrder(tx, c, {
        orderId: one!,
        reason: "wrong_order",
        voidedBy,
        at: new Date(),
      }),
    );
    expect(voided).toMatchObject({
      id: issued.id,
      number: issued.number,
      status: "voided",
      voidReason: "wrong_order",
      voidedBy,
    });
    expect(voided?.voidedAt).toEqual(expect.any(String));

    await expect(
      inTx((tx, c) =>
        voidReceiptForOrder(tx, c, {
          orderId: one!,
          reason: "wrong_order",
          voidedBy,
          at: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ code: "RECEIPT_ALREADY_VOIDED" });

    // The number stays on record and the next sale does not take it over.
    const next = await allocate(outletId, two!, null);
    expect(next.number).toBe("C-000002");
    const stored = await receiptRows(outletId);
    expect(stored.map((row) => [row.number, row.status])).toEqual([
      ["C-000001", "voided"],
      ["C-000002", "issued"],
    ]);
    // A void only touches that receipt.
    expect(
      await inTx((tx, c) =>
        voidReceiptForOrder(tx, c, {
          orderId: uuidToUlid(randomUUID()),
          reason: "wrong_order",
          voidedBy,
          at: new Date(),
        }),
      ),
    ).toBeNull();
  });

  it("POS-06 an explicit prefix is accepted before the first number and refused to change after", async () => {
    const outletId = await freshOutlet();
    const [one] = await drafts(outletId, 1);
    const device = randomUUID();
    const provisioned = await inTx((tx, c) =>
      provisionReceiptSequence(tx, c, {
        outletId,
        deviceId: device,
        prefix: "KSR1",
      }),
    );
    expect(provisioned).toMatchObject({
      prefix: "KSR1",
      lastNumber: 0,
      deviceId: device,
    });
    expect((await allocate(outletId, one!, device)).number).toBe("KSR1-000001");
    await expect(
      inTx((tx, c) =>
        provisionReceiptSequence(tx, c, {
          outletId,
          deviceId: device,
          prefix: "KSR2",
        }),
      ),
    ).rejects.toThrow();
    expect((await sequenceRows(outletId))[0]?.prefix).toBe("KSR1");
  });

  it("POS-06 an outlet with no receipts has no gaps to report", async () => {
    const outletId = await freshOutlet();
    expect(
      await inTx((tx, c) => receiptGapsForOutlet(tx, c, outletId)),
    ).toEqual([]);
    expect(
      await inTx((tx, c) =>
        findReceiptForOrder(tx, c, uuidToUlid(randomUUID())),
      ),
    ).toBeNull();
  });

  it("POS-06 the gap report names the missing number of a device run", async () => {
    const outletId = await freshOutlet();
    const [o1, o3, o4] = await drafts(outletId, 3);
    const holey = randomUUID();
    const clean = randomUUID();
    // Owner-side seed: a device run 1..3 where receipt 2 never arrived.
    const holeySeq = randomUUID();
    const cleanSeq = randomUUID();
    await asOwnerTenant(tenant.tenantId, async (client) => {
      for (const [id, device, prefix, last] of [
        [holeySeq, holey, "HOLE", 3],
        [cleanSeq, clean, "OKAY", 1],
      ] as const)
        await client.query(
          `INSERT INTO receipt_sequences (id, tenant_id, outlet_id, device_id, prefix, last_number)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, tenant.tenantId, outletId, device, prefix, last],
        );
      for (const [order, seq, device, prefix, ordinal] of [
        [o1, holeySeq, holey, "HOLE", 1],
        [o3, holeySeq, holey, "HOLE", 3],
        [o4, cleanSeq, clean, "OKAY", 1],
      ] as const)
        await client.query(
          `INSERT INTO pos_receipts
             (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status, issued_at, outlet_snapshot)
           VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'issued', now(), $8::jsonb)`,
          [
            tenant.tenantId,
            outletId,
            ulidToUuid(order!),
            seq,
            device,
            formatReceiptNumber(prefix, ordinal),
            ordinal,
            SEED_SNAPSHOT,
          ],
        );
    });
    const gaps = await inTx((tx, c) => receiptGapsForOutlet(tx, c, outletId));
    expect(gaps.find((gap) => gap.deviceId === holey)).toMatchObject({
      sequenceId: holeySeq,
      prefix: "HOLE",
      lastNumber: 3,
      missing: [2],
    });
    expect(gaps.find((gap) => gap.deviceId === clean)?.missing ?? []).toEqual(
      [],
    );
  });
});

// ---- POS-06: offline merge ---------------------------------------------------------

describe("POS-06 merge of an offline device run (legend-93a)", () => {
  it("POS-06 a device run merges once, replays idempotently and refuses regressions and prefix changes", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    const [o1, o2, o3, o4, o5, other] = await deviceOrders(outletId, device, 6);
    await provision(outletId, device, "OFF1");
    const base = { outletId, deviceId: device, prefix: "OFF1" };
    const run = (orderIds: string[], from = 1) =>
      orderIds.map((orderId, index) =>
        offlineReceipt({ ...base, orderId, ordinal: from + index }),
      );

    const merged = await mergeRun(
      outletId,
      device,
      "OFF1",
      3,
      run([o1!, o2!, o3!]),
    );
    expect(merged.inserted).toBe(3);
    expect(merged.sequence).toMatchObject({
      prefix: "OFF1",
      lastNumber: 3,
      deviceId: device,
    });
    expect((await receiptRows(outletId)).map((row) => row.number)).toEqual([
      "OFF1-000001",
      "OFF1-000002",
      "OFF1-000003",
    ]);

    // Replay of the same run: nothing new, nothing refused.
    const replay = await mergeRun(
      outletId,
      device,
      "OFF1",
      3,
      run([o1!, o2!, o3!]),
    );
    expect(replay.inserted).toBe(0);
    expect(await receiptRows(outletId)).toHaveLength(3);

    // A stale device re-sends an earlier batch that is already stored
    // identically: accepted as a no-op (see the stale replay test below).
    const staleReplay = await mergeRun(
      outletId,
      device,
      "OFF1",
      2,
      run([o1!, o2!]),
    );
    expect(staleReplay.inserted).toBe(0);
    expect(await receiptRows(outletId)).toHaveLength(3);
    // A stale batch that would reissue number 2 to another order is refused.
    await expect(
      mergeRun(outletId, device, "OFF1", 2, [
        offlineReceipt({ ...base, orderId: o1!, ordinal: 1 }),
        offlineReceipt({ ...base, orderId: other!, ordinal: 2 }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE_REGRESSION" });
    // An ordinal already used by another order is a regression too.
    await expect(
      mergeRun(
        outletId,
        device,
        "OFF1",
        3,
        run([other!]), // ordinal 1 again, but for a different order
      ),
    ).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE_REGRESSION" });
    // Another prefix for the same device never merges.
    await expect(
      mergeRun(
        outletId,
        device,
        "OFF2",
        3,
        [o1!, o2!, o3!].map((orderId, index) =>
          offlineReceipt({
            ...base,
            prefix: "OFF2",
            orderId,
            ordinal: index + 1,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "RECEIPT_PREFIX_MISMATCH" });
    // Refusals changed nothing.
    expect(await receiptRows(outletId)).toHaveLength(3);
    expect((await sequenceRows(outletId))[0]).toMatchObject({
      prefix: "OFF1",
      last_number: 3,
    });

    // A later run moves the sequence forward.
    const forward = await mergeRun(
      outletId,
      device,
      "OFF1",
      5,
      run([o4!, o5!], 4),
    );
    expect(forward.inserted).toBe(2);
    expect(forward.sequence.lastNumber).toBe(5);
    const gaps = await inTx((tx, c) => receiptGapsForOutlet(tx, c, outletId));
    for (const gap of gaps) expect(gap.missing).toEqual([]);
  });

  it("POS-06 a device id equal to the outlet id is refused: that sequence belongs to the cloud", async () => {
    const outletId = await freshOutlet();
    const [o1] = await drafts(outletId, 1);
    await expect(
      mergeRun(outletId, outletId, "P1", 1, [
        offlineReceipt({
          outletId,
          deviceId: outletId,
          prefix: "P1",
          orderId: o1!,
          ordinal: 1,
        }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_PREFIX_MISMATCH" });
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toHaveLength(0);
  });

  it("POS-06 a device cannot claim a last number beyond the receipts it sends", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    const [o1, o2, o3, o4] = await deviceOrders(outletId, device, 4);
    await provision(outletId, device, "OFF1");
    const base = { outletId, deviceId: device, prefix: "OFF1" };
    // Round 2: a claim beyond the sent receipts leaves ordinals missing, so it
    // is refused as RECEIPT_SEQUENCE_GAP (was VALIDATION_ERROR in round 1).

    // First run: claims 5 but sends only 1..3.
    await expect(
      mergeRun(outletId, device, "OFF1", 5, [
        offlineReceipt({ ...base, orderId: o1!, ordinal: 1 }),
        offlineReceipt({ ...base, orderId: o2!, ordinal: 2 }),
        offlineReceipt({ ...base, orderId: o3!, ordinal: 3 }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE_GAP" });
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 0 }]);

    // After a good run to 3, a later run sending only #4 cannot claim 6.
    await mergeRun(outletId, device, "OFF1", 3, [
      offlineReceipt({ ...base, orderId: o1!, ordinal: 1 }),
      offlineReceipt({ ...base, orderId: o2!, ordinal: 2 }),
      offlineReceipt({ ...base, orderId: o3!, ordinal: 3 }),
    ]);
    await expect(
      mergeRun(outletId, device, "OFF1", 6, [
        offlineReceipt({ ...base, orderId: o4!, ordinal: 4 }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE_GAP" });
    expect(await receiptRows(outletId)).toHaveLength(3);
    expect((await sequenceRows(outletId))[0]).toMatchObject({ last_number: 3 });
  });

  it("POS-06 a stale replay of an earlier batch is a no-op and the sequence stays put", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    const [o1, o2, o3, o4] = await deviceOrders(outletId, device, 4);
    await provision(outletId, device, "OFF1");
    const base = { outletId, deviceId: device, prefix: "OFF1" };
    const batch = (orderIds: string[], from: number) =>
      orderIds.map((orderId, index) =>
        offlineReceipt({ ...base, orderId, ordinal: from + index }),
      );

    await mergeRun(outletId, device, "OFF1", 2, batch([o1!, o2!], 1));
    await mergeRun(outletId, device, "OFF1", 4, batch([o3!, o4!], 3));
    const before = await receiptRows(outletId);
    expect(before.map((row) => row.number)).toEqual([
      "OFF1-000001",
      "OFF1-000002",
      "OFF1-000003",
      "OFF1-000004",
    ]);

    // The device retries its first batch (lastNumber 2 < cloud 4).
    const stale = await mergeRun(
      outletId,
      device,
      "OFF1",
      2,
      batch([o1!, o2!], 1),
    );
    expect(stale.inserted).toBe(0);
    expect(await receiptRows(outletId)).toEqual(before);
    expect((await sequenceRows(outletId))[0]).toMatchObject({ last_number: 4 });
  });

  it("POS-06 an offline receipt for an order of another outlet or an unknown order is refused", async () => {
    const outletId = await freshOutlet();
    const elsewhere = await freshOutlet();
    const device = randomUUID();
    // Completed and owned by the same device: only its outlet is wrong.
    const [foreignOrder] = await deviceOrders(elsewhere, device, 1);
    await provision(outletId, device, "OFF1");
    const base = { outletId, deviceId: device, prefix: "OFF1" };

    await expect(
      mergeRun(outletId, device, "OFF1", 1, [
        offlineReceipt({ ...base, orderId: foreignOrder!, ordinal: 1 }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_PREFIX_MISMATCH" });
    await expect(
      mergeRun(outletId, device, "OFF1", 1, [
        offlineReceipt({
          ...base,
          orderId: uuidToUlid(randomUUID()),
          ordinal: 1,
        }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_PREFIX_MISMATCH" });
    for (const id of [outletId, elsewhere])
      expect(await receiptRows(id)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 0 }]);
    expect(await sequenceRows(elsewhere)).toHaveLength(0);
  });

  it("POS-06 a receipt voided offline is voided in the cloud and keeps its number", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    const [o1, o2] = await deviceOrders(outletId, device, 2);
    await provision(outletId, device, "OFF1");
    const base = { outletId, deviceId: device, prefix: "OFF1" };
    await mergeRun(outletId, device, "OFF1", 2, [
      offlineReceipt({ ...base, orderId: o1!, ordinal: 1 }),
      offlineReceipt({ ...base, orderId: o2!, ordinal: 2 }),
    ]);
    // The cloud void went through the approval path (pos_order_voids row).
    await cloudVoid(outletId, o1!, "OFF1-000001");
    const replay = await mergeRun(outletId, device, "OFF1", 2, [
      offlineReceipt({ ...base, orderId: o1!, ordinal: 1, voided: true }),
      offlineReceipt({ ...base, orderId: o2!, ordinal: 2 }),
    ]);
    expect(replay.inserted).toBe(0);
    const stored = await receiptRows(outletId);
    expect(stored.map((row) => [row.number, row.status])).toEqual([
      ["OFF1-000001", "voided"],
      ["OFF1-000002", "issued"],
    ]);
    expect(stored[0]?.void_reason).toBe("wrong_order");
  });
});

// ---- POS-06: merge completeness (Round 2 P1) -------------------------------------
// Assumptions: a batch that would leave ordinals 1..lastNumber incomplete is
// refused as RECEIPT_SEQUENCE_GAP and writes nothing (the provisioned sequence
// row stays at last_number 0); the exact shape of `details.missing` is not asserted.

describe("POS-06 merge never advances past a hole (legend-93a round 2)", () => {
  const gapsOf = async (outletId: string, device: string) =>
    (await inTx((tx, c) => receiptGapsForOutlet(tx, c, outletId))).find(
      (gap) => gap.deviceId === device,
    )?.missing ?? [];

  it("POS-06 a last number that is not a receipt ordinal or a malformed device header is refused before any write", async () => {
    const outletId = await freshOutlet();
    const [o1] = await drafts(outletId, 1);
    const device = randomUUID();
    const base = { outletId, deviceId: device, prefix: "BAD1" };
    for (const lastNumber of [1e12, 1.5, -1])
      await expect(
        mergeRun(outletId, device, "BAD1", lastNumber, [
          offlineReceipt({ ...base, orderId: o1!, ordinal: 1 }),
        ]),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const badHeader = {
      ...offlineReceipt({ ...base, orderId: o1!, ordinal: 1 }),
      outletSnapshot: { outletName: "", outletAddress: 7 },
    } as unknown as PosReceipt;
    await expect(
      mergeRun(outletId, device, "BAD1", 1, [badHeader]),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await receiptRows(outletId)).toEqual([]);
    expect(await sequenceRows(outletId)).toEqual([]);
  });

  it("POS-06 a sparse batch is refused with RECEIPT_SEQUENCE_GAP and writes nothing; the missing numbers then merge in order", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    const [o1, o2, o3] = await deviceOrders(outletId, device, 3);
    await provision(outletId, device, "OFF1");
    const base = { outletId, deviceId: device, prefix: "OFF1" };

    // lastNumber 3 but only #3 sent, empty cloud: 1 and 2 are missing.
    await expect(
      mergeRun(outletId, device, "OFF1", 3, [
        offlineReceipt({ ...base, orderId: o3!, ordinal: 3 }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE_GAP" });
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 0 }]);

    const first = await mergeRun(outletId, device, "OFF1", 2, [
      offlineReceipt({ ...base, orderId: o1!, ordinal: 1 }),
      offlineReceipt({ ...base, orderId: o2!, ordinal: 2 }),
    ]);
    expect(first.inserted).toBe(2);
    expect(first.sequence.lastNumber).toBe(2);

    const last = await mergeRun(outletId, device, "OFF1", 3, [
      offlineReceipt({ ...base, orderId: o3!, ordinal: 3 }),
    ]);
    expect(last.inserted).toBe(1);
    expect(last.sequence.lastNumber).toBe(3);
    expect((await receiptRows(outletId)).map((row) => row.number)).toEqual([
      "OFF1-000001",
      "OFF1-000002",
      "OFF1-000003",
    ]);
    expect(await gapsOf(outletId, device)).toEqual([]);
  });

  it("POS-06 a batch that skips ahead of the cloud is refused and the cloud sequence stays put", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    const [o1, o2, o4] = await deviceOrders(outletId, device, 3);
    await provision(outletId, device, "OFF1");
    const base = { outletId, deviceId: device, prefix: "OFF1" };
    await mergeRun(outletId, device, "OFF1", 2, [
      offlineReceipt({ ...base, orderId: o1!, ordinal: 1 }),
      offlineReceipt({ ...base, orderId: o2!, ordinal: 2 }),
    ]);
    // #4 arrives alone with lastNumber 4: #3 is missing everywhere.
    await expect(
      mergeRun(outletId, device, "OFF1", 4, [
        offlineReceipt({ ...base, orderId: o4!, ordinal: 4 }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE_GAP" });
    expect(await receiptRows(outletId)).toHaveLength(2);
    expect((await sequenceRows(outletId))[0]).toMatchObject({ last_number: 2 });
  });

  it("legend-xlvvl d: a written-off number never lets a device run advance; the merge still refuses RECEIPT_SEQUENCE_GAP", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    const [o1, o3] = await deviceOrders(outletId, device, 2);
    await provision(outletId, device, "OFFW");
    const sequenceId = (await sequenceRows(outletId))[0]!.id;
    const base = { outletId, deviceId: device, prefix: "OFFW" };
    // Assumption: the cloud sequence is brought to last_number 2 by owner SQL
    // (as the write-off tests seed theirs), and the owner wrote off number 2
    // (no receipt, within last_number, as the database trigger demands).
    await rows(
      `UPDATE receipt_sequences SET last_number = 2
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, sequenceId],
    );
    await rows(
      `INSERT INTO receipt_number_writeoffs
         (id, tenant_id, outlet_id, sequence_id, prefix, sequence_number, reason, written_off_by)
       VALUES ($1, $2, $3, $4, 'OFFW', 2, 'Struk hilang bersama printer rusak', $5)`,
      [randomUUID(), tenant.tenantId, outletId, sequenceId, cashier.userId],
    );

    // The device advances to 3 with receipts 1 and 3 but not 2; the cloud holds
    // none. Number 2 is written off, yet the merge counts real receipts only.
    await expect(
      mergeRun(outletId, device, "OFFW", 3, [
        offlineReceipt({ ...base, orderId: o1!, ordinal: 1 }),
        offlineReceipt({ ...base, orderId: o3!, ordinal: 3 }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE_GAP" });
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect((await sequenceRows(outletId))[0]).toMatchObject({ last_number: 2 });
  });

  it("POS-06 a late replay of an earlier batch after a full run is a no-op without error", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    const [o1, o2, o3] = await deviceOrders(outletId, device, 3);
    await provision(outletId, device, "OFF1");
    const base = { outletId, deviceId: device, prefix: "OFF1" };
    const receipt = (orderId: string, ordinal: number) =>
      offlineReceipt({ ...base, orderId, ordinal });

    await mergeRun(outletId, device, "OFF1", 3, [
      receipt(o1!, 1),
      receipt(o2!, 2),
      receipt(o3!, 3),
    ]);
    const before = await receiptRows(outletId);
    // Reversed arrival: the early batch (#1,#2, lastNumber 2) shows up late.
    const late = await mergeRun(outletId, device, "OFF1", 2, [
      receipt(o1!, 1),
      receipt(o2!, 2),
    ]);
    expect(late.inserted).toBe(0);
    expect(late.sequence.lastNumber).toBe(3);
    expect(await receiptRows(outletId)).toEqual(before);
    expect((await sequenceRows(outletId))[0]).toMatchObject({ last_number: 3 });
    expect(await gapsOf(outletId, device)).toEqual([]);
  });

  it("POS-06 a batch with the missing number below the cloud last number backfills it and closes the gap", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    const [o1, o2, o3] = await deviceOrders(outletId, device, 3);
    const base = { outletId, deviceId: device, prefix: "BACK" };
    const sequenceId = randomUUID();
    // Owner-side seed that bypasses the service: last_number 3, receipts #1 and #3.
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `INSERT INTO receipt_sequences (id, tenant_id, outlet_id, device_id, prefix, last_number)
         VALUES ($1, $2, $3, $4, 'BACK', 3)`,
        [sequenceId, tenant.tenantId, outletId, device],
      );
      for (const [order, ordinal] of [
        [o1!, 1],
        [o3!, 3],
      ] as const)
        await client.query(
          `INSERT INTO pos_receipts
             (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status, issued_at, outlet_snapshot)
           VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'issued', now(), $8::jsonb)`,
          [
            tenant.tenantId,
            outletId,
            ulidToUuid(order),
            sequenceId,
            device,
            formatReceiptNumber("BACK", ordinal),
            ordinal,
            SEED_SNAPSHOT,
          ],
        );
    });
    expect(await gapsOf(outletId, device)).toEqual([2]);

    const merged = await mergeRun(outletId, device, "BACK", 3, [
      offlineReceipt({ ...base, orderId: o2!, ordinal: 2 }),
    ]);
    expect(merged.inserted).toBe(1);
    expect(merged.sequence.lastNumber).toBe(3);
    expect((await receiptRows(outletId)).map((row) => row.number)).toEqual([
      "BACK-000001",
      "BACK-000002",
      "BACK-000003",
    ]);
    expect(await gapsOf(outletId, device)).toEqual([]);
  });

  it("POS-06 a late batch #2,#1 with a lower lastNumber backfills a cloud that already holds only #3 (second-opinion P1)", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    const [o1, o2, o3] = await deviceOrders(outletId, device, 3);
    const base = { outletId, deviceId: device, prefix: "LATE" };
    const sequenceId = randomUUID();
    // The state an earlier merge left behind: last_number 3, only #3 stored.
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `INSERT INTO receipt_sequences (id, tenant_id, outlet_id, device_id, prefix, last_number)
         VALUES ($1, $2, $3, $4, 'LATE', 3)`,
        [sequenceId, tenant.tenantId, outletId, device],
      );
      await client.query(
        `INSERT INTO pos_receipts
           (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status, issued_at, outlet_snapshot)
         VALUES ($1, $2, $3::uuid, $4, $5, $6, 3, 'issued', now(), $7::jsonb)`,
        [
          tenant.tenantId,
          outletId,
          ulidToUuid(o3!),
          sequenceId,
          device,
          formatReceiptNumber("LATE", 3),
          SEED_SNAPSHOT,
        ],
      );
    });
    expect(await gapsOf(outletId, device)).toEqual([1, 2]);

    // The late batch, in reverse order, with the device's lastNumber 2 < 3.
    const merged = await mergeRun(outletId, device, "LATE", 2, [
      offlineReceipt({ ...base, orderId: o2!, ordinal: 2 }),
      offlineReceipt({ ...base, orderId: o1!, ordinal: 1 }),
    ]);
    expect(merged.inserted).toBe(2);
    expect(merged.sequence.lastNumber).toBe(3);
    expect((await receiptRows(outletId)).map((row) => row.number)).toEqual([
      "LATE-000001",
      "LATE-000002",
      "LATE-000003",
    ]);
    expect(await gapsOf(outletId, device)).toEqual([]);
  });

  it("POS-06 an ordinal already stored for another order is RECEIPT_SEQUENCE_REGRESSION and the whole batch is refused", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    const [o1, o2, o3] = await deviceOrders(outletId, device, 3);
    await provision(outletId, device, "OFF1");
    const base = { outletId, deviceId: device, prefix: "OFF1" };
    await mergeRun(outletId, device, "OFF1", 1, [
      offlineReceipt({ ...base, orderId: o1!, ordinal: 1 }),
    ]);
    // A later batch that moves forward but gives #1 to a different order.
    await expect(
      mergeRun(outletId, device, "OFF1", 3, [
        offlineReceipt({ ...base, orderId: o2!, ordinal: 1 }),
        offlineReceipt({ ...base, orderId: o3!, ordinal: 2 }),
        offlineReceipt({ ...base, orderId: o1!, ordinal: 3 }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE_REGRESSION" });
    expect((await receiptRows(outletId)).map((row) => row.number)).toEqual([
      "OFF1-000001",
    ]);
    expect((await sequenceRows(outletId))[0]).toMatchObject({ last_number: 1 });
  });
});

// ---- POS-06: database backstop ------------------------------------------------------

describe("POS-06 the database refuses to rewrite receipts (legend-93a)", () => {
  it("POS-06 receipts cannot be deleted or renumbered and sequences cannot move backwards", async () => {
    const outletId = await freshOutlet();
    const [one, two, three] = await drafts(outletId, 3);
    const receipt = await allocate(outletId, one!, null);
    await allocate(outletId, two!, null);
    const [sequence] = await sequenceRows(outletId);

    const attempt = (text: string, params: unknown[] = []) =>
      asOwnerTenant(tenant.tenantId, (client) => client.query(text, params));

    await expect(
      attempt("DELETE FROM pos_receipts WHERE tenant_id = $1 AND id = $2", [
        tenant.tenantId,
        receipt.id,
      ]),
    ).rejects.toThrow(/POS-06/);
    await expect(
      attempt(
        "UPDATE pos_receipts SET number = 'C-000099' WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, receipt.id],
      ),
    ).rejects.toThrow(/POS-06/);
    await expect(
      attempt(
        "UPDATE pos_receipts SET sequence_number = 2 WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, receipt.id],
      ),
    ).rejects.toThrow(/POS-06/);

    // Sequence: never down, never deleted.
    await expect(
      attempt(
        "UPDATE receipt_sequences SET last_number = 1 WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, sequence!.id],
      ),
    ).rejects.toThrow(/POS-06/);
    await expect(
      attempt(
        "DELETE FROM receipt_sequences WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, sequence!.id],
      ),
    ).rejects.toThrow(/POS-06/);

    // A receipt that names another prefix, or a number the device has not
    // issued yet, is refused at insert.
    for (const [number, ordinal] of [
      ["ZZ-000001", 1],
      ["C-000099", 99],
    ] as const)
      await expect(
        attempt(
          `INSERT INTO pos_receipts
             (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status, issued_at, outlet_snapshot)
           VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'issued', now(), $8::jsonb)`,
          [
            tenant.tenantId,
            outletId,
            ulidToUuid(three!),
            sequence!.id,
            outletId,
            number,
            ordinal,
            SEED_SNAPSHOT,
          ],
        ),
      ).rejects.toThrow(/POS-06/);

    // Nothing changed.
    expect((await receiptRows(outletId)).map((row) => row.number)).toEqual([
      "C-000001",
      "C-000002",
    ]);
    expect((await sequenceRows(outletId))[0]?.last_number).toBe(2);
  });

  it("POS-06 a voided receipt cannot be reopened", async () => {
    const outletId = await freshOutlet();
    const [one] = await drafts(outletId, 1);
    const receipt = await allocate(outletId, one!, null);
    await inTx((tx, c) =>
      voidReceiptForOrder(tx, c, {
        orderId: one!,
        reason: "wrong_order",
        voidedBy: userIdSchema.parse(cashier.userId),
        at: new Date(),
      }),
    );
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          `UPDATE pos_receipts SET status = 'issued', voided_at = NULL, void_reason = NULL, voided_by = NULL
           WHERE tenant_id = $1 AND id = $2`,
          [tenant.tenantId, receipt.id],
        ),
      ),
    ).rejects.toThrow(/POS-06/);
  });

  it("POS-07 issued links and invoices are append-only", async () => {
    const s = await showcase();
    for (const table of ["pos_receipt_links", "pos_invoices"]) {
      await expect(
        asOwnerTenant(tenant.tenantId, (client) =>
          client.query(
            `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = $2`,
            [tenant.tenantId, s.outletId],
          ),
        ),
      ).rejects.toThrow(/append-only/);
    }
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          `UPDATE pos_invoices SET notes = 'diubah' WHERE tenant_id = $1 AND outlet_id = $2`,
          [tenant.tenantId, s.outletId],
        ),
      ),
    ).rejects.toThrow(/append-only/);
  });
});

// ---- POS-07: documents -----------------------------------------------------------------

describe("POS-07 receipt document (legend-93a)", () => {
  it("POS-07 printing a completed sale returns the receipt with outlet name and address, items, tax and payment method", async () => {
    const s = await showcase();
    expect(() => posReceiptIssueResultSchema.parse(s.issued)).not.toThrow();
    const { receipt, document } = s.issued;
    expect(receipt).toMatchObject({
      number: "P1-000001",
      status: "issued",
      orderId: s.orderId,
      outletId: s.outletId,
    });
    expect(document).toMatchObject({
      receiptNumber: receipt.number,
      documentKind: "receipt",
      status: "issued",
      outletName: OUTLET_NAME,
      outletAddress: OUTLET_ADDRESS,
      subtotalIdr: 50_000,
      taxIdr: 5_000,
      totalIdr: s.totalIdr,
    });
    expect(document.items).toEqual([
      expect.objectContaining({
        name: "Kopi Susu",
        quantity: 2,
        unitPriceIdr: KOPI_IDR,
        lineTotalIdr: 50_000,
      }),
    ]);
    expect(document.taxLines).toEqual([
      expect.objectContaining({ rateBp: 1_000, amountIdr: 5_000 }),
    ]);
    expect(document.tenders).toEqual([
      expect.objectContaining({ method: "cash", amountIdr: s.totalIdr }),
    ]);
  });

  it("POS-07 the deliveries are recorded: the link is sent at once and returned, the cloud print says not printed (1268 B2)", async () => {
    const s = await showcase();
    const { deliveries, link } = s.issued;
    expect(
      deliveries.map((row: { channel: string }) => row.channel).sort(),
    ).toEqual(["link", "print"]);
    for (const row of deliveries)
      expect(row).toMatchObject(
        row.channel === "print"
          ? { status: "failed", sentAt: null, failureReason: "not_printed" }
          : { status: "sent", sentAt: expect.any(String) },
      );
    expect(s.issued.printResult).toBe("not_printed");
    expect(link).toMatchObject({ receiptId: s.issued.receipt.id });
    // The link opens the web page of the tenant, not the API.
    expect(link.url.startsWith(`${WEB_URL}/r/`)).toBe(true);
    expect(link.url).toContain("/r/");
    expect(link.url).not.toContain("/api/");
  });

  it("POS-07 the default delivery is one print, with no link", async () => {
    const outletId = await freshOutlet();
    const { orderId } = await completedSale(outletId);
    const res = await api(outletId).post(`/orders/${orderId}/receipts`);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(
      res.body.data.deliveries.map((row: { channel: string }) => row.channel),
    ).toEqual(["print"]);
    expect(res.body.data.link).toBeNull();
    expect(res.body.data.receipt.reprintCount).toBe(0);
  });

  it("POS-07 the same request replayed returns the same deliveries and link; a new print counts as a reprint", async () => {
    const s = await showcase();
    const replay = await api(s.outletId).post(`/orders/${s.orderId}/receipts`, {
      deliveries: ["print", "link"],
      idempotencyKey: s.issueKey,
    });
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    const ids = (rowsOf: { id: string }[]) =>
      rowsOf.map((row) => row.id).sort();
    expect(ids(replay.body.data.deliveries)).toEqual(ids(s.issued.deliveries));
    expect(replay.body.data.link.url).toBe(s.issued.link.url);
    expect(replay.body.data.receipt.reprintCount).toBe(0);

    const again = await api(s.outletId).post(`/orders/${s.orderId}/receipts`, {
      deliveries: ["print"],
    });
    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
    expect(again.body.data.receipt.number).toBe(s.issued.receipt.number);
    expect(again.body.data.receipt.reprintCount).toBe(1);
  });

  it("POS-07 the document is readable by receipt id and by number, and an unknown number is 404", async () => {
    const s = await showcase();
    const byId = await api(s.outletId).get(`/receipts/${s.issued.receipt.id}`);
    expect(byId.status).toBe(200);
    expect(receiptDocumentSchema.parse(byId.body.data)).toMatchObject({
      receiptNumber: s.issued.receipt.number,
      outletName: OUTLET_NAME,
      outletAddress: OUTLET_ADDRESS,
    });
    const byNumber = await api(s.outletId).get(
      `/receipts/by-number/${s.issued.receipt.number}`,
    );
    expect(byNumber.status).toBe(200);
    expect(byNumber.body.data.receipt.id).toBe(s.issued.receipt.id);
    expect(byNumber.body.data.document.outletAddress).toBe(OUTLET_ADDRESS);

    const unknown = await api(s.outletId).get("/receipts/by-number/P9-000999");
    expect(unknown.status).toBe(404);
    const malformed = await api(s.outletId).get(
      "/receipts/by-number/nomor-salah",
    );
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(malformed.status).toBeLessThan(500);
    const missing = await api(s.outletId).get(`/receipts/${randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  it("POS-06 a voided receipt is still readable with its number and says it is voided", async () => {
    const outletId = await freshOutlet();
    const { orderId } = await completedSale(outletId);
    const issued = await api(outletId).post(`/orders/${orderId}/receipts`);
    expect(issued.status).toBeLessThan(300);
    const number = issued.body.data.receipt.number as string;
    await inTx((tx, c) =>
      voidReceiptForOrder(tx, c, {
        orderId,
        reason: "wrong_order",
        voidedBy: userIdSchema.parse(cashier.userId),
        at: new Date(),
      }),
    );
    const doc = await api(outletId).get(
      `/receipts/${issued.body.data.receipt.id}`,
    );
    expect(doc.status).toBe(200);
    expect(doc.body.data).toMatchObject({
      receiptNumber: number,
      status: "voided",
    });
    const byNumber = await api(outletId).get(`/receipts/by-number/${number}`);
    expect(byNumber.body.data.receipt).toMatchObject({
      number,
      status: "voided",
      voidReason: "wrong_order",
    });
  });

  it("POS-07 a receipt is never printed without an outlet address", async () => {
    const outletId = await freshOutlet({ address: "Jl. Uji 1" });
    const { orderId } = await completedSale(outletId);
    // The sale itself completed and has its number...
    const [stored] = await receiptRows(outletId);
    expect(stored?.number).toBe("P1-000001");
    // ...but no document is produced until the outlet has a real address.
    const refused = await api(outletId).post(`/orders/${orderId}/receipts`);
    expect(refused.status).toBe(409);
    const byId = await api(outletId).get(`/receipts/${stored!.id}`);
    expect(byId.status).toBe(409);
    const pdf = await api(outletId)
      .get(`/receipts/${stored!.id}/pdf`)
      .buffer(true)
      .parse(binary as never);
    expect(pdf.status).toBe(409);

    await owner.query("UPDATE outlets SET address = $2 WHERE id = $1", [
      outletId,
      OUTLET_ADDRESS,
    ]);
    // Round 2: the receipt keeps the outlet address frozen at issue time, so
    // the old sale stays refused after the outlet is fixed...
    const stillRefused = await api(outletId).post(
      `/orders/${orderId}/receipts`,
    );
    expect(stillRefused.status).toBe(409);
    // ...and the next sale, issued with the fixed address, prints.
    const next = await completedSale(outletId);
    const fixed = await api(outletId).post(`/orders/${next.orderId}/receipts`);
    expect(fixed.status, JSON.stringify(fixed.body)).toBeLessThan(300);
    expect(fixed.body.data.document.outletAddress).toBe(OUTLET_ADDRESS);
  });

  it("POS-07 an order that is not completed has no receipt to print", async () => {
    const outletId = await freshOutlet();
    const draft = await draftOrder(outletId);
    const refused = await api(outletId).post(`/orders/${draft}/receipts`);
    expect(refused.status).toBe(409);
    expect(await receiptRows(outletId)).toHaveLength(0);
  });

  it("POS-07 invalid delivery requests are refused: email needs an address, WhatsApp does not exist", async () => {
    const outletId = await freshOutlet();
    const { orderId } = await completedSale(outletId);
    const noAddress = await api(outletId).post(`/orders/${orderId}/receipts`, {
      deliveries: ["email"],
    });
    expect(noAddress.status).toBeGreaterThanOrEqual(400);
    expect(noAddress.status).toBeLessThan(500);
    const badAddress = await api(outletId).post(`/orders/${orderId}/receipts`, {
      deliveries: ["email"],
      email: "bukan-email",
    });
    expect(badAddress.status).toBeGreaterThanOrEqual(400);
    expect(badAddress.status).toBeLessThan(500);
    const whatsapp = await api(outletId).post(`/orders/${orderId}/receipts`, {
      deliveries: ["whatsapp"],
    });
    expect(whatsapp.status).toBeGreaterThanOrEqual(400);
    expect(whatsapp.status).toBeLessThan(500);
    const queued = await rows(
      `SELECT 1 FROM pos_receipt_deliveries WHERE tenant_id = $1 AND outlet_id = $2 AND channel = 'email'`,
      [tenant.tenantId, outletId],
    );
    expect(queued).toHaveLength(0);
  });
});

// ---- POS-07: PDF -----------------------------------------------------------------------

describe("POS-07 PDF (legend-93a)", () => {
  it("POS-07 the receipt PDF starts with %PDF- and prints the outlet name, address and amount", async () => {
    const s = await showcase();
    const res = await api(s.outletId)
      .get(`/receipts/${s.issued.receipt.id}/pdf`)
      .buffer(true)
      .parse(binary as never);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = body.toString("latin1");
    expect(text).toContain("STRUK");
    expect(text).toContain(OUTLET_NAME);
    expect(text).toContain(OUTLET_ADDRESS);
    expect(text).toContain(s.issued.receipt.number);
    expect(text).toContain("Rp 55.000");
  });

  it("POS-07 the kuitansi PDF is titled KUITANSI and an unknown kind is refused", async () => {
    const s = await showcase();
    const res = await api(s.outletId)
      .get(`/receipts/${s.issued.receipt.id}/pdf?kind=kuitansi`)
      .buffer(true)
      .parse(binary as never);
    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(body.toString("latin1")).toContain("KUITANSI");
    const bad = await api(s.outletId).get(
      `/receipts/${s.issued.receipt.id}/pdf?kind=bogus`,
    );
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    const missing = await api(s.outletId).get(`/receipts/${randomUUID()}/pdf`);
    expect(missing.status).toBe(404);
  });
});

// ---- Invoice ----------------------------------------------------------------------------

describe("F8 invoice for an order with a receipt (legend-93a)", () => {
  it("POS-07 an invoice carries the receipt number, outlet name and address, the billed party and is paid", async () => {
    const s = await showcase();
    const invoice = invoiceDocumentSchema.parse(s.invoice);
    expect(invoice).toMatchObject({
      documentKind: "invoice",
      receiptNumber: s.issued.receipt.number,
      outletName: OUTLET_NAME,
      outletAddress: OUTLET_ADDRESS,
      billedTo: {
        name: "PT Kopi Nusantara",
        address: "Jl. Sudirman No. 1, Jakarta Pusat",
        npwp: "01.234.567.8-901.234",
      },
      dueDate: "2026-12-31",
      notes: "Pesanan acara kantor",
      paymentStatus: "paid",
      totalIdr: s.totalIdr,
      taxIdr: 5_000,
    });
  });

  it("Q81-ECON-INV-01: a DP-only durable return marks the invoice refunded even when native tender payout is zero", async () => {
    const outletId = await freshOutlet();
    const { orderId, totalIdr } = await completedSale(outletId);
    await asOwnerTenant(tenant.tenantId, (client) =>
      seedEconomicDepositRefund(client, {
        tenantId: tenant.tenantId,
        outletId,
        orderId: ulidToUuid(orderId),
        tenderIdr: 0,
        depositIdr: totalIdr,
        requestedBy: cashier.userId,
        approvedBy: approver.userId,
        refundedAt: new Date().toISOString(),
      }),
    );
    const invoice = await api(outletId).post(`/orders/${orderId}/invoices`, {
      billedTo: { name: "CV Retur DP", address: "Jl. Retur No. 7, Jakarta" },
      dueDate: "2026-12-31",
    });
    expect(invoice.status, JSON.stringify(invoice.body)).toBeLessThan(300);
    expect(invoice.body.data.paymentStatus).toBe("refunded");
  });

  it("POS-07 the same invoice request replayed returns the same invoice and stores one", async () => {
    const s = await showcase();
    const replay = await api(s.outletId).post(
      `/orders/${s.orderId}/invoices`,
      s.invoiceBody,
    );
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(replay.body.data).toEqual(s.invoice);
    const stored = await rows(
      `SELECT id FROM pos_invoices WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(s.orderId)],
    );
    expect(stored).toHaveLength(1);
  });

  it("POS-07 the invoice PDF starts with %PDF- and is titled INVOICE", async () => {
    const s = await showcase();
    const [row] = await rows<{ id: string }>(
      `SELECT id FROM pos_invoices WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(s.orderId)],
    );
    const res = await api(s.outletId)
      .get(`/invoices/${row!.id}/pdf`)
      .buffer(true)
      .parse(binary as never);
    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = body.toString("latin1");
    expect(text).toContain("INVOICE");
    expect(text).toContain("PT Kopi Nusantara");
  });

  it("POS-07 an order whose receipt was voided is invoiced as refunded", async () => {
    const outletId = await freshOutlet();
    const { orderId } = await completedSale(outletId);
    await inTx((tx, c) =>
      voidReceiptForOrder(tx, c, {
        orderId,
        reason: "wrong_order",
        voidedBy: userIdSchema.parse(cashier.userId),
        at: new Date(),
      }),
    );
    const res = await api(outletId).post(`/orders/${orderId}/invoices`, {
      billedTo: {
        name: "CV Acara Bersama",
        address: "Jl. Melati No. 7, Bandung",
      },
      dueDate: "2026-12-31",
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body.data).toMatchObject({
      paymentStatus: "refunded",
      status: "voided",
    });
  });

  it("POS-07 an order without a receipt cannot be invoiced, and a too-short billing address is refused", async () => {
    const outletId = await freshOutlet();
    const draft = await draftOrder(outletId);
    const body = {
      billedTo: { name: "CV Acara", address: "Jl. Melati No. 7, Bandung" },
      dueDate: "2026-12-31",
    };
    const noReceipt = await api(outletId).post(
      `/orders/${draft}/invoices`,
      body,
    );
    // Assumption: refused like any not-yet-final order (409); at least a 4xx.
    expect(noReceipt.status).toBeGreaterThanOrEqual(400);
    expect(noReceipt.status).toBeLessThan(500);
    const { orderId } = await completedSale(outletId);
    const shortAddress = await api(outletId).post(
      `/orders/${orderId}/invoices`,
      {
        ...body,
        billedTo: { name: "CV Acara", address: "Jl. 1" },
      },
    );
    expect(shortAddress.status).toBeGreaterThanOrEqual(400);
    expect(shortAddress.status).toBeLessThan(500);
    const stored = await rows(
      `SELECT 1 FROM pos_invoices WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenant.tenantId, outletId],
    );
    expect(stored).toHaveLength(0);
  });
});

// ---- E-receipt link and public lookup ------------------------------------------------------

describe("POS-07 e-receipt link and public lookup (legend-93a)", () => {
  // The link is `${WEB_URL}/r/<token>`; the API still serves the token under
  // /api/public/receipts/<token>.
  const tokenOf = (url: string) => url.slice(url.lastIndexOf("/r/") + 3);
  const publicGet = (path: string, host = headers) =>
    agent(app).get(path).set(host);

  it("POS-07 a link opens the e-receipt without signing in, with the outlet name and address", async () => {
    const s = await showcase();
    const token = tokenOf(s.issued.link.url);
    const res = await publicGet(`/api/public/receipts/${token}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(receiptDocumentSchema.parse(res.body.data)).toMatchObject({
      receiptNumber: s.issued.receipt.number,
      outletName: OUTLET_NAME,
      outletAddress: OUTLET_ADDRESS,
      totalIdr: s.totalIdr,
    });
  });

  it("POS-07 only the hash of the token is stored, and the link lasts 90 days", async () => {
    const s = await showcase();
    const token = tokenOf(s.issued.link.url);
    const hash = createHash("sha256").update(token).digest("hex");
    const stored = await rows<{ token_hash: string; expires_at: Date }>(
      `SELECT token_hash, expires_at FROM pos_receipt_links
       WHERE tenant_id = $1 AND receipt_id = $2`,
      [tenant.tenantId, s.issued.receipt.id],
    );
    expect(stored.map((row) => row.token_hash)).toContain(hash);
    expect(JSON.stringify(stored)).not.toContain(token);
    const days =
      (new Date(s.issued.link.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90.01);
  });

  it("POS-07 creating a link: the same request returns the same URL, a new request a new one, both open", async () => {
    const s = await showcase();
    const key = randomUUID();
    const path = `/receipts/${s.issued.receipt.id}/link`;
    const first = await api(s.outletId).post(path, { idempotencyKey: key });
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    expect(first.body.data.receiptId).toBe(s.issued.receipt.id);
    const replay = await api(s.outletId).post(path, { idempotencyKey: key });
    expect(replay.body.data.url).toBe(first.body.data.url);
    const second = await api(s.outletId).post(path);
    expect(second.body.data.url).not.toBe(first.body.data.url);
    for (const url of [first.body.data.url, second.body.data.url]) {
      const open = await publicGet(`/api/public/receipts/${tokenOf(url)}`);
      expect(open.status).toBe(200);
    }
    const unknown = await api(s.outletId).post(
      `/receipts/${randomUUID()}/link`,
    );
    expect(unknown.status).toBe(404);
  });

  it("POS-07 the public e-receipt hides the cashier name and tender references; staff still see references", async () => {
    const reference = "REF-INTERNAL-7731";
    const outletId = await freshOutlet();
    const { orderId } = await completedSale(outletId, reference);
    const issued = await api(outletId).post(`/orders/${orderId}/receipts`, {
      deliveries: ["print", "link"],
    });
    expect(issued.status, JSON.stringify(issued.body)).toBeLessThan(300);
    // Staff document keeps the reference.
    expect(issued.body.data.document.tenders).toEqual([
      expect.objectContaining({ method: "cash", reference }),
    ]);

    const token = tokenOf(issued.body.data.link.url);
    const res = await publicGet(`/api/public/receipts/${token}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const document = receiptDocumentSchema.parse(res.body.data);
    expect(document.cashierName).toBeNull();
    expect(document.tenders.length).toBeGreaterThan(0);
    for (const tender of document.tenders) expect(tender.reference).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(reference);

    for (const query of ["", "?kind=kuitansi"]) {
      const pdf = await publicGet(`/api/public/receipts/${token}/pdf${query}`)
        .buffer(true)
        .parse(binary as never);
      expect(pdf.status).toBe(200);
      expect((pdf.body as Buffer).toString("latin1")).not.toContain(reference);
    }
  });

  it("POS-07 the public receipt PDF starts with %PDF-", async () => {
    const s = await showcase();
    const token = tokenOf(s.issued.link.url);
    for (const [query, title] of [
      ["", "STRUK"],
      ["?kind=kuitansi", "KUITANSI"],
    ] as const) {
      const res = await publicGet(`/api/public/receipts/${token}/pdf${query}`)
        .buffer(true)
        .parse(binary as never);
      expect(res.status).toBe(200);
      const body = res.body as Buffer;
      expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(body.toString("latin1")).toContain(title);
    }
  });

  it("POS-07 an unknown token, an expired token and another tenant's host all answer the same 404", async () => {
    const s = await showcase();
    const expiredToken = randomBytes(32).toString("base64url");
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO pos_receipt_links
           (tenant_id, outlet_id, receipt_id, token_hash, idempotency_key, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 day')`,
        [
          tenant.tenantId,
          s.outletId,
          s.issued.receipt.id,
          createHash("sha256").update(expiredToken).digest("hex"),
          randomUUID(),
        ],
      ),
    );
    const unknown = await publicGet(
      `/api/public/receipts/${randomBytes(32).toString("base64url")}`,
    );
    const expired = await publicGet(`/api/public/receipts/${expiredToken}`);
    const expiredPdf = await publicGet(
      `/api/public/receipts/${expiredToken}/pdf`,
    );
    // A valid token under a different tenant's hostname finds nothing.
    const foreign = await publicGet(
      `/api/public/receipts/${tokenOf(s.issued.link.url)}`,
      { Host: seededHostname },
    );
    expect(unknown.status).toBe(404);
    expect(expired.status).toBe(404);
    expect(expiredPdf.status).toBe(404);
    expect(errorCode(expired.body)).toBe(errorCode(unknown.body));
    expect(expired.body.data).toBeUndefined();
    expect(foreign.status).toBe(404);
    expect(foreign.body.data).toBeUndefined();
  });
});

// ---- Email -------------------------------------------------------------------------------------

describe("POS-07 e-receipt by email (legend-93a)", () => {
  async function queueEmail(address: string) {
    const outletId = await freshOutlet();
    const { orderId } = await completedSale(outletId);
    const res = await api(outletId).post(`/orders/${orderId}/receipts`, {
      deliveries: ["email"],
      email: address,
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body.data.deliveries).toHaveLength(1);
    return { outletId, orderId, body: res.body.data };
  }
  const uniqueAddress = () => `owner-${randomUUID().slice(0, 8)}@example.com`;
  const failing: EmailProvider = {
    send: async () => {
      throw new Error("smtp down");
    },
  } as unknown as EmailProvider;
  const deliveryRow = async (id: string) =>
    (
      await rows<{
        status: string;
        attempts: number;
        failure_reason: string | null;
        destination_sealed: string | null;
      }>(
        `SELECT status, attempts, failure_reason, destination_sealed
         FROM pos_receipt_deliveries WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, id],
      )
    )[0]!;

  it("POS-07 an email is queued with a masked address, then sent by the worker", async () => {
    const address = uniqueAddress();
    const { outletId, body } = await queueEmail(address);
    const [delivery] = body.deliveries;
    expect(delivery).toMatchObject({
      channel: "email",
      status: "queued",
      destinationMasked: "o***@example.com",
      sentAt: null,
      failureReason: null,
    });
    // The raw address is neither in the response nor stored in the clear.
    expect(JSON.stringify(body)).not.toContain(address);
    const stored = await deliveryRow(delivery.id);
    expect(stored.destination_sealed).toEqual(expect.any(String));
    expect(stored.destination_sealed).not.toContain(address);

    const provider = new FakeEmailProvider();
    const context = tenantContext(tenant.tenantId);
    await runPosReceiptEmailJob([context], { email: provider });
    const mine = provider.sent.filter((mail) => mail.to === address);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.reference).toBe(delivery.id);
    expect(mine[0]?.subject.length).toBeGreaterThan(0);
    expect(`${mine[0]?.subject}\n${mine[0]?.body}`).toContain(
      body.receipt.number,
    );

    // The receipt now shows it as sent, still without the raw address.
    const read = await api(outletId).get(
      `/receipts/by-number/${body.receipt.number}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.data.deliveries).toEqual([
      expect.objectContaining({
        id: delivery.id,
        channel: "email",
        status: "sent",
        destinationMasked: "o***@example.com",
        sentAt: expect.any(String),
      }),
    ]);
    expect(JSON.stringify(read.body)).not.toContain(address);

    // Running the job again never sends it twice.
    await runPosReceiptEmailJob([context], { email: provider });
    expect(provider.sent.filter((mail) => mail.to === address)).toHaveLength(1);
  });

  it("POS-07 the same request with another address is refused as IDEMPOTENCY_KEY_REUSED, before and after sending", async () => {
    const address = uniqueAddress();
    const other = `zed-${randomUUID().slice(0, 8)}@example.com`;
    const outletId = await freshOutlet();
    const { orderId } = await completedSale(outletId);
    const idempotencyKey = randomUUID();
    const issue = (email: string) =>
      api(outletId).post(`/orders/${orderId}/receipts`, {
        deliveries: ["email"],
        email,
        idempotencyKey,
      });

    const first = await issue(address);
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    const deliveryId = first.body.data.deliveries[0].id as string;

    // Queued: the sealed address is compared.
    const clash = await issue(other);
    expect(clash.status, JSON.stringify(clash.body)).toBe(409);
    expect(errorCode(clash.body)).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(JSON.stringify(clash.body)).not.toContain(other);
    const same = await issue(address);
    expect(same.status, JSON.stringify(same.body)).toBeLessThan(300);
    expect(same.body.data.deliveries[0].id).toBe(deliveryId);

    // Sent: the sealed address is gone, the mask is compared.
    const provider = new FakeEmailProvider();
    await runPosReceiptEmailJob([tenantContext(tenant.tenantId)], {
      email: provider,
    });
    expect(provider.sent.filter((mail) => mail.to === address)).toHaveLength(1);
    const clashAfter = await issue(other);
    expect(clashAfter.status, JSON.stringify(clashAfter.body)).toBe(409);
    expect(errorCode(clashAfter.body)).toBe("IDEMPOTENCY_KEY_REUSED");
    const sameAfter = await issue(address);
    expect(sameAfter.status, JSON.stringify(sameAfter.body)).toBeLessThan(300);
    expect(sameAfter.body.data.deliveries[0].id).toBe(deliveryId);
    // Nothing was sent twice or to the other address.
    expect(provider.sent.filter((mail) => mail.to === other)).toHaveLength(0);
    await runPosReceiptEmailJob([tenantContext(tenant.tenantId)], {
      email: provider,
    });
    expect(provider.sent.filter((mail) => mail.to === address)).toHaveLength(1);
  });

  it("POS-07 the sealed address is dropped once the email is sent or finally failed, and kept while it is retried", async () => {
    const context = tenantContext(tenant.tenantId);

    const sentCase = await queueEmail(uniqueAddress());
    const sentId = sentCase.body.deliveries[0].id as string;
    expect((await deliveryRow(sentId)).destination_sealed).toEqual(
      expect.any(String),
    );
    await runPosReceiptEmailJob([context], { email: new FakeEmailProvider() });
    expect(await deliveryRow(sentId)).toMatchObject({
      status: "sent",
      destination_sealed: null,
    });

    const failCase = await queueEmail(uniqueAddress());
    const failId = failCase.body.deliveries[0].id as string;
    await runPosReceiptEmailJob([context], { email: failing });
    // Still retried: the address must stay available.
    expect(await deliveryRow(failId)).toMatchObject({
      status: "queued",
      attempts: 1,
      destination_sealed: expect.any(String),
    });
    for (let attempt = 2; attempt <= 5; attempt += 1)
      await runPosReceiptEmailJob(
        [context],
        { email: failing },
        hoursLater(attempt),
      );
    expect(await deliveryRow(failId)).toMatchObject({
      status: "failed",
      attempts: 5,
      destination_sealed: null,
    });
  });

  it("POS-07 a provider failure leaves the email queued and it is sent on the next run", async () => {
    const address = uniqueAddress();
    const { body } = await queueEmail(address);
    const id = body.deliveries[0].id as string;
    const context = tenantContext(tenant.tenantId);

    await runPosReceiptEmailJob([context], { email: failing });
    expect(await deliveryRow(id)).toMatchObject({
      status: "queued",
      attempts: 1,
    });

    const provider = new FakeEmailProvider();
    // Inside the backoff window the retry waits.
    await runPosReceiptEmailJob([context], { email: provider });
    expect(provider.sent.filter((mail) => mail.to === address)).toHaveLength(0);
    await runPosReceiptEmailJob([context], { email: provider }, hoursLater(1));
    expect(provider.sent.filter((mail) => mail.to === address)).toHaveLength(1);
    expect((await deliveryRow(id)).status).toBe("sent");
  });

  it("POS-07 after 5 failed attempts the email is marked failed with a reason and is not retried", async () => {
    const address = uniqueAddress();
    const { body } = await queueEmail(address);
    const id = body.deliveries[0].id as string;
    const context = tenantContext(tenant.tenantId);

    for (let attempt = 1; attempt <= 5; attempt += 1)
      await runPosReceiptEmailJob(
        [context],
        { email: failing },
        hoursLater(attempt),
      );
    const failed = await deliveryRow(id);
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(5);
    expect(failed.failure_reason).toEqual(expect.any(String));
    expect(failed.failure_reason?.length).toBeGreaterThan(0);

    const provider = new FakeEmailProvider();
    await runPosReceiptEmailJob([context], { email: provider }, hoursLater(9));
    expect(provider.sent.filter((mail) => mail.to === address)).toHaveLength(0);
    expect((await deliveryRow(id)).status).toBe("failed");
  });

  it("POS-07 a worker run with nothing queued sends nothing", async () => {
    const provider = new FakeEmailProvider();
    await runPosReceiptEmailJob([tenantContext(seededTenantId)], {
      email: provider,
    });
    expect(provider.sent).toHaveLength(0);
  });
});

// ---- Isolation and permissions ----------------------------------------------------------------

describe("Receipt isolation and permissions (legend-93a)", () => {
  it("TEN-01 another tenant sees no receipt row in any of the five tables, and the service refuses", async () => {
    const s = await showcase();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.tenantId],
      );
      for (const table of RECEIPT_TABLES) {
        const own = await client.query(
          `SELECT count(*)::int AS count FROM ${table}`,
        );
        expect(own.rows[0]?.count, `${table} (own tenant)`).toBeGreaterThan(0);
      }
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [seededTenantId],
      );
      for (const table of RECEIPT_TABLES) {
        const { rows: found } = await client.query(
          `SELECT count(*)::int AS count FROM ${table} WHERE tenant_id = $1`,
          [tenant.tenantId],
        );
        expect(found[0]?.count, table).toBe(0);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    const other = tenantContext(seededTenantId);
    expect(
      await inTx((tx, c) => findReceiptById(tx, c, s.issued.receipt.id), other),
    ).toBeNull();
    expect(
      await inTx(
        (tx, c) =>
          findReceiptByNumber(tx, c, s.outletId, s.issued.receipt.number),
        other,
      ),
    ).toBeNull();
    expect(
      await inTx((tx, c) => findReceiptForOrder(tx, c, s.orderId), other),
    ).toBeNull();
    expect(
      await inTx((tx, c) => receiptGapsForOutlet(tx, c, s.outletId), other),
    ).toEqual([]);
    // Another tenant cannot allocate a number on this tenant's order.
    await expect(
      inTx(
        (tx, c) =>
          allocateReceipt(tx, c, {
            orderId: s.orderId,
            outletId: s.outletId,
            deviceId: null,
            at: new Date(),
          }),
        other,
      ),
    ).rejects.toBeDefined();
  });

  it("TEN-03 the outlet RLS hides every receipt table from a context scoped to another outlet", async () => {
    await showcase();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
        [tenant.tenantId, JSON.stringify([randomUUID()])],
      );
      for (const table of RECEIPT_TABLES) {
        const { rows: found } = await client.query(
          `SELECT count(*)::int AS count FROM ${table}`,
        );
        expect(found[0]?.count, table).toBe(0);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("TEN-03 receipts need a signed-in member with the right permission on that outlet", async () => {
    const s = await showcase();
    const path = `/api/outlets/${s.outletId}/pos`;
    const receiptPath = `/receipts/${s.issued.receipt.id}`;

    // Anonymous: 401 on read and write.
    const anonymousRead = await agent(app)
      .get(`${path}${receiptPath}`)
      .set(headers)
      .set(originHeader);
    expect(anonymousRead.status).toBe(401);
    const anonymousIssue = await agent(app)
      .post(`${path}/orders/${s.orderId}/receipts`)
      .set(headers)
      .set(originHeader)
      .send({ idempotencyKey: randomUUID() });
    expect(anonymousIssue.status).toBe(401);

    // No POS permission at all: refused.
    expect((await api(s.outletId, viewer).get(receiptPath)).status).toBe(403);
    expect(
      (await api(s.outletId, viewer).post(`/orders/${s.orderId}/receipts`))
        .status,
    ).toBe(403);

    // order.view reads, but issuing, linking and invoicing need pos.payment.accept.
    const asReader = api(s.outletId, reader);
    expect((await asReader.get(receiptPath)).status).toBe(200);
    expect(
      (await asReader.get(`/receipts/by-number/${s.issued.receipt.number}`))
        .status,
    ).toBe(200);
    expect((await asReader.post(`/orders/${s.orderId}/receipts`)).status).toBe(
      403,
    );
    expect((await asReader.post(`${receiptPath}/link`)).status).toBe(403);
    expect(
      (
        await asReader.post(`/orders/${s.orderId}/invoices`, {
          billedTo: { name: "CV Acara", address: "Jl. Melati No. 7, Bandung" },
          dueDate: "2026-12-31",
        })
      ).status,
    ).toBe(403);

    // An outlet that is not the caller's: not served.
    const foreign = await api(randomUUID()).get(receiptPath);
    expect([403, 404]).toContain(foreign.status);
  });

  it("TEN-03 a member limited to another outlet cannot read or issue receipts here", async () => {
    const s = await showcase();
    const otherOutlet = await freshOutlet();
    const limited = await member(ids.cashierRole, "Receipt Outlet Lain", {
      type: "outlet",
      id: otherOutlet,
    });
    const asLimited = api(s.outletId, limited);
    expect(
      (await asLimited.get(`/receipts/${s.issued.receipt.id}`)).status,
    ).toBe(403);
    expect((await asLimited.post(`/orders/${s.orderId}/receipts`)).status).toBe(
      403,
    );
    expect(
      (await asLimited.post(`/receipts/${s.issued.receipt.id}/link`)).status,
    ).toBe(403);
    // In their own outlet the same member works.
    const own = await completedSaleAs(limited, otherOutlet);
    const issued = await api(otherOutlet, limited).post(
      `/orders/${own}/receipts`,
    );
    expect(issued.status, JSON.stringify(issued.body)).toBeLessThan(300);
  });
});

// ---- POS-07: frozen outlet snapshot (Round 2 P2) -----------------------------------
// Assumptions: the issued email carries the outlet name and address in its
// subject or body; the snapshot keys are camelCase (outletName, outletAddress,
// legalName, npwpLast4) as in PosReceiptOutletSnapshot.

describe("POS-07 a receipt keeps the outlet name and address of the day it was issued (legend-93a round 2)", () => {
  const OLD_NAME = "Kopi Lama Menteng";
  const OLD_ADDRESS = "Jl. Lama Menteng No. 7, Jakarta Pusat";
  const NEW_NAME = "Kopi Baru Kemang";
  const NEW_ADDRESS = "Jl. Baru Kemang Raya No. 99, Jakarta Selatan";
  const tokenOf = (url: string) => url.slice(url.lastIndexOf("/r/") + 3);
  const snapshotOf = async (receiptId: string) =>
    (
      await rows<{ outlet_snapshot: Record<string, unknown> }>(
        `SELECT outlet_snapshot FROM pos_receipts WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, receiptId],
      )
    )[0]?.outlet_snapshot;

  it("POS-07 after the outlet is renamed, the document, PDF, e-receipt, email and invoice of an issued receipt keep the original name and address", async () => {
    const outletId = await freshOutlet({
      name: OLD_NAME,
      address: OLD_ADDRESS,
    });
    const { orderId } = await completedSale(outletId);
    const address = `snap-${randomUUID().slice(0, 8)}@example.com`;
    const issued = await api(outletId).post(`/orders/${orderId}/receipts`, {
      deliveries: ["print", "link", "email"],
      email: address,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBeLessThan(300);
    const receiptId = issued.body.data.receipt.id as string;
    const token = tokenOf(issued.body.data.link.url);
    expect(issued.body.data.document).toMatchObject({
      outletName: OLD_NAME,
      outletAddress: OLD_ADDRESS,
    });

    await owner.query(
      "UPDATE outlets SET name = $2, address = $3 WHERE id = $1",
      [outletId, NEW_NAME, NEW_ADDRESS],
    );

    // Staff document, by id and by number.
    const byId = await api(outletId).get(`/receipts/${receiptId}`);
    expect(byId.status, JSON.stringify(byId.body)).toBe(200);
    expect(byId.body.data).toMatchObject({
      outletName: OLD_NAME,
      outletAddress: OLD_ADDRESS,
    });
    const byNumber = await api(outletId).get(
      `/receipts/by-number/${issued.body.data.receipt.number}`,
    );
    expect(byNumber.status).toBe(200);
    expect(byNumber.body.data.document).toMatchObject({
      outletName: OLD_NAME,
      outletAddress: OLD_ADDRESS,
    });

    // PDF (staff).
    const pdf = await api(outletId)
      .get(`/receipts/${receiptId}/pdf`)
      .buffer(true)
      .parse(binary as never);
    expect(pdf.status).toBe(200);
    const pdfText = (pdf.body as Buffer).toString("latin1");
    expect(pdfText).toContain(OLD_NAME);
    expect(pdfText).toContain(OLD_ADDRESS);
    expect(pdfText).not.toContain(NEW_NAME);
    expect(pdfText).not.toContain(NEW_ADDRESS);

    // Public e-receipt and its PDF.
    const publicRes = await agent(app)
      .get(`/api/public/receipts/${token}`)
      .set(headers);
    expect(publicRes.status, JSON.stringify(publicRes.body)).toBe(200);
    expect(receiptDocumentSchema.parse(publicRes.body.data)).toMatchObject({
      outletName: OLD_NAME,
      outletAddress: OLD_ADDRESS,
    });
    const publicPdf = await agent(app)
      .get(`/api/public/receipts/${token}/pdf`)
      .set(headers)
      .buffer(true)
      .parse(binary as never);
    expect(publicPdf.status).toBe(200);
    const publicPdfText = (publicPdf.body as Buffer).toString("latin1");
    expect(publicPdfText).toContain(OLD_NAME);
    expect(publicPdfText).not.toContain(NEW_NAME);

    // Email sent by the worker after the rename.
    const provider = new FakeEmailProvider();
    await runPosReceiptEmailJob([tenantContext(tenant.tenantId)], {
      email: provider,
    });
    const mail = provider.sent.filter((sent) => sent.to === address);
    expect(mail).toHaveLength(1);
    const mailText = `${mail[0]?.subject}\n${mail[0]?.body}`;
    expect(mailText).toContain(OLD_NAME);
    expect(mailText).toContain(OLD_ADDRESS);
    expect(mailText).not.toContain(NEW_NAME);
    expect(mailText).not.toContain(NEW_ADDRESS);

    // Invoice for the same order, raised after the rename.
    const invoice = await api(outletId).post(`/orders/${orderId}/invoices`, {
      billedTo: {
        name: "PT Kopi Nusantara",
        address: "Jl. Sudirman No. 1, Jakarta Pusat",
        npwp: "01.234.567.8-901.234",
      },
      dueDate: "2026-12-31",
    });
    expect(invoice.status, JSON.stringify(invoice.body)).toBeLessThan(300);
    expect(invoiceDocumentSchema.parse(invoice.body.data)).toMatchObject({
      outletName: OLD_NAME,
      outletAddress: OLD_ADDRESS,
    });
  });

  it("POS-07 a receipt issued after the rename shows the new name and address, the earlier one still the old", async () => {
    const outletId = await freshOutlet({
      name: OLD_NAME,
      address: OLD_ADDRESS,
    });
    const before = await completedSale(outletId);
    const beforeIssued = await api(outletId).post(
      `/orders/${before.orderId}/receipts`,
    );
    expect(beforeIssued.status).toBeLessThan(300);

    await owner.query(
      "UPDATE outlets SET name = $2, address = $3 WHERE id = $1",
      [outletId, NEW_NAME, NEW_ADDRESS],
    );
    const after = await completedSale(outletId);
    const afterIssued = await api(outletId).post(
      `/orders/${after.orderId}/receipts`,
    );
    expect(afterIssued.status, JSON.stringify(afterIssued.body)).toBeLessThan(
      300,
    );
    expect(afterIssued.body.data.document).toMatchObject({
      outletName: NEW_NAME,
      outletAddress: NEW_ADDRESS,
    });
    const reread = await api(outletId).get(
      `/receipts/${beforeIssued.body.data.receipt.id}`,
    );
    expect(reread.body.data).toMatchObject({
      outletName: OLD_NAME,
      outletAddress: OLD_ADDRESS,
    });
    expect(await snapshotOf(afterIssued.body.data.receipt.id)).toMatchObject({
      outletName: NEW_NAME,
      outletAddress: NEW_ADDRESS,
    });
  });

  it("POS-07 the receipt row stores the outlet snapshot, and the database refuses to change it", async () => {
    const outletId = await freshOutlet({
      name: OLD_NAME,
      address: OLD_ADDRESS,
    });
    const [order] = await drafts(outletId, 1);
    const receipt = await allocate(outletId, order!, null);
    const snapshot = await snapshotOf(receipt.id);
    expect(snapshot).toMatchObject({
      outletName: OLD_NAME,
      outletAddress: OLD_ADDRESS,
    });
    expect(snapshot).toHaveProperty("legalName");
    expect(snapshot).toHaveProperty("npwpLast4");

    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          `UPDATE pos_receipts SET outlet_snapshot = $3::jsonb WHERE tenant_id = $1 AND id = $2`,
          [
            tenant.tenantId,
            receipt.id,
            JSON.stringify({
              outletName: NEW_NAME,
              outletAddress: NEW_ADDRESS,
              legalName: null,
              npwpLast4: null,
            }),
          ],
        ),
      ),
    ).rejects.toThrow(/POS-06|snapshot/i);
    expect(await snapshotOf(receipt.id)).toMatchObject({
      outletName: OLD_NAME,
    });
  });

  it("POS-07 an offline receipt merged later is stored with the device's own outlet copy, or the outlet at merge time when it sends none", async () => {
    const outletId = await freshOutlet({
      name: OLD_NAME,
      address: OLD_ADDRESS,
    });
    const device = randomUUID();
    const [o1, o2] = await deviceOrders(outletId, device, 2);
    await provision(outletId, device, "OFF1");
    const base = { outletId, deviceId: device, prefix: "OFF1" };
    const edgeCopy = {
      outletName: "Kopi Tepi Jalan",
      outletAddress: "Jl. Tepi Jalan No. 3, Bandung",
      legalName: null,
      npwpLast4: null,
    };
    const withCopy = {
      ...offlineReceipt({ ...base, orderId: o1!, ordinal: 1 }),
      outletSnapshot: edgeCopy,
    } as unknown as PosReceipt;
    const merged = await mergeRun(outletId, device, "OFF1", 2, [
      withCopy,
      offlineReceipt({ ...base, orderId: o2!, ordinal: 2 }),
    ]);
    expect(merged.inserted).toBe(2);
    const [one, two] = await receiptRows(outletId);
    expect(await snapshotOf(one!.id)).toMatchObject(edgeCopy);
    expect(await snapshotOf(two!.id)).toMatchObject({
      outletName: OLD_NAME,
      outletAddress: OLD_ADDRESS,
    });
  });
});

describe("Q4 a tax-free order prints with no tax rows (legend-93a)", () => {
  const TAX_LABELS = /PBJT|PPN|PB1|Pajak/;
  const tokenOf = (url: string) => url.slice(url.lastIndexOf("/r/") + 3);

  /**
   * An outlet where the item is exempt: an outlet rule at 0% that names the
   * item beats the tenant-wide PBJT rule there, so the sale is taxed 0 and
   * every other test keeps the tenant-wide rule.
   */
  async function taxFreeOutlet(): Promise<string> {
    const outletId = await freshOutlet();
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tax_rules
           (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
            price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
            published_at, published_by)
         VALUES ($1, $2, $3, 'EXEMPT-RCP', 'Bebas pajak', 'other', 0, NULL, '[]',
                 $4, false, true, true, 1, '2026-01-01', 'published', now(), $5)`,
        [
          randomUUID(),
          tenant.tenantId,
          outletId,
          JSON.stringify({
            itemClasses: [],
            categoryIds: [],
            itemIds: [ids.kopi],
          }),
          cashier.userId,
        ],
      );
    });
    return outletId;
  }

  it("Q4 a sale with no tax prints a receipt, PDFs, e-receipt, email and invoice without any tax row", async () => {
    const outletId = await taxFreeOutlet();
    const { orderId, totalIdr } = await completedSale(outletId);
    const address = `q4-${randomUUID().slice(0, 8)}@example.com`;
    const issued = await api(outletId).post(`/orders/${orderId}/receipts`, {
      deliveries: ["print", "link", "email"],
      email: address,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const { document, receipt, link } = issued.body.data;
    expect(document.taxLines).toEqual([]);
    expect(document.taxIdr).toBe(0);
    expect(document.subtotalIdr).toBe(50_000);
    expect(document.totalIdr).toBe(totalIdr);
    expect(document.subtotalIdr + document.taxIdr).toBe(document.totalIdr);

    const staffPdf = await api(outletId)
      .get(`/receipts/${receipt.id}/pdf`)
      .buffer(true)
      .parse(binary as never);
    expect(staffPdf.status).toBe(200);
    const staffText = (staffPdf.body as Buffer).toString("latin1");
    expect(staffText).toContain("Rp 50.000");
    expect(staffText).not.toMatch(TAX_LABELS);

    const token = tokenOf(link.url);
    const publicPdf = await agent(app)
      .get(`/api/public/receipts/${token}/pdf`)
      .set(headers)
      .buffer(true)
      .parse(binary as never);
    expect(publicPdf.status).toBe(200);
    expect((publicPdf.body as Buffer).toString("latin1")).not.toMatch(
      TAX_LABELS,
    );

    const open = await agent(app)
      .get(`/api/public/receipts/${token}`)
      .set(headers);
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(receiptDocumentSchema.parse(open.body.data).taxLines).toEqual([]);

    const provider = new FakeEmailProvider();
    await runPosReceiptEmailJob([tenantContext(tenant.tenantId)], {
      email: provider,
    });
    const mail = provider.sent.find((sent) => sent.to === address);
    expect(mail).toBeDefined();
    expect(`${mail?.subject}\n${mail?.body}`).not.toMatch(TAX_LABELS);

    const invoice = await api(outletId).post(`/orders/${orderId}/invoices`, {
      billedTo: {
        name: "PT Kopi Nusantara",
        address: "Jl. Sudirman No. 1, Jakarta Pusat",
        npwp: "01.234.567.8-901.234",
      },
      dueDate: "2026-12-31",
    });
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
    expect(invoice.body.data.taxLines).toEqual([]);
  });

  it("Q4 a partly exempt sale (one item taxed, one exempt) prints only the nonzero tax row", async () => {
    // Teh Tawar is exempt at this outlet (0% outlet rule naming it); Kopi Susu
    // keeps the tenant-wide PBJT 10%. 1 x Rp25.000 + 1 x Rp10.000, tax Rp2.500.
    const outletId = await freshOutlet();
    const teh = randomUUID();
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, 'Teh Tawar', true, $5)`,
        [teh, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         SELECT $1, $2, id, $3, 10000 FROM price_lists
         WHERE tenant_id = $2 AND outlet_id = $4`,
        [randomUUID(), tenant.tenantId, teh, outletId],
      );
      await client.query(
        `INSERT INTO tax_rules
           (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
            price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
            published_at, published_by)
         VALUES ($1, $2, $3, 'EXEMPT-TEH', 'Bebas pajak', 'other', 0, NULL, '[]',
                 $4, false, true, true, 1, '2026-01-01', 'published', now(), $5)`,
        [
          randomUUID(),
          tenant.tenantId,
          outletId,
          JSON.stringify({ itemClasses: [], categoryIds: [], itemIds: [teh] }),
          cashier.userId,
        ],
      );
    });

    const created = await cashApi(outletId).post("/orders", {
      channel: "pos",
      serviceType: "takeaway",
      items: [
        { menuItemId: ids.kopi, quantity: 1, modifierIds: [] },
        { menuItemId: teh, quantity: 1, modifierIds: [] },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.data.id as string;
    let status = created.body.data.status as string;
    if (status === "draft") {
      const submitted = await cashApi(outletId).post(
        `/orders/${orderId}/submit`,
        {
          expectedStatus: status,
        },
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      status = submitted.body.data.status as string;
    }
    const totalIdr = created.body.data.totalIdr as number;
    const paid = await cashApi(outletId).post(`/orders/${orderId}/tenders`, {
      method: "cash",
      receivedIdr: totalIdr,
      expectedStatus: status,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const completed = await cashApi(outletId).post(
      `/orders/${orderId}/complete`,
      {
        expectedStatus: paid.body.data.order.status,
      },
    );
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    const issued = await cashApi(outletId).post(`/orders/${orderId}/receipts`, {
      deliveries: ["print"],
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const { document, receipt } = issued.body.data;
    expect(document.subtotalIdr).toBe(35_000);
    expect(document.taxIdr).toBe(2_500);
    expect(document.totalIdr).toBe(totalIdr);
    expect(document.taxLines).toHaveLength(1);
    expect(document.taxLines[0]).toMatchObject({
      name: "PBJT 10%",
      rateBp: 1000,
      amountIdr: 2_500,
    });

    const pdf = await api(outletId)
      .get(`/receipts/${receipt.id}/pdf`)
      .buffer(true)
      .parse(binary as never);
    expect(pdf.status).toBe(200);
    const text = (pdf.body as Buffer).toString("latin1");
    expect(text).toContain("PBJT 10%");
    expect(text).not.toContain("Bebas pajak");

    const invoice = await api(outletId).post(`/orders/${orderId}/invoices`, {
      billedTo: {
        name: "PT Kopi Nusantara",
        address: "Jl. Sudirman No. 1, Jakarta Pusat",
        npwp: "01.234.567.8-901.234",
      },
      dueDate: "2026-12-31",
    });
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
    expect(invoice.body.data.taxLines).toEqual(document.taxLines);
  });
});

/** A sale rung up by a specific member (the limited-outlet cashier). */
async function completedSaleAs(who: Member, outletId: string): Promise<string> {
  const created = await cashApi(outletId, who).post("/orders", {
    channel: "pos",
    serviceType: "takeaway",
    items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await cashApi(outletId, who).post(
      `/orders/${orderId}/submit`,
      {
        expectedStatus: status,
      },
    );
    status = submitted.body.data.status as string;
  }
  const paid = await cashApi(outletId, who).post(`/orders/${orderId}/tenders`, {
    method: "cash",
    receivedIdr: (created.body.data.totalIdr as number) + 5_000,
    expectedStatus: status,
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const completed = await cashApi(outletId, who).post(
    `/orders/${orderId}/complete`,
    {
      expectedStatus: paid.body.data.order.status as string,
    },
  );
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  return orderId;
}

describe("legend-2lp.2 receipt delivery with the real edge queue", () => {
  it("commits one receipt job with its delivery and prints the frozen sale once", async () => {
    const outletId = outletIdSchema.parse(await freshOutlet());
    const { orderId } = await completedSale(outletId);
    const printerId = randomUUID();
    await rows(
      `INSERT INTO edge_printers
         (id, tenant_id, outlet_id, label, role, transport, host, port, paper_width)
       VALUES ($1, $2, $3, 'Receipt 928', 'receipt', 'network', '192.168.1.50', 9100, 48)
       RETURNING id`,
      [printerId, tenant.tenantId, outletId],
    );
    const context = establishScopedTenantContext(
      tenantContext(tenant.tenantId).tenant,
      { kind: "outlets", outletIds: [outletId] },
    );
    const store = createDbPrintStore({ db, context });
    const transport = new FakePrinterTransport();
    const printer = createPrintAgent({ store, transportFor: () => transport });
    const originalRuntime = getEdgeRuntimeState();
    const getAgent = vi
      .spyOn(printRuntime, "getEdgePrintAgent")
      .mockReturnValue(printer);
    setEdgeRuntimeStateForTests({
      ...originalRuntime,
      edgeMode: true,
      identity: {
        context,
        scope: {
          tenantId: context.tenant.tenantId,
          outletId,
          edgeNodeId: randomUUID(),
        },
      },
    });
    const caller = { userId: userIdSchema.parse(cashier.userId) };
    const request = {
      deliveries: ["print"] as const,
      idempotencyKey: randomUUID(),
    };
    try {
      const issued = await issueReceiptDeliveries(
        context,
        caller,
        outletId,
        orderId,
        request,
      );
      await issueReceiptDeliveries(context, caller, outletId, orderId, request);
      const queued = await store.listJobs({ limit: 10 });
      expect(queued.items).toHaveLength(1);
      expect(queued.items[0]).toMatchObject({
        printerId,
        kind: "receipt",
        sourceRef: issued.receipt.number,
        status: "queued",
      });
      expect(transport.printed).toHaveLength(0);
      await printer.drain(printerId);
      expect(transport.printed).toHaveLength(1);
      const text = Buffer.from(transport.printed[0]!).toString("latin1");
      expect(text).toContain(OUTLET_NAME);
      expect(text.replace(/\s+/g, " ")).toContain(OUTLET_ADDRESS);
      expect(text).toContain(issued.receipt.number);
      expect(text).toContain("Kopi Susu");
      expect(text).not.toContain("CETAK ULANG");
    } finally {
      await printer.stop();
      getAgent.mockRestore();
      setEdgeRuntimeStateForTests(originalRuntime);
    }
  });
});
