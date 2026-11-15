// POS QRIS capture vs the EDC-01 bill lock (bead legend-56gg2, tier K / money).
//
// Founder rule: the guest is never charged twice for one bill and the outlet
// is never short. A POS QRIS tender the guest has paid must NOT be captured
// while an EDC (ECR) card request is open on the same bill; the QRIS money is
// refunded in full and the card sale wins. Before the fix the paid webhook
// (`handlePosPaymentPaid`) captured the QRIS tender without taking the EDC-01
// bill lock, so "QRIS 100k open, cashier starts card 100k, guest pays both"
// charged the guest twice with no flag.
//
// Written from docs/briefs (brief-qris.md "Design" and "Tests") and the
// existing fixtures of pos-qris-capture-refund-race.test.ts (QRIS rows, stall
// by pg_locks polling), pos-edc-tender.test.ts (ledger rows, edc_card tender)
// and edc-agent-amount.test.ts (card write-ahead through the EDC agent).
//
// Assumptions where the brief is not exact:
// - "Open EDC request" = a sale row of the bill (reference = order number) in
//   pending or unknown, OR flagged needs_reconciliation, OR approved while no
//   live (authorized/captured) tender holds it (EDC-01 definition).
// - One isolated tenant with real POS bills created through the API; the QRIS
//   link, paid intent, evidence and the authorized QRIS tender are raw rows
//   (the paid webhook state), as in the capture-refund race test.
// - The webhook is `handlePosPaymentPaid` called directly with a minimal
//   `payment.paid` envelope (same cast as the sibling tests).
// - "Late-payment refund requested" = exactly one payment_refunds row on the
//   paid intent, filed by system:pos, for the full intent amount.
// - "The bill is not paid" = no captured QRIS tender and the order status is
//   unchanged by the webhook.
// - Case f accepts any refusal of the card write-ahead (the exact code is the
//   amount check or the not-payable check); what is asserted is that it is
//   refused and records no ledger row.
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
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EdcPaymentRequest } from "@starter/shared/edc";
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { createEdcAgent } from "../edge/edc/agent.ts";
import { EdcProviderRegistry } from "../edge/edc/registry.ts";
import { EcrSimulator } from "../edge/edc/simulator.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import {
  handlePosPaymentPaid,
  type DomainEvent,
} from "../services/pos-order-payment.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
  device: randomUUID(),
  terminal: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: { client: ReturnType<typeof agent>; userId: string };
let ctx: ScopedTenantContext;
let edcAgent: ReturnType<typeof createEdcAgent>;

function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let next = 0;
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      next += 1;
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? ids.device,
        number: `POS1-${String(next).padStart(6, "0")}`,
        sequenceNumber: next,
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
    async voidForOrder() {
      return null;
    },
  };
}

async function inTenantTransaction<T>(
  client: PoolClient,
  run: () => Promise<T>,
): Promise<T> {
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenant.tenantId],
  );
  return run();
}

async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const result = await inTenantTransaction(client, () => run(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function pos() {
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
    cashier.client
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
    get: (orderId: string) =>
      cashier.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    tender: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/tenders`, body),
  };
}

// ---- Bill, QRIS and EDC fixtures --------------------------------------------

type Bill = {
  orderId: string; // API (ULID) id
  orderUuid: string; // database id
  number: string;
  totalIdr: number;
  status: string;
};

async function newBill(): Promise<Bill> {
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
    orderUuid: ulidToUuid(orderId),
    number: created.body.data.number as string,
    totalIdr: created.body.data.totalIdr as number,
    status,
  };
}

type Qris = { linkId: string; intentId: string; tenderId: string };

/**
 * The guest has paid the bill's QRIS in full: link, `paid` intent, evidence
 * and the authorized POS tender, as the WS-05 webhook leaves them before the
 * POS consumer (`deliverPaid`) runs.
 */
async function paidQris(bill: Bill): Promise<Qris> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  const amount = bill.totalIdr;
  const tenderId = await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'qris-edc-lock-test')`,
      [
        linkId,
        tenant.tenantId,
        tenant.outletId,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `QL-${linkId.slice(0, 8)}`,
        amount,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
          idempotency_key, status, instructions, expires_at, paid_at, provider_ref)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
               now() + interval '1 hour', now(), $7)`,
      [
        intentId,
        tenant.tenantId,
        tenant.outletId,
        linkId,
        amount,
        `ql-pay-${intentId}`,
        `ref-${intentId.slice(0, 8)}`,
      ],
    );
    await client.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [
        tenant.tenantId,
        tenant.outletId,
        intentId,
        `evidence-${intentId}`,
        amount,
      ],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
          payment_link_id, payment_link_token_sealed, payment_intent_id, amount_idr,
          status, requested_at)
       VALUES ($1, $2, $3, 'qris', 'doit', $4, 'sealed-test-token', $5, $6,
               'authorized', now())
       RETURNING id`,
      [
        tenant.tenantId,
        tenant.outletId,
        bill.orderUuid,
        linkId,
        intentId,
        amount,
      ],
    );
    return rows[0]!.id;
  });
  return { linkId, intentId, tenderId };
}

/** The verified `payment.paid` of the QRIS, as the outbox consumer hands it. */
const deliverPaid = (qris: Qris) =>
  handlePosPaymentPaid(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    ),
    {
      name: "payment.paid",
      payload: { paymentLinkId: qris.linkId, intentId: qris.intentId },
    } as unknown as DomainEvent,
  );

type EdcState = {
  status?: string;
  needsReconciliation?: boolean;
};

/**
 * A card ECR sale of the bill in the EDC ledger. `client` writes it inside an
 * open transaction (case e); otherwise it is committed at once.
 */
async function ecrSale(
  bill: Bill,
  { status = "approved", needsReconciliation = false }: EdcState = {},
  client?: PoolClient,
): Promise<string> {
  const id = randomUUID();
  const final = ["approved", "declined", "cancelled", "failed"].includes(
    status,
  );
  const insert = (c: PoolClient) =>
    c.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          approval_code, rrn, needs_reconciliation, completed_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', $8, 'sale', 'ecr', $9,
               'APP123', $10, $11, $12)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        ids.terminal,
        bill.number,
        randomUUID(),
        bill.totalIdr,
        status,
        randomUUID().slice(0, 12),
        "RRN" + randomUUID().replace(/-/g, "").slice(0, 9),
        needsReconciliation,
        final ? new Date() : null,
      ],
    );
  if (client) await insert(client);
  else await asOwnerTenant(insert);
  return id;
}

async function approveSale(edcTransactionId: string) {
  await asOwnerTenant((client) =>
    client.query(
      `UPDATE edc_transactions
          SET status = 'approved', completed_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, edcTransactionId],
    ),
  );
}

/** Books the approved ECR sale as the bill's card tender, as the POS does. */
async function bookCardTender(bill: Bill, edcTransactionId: string) {
  const got = await pos().get(bill.orderId);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  const booked = await pos().tender(bill.orderId, {
    method: "edc_card",
    expectedStatus: got.body.data.status as string,
    edcTransactionId,
  });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  expect(booked.body.data.remainingIdr).toBe(0);
}

async function tenderStatus(tenderId: string): Promise<string | undefined> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM pos_order_tenders WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, tenderId],
  );
  return rows[0]?.status;
}

async function orderStatus(bill: Bill): Promise<string | undefined> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM orders WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, bill.orderUuid],
  );
  return rows[0]?.status;
}

async function capturedTenders(bill: Bill) {
  const { rows } = await owner.query<{ method: string; amount: string }>(
    `SELECT method, amount_idr::text AS amount FROM pos_order_tenders
      WHERE tenant_id = $1 AND order_id = $2 AND status = 'captured'`,
    [tenant.tenantId, bill.orderUuid],
  );
  return rows;
}

async function refundRows(intentId: string) {
  const { rows } = await owner.query<{
    status: string;
    amount: string;
    requested_by: string;
  }>(
    `SELECT status, amount_idr::text AS amount, requested_by FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY created_at`,
    [tenant.tenantId, intentId],
  );
  return rows;
}

async function ledgerRows(bill: Bill) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM edc_transactions WHERE tenant_id = $1 AND reference = $2",
    [tenant.tenantId, bill.number],
  );
  return rows;
}

/**
 * The money invariant, asserted in every case: the captured tenders never
 * exceed the bill, and the guest never has a captured QRIS tender while a card
 * sale of the same bill is pending, unknown or approved.
 */
async function expectNoDoubleCharge(bill: Bill) {
  const { rows } = await owner.query<{
    captured_sum: string;
    qris_captured: string;
    edc_live: string;
  }>(
    `SELECT coalesce(sum(t.amount_idr) FILTER (WHERE t.status = 'captured'), 0)::text AS captured_sum,
            count(*) FILTER (WHERE t.status = 'captured' AND t.method = 'qris')::text AS qris_captured,
            (SELECT count(*) FROM edc_transactions e
              WHERE e.tenant_id = $1 AND e.reference = $3 AND e.type = 'sale'
                AND e.status IN ('pending', 'unknown', 'approved'))::text AS edc_live
       FROM pos_order_tenders t
      WHERE t.tenant_id = $1 AND t.order_id = $2`,
    [tenant.tenantId, bill.orderUuid, bill.number],
  );
  const row = rows[0]!;
  expect(
    Number(row.captured_sum),
    "captured tenders exceed the bill total",
  ).toBeLessThanOrEqual(bill.totalIdr);
  expect(
    Number(row.qris_captured) > 0 && Number(row.edc_live) > 0,
    "QRIS captured while a card sale of the same bill is live",
  ).toBe(false);
}

/** QRIS refused: tender voided, one full late-payment refund, bill unchanged. */
async function expectQrisRefunded(
  bill: Bill,
  qris: Qris,
  statusBefore: string | undefined,
) {
  expect(await tenderStatus(qris.tenderId)).toBe("voided");
  expect(await orderStatus(bill)).toBe(statusBefore);
  const refunds = await refundRows(qris.intentId);
  expect(refunds).toHaveLength(1);
  expect(refunds[0]).toMatchObject({
    amount: String(bill.totalIdr),
    requested_by: "system:pos",
  });
}

/**
 * Polls whether `competitor` waits on an advisory lock held by `holderPid`
 * ("blocked") or finishes first ("settled"). Bounded, never a fixed sleep.
 */
async function raceOnAdvisoryLock(
  holderPid: number,
  competitor: Promise<unknown>,
): Promise<"blocked" | "settled"> {
  let settled = false;
  void competitor.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let attempt = 0; attempt < 600; attempt++) {
    if (settled) return "settled";
    const { rows } = await owner.query(
      `SELECT l.pid FROM pg_locks l
        WHERE l.locktype = 'advisory' AND NOT l.granted
          AND $1::int = ANY(pg_blocking_pids(l.pid))
        LIMIT 1`,
      [holderPid],
    );
    if (rows[0]) return "blocked";
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The webhook neither settled nor waited on the bill lock");
}

function request(reference: string, amountIdr: number): EdcPaymentRequest {
  return {
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    outletId: outletIdSchema.parse(tenant.outletId),
    terminalId: ids.terminal,
    reference,
    idempotencyKey: randomUUID(),
    amountIdr: idr(amountIdr),
    method: "card",
  } as EdcPaymentRequest;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`qel-${randomUUID().slice(0, 6)}`);
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
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'QRIS EDC Kasir', false, NULL, $3, false, '["tenant"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "shift.cash.operate",
      ]),
    ],
  );
  const client = agent(app);
  await signUp(client, "QRIS EDC Kasir");
  const session = await client.get("/api/auth/get-session");
  cashier = { client, userId: session.body.user.id as string };
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, cashier.userId, ids.cashierRole],
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
  await asOwnerTenant(async (c) => {
    await c.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QRIS EDC Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await c.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await c.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await c.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
    );
    await c.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await c.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-QEL', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await c.query(
      `INSERT INTO pos_approval_policies (tenant_id, outlet_id, discount_threshold_bp)
       VALUES ($1, NULL, 1000)`,
      [tenant.tenantId],
    );
    await c.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-QEL', 'MID-QEL', 'Test EDC', 'lan',
               '10.0.0.8', ARRAY['card','qris'], 'active')`,
      [ids.terminal, tenant.tenantId, tenant.outletId],
    );
  });
  ctx = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
  );
  const registry = new EdcProviderRegistry();
  registry.register(new EcrSimulator("bca"));
  edcAgent = createEdcAgent({
    db,
    registry,
    saleTimeoutMs: 50,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
  });
  await edcAgent.start(ctx);
});

afterAll(async () => {
  await edcAgent?.stop(ctx).catch(() => undefined);
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-56gg2 a paid POS QRIS is never captured while an EDC request is open on the bill", () => {
  it("legend-56gg2 a: a pending card sale, then the QRIS is paid: QRIS voided and refunded, then the card tender books the bill once", async () => {
    const bill = await newBill();
    const sale = await ecrSale(bill, { status: "pending" });
    const qris = await paidQris(bill);
    const before = await orderStatus(bill);

    await deliverPaid(qris);

    await expectQrisRefunded(bill, qris, before);
    expect(await capturedTenders(bill)).toEqual([]);
    await expectNoDoubleCharge(bill);

    // The card sale is then approved and the POS books it: one settlement.
    await approveSale(sale);
    await bookCardTender(bill, sale);
    const captured = await capturedTenders(bill);
    expect(captured).toEqual([
      { method: "edc_card", amount: String(bill.totalIdr) },
    ]);
    await expectNoDoubleCharge(bill);
  });

  const openStates: [string, EdcState][] = [
    ["unknown", { status: "unknown" }],
    [
      "declined but flagged needs_reconciliation",
      { status: "declined", needsReconciliation: true },
    ],
    ["approved without a live tender", { status: "approved" }],
  ];
  it.each(openStates)(
    "legend-56gg2 b: an EDC sale %s refuses the QRIS capture and refunds it in full",
    async (_label, state) => {
      const bill = await newBill();
      await ecrSale(bill, state);
      const qris = await paidQris(bill);
      const before = await orderStatus(bill);

      await deliverPaid(qris);

      await expectQrisRefunded(bill, qris, before);
      expect(await capturedTenders(bill)).toEqual([]);
      await expectNoDoubleCharge(bill);
    },
  );

  it("legend-56gg2 c: a card sale that ended declined (no flag) does not stop the QRIS capture", async () => {
    const bill = await newBill();
    await ecrSale(bill, { status: "declined" });
    const qris = await paidQris(bill);

    await deliverPaid(qris);

    expect(await tenderStatus(qris.tenderId)).toBe("captured");
    expect(await capturedTenders(bill)).toEqual([
      { method: "qris", amount: String(bill.totalIdr) },
    ]);
    expect(await refundRows(qris.intentId)).toEqual([]);
    await expectNoDoubleCharge(bill);
  });

  it("legend-56gg2 d: the card is approved and its tender already booked: the QRIS is not captured and is refunded", async () => {
    const bill = await newBill();
    const sale = await ecrSale(bill, { status: "approved" });
    await bookCardTender(bill, sale);
    const qris = await paidQris(bill);
    const before = await orderStatus(bill);

    await deliverPaid(qris);

    await expectQrisRefunded(bill, qris, before);
    expect(await capturedTenders(bill)).toEqual([
      { method: "edc_card", amount: String(bill.totalIdr) },
    ]);
    await expectNoDoubleCharge(bill);
  });

  it("legend-56gg2 e: the webhook waits for a card write-ahead holding the bill lock, then refuses to capture", async () => {
    const bill = await newBill();
    const qris = await paidQris(bill);
    const before = await orderStatus(bill);
    // Simulates the EDC agent's write-ahead mid-flight: it holds the EDC-01
    // advisory lock of this bill in an open transaction.
    const holder = await owner.connect();
    let webhook: Promise<void> | undefined;
    try {
      await holder.query("BEGIN");
      await inTenantTransaction(holder, async () => {
        await holder.query(
          "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
          [tenant.tenantId, `${tenant.outletId}:${bill.number}`],
        );
      });
      const { rows } = await holder.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );

      webhook = deliverPaid(qris);

      expect(
        await raceOnAdvisoryLock(rows[0]!.pid, webhook),
        "the QRIS webhook must wait for the EDC-01 bill lock",
      ).toBe("blocked");
      // Nothing is captured while the write-ahead is still open.
      expect(await tenderStatus(qris.tenderId)).toBe("authorized");

      await ecrSale(bill, { status: "pending" }, holder);
      await holder.query("COMMIT");
      await webhook;

      await expectQrisRefunded(bill, qris, before);
      expect(await capturedTenders(bill)).toEqual([]);
      await expectNoDoubleCharge(bill);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await webhook?.catch(() => undefined);
    }
  });

  it("legend-56gg2 f: the QRIS captured first: a full-amount card write-ahead is refused and records nothing", async () => {
    const bill = await newBill();
    const qris = await paidQris(bill);
    await deliverPaid(qris);
    expect(await tenderStatus(qris.tenderId)).toBe("captured");

    const refused = await edcAgent
      .requestPayment(ctx, cashier.userId, request(bill.number, bill.totalIdr))
      .then(
        () => false,
        () => true,
      );

    expect(refused, "the card sale of an already paid bill was accepted").toBe(
      true,
    );
    expect(await ledgerRows(bill)).toEqual([]);
    expect(await capturedTenders(bill)).toEqual([
      { method: "qris", amount: String(bill.totalIdr) },
    ]);
    await expectNoDoubleCharge(bill);
  });
});
