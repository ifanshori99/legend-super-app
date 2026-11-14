// Second-opinion findings of the EDC bill lock (bead legend-ftsq0, branch
// fix/edc-so-829; docs/briefs/so-edc-829-findings.md and the CTO decisions of
// docs/briefs/sub-edc-so-829.md). Tier K / money. Founder rule: the guest is
// never charged twice and the outlet is never short; when unsure, REJECT.
// One test per finding. Written to the findings and the CTO decisions, not to
// the implementation: every test is expected to FAIL on base 7e32d2707.
//
//   P1-A  cancel answered `cancelled` while the sale is still on the wire:
//         the bill stays locked (cash refused, QRIS never survives), and when
//         the sale then answers `approved` the guest has paid exactly once.
//   P1-B  `unknown` without the flag (terminal with no inquiry and no cancel):
//         Owner/Finance (MFA) can resolve it with evidence, but only after the
//         delayed-response window; before that it stays fail-closed.
//   P1-C  `declined` by hand is refused while the sale may still charge the
//         card (cancel answered with a wrong trace, sale call not settled);
//         the late charge ends `approved` with its approval code.
//   P1-D  a sale that timed out and is late-approved after `stop()`: stop()
//         waits for the late write; the row is `approved` and the "wire open"
//         marker (`sale_wire_open_at`) is cleared.
//   P1-E  a late approval after the row is already final keeps the evidence
//         (approval code, RRN) and flags the row.
//   P1-F  round 3: a cancel answer alone never ends a dispatched sale (queued
//         cancel on a dispatched `unknown` row keeps it `unknown`); a row that
//         never reached the terminal is still cancelled.
//   P1-G  round 3: `createEdcAgent` refuses a sale timeout that is not shorter
//         than the late-response window.
//   P1-H  round 3: an outlet re-acquire (`start()` again) keeps the wire
//         marker of a sale call of this very process that is still running.
//   P2    resolving a flagged row whose status does not change still writes
//         an outbox event that carries `needsReconciliation: false`.
//
// Assumptions (the findings do not fix these; also in the report):
// - Fail-closed lock refusals are HTTP 409 (as EDC-01); the exact code is not
//   asserted.
// - P1-A: the QRIS webhook may refuse the QRIS at once or the system may void
//   and refund it after the card is approved; the test only asserts the end
//   state (tender voided, one full late-payment refund by system:pos) within a
//   bounded wait, never the point in time.
// - P1-B: "the delayed-response window" is unspecified. The row is aged by
//   three days (created/updated/dispatched), far beyond any plausible window;
//   an immediate resolve must be refused (CTO: fail-closed until the window).
// - P1-C: the stuck sale call is a provider promise that ignores the abort
//   signal and settles `approved` (and charges at the simulator) when the
//   test opens its gate. Owner evidence `terminal_receipt` says "declined".
//   Afterwards the guest's single charge must still be visible: the row is
//   `approved` with its approval code (round 2: the late write is applied by
//   the agent, not merely flagged).
// - P1-D/P1-E: `sale_wire_open_at` is set while the timed-out sale call is
//   still on the wire and NULL once it settles (round-2 design). P1-E reaches
//   a final row by flipping the timed-out row to `failed` directly in the
//   database (no public path finalizes a dispatched row while its wire is
//   open), then letting the sale call answer `approved`; the final status is
//   kept, the row is flagged, approval code and RRN are stored.
// - P2: the event name of a resolution is not fixed; only an outbox event of
//   the row (aggregate id) with `needsReconciliation: false` and the row's
//   unchanged status is asserted. Rows are written directly, so they have no
//   earlier outbox events. Delivery to the edge-to-cloud receiver is covered
//   by edc-outbox.test.ts and not repeated here.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { roleTemplate } from "@starter/shared/access";
import {
  EcrTransportError,
  ecrResultSchema,
  type EcrSaleRequest,
  type EdcPaymentRequest,
  type EdcProvider,
} from "@starter/shared/edc";
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { createEdcAgent } from "../edge/edc/agent.ts";
import { EDC_LATE_RESPONSE_WINDOW_MS } from "../edge/edc/late-response.ts";
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
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;

const ids = {
  cashierRole: randomUUID(),
  ownerRole: randomUUID(),
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  device: randomUUID(),
};

type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: Member;
let ownerUser: Member;
let ctx: ScopedTenantContext;

// ---- Receipt numbering double (same as the sibling EDC POS tests) ------------

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

// ---- Database helpers --------------------------------------------------------

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

async function member(roleId: string, label: string): Promise<Member> {
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
  // The resolve route needs a session that verified its second factor.
  await verifySessionMfa(email);
  return { client, userId };
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
    get: (orderId: string) =>
      who.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    cash: async (bill: Bill) => {
      const got = await who.client
        .get(`${base}/${bill.orderId}`)
        .set(headers)
        .set(originHeader);
      return send(`/${bill.orderId}/tenders`, {
        method: "cash",
        receivedIdr: bill.totalIdr,
        expectedStatus: got.body.data.status as string,
      });
    },
  };
}

type Bill = {
  orderId: string; // API (ULID) id
  orderUuid: string; // database id
  number: string;
  totalIdr: number;
};

async function newBill(): Promise<Bill> {
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const status = created.body.data.status as string;
  const orderId = created.body.data.id as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  }
  return {
    orderId,
    orderUuid: ulidToUuid(orderId),
    number: created.body.data.number as string,
    totalIdr: created.body.data.totalIdr as number,
  };
}

async function seedTerminal(): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant((client) =>
    client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', $4, 'MID-SO829', 'Test EDC', 'lan', '10.0.0.9', $5, 'active')`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        `TID-${id.slice(0, 8)}`,
        ["card", "qris"],
      ],
    ),
  );
  return id;
}

type LedgerRow = {
  id: string;
  status: string;
  needs_reconciliation: boolean;
  dispatched_at: Date | null;
  approval_code: string | null;
  rrn: string | null;
  sale_wire_open_at: Date | null;
};

async function ledgerRows(reference: string): Promise<LedgerRow[]> {
  const { rows } = await owner.query<LedgerRow>(
    `SELECT id, status, needs_reconciliation, dispatched_at, approval_code, rrn,
            sale_wire_open_at FROM edc_transactions
      WHERE tenant_id = $1 AND reference = $2 ORDER BY created_at, id`,
    [tenant.tenantId, reference],
  );
  return rows;
}

/** A card ECR sale row written directly (no earlier outbox events). */
async function ledgerSale(input: {
  reference: string;
  amountIdr: number;
  status: string;
  flagged: boolean;
  /** Default true. False: the sale never reached the terminal. */
  dispatched?: boolean;
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
          completed_at, needs_reconciliation, dispatched_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', $8, 'sale', 'ecr', $9,
               $10, $11, $12)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        terminalIdForDirectRows,
        input.reference,
        randomUUID(),
        input.amountIdr,
        input.status,
        randomUUID().replaceAll("-", "").slice(0, 12),
        final ? new Date() : null,
        input.flagged,
        input.dispatched === false ? null : new Date(),
      ],
    ),
  );
  return id;
}
let terminalIdForDirectRows: string;

const ageRow = (id: string, interval: string) =>
  owner.query(
    `UPDATE edc_transactions
        SET created_at = now() - $2::interval,
            updated_at = now() - $2::interval,
            dispatched_at = now() - $2::interval
      WHERE tenant_id = $1 AND id = $3`,
    [tenant.tenantId, interval, id],
  );

async function nonVoidedTenders(bill: Bill, method?: string) {
  const { rows } = await owner.query<{ method: string; amount: string }>(
    `SELECT method, amount_idr::text AS amount FROM pos_order_tenders
      WHERE tenant_id = $1 AND order_id = $2
        AND status NOT IN ('voided', 'failed')
        AND ($3::text IS NULL OR method = $3)`,
    [tenant.tenantId, bill.orderUuid, method ?? null],
  );
  return rows;
}

type EvidenceInput = {
  source: "inquiry" | "terminal_receipt" | "bank_statement";
  note: string;
};
const declined = (
  evidence: Partial<EvidenceInput> = {},
): Record<string, unknown> => ({
  outcome: "declined",
  evidence: {
    source: "terminal_receipt",
    note: "Struk terminal dicek: tidak ada penagihan kartu",
    ...evidence,
  },
});

function resolve(edcTransactionId: string, body: Record<string, unknown>) {
  return ownerUser.client
    .post(
      `/api/payments/admin/edc/transactions/${encodeURIComponent(edcTransactionId)}/reconciliation`,
    )
    .set(headers)
    .set(originHeader)
    .send(body);
}

// ---- QRIS fixtures (paid webhook state, as pos-qris-edc-lock.test.ts) --------

type Qris = { linkId: string; intentId: string; tenderId: string };

async function paidQris(bill: Bill): Promise<Qris> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  const amount = bill.totalIdr;
  const tenderId = await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'edc-so-829-test')`,
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

async function qrisState(qris: Qris) {
  const tender = await owner.query<{ status: string }>(
    "SELECT status FROM pos_order_tenders WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, qris.tenderId],
  );
  const refunds = await owner.query<{
    amount: string;
    requested_by: string;
  }>(
    `SELECT amount_idr::text AS amount, requested_by FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY created_at`,
    [tenant.tenantId, qris.intentId],
  );
  return { tender: tender.rows[0]?.status, refunds: refunds.rows };
}

// ---- Agent and provider fixtures ---------------------------------------------

const started: Array<{
  agent: ReturnType<typeof createEdcAgent>;
  ctx: ScopedTenantContext;
}> = [];
const gates: Array<() => void> = [];

afterEach(async () => {
  for (const open of gates.splice(0)) open();
  for (const { agent: a, ctx: c } of started.splice(0))
    await a.stop(c).catch(() => undefined);
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  gates.push(open);
  return { open, promise };
}

const passThrough = (
  sim: EcrSimulator,
  over: Partial<EdcProvider> = {},
): EdcProvider => ({
  bank: sim.bank,
  capabilities: sim.capabilities,
  sale: (r) => sim.sale(r),
  cancel: (r) => sim.cancel(r),
  inquiry: (r) => sim.inquiry(r),
  void: (r) => sim.void(r),
  ...over,
});

async function startAgent(
  provider: EdcProvider,
  saleTimeoutMs: number,
): Promise<{
  agent: ReturnType<typeof createEdcAgent>;
  terminalId: string;
}> {
  const terminalId = await seedTerminal();
  const a = createEdcAgent({
    db,
    registry: new EdcProviderRegistry().register(provider),
    saleTimeoutMs,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
  });
  started.push({ agent: a, ctx });
  await a.start(ctx);
  return { agent: a, terminalId };
}

function saleRequest(bill: Bill, terminalId: string): EdcPaymentRequest {
  return {
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    outletId: outletIdSchema.parse(tenant.outletId),
    terminalId,
    reference: bill.number,
    idempotencyKey: randomUUID(),
    amountIdr: idr(bill.totalIdr),
    method: "card",
  } as EdcPaymentRequest;
}

const refTo = (id: string) => ({
  tenantId: tenantIdSchema.parse(tenant.tenantId),
  outletId: outletIdSchema.parse(tenant.outletId),
  transactionId: id,
});

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`so829-${randomUUID().slice(0, 6)}`);
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
      "SO829 Kasir",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "shift.cash.operate",
      ],
    ],
    [ids.ownerRole, "SO829 Owner", roleTemplate("owner").permissions],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "SO829 Kasir");
  ownerUser = await member(ids.ownerRole, "SO829 Owner");
  ctx = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
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
       VALUES ($1, $2, $3, 'SO829 Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-S829', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await c.query(
      `INSERT INTO pos_approval_policies (tenant_id, outlet_id, discount_threshold_bp)
       VALUES ($1, NULL, 1000)`,
      [tenant.tenantId],
    );
  });
  terminalIdForDirectRows = await seedTerminal();
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

// ---- Tests ------------------------------------------------------------------

describe("legend-ftsq0 EDC bill lock second-opinion findings", () => {
  it("P1-A cancel answered `cancelled` while the sale is still on the wire: bill stays locked, guest pays once", async () => {
    const saleGate = gate();
    const state = { saleStarted: false };
    const sim = new EcrSimulator("bca");
    const provider = passThrough(sim, {
      // The terminal answers the cancel `cancelled` (it can pass the sale in
      // the queue), yet the sale call is still waiting and answers later.
      cancel: async (r) =>
        ecrResultSchema.parse({
          outcome: "cancelled",
          trace: r.trace,
          amountIdr: null,
        }),
      sale: async (r: EcrSaleRequest) => {
        state.saleStarted = true;
        await saleGate.promise;
        return sim.sale(r);
      },
    });
    const { agent: edc, terminalId } = await startAgent(provider, 30_000);
    const bill = await newBill();

    const selling = edc.requestPayment(
      ctx,
      cashier.userId,
      saleRequest(bill, terminalId),
    );
    selling.catch(() => undefined);
    let rowId = "";
    await vi.waitFor(async () => {
      const rows = await ledgerRows(bill.number);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("pending");
      expect(rows[0]!.dispatched_at).not.toBeNull();
      expect(state.saleStarted).toBe(true);
      rowId = rows[0]!.id;
    });
    // The terminal answers the cancel `cancelled`, but a cancel answer alone
    // is not proof the sale is over (CTO rule): the sale's own answer decides.
    await edc.cancel(ctx, cashier.userId, refTo(rowId)).catch(() => undefined);
    const [afterCancel] = await ledgerRows(bill.number);
    expect(
      afterCancel?.status,
      "the cancel answer finalized a sale that is still on the wire",
    ).toBe("pending");

    // The sale has not answered: cash is refused, the guest may still be charged.
    const cash = await pos().cash(bill);
    expect(
      cash.status,
      `cash was accepted while the card sale may still charge: ${JSON.stringify(cash.body)}`,
    ).toBe(409);

    // The guest also paid by QRIS in this window.
    const qris = await paidQris(bill);
    await deliverPaid(qris);

    // Now the sale answers `approved`: the card was charged.
    saleGate.open();
    await selling.catch(() => undefined);
    expect(sim.chargedCount(terminalId)).toBe(1);

    // No second payment survives: no cash tender, the QRIS is voided and
    // refunded in full (exactly once, by the system).
    expect(await nonVoidedTenders(bill, "cash")).toEqual([]);
    await vi.waitFor(
      async () => {
        const after = await qrisState(qris);
        expect(after.tender).toBe("voided");
        expect(after.refunds).toEqual([
          { amount: String(bill.totalIdr), requested_by: "system:pos" },
        ]);
      },
      { timeout: 5_000 },
    );
    expect(await nonVoidedTenders(bill, "qris")).toEqual([]);
  });

  it("P1-B an `unknown` sale without the flag (no inquiry, no cancel) stays fail-closed, then Owner resolves it with evidence and the bill is paid once", async () => {
    const sim = new EcrSimulator("bca", {
      capabilities: { inquiry: "none", cancelInProgress: false },
    });
    const provider = passThrough(sim, {
      sale: async () => {
        throw new EcrTransportError("timeout", "no answer from the terminal");
      },
      cancel: async () => {
        throw new EcrTransportError("timeout", "no answer from the terminal");
      },
    });
    const { agent: edc, terminalId } = await startAgent(provider, 50);
    const bill = await newBill();

    await edc
      .requestPayment(ctx, cashier.userId, saleRequest(bill, terminalId))
      .catch(() => undefined);
    const [sale] = await ledgerRows(bill.number);
    expect(sale?.status).toBe("unknown");
    expect(
      sale?.needs_reconciliation,
      "precondition: a timed-out sale is unknown without the flag",
    ).toBe(false);

    // Fail-closed right after the timeout: a late terminal answer is possible.
    const early = await resolve(sale!.id, declined());
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    const earlyCash = await pos().cash(bill);
    expect(earlyCash.status, JSON.stringify(earlyCash.body)).toBe(409);

    // The delayed-response window has long passed: Owner (MFA session) proves
    // the sale never charged and frees the bill.
    await ageRow(sale!.id, "3 days");
    const resolved = await resolve(sale!.id, declined());
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.data).toMatchObject({
      id: sale!.id,
      status: "declined",
      needsReconciliation: false,
    });

    // Released: the bill is paid exactly once, at the bill amount.
    const cash = await pos().cash(bill);
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(cash.body.data.remainingIdr).toBe(0);
    expect(await nonVoidedTenders(bill)).toEqual([
      { method: "cash", amount: String(bill.totalIdr) },
    ]);
  });

  it("P1-C `declined` by hand is refused while the sale may still charge the card; the late charge ends approved with its approval code", async () => {
    const saleGate = gate();
    const state = { saleStarted: false };
    const late: { approvalCode: string | null } = { approvalCode: null };
    const sim = new EcrSimulator("bca");
    const provider = passThrough(sim, {
      // The cancel answer carries the wrong trace: it proves nothing.
      cancel: async () =>
        ecrResultSchema.parse({
          outcome: "cancelled",
          trace: "WRONG0000001",
          amountIdr: null,
        }),
      // The stuck sale call ignores the abort signal and charges when opened.
      sale: async (r: EcrSaleRequest) => {
        state.saleStarted = true;
        await saleGate.promise;
        const answer = await sim.sale(r);
        late.approvalCode = answer.approvalCode;
        return answer;
      },
    });
    const { agent: edc, terminalId } = await startAgent(provider, 400);
    const bill = await newBill();

    const selling = edc.requestPayment(
      ctx,
      cashier.userId,
      saleRequest(bill, terminalId),
    );
    selling.catch(() => undefined);
    let rowId = "";
    await vi.waitFor(async () => {
      const rows = await ledgerRows(bill.number);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dispatched_at).not.toBeNull();
      expect(state.saleStarted).toBe(true);
      rowId = rows[0]!.id;
    });
    await edc.cancel(ctx, cashier.userId, refTo(rowId)).catch(() => undefined);
    // The sale call times out and the row is left unknown and flagged.
    await vi.waitFor(async () => {
      const [row] = await ledgerRows(bill.number);
      expect(row?.status).toBe("unknown");
      expect(row?.needs_reconciliation).toBe(true);
    });

    // The sale call has not settled: nobody proved it cannot charge anymore.
    const byHand = await resolve(rowId, declined());
    expect(
      byHand.status,
      `declined accepted while the sale is still on the wire: ${JSON.stringify(byHand.body)}`,
    ).toBe(409);
    const cash = await pos().cash(bill);
    expect(
      cash.status,
      `cash accepted while the sale is still on the wire: ${JSON.stringify(cash.body)}`,
    ).toBe(409);

    // The sale finally charges the card.
    saleGate.open();
    await selling.catch(() => undefined);
    expect(sim.chargedCount(terminalId)).toBe(1);

    // The guest paid once by card and the ledger still shows it; no cash.
    expect(await nonVoidedTenders(bill, "cash")).toEqual([]);
    // The agent applies the late answer itself; it is not left only flagged.
    await vi.waitFor(
      async () => {
        expect(
          late.approvalCode,
          "the simulator approves with a code",
        ).toBeTruthy();
        const [after] = await ledgerRows(bill.number);
        expect(after?.status).toBe("approved");
        expect(after?.approval_code).toBe(late.approvalCode);
        expect(after?.sale_wire_open_at).toBeNull();
      },
      { timeout: 5_000 },
    );
    const lateCash = await pos().cash(bill);
    expect(lateCash.status, JSON.stringify(lateCash.body)).toBe(409);
  });

  it("P1-D a sale that timed out and is approved late, after stop() was called: stop() waits for the late write; the row is approved and the wire marker is cleared", async () => {
    const saleGate = gate();
    const state = { saleStarted: false };
    const sim = new EcrSimulator("bca");
    const provider = passThrough(sim, {
      sale: async (r: EcrSaleRequest) => {
        state.saleStarted = true;
        await saleGate.promise;
        return ecrResultSchema.parse({
          outcome: "approved",
          approvalCode: "APLATE829",
          amountIdr: r.amountIdr,
          trace: r.trace,
        });
      },
    });
    const { agent: edc, terminalId } = await startAgent(provider, 100);
    const bill = await newBill();

    const selling = edc.requestPayment(
      ctx,
      cashier.userId,
      saleRequest(bill, terminalId),
    );
    selling.catch(() => undefined);
    // The agent gives up waiting: unknown, and the sale call is still on the wire.
    await vi.waitFor(async () => {
      const [row] = await ledgerRows(bill.number);
      expect(state.saleStarted).toBe(true);
      expect(row?.status).toBe("unknown");
      expect(row?.sale_wire_open_at).not.toBeNull();
    });
    const rowId = (await ledgerRows(bill.number))[0]!.id;

    // The cashier closes the outlet: stop() must wait for the pending wire.
    let stopped = false;
    const stopping = edc.stop(ctx).then(() => {
      stopped = true;
    });
    await new Promise((resolveTick) => setTimeout(resolveTick, 150));
    expect(
      stopped,
      "stop() returned while the sale call was still on the wire",
    ).toBe(false);
    expect((await ledgerRows(bill.number))[0]!.status).toBe("unknown");

    // The terminal finally answers: the card was charged.
    saleGate.open();
    await stopping;
    const [after] = await ledgerRows(bill.number);
    expect(after?.id).toBe(rowId);
    // Approved, or at least flagged with the approval code as evidence.
    expect(
      after?.status === "approved" ||
        (after?.needs_reconciliation === true &&
          after?.approval_code === "APLATE829"),
      `late approval left a ${after?.status} row`,
    ).toBe(true);
    expect(after?.approval_code).toBe("APLATE829");
    expect(after?.sale_wire_open_at).toBeNull();
  });

  it("P1-E a late approval after the row is already final keeps its approval code and RRN as evidence", async () => {
    const saleGate = gate();
    const state = { saleStarted: false };
    const sim = new EcrSimulator("bca");
    const provider = passThrough(sim, {
      sale: async (r: EcrSaleRequest) => {
        state.saleStarted = true;
        await saleGate.promise;
        return ecrResultSchema.parse({
          outcome: "approved",
          approvalCode: "APLATE829",
          rrn: "RRN829A1B2",
          amountIdr: r.amountIdr,
          trace: r.trace,
        });
      },
    });
    const { agent: edc, terminalId } = await startAgent(provider, 100);
    const bill = await newBill();

    const selling = edc.requestPayment(
      ctx,
      cashier.userId,
      saleRequest(bill, terminalId),
    );
    selling.catch(() => undefined);
    await vi.waitFor(async () => {
      const [row] = await ledgerRows(bill.number);
      expect(state.saleStarted).toBe(true);
      expect(row?.status).toBe("unknown");
    });
    const rowId = (await ledgerRows(bill.number))[0]!.id;
    // The row is made final while the wire is still open.
    await owner.query(
      `UPDATE edc_transactions SET status = 'failed', completed_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, rowId],
    );

    saleGate.open();
    await vi.waitFor(
      async () => {
        const [after] = await ledgerRows(bill.number);
        expect(after?.approval_code).toBe("APLATE829");
        expect(after?.rrn).toBe("RRN829A1B2");
        expect(after?.sale_wire_open_at).toBeNull();
      },
      { timeout: 5_000 },
    );
    const [after] = await ledgerRows(bill.number);
    // A final row is never reopened or rewritten to approved silently: it
    // stays final and is flagged for reconciliation, with the evidence.
    expect(after?.status).toBe("failed");
    expect(after?.needs_reconciliation).toBe(true);
  });

  it("P1-F a queued cancel on a dispatched `unknown` sale does not finalize it: row stays unknown and the bill stays locked", async () => {
    const sim = new EcrSimulator("bca");
    // The terminal answers every cancel `cancelled` with the right trace, yet
    // that proves nothing about a sale that was sent to the terminal.
    const provider = passThrough(sim, {
      cancel: async (r) =>
        ecrResultSchema.parse({
          outcome: "cancelled",
          trace: r.trace,
          amountIdr: null,
        }),
    });
    const bill = await newBill();
    const id = await ledgerSale({
      reference: bill.number,
      amountIdr: bill.totalIdr,
      status: "unknown",
      flagged: false,
    });
    const { agent: edc } = await startAgent(provider, 5_000);

    await edc.cancel(ctx, cashier.userId, refTo(id)).catch(() => undefined);

    const [row] = await ledgerRows(bill.number);
    expect(
      row?.status,
      "a cancel answer finalized a dispatched sale whose charge is unproven",
    ).toBe("unknown");
    expect(row?.dispatched_at).not.toBeNull();
    const cash = await pos().cash(bill);
    expect(cash.status, JSON.stringify(cash.body)).toBe(409);
    expect(await nonVoidedTenders(bill)).toEqual([]);
  });

  it.each(["pending", "unknown"])(
    "P1-F a recovered %s sale that never reached the terminal is cancelled by a cancel",
    async (status) => {
      const provider = passThrough(new EcrSimulator("bca"), {
        cancel: async (r) =>
          ecrResultSchema.parse({
            outcome: "cancelled",
            trace: r.trace,
            amountIdr: null,
          }),
      });
      const bill = await newBill();
      // Written before the agent starts: the agent finds it as a leftover.
      const id = await ledgerSale({
        reference: bill.number,
        amountIdr: bill.totalIdr,
        status,
        flagged: false,
        dispatched: false,
      });
      const { agent: edc } = await startAgent(provider, 5_000);

      await edc.cancel(ctx, cashier.userId, refTo(id)).catch(() => undefined);

      const [row] = await ledgerRows(bill.number);
      expect(row?.id).toBe(id);
      expect(
        row?.status,
        "nothing was ever sent to the terminal, so the cancel is final",
      ).toBe("cancelled");
      expect(row?.dispatched_at).toBeNull();
    },
  );

  it("P1-G createEdcAgent throws when the sale timeout is not shorter than the late-response window", () => {
    const make = (saleTimeoutMs: number) =>
      createEdcAgent({
        db,
        registry: new EdcProviderRegistry().register(
          passThrough(new EcrSimulator("bca")),
        ),
        saleTimeoutMs,
        inquiryTimeoutMs: 50,
        cancelTimeoutMs: 50,
      });
    expect(() => make(EDC_LATE_RESPONSE_WINDOW_MS)).toThrow();
    expect(() => make(EDC_LATE_RESPONSE_WINDOW_MS + 1)).toThrow();
    // Control: a timeout shorter than the window is accepted.
    expect(() => make(EDC_LATE_RESPONSE_WINDOW_MS - 1)).not.toThrow();
  });

  it("P1-H an outlet re-acquire (start() again) keeps the wire marker of a sale call of this process that is still running", async () => {
    // Assumption: lock loss is hard to simulate without knowing the lock key,
    // so a second start() on the running agent stands for the re-acquire. Its
    // outcome (idempotent, or refused) is not asserted, only that the marker
    // of the live call survives it.
    const saleGate = gate();
    const sim = new EcrSimulator("bca");
    const state = { saleStarted: false };
    const provider = passThrough(sim, {
      sale: async (r: EcrSaleRequest) => {
        state.saleStarted = true;
        await saleGate.promise;
        return sim.sale(r);
      },
    });
    const { agent: edc, terminalId } = await startAgent(provider, 100);
    const bill = await newBill();

    const selling = edc.requestPayment(
      ctx,
      cashier.userId,
      saleRequest(bill, terminalId),
    );
    selling.catch(() => undefined);
    await vi.waitFor(async () => {
      const [row] = await ledgerRows(bill.number);
      expect(state.saleStarted).toBe(true);
      expect(row?.status).toBe("unknown");
      expect(row?.sale_wire_open_at).not.toBeNull();
    });

    await edc.start(ctx).catch(() => undefined);
    const [during] = await ledgerRows(bill.number);
    expect(
      during?.sale_wire_open_at,
      "the re-acquire cleared the marker of a call that is still on the wire",
    ).not.toBeNull();
    // The bill stays locked while the call runs.
    const cash = await pos().cash(bill);
    expect(cash.status, JSON.stringify(cash.body)).toBe(409);

    // The call settles: the late approval lands and the marker is cleared.
    saleGate.open();
    await selling.catch(() => undefined);
    await vi.waitFor(
      async () => {
        const [after] = await ledgerRows(bill.number);
        expect(after?.status).toBe("approved");
        expect(after?.sale_wire_open_at).toBeNull();
      },
      { timeout: 5_000 },
    );
  });

  it.each(["declined", "cancelled", "failed"])(
    "P2 resolving a flagged %s row keeps its status and still writes an outbox event with needsReconciliation false",
    async (status) => {
      const bill = await newBill();
      const id = await ledgerSale({
        reference: bill.number,
        amountIdr: bill.totalIdr,
        status,
        flagged: true,
      });

      const res = await resolve(id, declined());
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({
        status,
        needsReconciliation: false,
      });

      const events = await owner.query<{
        payload: { status: string; needsReconciliation: boolean };
      }>(
        `SELECT event->'payload' AS payload FROM domain_event_outbox
          WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY sequence`,
        [tenant.tenantId, id],
      );
      expect(
        events.rows.map((r) => r.payload),
        "the resolution left no event in the outbox",
      ).toContainEqual(
        expect.objectContaining({ status, needsReconciliation: false }),
      );
    },
  );
});
