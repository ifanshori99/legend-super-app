// EDC reconciliation resolve (Design B; bead legend-x9zmq; PRD EDC-02, EDC-03,
// EDC-06; founder rule "jangan sampai rugi": the customer is never charged
// twice and the outlet is never short; when unsure, REJECT).
//
// A request row flagged `needs_reconciliation` locks the POS bill (EDC-01). The
// official way out is POST /api/payments/admin/edc/transactions/:id/reconciliation
// by an Owner or a Finance manager (permission `payment.reconcile`), audited.
//
// Written from the brief (Design B), the shared EDC/payment contracts and the
// POS behaviour already fixed by pos-edc-tender.test.ts, not from the
// implementation. Fixtures mirror pos-edc-tender.test.ts.
//
// Assumptions (the contract text is not final on these):
// - Request body `{ outcome: "declined" | "approved", evidence: { source:
//   "inquiry" | "terminal_receipt" | "bank_statement", note (1..500),
//   approvalCode?, rrn? } }`; the response is `{ data: EdcTransaction }`.
// - Invalid bodies answer 422 (the strict shared validator; as the POS routes).
// - "Another approved row" / flag not set / wrong status / live tender on the
//   row / late approval / amount mismatch are all 409. A missing row is 404.
// - Owner and Finance are modelled by the permission lists of the shared
//   role templates `owner` and `finance`; cashier and supervisor likewise.
//   Only Owner and Finance hold `payment.reconcile`.
// - The audit row is in audit_logs with event.action
//   `edc_transaction.reconciliation_resolved` and event.objectId = row id.
// - After `approved` the request is NOT a tender yet: the existing ECR tender
//   path books it exactly once (the bill stays unpaid until then).
// - A flagged approved row that is already a live tender is also tested by
//   tendering an approved row and then setting the flag by the table owner.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { roleTemplate } from "@starter/shared/access";
import { EdcError } from "@starter/shared/edc";
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
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
const ACTION = "edc_transaction.reconciliation_resolved";

const ids = {
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  ownerRole: randomUUID(),
  financeRole: randomUUID(),
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  device: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
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
let ownerNoMfa: Member; // Owner role, but this session never verified a second factor
let terminalId: string;

// ---- Receipt numbering double (same as pos-edc-tender.test.ts) -----------------

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
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
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
  withMfa = true,
): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  // The resolve route needs a session that verified its second factor (F4);
  // the real TOTP path is covered by identity-mfa-api.test.ts.
  if (withMfa) await verifySessionMfa(email);
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
    create: (body: Record<string, unknown> = {}) =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
        ...body,
      }),
    get: (orderId: string) =>
      who.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    cash: (orderId: string, expectedStatus: string, receivedIdr: number) =>
      send(`/${orderId}/tenders`, {
        method: "cash",
        receivedIdr,
        expectedStatus,
      }),
    tender: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/tenders`, body),
    // A 1% manual discount: accepted on an unlocked bill, 409 while locked.
    discount: (orderId: string) =>
      send(`/${orderId}/discounts`, {
        source: "manual",
        kind: "percent",
        percentBp: 100,
        reason: "manager_goodwill",
        reasonNote: "Diskon kecil pelanggan tetap",
      }),
  };
}

type Order = {
  orderId: string;
  number: string;
  totalIdr: number;
  status: string;
};

async function newOrder(): Promise<Order> {
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  let status = created.body.data.status as string;
  const orderId = created.body.data.id as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  return {
    orderId,
    number: created.body.data.number as string,
    totalIdr: created.body.data.totalIdr as number,
    status,
  };
}

/** One ECR sale row of the ledger, optionally flagged for reconciliation. */
async function ledgerSale(input: {
  reference: string;
  amountIdr: number;
  status: string;
  flagged?: boolean;
  mode?: string;
  approvalCode?: string | null;
  rrn?: string | null;
  /** Defaults to older than the late-response window, so an `unknown` row is
   * past the point where the terminal could still answer. Override to test the
   * window itself. */
  dispatchedAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  const final = ["approved", "declined", "cancelled", "failed"].includes(
    input.status,
  );
  await asOwnerTenant((client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          approval_code, rrn, completed_at, needs_reconciliation, dispatched_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', $8, 'sale', $9, $10,
               $11, $12, $13, $14, $15)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        terminalId,
        input.reference,
        randomUUID(),
        input.amountIdr,
        input.status,
        input.mode ?? "ecr",
        randomUUID().replaceAll("-", "").slice(0, 12),
        input.approvalCode === undefined ? null : input.approvalCode,
        input.rrn === undefined ? null : input.rrn,
        final ? new Date() : null,
        input.flagged ?? true,
        input.dispatchedAt ??
          new Date(Date.now() - EDC_LATE_RESPONSE_WINDOW_MS - 60_000),
      ],
    ),
  );
  return id;
}

async function setFlag(edcTransactionId: string, value: boolean) {
  await asOwnerTenant((client) =>
    client.query(
      `UPDATE edc_transactions SET needs_reconciliation = $2 WHERE id = $1`,
      [edcTransactionId, value],
    ),
  );
}

async function setWireOpen(edcTransactionId: string) {
  await asOwnerTenant((client) =>
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
    amount_idr: string;
    approval_code: string | null;
    rrn: string | null;
    completed_at: Date | null;
  }>(
    `SELECT status, needs_reconciliation, amount_idr::text AS amount_idr,
            approval_code, rrn, completed_at
     FROM edc_transactions WHERE id = $1`,
    [edcTransactionId],
  );
  return rows[0]!;
}

/** Live tenders of the order (status not voided/failed). */
async function liveTenders(orderId: string) {
  const { rows } = await owner.query<{ count: string; sum: string | null }>(
    `SELECT count(*)::text AS count, sum(amount_idr)::text AS sum
     FROM pos_order_tenders
     WHERE order_id = $1 AND status NOT IN ('voided', 'failed')`,
    [ulidToUuid(orderId)],
  );
  return {
    count: Number(rows[0]!.count),
    sumIdr: Number(rows[0]!.sum ?? 0),
  };
}

async function tendersOfRow(edcTransactionId: string): Promise<number> {
  const { rows } = await owner.query(
    `SELECT 1 FROM pos_order_tenders
     WHERE edc_transaction_id = $1 AND status NOT IN ('voided', 'failed')`,
    [edcTransactionId],
  );
  return rows.length;
}

async function auditRows(edcTransactionId: string) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2
       AND event->>'objectId' = $3`,
    [tenant.tenantId, ACTION, edcTransactionId],
  );
  return rows;
}

function payEdc(order: Order, edcTransactionId: string) {
  return pos().tender(order.orderId, {
    method: "edc_card",
    expectedStatus: order.status,
    edcTransactionId,
  });
}

type Evidence = {
  source: "inquiry" | "terminal_receipt" | "bank_statement";
  note: string;
  approvalCode?: string;
  rrn?: string;
  chargedAmountIdr?: number;
};
const evidence = (extra: Partial<Evidence> = {}): Evidence => ({
  source: "inquiry",
  note: "Dicek ke mesin EDC: status transaksi sudah dipastikan",
  ...extra,
});

function resolve(
  who: Member,
  edcTransactionId: string,
  body: Record<string, unknown>,
) {
  return who.client
    .post(
      `/api/payments/admin/edc/transactions/${encodeURIComponent(edcTransactionId)}/reconciliation`,
    )
    .set(headers)
    .set(originHeader)
    .send(body);
}

// EdcError("EDC_AMOUNT_MISMATCH") answers HTTP as a 409 CONFLICT with its
// own message (packages/shared/src/edc/index.ts), like the agent's refusal.
function expectAmountMismatch(res: {
  body: { error?: { code?: string; message?: string } };
}) {
  expect(res.body.error?.code, JSON.stringify(res.body)).toBe("CONFLICT");
  expect(res.body.error?.message).toBe(
    new EdcError("EDC_AMOUNT_MISMATCH").message,
  );
}

const declined = (extra: Partial<Evidence> = {}) => ({
  outcome: "declined",
  evidence: evidence(extra),
});
// `approved` requires the amount printed on the terminal evidence (F1).
const approved = (chargedAmountIdr: number, extra: Partial<Evidence> = {}) => ({
  outcome: "approved",
  evidence: evidence({ chargedAmountIdr, ...extra }),
});

/** The 1% discount is accepted only when no open ECR request locks the bill. */
async function expectBillUnlocked(order: Order) {
  const res = await pos().discount(order.orderId);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}
async function expectBillLocked(order: Order) {
  const res = await pos().discount(order.orderId);
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(res.body.error?.code, JSON.stringify(res.body)).toBe(
    "EDC_REQUEST_OPEN",
  );
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`edr-${randomUUID().slice(0, 6)}`);
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
  const roles: [string, string, readonly string[]][] = [
    [
      ids.cashierRole,
      "EDC Rekon Kasir",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "shift.cash.operate",
      ],
    ],
    [
      ids.supervisorRole,
      "EDC Rekon Supervisor",
      roleTemplate("supervisor").permissions,
    ],
    [ids.ownerRole, "EDC Rekon Owner", roleTemplate("owner").permissions],
    [ids.financeRole, "EDC Rekon Finance", roleTemplate("finance").permissions],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "Rekon Kasir");
  supervisor = await member(ids.supervisorRole, "Rekon Supervisor");
  ownerUser = await member(ids.ownerRole, "Rekon Owner");
  financeUser = await member(ids.financeRole, "Rekon Finance");
  ownerNoMfa = await member(ids.ownerRole, "Rekon Owner Tanpa MFA", false);
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
  terminalId = randomUUID();
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Rekon Uji', 0)`,
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
    await client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-RECON', 'MID-RECON', 'Test EDC', 'lan',
               '10.0.0.8', ARRAY['card','qris'], 'active')`,
      [terminalId, tenant.tenantId, tenant.outletId],
    );
  });
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- Permission ---------------------------------------------------------------

describe("EDC-06 who may resolve an EDC reconciliation (Owner or Finance, either suffices)", () => {
  it("a cashier and a supervisor get 403 and the flagged request is untouched", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    for (const who of [cashier, supervisor]) {
      const res = await resolve(who, id, declined());
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }
    expect(await row(id)).toMatchObject({
      status: "unknown",
      needs_reconciliation: true,
    });
    expect(await auditRows(id)).toHaveLength(0);
    await expectBillLocked(order);
  });

  it("an anonymous caller gets 401", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    const res = await agent(app)
      .post(`/api/payments/admin/edc/transactions/${id}/reconciliation`)
      .set(headers)
      .set(originHeader)
      .send(declined());
    expect(res.status).toBe(401);
    expect((await row(id)).needs_reconciliation).toBe(true);
  });

  it.each([
    ["owner", () => ownerUser],
    ["finance manager", () => financeUser],
  ])(
    "a %s alone (no second person) resolves it and the audit records who",
    async (_label, who) => {
      const order = await newOrder();
      const id = await ledgerSale({
        reference: order.number,
        amountIdr: order.totalIdr,
        status: "unknown",
      });
      const res = await resolve(who(), id, declined());
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({
        id,
        status: "declined",
        needsReconciliation: false,
      });
      const audits = await auditRows(id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.event).toMatchObject({
        action: ACTION,
        objectId: id,
        actorId: who().userId,
      });
      expect(JSON.stringify(audits[0]!.event)).toContain("declined");
    },
  );
});

// ---- Rule 1: eligibility ----------------------------------------------------------

describe("EDC-06 only a flagged sale row can be resolved, and only once", () => {
  it("an unknown row id is 404", async () => {
    const res = await resolve(ownerUser, randomUUID(), declined());
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it("a row that is not flagged is refused 409 and left as it was", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "declined",
      flagged: false,
    });
    const res = await resolve(ownerUser, id, declined());
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(await row(id)).toMatchObject({
      status: "declined",
      needs_reconciliation: false,
    });
    expect(await auditRows(id)).toHaveLength(0);
  });

  it("a pending (still in flight) flagged row cannot be resolved by hand", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "pending",
    });
    for (const body of [declined(), approved(order.totalIdr)]) {
      const res = await resolve(ownerUser, id, body);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
    }
    expect(await row(id)).toMatchObject({
      status: "pending",
      needs_reconciliation: true,
    });
    await expectBillLocked(order);
  });

  it("a row past the late-response window whose adapter call is still open is refused 409 and left untouched", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    await setWireOpen(id);
    for (const body of [declined(), approved(order.totalIdr)]) {
      const res = await resolve(ownerUser, id, body);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
    }
    expect(await row(id)).toMatchObject({
      status: "unknown",
      needs_reconciliation: true,
      completed_at: null,
    });
    expect(await auditRows(id)).toHaveLength(0);
    expect(await tendersOfRow(id)).toBe(0);
  });

  it("resolving twice: the second answer is 409 and there is one audit row", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    expect((await resolve(ownerUser, id, declined())).status).toBe(200);
    const again = await resolve(financeUser, id, approved(order.totalIdr));
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect((await row(id)).status).toBe("declined");
    expect(await auditRows(id)).toHaveLength(1);
    expect(await tendersOfRow(id)).toBe(0);
  });
});

describe("EDC-06 the resolve body is strictly validated", () => {
  it.each([
    ["no note", { outcome: "declined", evidence: { source: "inquiry" } }],
    [
      "an empty note",
      { outcome: "declined", evidence: { source: "inquiry", note: "" } },
    ],
    [
      "a note over 500 characters",
      {
        outcome: "declined",
        evidence: { source: "inquiry", note: "x".repeat(501) },
      },
    ],
    [
      "an unknown evidence source",
      { outcome: "declined", evidence: { source: "gossip", note: "ok" } },
    ],
    ["an unknown outcome", { outcome: "cancelled", evidence: evidence() }],
    ["no outcome", { evidence: evidence() }],
    ["no evidence", { outcome: "declined" }],
    [
      "an unexpected extra field",
      { outcome: "declined", evidence: evidence(), amountIdr: 1 },
    ],
  ])("%s is 422 and changes nothing", async (_label, body) => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    const res = await resolve(ownerUser, id, body);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(await row(id)).toMatchObject({
      status: "unknown",
      needs_reconciliation: true,
    });
    expect(await auditRows(id)).toHaveLength(0);
  });
});

// ---- Rule 2: declined ---------------------------------------------------------------

describe("EDC-02 resolving a flagged request as declined releases the bill and records no payment", () => {
  it("unknown -> declined: the bill is unlocked, still unpaid, and another tender can pay it", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    await expectBillLocked(order);

    const res = await resolve(
      ownerUser,
      id,
      declined({ source: "terminal_receipt" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      id,
      status: "declined",
      needsReconciliation: false,
    });
    expect(res.body.data.completedAt).not.toBeNull();
    expect(await row(id)).toMatchObject({
      status: "declined",
      needs_reconciliation: false,
    });

    // Nobody was paid; the lock is open again.
    expect(await liveTenders(order.orderId)).toEqual({ count: 0, sumIdr: 0 });
    const bill = await pos().get(order.orderId);
    expect(bill.body.data).toMatchObject({
      totalIdr: order.totalIdr,
      tenders: [],
    });
    expect(bill.body.data.status).not.toBe("completed");

    // The declined EDC sale is not bookable as a tender.
    const refused = await payEdc(order, id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);

    // Another method pays the bill once, at the bill amount.
    const cash = await pos().cash(order.orderId, order.status, order.totalIdr);
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(cash.body.data.remainingIdr).toBe(0);
    expect(await liveTenders(order.orderId)).toEqual({
      count: 1,
      sumIdr: order.totalIdr,
    });
    expect(await tendersOfRow(id)).toBe(0);
  });

  it("the discount path (EDC-01 lock) opens again after the declined resolve", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    await expectBillLocked(order);
    expect((await resolve(financeUser, id, declined())).status).toBe(200);
    await expectBillUnlocked(order);
  });

  it.each(["declined", "cancelled", "failed"])(
    "a %s row flagged (late approval) is resolved as declined: status stays %s, flag cleared, bill unlocked",
    async (status) => {
      const order = await newOrder();
      const id = await ledgerSale({
        reference: order.number,
        amountIdr: order.totalIdr,
        status,
      });
      await expectBillLocked(order);
      const res = await resolve(ownerUser, id, declined());
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({
        status,
        needsReconciliation: false,
      });
      expect(await row(id)).toMatchObject({
        status,
        needs_reconciliation: false,
      });
      await expectBillUnlocked(order);
      expect(await liveTenders(order.orderId)).toEqual({ count: 0, sumIdr: 0 });
    },
  );

  it("declined is refused while a live tender references the row (the customer paid)", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "approved",
      flagged: false,
      approvalCode: "APP123",
      rrn: "RRN000000001",
    });
    const paid = await payEdc(order, id);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    await setFlag(id, true);

    const res = await resolve(ownerUser, id, declined());
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(await row(id)).toMatchObject({
      status: "approved",
      needs_reconciliation: true,
    });
    expect(await tendersOfRow(id)).toBe(1);
    expect(await liveTenders(order.orderId)).toEqual({
      count: 1,
      sumIdr: order.totalIdr,
    });
    expect(await auditRows(id)).toHaveLength(0);
  });
});

// ---- Rule 3: approved ---------------------------------------------------------------

describe("EDC-03 resolving an unknown request as approved books the payment exactly once", () => {
  it.each([
    ["owner", () => ownerUser],
    ["finance manager", () => financeUser],
  ])(
    "%s: unknown -> approved, then exactly one EDC tender settles the bill at the row amount",
    async (_label, who) => {
      const order = await newOrder();
      const id = await ledgerSale({
        reference: order.number,
        amountIdr: order.totalIdr,
        status: "unknown",
      });
      const res = await resolve(
        who(),
        id,
        approved(order.totalIdr, {
          source: "bank_statement",
          approvalCode: "AC7788",
          rrn: "RRN123456789",
        }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({
        id,
        status: "approved",
        needsReconciliation: false,
        amountIdr: order.totalIdr,
        approvalCode: "AC7788",
        rrn: "RRN123456789",
      });
      expect(res.body.data.completedAt).not.toBeNull();
      expect(await row(id)).toMatchObject({
        status: "approved",
        needs_reconciliation: false,
        amount_idr: String(order.totalIdr),
        approval_code: "AC7788",
        rrn: "RRN123456789",
      });
      const audits = await auditRows(id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.event).toMatchObject({
        action: ACTION,
        actorId: who().userId,
      });

      // Resolving is not paying: the bill stays unpaid and locked to everything
      // but the booking of this very approval.
      expect(await liveTenders(order.orderId)).toEqual({ count: 0, sumIdr: 0 });
      await expectBillLocked(order);

      // The existing ECR tender path books it once, at the row amount.
      const paid = await payEdc(order, id);
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      expect(paid.body.data.remainingIdr).toBe(0);
      expect(await liveTenders(order.orderId)).toEqual({
        count: 1,
        sumIdr: order.totalIdr,
      });
      expect(await tendersOfRow(id)).toBe(1);

      // Booking again (new idempotency key) never adds a second payment.
      const again = await payEdc(order, id);
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      expect(await liveTenders(order.orderId)).toEqual({
        count: 1,
        sumIdr: order.totalIdr,
      });
    },
  );

  it("a stale amount (the bill changed after the sale was sent) is refused EDC_AMOUNT_MISMATCH and nothing is paid", async () => {
    const order = await newOrder();
    const discounted = await pos().discount(order.orderId);
    expect(discounted.status, JSON.stringify(discounted.body)).toBe(201);
    const current = await pos().get(order.orderId);
    expect(current.body.data.totalIdr).toBeLessThan(order.totalIdr);
    // The sale was sent for the old, higher total.
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    const res = await resolve(ownerUser, id, approved(order.totalIdr));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expectAmountMismatch(res);
    expect(await row(id)).toMatchObject({
      status: "unknown",
      needs_reconciliation: true,
    });
    expect(await tendersOfRow(id)).toBe(0);
    expect(await liveTenders(order.orderId)).toEqual({ count: 0, sumIdr: 0 });
    expect(await auditRows(id)).toHaveLength(0);
  });

  it("a row amount above the bill (customer charged too much) is refused EDC_AMOUNT_MISMATCH", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr + 1_000,
      status: "unknown",
    });
    const res = await resolve(
      financeUser,
      id,
      approved(order.totalIdr + 1_000),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expectAmountMismatch(res);
    expect((await row(id)).status).toBe("unknown");
    expect(await liveTenders(order.orderId)).toEqual({ count: 0, sumIdr: 0 });
  });

  it("a row amount below the bill is refused too (never part-pays by accident)", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr - 1_000,
      status: "unknown",
    });
    const res = await resolve(ownerUser, id, approved(order.totalIdr - 1_000));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expectAmountMismatch(res);
    expect((await row(id)).status).toBe("unknown");
  });

  it("a reference with no bill at all cannot be approved", async () => {
    const id = await ledgerSale({
      reference: `NOBILL-${randomUUID().slice(0, 8)}`,
      amountIdr: 55_000,
      status: "unknown",
    });
    const res = await resolve(ownerUser, id, approved(55_000));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(await row(id)).toMatchObject({
      status: "unknown",
      needs_reconciliation: true,
    });
    expect(await tendersOfRow(id)).toBe(0);
  });

  it("approved twice: another approved row for the same reference exists -> 409 and the customer is charged only once in the books", async () => {
    const order = await newOrder();
    const first = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "approved",
      flagged: false,
      approvalCode: "FIRST1",
      rrn: "RRN000000002",
    });
    const second = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    const res = await resolve(ownerUser, second, approved(order.totalIdr));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(await row(second)).toMatchObject({
      status: "unknown",
      needs_reconciliation: true,
    });

    // The first approval is booked once; the second never becomes a tender.
    expect((await payEdc(order, first)).status).toBe(201);
    const secondPay = await payEdc(order, second);
    expect(secondPay.status, JSON.stringify(secondPay.body)).toBe(409);
    expect(await liveTenders(order.orderId)).toEqual({
      count: 1,
      sumIdr: order.totalIdr,
    });
    expect(await tendersOfRow(second)).toBe(0);
    expect(await auditRows(second)).toHaveLength(0);
  });

  it("the double charge is resolved by voiding it on the terminal and resolving the second row as declined", async () => {
    const order = await newOrder();
    const first = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "approved",
      flagged: false,
    });
    const second = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    expect((await payEdc(order, first)).status).toBe(201);
    const res = await resolve(
      financeUser,
      second,
      declined({ source: "terminal_receipt" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await row(second)).toMatchObject({
      status: "declined",
      needs_reconciliation: false,
    });
    expect(await liveTenders(order.orderId)).toEqual({
      count: 1,
      sumIdr: order.totalIdr,
    });
  });

  it.each(["declined", "cancelled", "failed"])(
    "a late approval of a %s row is never flipped to approved: 409, status and flag unchanged, bill still locked",
    async (status) => {
      const order = await newOrder();
      const id = await ledgerSale({
        reference: order.number,
        amountIdr: order.totalIdr,
        status,
      });
      const res = await resolve(ownerUser, id, approved(order.totalIdr));
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(await row(id)).toMatchObject({
        status,
        needs_reconciliation: true,
      });
      expect(await tendersOfRow(id)).toBe(0);
      expect(await liveTenders(order.orderId)).toEqual({ count: 0, sumIdr: 0 });
      expect(await auditRows(id)).toHaveLength(0);
      await expectBillLocked(order);
      // The human voids the charge on the terminal and resolves it declined.
      const closed = await resolve(
        ownerUser,
        id,
        declined({ source: "terminal_receipt" }),
      );
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      expect((await row(id)).status).toBe(status);
      await expectBillUnlocked(order);
    },
  );

  it("an already-approved flagged row that is a live tender only has its flag cleared: still exactly one tender", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "approved",
      flagged: false,
    });
    expect((await payEdc(order, id)).status).toBe(201);
    await setFlag(id, true);

    const res = await resolve(financeUser, id, approved(order.totalIdr));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      status: "approved",
      needsReconciliation: false,
    });
    expect(await tendersOfRow(id)).toBe(1);
    expect(await liveTenders(order.orderId)).toEqual({
      count: 1,
      sumIdr: order.totalIdr,
    });
    expect(await auditRows(id)).toHaveLength(1);
  });

  it("an approved ECR row with no tender yet and a bill that can still take it: only the flag is cleared, then the ECR path books it once", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "approved",
    });
    const res = await resolve(ownerUser, id, approved(order.totalIdr));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await row(id)).toMatchObject({
      status: "approved",
      needs_reconciliation: false,
    });
    expect(await auditRows(id)).toHaveLength(1);
    expect(await liveTenders(order.orderId)).toEqual({ count: 0, sumIdr: 0 });
    expect((await payEdc(order, id)).status).toBe(201);
    expect(await tendersOfRow(id)).toBe(1);
  });

  it("an approved ECR row with no tender yet is refused when the bill changed since (EDC_AMOUNT_MISMATCH): the lock stays", async () => {
    const order = await newOrder();
    // The sale amount is stale: it differs from what the bill still owes.
    const staleIdr = order.totalIdr - 1_000;
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: staleIdr,
      status: "approved",
    });
    const res = await resolve(financeUser, id, approved(staleIdr));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expectAmountMismatch(res);
    expect(await row(id)).toMatchObject({
      status: "approved",
      needs_reconciliation: true,
    });
    expect(await auditRows(id)).toHaveLength(0);
    expect(await tendersOfRow(id)).toBe(0);
  });

  it("an approved standalone (hand-keyed) row with no live tender is refused (it can never be booked later)", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "approved",
      mode: "standalone",
    });
    const res = await resolve(ownerUser, id, approved(order.totalIdr));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(await row(id)).toMatchObject({
      status: "approved",
      needs_reconciliation: true,
    });
    expect(await auditRows(id)).toHaveLength(0);
  });

  it("approved needs the amount printed on the terminal evidence: missing -> 422, different from the request -> EDC_AMOUNT_MISMATCH, row untouched", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    const missing = await resolve(ownerUser, id, {
      outcome: "approved",
      evidence: evidence(),
    });
    expect(missing.status, JSON.stringify(missing.body)).toBe(422);
    const different = await resolve(
      ownerUser,
      id,
      approved(order.totalIdr + 500),
    );
    expect(different.status, JSON.stringify(different.body)).toBe(409);
    expectAmountMismatch(different);
    expect(await row(id)).toMatchObject({
      status: "unknown",
      needs_reconciliation: true,
    });
    expect(await tendersOfRow(id)).toBe(0);
    expect(await auditRows(id)).toHaveLength(0);
  });

  // X1 (cloud-only release §3): a difference between the bank evidence and
  // the booked amount leaves the row "perlu dicek" (still flagged) and alerts
  // the outlet supervisors and owners once per row and stated amount.
  it("X1 a charged amount that differs from the row stays flagged and raises one alert", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "approved",
      mode: "standalone",
    });
    const alerts = async () =>
      (
        await owner.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM notification_outbox
           WHERE tenant_id = $1 AND event_type = 'edc_transaction.reconciliation_mismatch'
             AND payload->>'edcTransactionId' = $2`,
          [tenant.tenantId, id],
        )
      ).rows;
    const counts: number[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await resolve(ownerUser, id, approved(order.totalIdr - 500));
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expectAmountMismatch(res);
      counts.push((await alerts()).length);
    }
    // The same stated amount alerts once, however often it is sent.
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(counts[0]);
    expect(await row(id)).toMatchObject({
      status: "approved",
      needs_reconciliation: true,
    });
    expect(await auditRows(id)).toHaveLength(0);
    const sent = await alerts();
    expect(sent[0]?.payload).toMatchObject({
      edcTransactionId: id,
      amountIdr: String(order.totalIdr),
      chargedAmountIdr: String(order.totalIdr - 500),
    });
  });

  it("a declined answer does not need (and ignores) the charged amount", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    const res = await resolve(ownerUser, id, declined({ chargedAmountIdr: 1 }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await row(id)).status).toBe("declined");
  });

  it("an Owner session without a verified second factor is refused (MFA_REQUIRED) and the row is untouched", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    for (const body of [declined(), approved(order.totalIdr)]) {
      const res = await resolve(ownerNoMfa, id, body);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error?.code, JSON.stringify(res.body)).toBe(
        "MFA_REQUIRED",
      );
    }
    expect(await row(id)).toMatchObject({
      status: "unknown",
      needs_reconciliation: true,
    });
    expect(await auditRows(id)).toHaveLength(0);
    await expectBillLocked(order);
  });

  it("two people approving the same request at the same time: exactly one wins, one tender in the end", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    const [a, b] = await Promise.all([
      resolve(ownerUser, id, approved(order.totalIdr)),
      resolve(financeUser, id, approved(order.totalIdr)),
    ]);
    expect(
      [a.status, b.status].sort(),
      JSON.stringify([a.body, b.body]),
    ).toEqual([200, 409]);
    expect(await auditRows(id)).toHaveLength(1);
    expect((await payEdc(order, id)).status).toBe(201);
    expect(await liveTenders(order.orderId)).toEqual({
      count: 1,
      sumIdr: order.totalIdr,
    });
  });

  it("an owner and a finance manager answering opposite outcomes at once: one answer wins and money is never both paid and released", async () => {
    const order = await newOrder();
    const id = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "unknown",
    });
    const [a, b] = await Promise.all([
      resolve(ownerUser, id, approved(order.totalIdr)),
      resolve(financeUser, id, declined()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const final = await row(id);
    expect(final.needs_reconciliation).toBe(false);
    expect(["approved", "declined"]).toContain(final.status);
    expect(await auditRows(id)).toHaveLength(1);
    // Whatever won, the bill is never paid more than once.
    if (final.status === "approved") {
      expect((await payEdc(order, id)).status).toBe(201);
      expect((await liveTenders(order.orderId)).count).toBe(1);
    } else {
      expect(await liveTenders(order.orderId)).toEqual({ count: 0, sumIdr: 0 });
      expect((await payEdc(order, id)).status).toBe(409);
    }
  });
});
