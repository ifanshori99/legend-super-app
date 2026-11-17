// legend-s61sg follow-up (brief 982, finding B, money): the void of an order
// with a paid swap charge, three gaps found by the architect review.
//
// B4: the approver ceiling (supervisor 200_000) is checked against the whole
//     outflow (order cash + charge cash), also when the order itself has no
//     captured cash tender left (the check used to run only when the order cash
//     was > 0).
// B5: a void held for the drawer (the outflow is over the expected cash) does
//     not take the charge cash out of the drawer now: no counted cash_out, no
//     cash-approval queue row (it would journal twice); the charge cash is part
//     of the held correction cash (heldCorrectionCashIdrOf) like the order cash.
// B6: a gateway charge whose intent is already fully refunded is skipped by the
//     void (the money is already out); an EDC charge still blocks the void 409.
//
// Real path and harness as order-charge-void-982-s61sg.test.ts (Express app,
// Better Auth, RBAC, POS void route, PostgreSQL with RLS, isolated tenant).

import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
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
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { qrOrderEvents } from "@starter/shared/qr-order";
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  deliverAutoJournalEvent,
  retryParkedAutoJournals,
} from "../services/accounting-auto-journal-consumer.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import {
  heldCorrectionCashIdrOf,
  liveExpectedCashIdr,
} from "../services/pos-shift-support.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const KOPI_IDR = 25_000;

type ChargeSpec = {
  differenceIdr: number;
  grossSalesIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
  amountIdr: number;
};

/** A swap charge of this difference with 10% service and 10% PBJT on top. */
function chargeOf(differenceIdr: number): ChargeSpec {
  const serviceChargeIdr = Math.round(differenceIdr * 0.1);
  const pbjtIdr = Math.round((differenceIdr + serviceChargeIdr) * 0.1);
  return {
    differenceIdr,
    grossSalesIdr: differenceIdr,
    serviceChargeIdr,
    pbjtIdr,
    amountIdr: differenceIdr + serviceChargeIdr + pbjtIdr,
  };
}

let CHARGE: ChargeSpec = chargeOf(20_000);

type Role =
  | "cash_on_hand"
  | "gateway_clearing"
  | "tax_payable_pbjt"
  | "customer_deposit"
  | "sales_revenue"
  | "service_charge";
const CHART: [Role, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas Outlet", "asset", "current_asset"],
  [
    "gateway_clearing",
    "1201",
    "Kliring Payment Gateway",
    "asset",
    "current_asset",
  ],
  ["tax_payable_pbjt", "2104", "Utang PBJT", "liability", "current_liability"],
  [
    "customer_deposit",
    "2107",
    "Uang Muka Pelanggan",
    "liability",
    "current_liability",
  ],
  ["sales_revenue", "4101", "Penjualan", "revenue", "revenue"],
  ["service_charge", "4103", "Service Charge", "revenue", "revenue"],
];
const accounts = {} as Record<Role, string>;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  device: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let shiftId = "";
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let supervisor: Member;

// ---- Receipt numbering double (as pos-order-void-noncash.test.ts) ----------

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

// ---- Fixtures ----------------------------------------------------------------

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
  { replica = false }: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
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

function contextOf(
  tenantId: string,
  source: "session" | "domain" = "domain",
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source,
    }),
    { kind: "tenant" },
  );
}

async function member(roleId: string, label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

const deviceToken = () =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId: ids.device,
  });

function pos(
  who: Member = cashier,
  outletId = tenant.outletId,
  host: { Host: string } = headers,
) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
      .post(`${base}${path}`)
      .set(host)
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
      who.client.get(`${base}/${orderId}`).set(host).set(originHeader),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    cash: (orderId: string, expectedStatus: string, receivedIdr: number) =>
      send(`/${orderId}/tenders`, {
        method: "cash",
        receivedIdr,
        expectedStatus,
      }),
    complete: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/complete`, { expectedStatus }),
    correctionVoid: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/void`, body),
    refund: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/refund`, body),
  };
}

async function pinApproval(input: {
  action: "void" | "refund";
  orderId: string;
  valueIdr: number;
}): Promise<{ approvedBy: string; overrideId: string }> {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    {
      outletId: tenant.outletId,
      action: input.action,
      valueIdr: input.valueIdr,
      reason: "Pelanggan salah pesan",
      objectType: "order",
      objectId: input.orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: supervisor.userId, overrideId: override.id };
}

function periodsAroundNow(): string[] {
  const now = new Date();
  return [-1, 0, 1].map((shift) => {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, 1),
    );
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`v982-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: ids.device,
  });
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.device
      ? tenant.outletId
      : null,
  );
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "POS Kasir Uji",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "pos.refund.request",
        "shift.cash.operate",
      ],
    ],
    [
      ids.supervisorRole,
      "POS Supervisor Uji",
      ["order.view", "pos.void.approve", "pos.refund.approve"],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, ($5::text IS NOT NULL), $5, $4, false, '["tenant"]')`,
      [
        id,
        tenant.tenantId,
        name,
        JSON.stringify(permissions),
        id === ids.supervisorRole ? "supervisor" : null,
      ],
    );
  cashier = await member(ids.cashierRole, "POS Kasir");
  supervisor = await member(ids.supervisorRole, "POS Supervisor");
  await openPosShift(
    contextOf(tenant.tenantId, "session"),
    { userId: userIdSchema.parse(cashier.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  const { rows: openShifts } = await owner.query<{ id: string }>(
    "SELECT id FROM pos_shifts WHERE tenant_id = $1 AND status = 'open'",
    [tenant.tenantId],
  );
  shiftId = openShifts[0]!.id;
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'POS Uji', 0)`,
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
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-POS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
  });
  // Accounting: module on, chart + mappings + open periods for the outlet's
  // legal entity (same chart as accounting-auto-journal-order-charge).
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    tenant.tenantId,
    JSON.stringify({
      modules: ["qr_order", "accounting"],
      integrationProviders: [],
    }),
  ]);
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.tenantId, tenant.legalEntityId, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenant.tenantId, tenant.legalEntityId, role, accounts[role]],
    );
  }
  for (const period of periodsAroundNow())
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenant.tenantId, tenant.legalEntityId, period],
    );
}, 120_000);

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  setEdgeCredentialVerifier(null);
  setAuditWriter(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- Sale + charge builders ------------------------------------------------------

type Sale = { orderId: string; totalIdr: number };

async function completedCashSale(): Promise<Sale> {
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const totalIdr = created.body.data.totalIdr as number;
  const paid = await pos().cash(orderId, status, totalIdr);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const completed = await pos().complete(
    orderId,
    paid.body.data.order.status as string,
  );
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  return { orderId, totalIdr };
}

async function seedLink(totalIdr: number): Promise<string> {
  const linkId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
    [
      linkId,
      tenant.tenantId,
      tenant.outletId,
      randomBytes(32).toString("hex"),
      `V9-${linkId.slice(0, 8)}`,
      totalIdr,
    ],
  );
  return linkId;
}

/** A paid gateway intent on the link, with its evidence. */
async function seedPaidIntent(
  linkId: string,
  amountIdr: number,
): Promise<string> {
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
        status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(),
             '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [
      intentId,
      tenant.tenantId,
      tenant.outletId,
      linkId,
      amountIdr,
      `v9-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [
      tenant.tenantId,
      tenant.outletId,
      intentId,
      `v9-ref-${intentId}`,
      amountIdr,
    ],
  );
  return intentId;
}

async function seedCompletedRefund(
  intentId: string,
  amountIdr: number,
): Promise<void> {
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, unallocated_fund_id)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', 'completed', 'requester', 'approver', now(), now(), NULL)`,
    [randomUUID(), tenant.tenantId, tenant.outletId, intentId, amountIdr],
  );
}

/** A cash movement of the open shift (default: the cash_in that collected the charge). */
async function seedCashIn(
  type: "cash_in" | "cash_out" = "cash_in",
  amountIdr: number = CHARGE.amountIdr,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO cash_movements
       (id, tenant_id, outlet_id, shift_id, type, amount_idr, reason_note, recorded_by,
        recorded_at, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, $9, $5, 'Selisih swap pesanan', $6, now(), $7, $8)`,
    [
      id,
      tenant.tenantId,
      tenant.outletId,
      shiftId,
      amountIdr,
      cashier.userId,
      `v9-cash-${id}`,
      randomBytes(32).toString("hex"),
      type,
    ],
  );
  return id;
}

/** The issue foreign key is skipped: the consumers read the charge, not the issue. */
const issueOfCharge = new Map<string, string>();

async function seedPaidCharge(
  orderId: string,
  input: { intentId: string | null; cashMovementId?: string; linkId: string },
): Promise<string> {
  const chargeId = randomUUID();
  const issueId = randomUUID();
  issueOfCharge.set(chargeId, issueId);
  const cash = input.cashMovementId !== undefined;
  await asOwnerTenant(
    tenant.tenantId,
    (client) =>
      client.query(
        `INSERT INTO order_issue_charges
           (id, tenant_id, outlet_id, order_issue_id, order_id, route, status, difference_idr,
            gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr, payment_link_id,
            payment_link_token_sealed, payment_intent_id, paid_at${cash ? ", cash_movement_id, paid_by" : ""})
         VALUES ($1, $2, $3, $4, $5, 'qr_link', 'paid', $6, $7, $8, $9, $10, $11, 'sealed', $12, now()${cash ? ", $13, $14" : ""})`,
        [
          chargeId,
          tenant.tenantId,
          tenant.outletId,
          issueId,
          ulidToUuid(orderId),
          CHARGE.differenceIdr,
          CHARGE.grossSalesIdr,
          CHARGE.serviceChargeIdr,
          CHARGE.pbjtIdr,
          CHARGE.amountIdr,
          input.linkId,
          cash ? null : input.intentId,
          ...(cash ? [input.cashMovementId, cashier.userId] : []),
        ],
      ),
    { replica: true },
  );
  return chargeId;
}

/** A sale whose swap charge was paid in cash at the till. */
async function saleWithCashCharge() {
  const sale = await completedCashSale();
  const cashMovementId = await seedCashIn();
  const linkId = await seedLink(CHARGE.amountIdr);
  const chargeId = await seedPaidCharge(sale.orderId, {
    intentId: null,
    cashMovementId,
    linkId,
  });
  return { ...sale, chargeId, cashMovementId };
}

function chargePaidEvent(
  orderId: string,
  chargeId: string,
  cashMovementId: string,
): EventEnvelope {
  const definition = qrOrderEvents["order_issue.charge_paid"];
  const issueId = issueOfCharge.get(chargeId) ?? randomUUID();
  const id = createUlid();
  const at = new Date().toISOString();
  return definition.envelopeSchema.parse({
    id,
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: issueId,
    sequence: 1,
    occurredAt: at,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `v9-charge-${id}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: {
      orderId,
      orderIssueId: issueId,
      chargeId,
      paymentIntentId: null,
      ...CHARGE,
      paidAt: at,
      method: "pos_cash",
      cashMovementId,
    },
  }) as EventEnvelope;
}

// ---- Observers -----------------------------------------------------------------

async function deliver(event: EventEnvelope) {
  const context = contextOf(tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, new Date()),
  );
}

/** Every outbox event about the order, in order, through the auto-journal consumer. */
async function deliverOutboxOf(orderId: string): Promise<void> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1
       AND (event->>'name' LIKE 'order%' OR event->>'name' = 'payment.refunded')
       AND event::text LIKE $2
     ORDER BY created_at, id`,
    [tenant.tenantId, `%${orderId}%`],
  );
  for (const row of rows) await deliver(eventEnvelopeSchema.parse(row.event));
}

async function postSale(orderId: string): Promise<void> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'order.paid' AND event::text LIKE $2
     ORDER BY created_at, id`,
    [tenant.tenantId, `%${orderId}%`],
  );
  expect(rows, "order.paid of the sale is in the outbox").toHaveLength(1);
  const result = await deliver(eventEnvelopeSchema.parse(rows[0]!.event));
  expect(result.status, JSON.stringify(result)).toBe("posted");
}

async function sweep() {
  return retryParkedAutoJournals(
    contextOf(tenant.tenantId),
    new Date(Date.now() + 2 * 60 * 60 * 1000),
  );
}

async function drawerCash(): Promise<number> {
  const context = contextOf(tenant.tenantId, "session");
  return withTenant(db, context, async (tx) => {
    const [shift] = await tx
      .select()
      .from(posShifts)
      .where(eq(posShifts.id, shiftId));
    return liveExpectedCashIdr(tx, shift!);
  });
}

async function balanceOf(role: Role): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [tenant.tenantId, accounts[role]],
  );
  return Number(rows[0]!.balance ?? 0);
}

async function unbalancedEntries(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT entry_id FROM journal_lines WHERE tenant_id = $1
       GROUP BY entry_id HAVING sum(debit_idr) <> sum(credit_idr)) t`,
    [tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

async function parkedCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM auto_journal_parked WHERE tenant_id = $1",
    [tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

async function chargeStatus(chargeId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM order_issue_charges WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, chargeId],
  );
  return rows[0]!.status;
}

async function voidRowCount(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pos_order_voids
     WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return Number(rows[0]?.count);
}

async function approvalUses(overrideId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pos_order_approval_uses
     WHERE override_id = $1::uuid`,
    [ulidToUuid(overrideId)],
  );
  return Number(rows[0]?.count);
}

async function voidOrder(sale: Sale) {
  const approval = await pinApproval({
    action: "void",
    orderId: sale.orderId,
    valueIdr: sale.totalIdr,
  });
  const response = await pos().correctionVoid(sale.orderId, {
    reason: "customer_cancelled",
    reasonNote: "Pelanggan salah pesan",
    ...approval,
  });
  return { response, approval };
}

async function expectRolesNetZero(): Promise<void> {
  for (const role of [
    "cash_on_hand",
    "sales_revenue",
    "service_charge",
    "tax_payable_pbjt",
  ] as const)
    expect(await balanceOf(role), `net of ${role}`).toBe(0);
}

async function heldCorrectionCash(): Promise<number> {
  const context = contextOf(tenant.tenantId, "session");
  return withTenant(db, context, async (tx) => {
    const [shift] = await tx
      .select()
      .from(posShifts)
      .where(eq(posShifts.id, shiftId));
    return heldCorrectionCashIdrOf(tx, shift!);
  });
}

/** Journal entries of the refund events of this charge (the order.charge_refunded journal). */
async function chargeRefundJournalCount(chargeId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM domain_event_outbox o
       JOIN journal_entries j
         ON j.tenant_id = o.tenant_id
        AND j.idempotency_key = 'aj:order-charge-refund:' || (o.event->'payload'->>'refundId')
      WHERE o.tenant_id = $1
        AND o.event->>'name' = 'order_issue.charge_refunded'
        AND o.event->'payload'->>'chargeId' = $2`,
    [tenant.tenantId, chargeId],
  );
  return Number(rows[0]!.n);
}

async function refundRowsOfIntent(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenant.tenantId, intentId],
  );
  return Number(rows[0]!.n);
}

// ============================================================================

describe("legend-s61sg follow-up: void with a paid swap charge (finding B)", () => {
  it("B4 the approver ceiling covers the charge cash even when the order has no captured cash tender", async () => {
    CHARGE = chargeOf(250_000);
    const sale = await saleWithCashCharge();
    // Only the charge cash goes out of the drawer: the order's own cash tender
    // is no longer captured.
    // (replica role: the immutability trigger of final rows is off.)
    await asOwnerTenant(
      tenant.tenantId,
      (client) =>
        client.query(
          `UPDATE pos_order_tenders SET status = 'voided'
           WHERE tenant_id = $1 AND order_id = $2::uuid`,
          [tenant.tenantId, ulidToUuid(sale.orderId)],
        ),
      { replica: true },
    );
    const before = await drawerCash();

    const { response, approval } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(JSON.stringify(response.body)).toContain(
      "REFUND_APPROVAL_LIMIT_EXCEEDED",
    );

    expect(await voidRowCount(sale.orderId)).toBe(0);
    expect(await approvalUses(approval.overrideId)).toBe(0);
    expect(await chargeStatus(sale.chargeId)).toBe("paid");
    expect(await drawerCash()).toBe(before);
  });

  it("B6 a gateway charge already fully refunded is skipped: the void goes through, only the cash charge is returned, no second refund", async () => {
    CHARGE = chargeOf(20_000);
    const sale = await saleWithCashCharge();
    const linkId = await seedLink(CHARGE.amountIdr);
    const intentId = await seedPaidIntent(linkId, CHARGE.amountIdr);
    await seedCompletedRefund(intentId, CHARGE.amountIdr);
    const gatewayChargeId = await seedPaidCharge(sale.orderId, {
      intentId,
      linkId,
    });
    const before = await drawerCash();

    const { response } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    expect(await voidRowCount(sale.orderId)).toBe(1);
    expect(await chargeStatus(sale.chargeId)).not.toBe("paid");
    // Nothing left to give back: untouched, and no new refund of its intent.
    expect(await chargeStatus(gatewayChargeId)).toBe("paid");
    expect(await refundRowsOfIntent(intentId)).toBe(1);
    // The drawer returns the sale and the cash charge only.
    expect(await drawerCash()).toBe(before - sale.totalIdr - CHARGE.amountIdr);
  });

  it("B6 an EDC charge (no intent, no cash) still blocks the void 409", async () => {
    CHARGE = chargeOf(20_000);
    const sale = await completedCashSale();
    const linkId = await seedLink(CHARGE.amountIdr);
    const chargeId = await seedPaidCharge(sale.orderId, {
      intentId: null,
      linkId,
    });
    const before = await drawerCash();

    const { response, approval } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBe(409);

    expect(await voidRowCount(sale.orderId)).toBe(0);
    expect(await approvalUses(approval.overrideId)).toBe(0);
    expect(await chargeStatus(chargeId)).toBe("paid");
    expect(await drawerCash()).toBe(before);
  });

  it("B5 a void held for the drawer does not pay the charge cash out now: no counted cash_out, no approval-queue row, the charge cash is held correction cash, and the journal reverses the charge (balanced, not parked)", async () => {
    CHARGE = chargeOf(20_000);
    const sale = await saleWithCashCharge();
    await postSale(sale.orderId);
    const posted = await deliver(
      chargePaidEvent(sale.orderId, sale.chargeId, sale.cashMovementId),
    );
    expect(posted.status, JSON.stringify(posted)).toBe("posted");
    // Leave the sale alone fits, the sale plus the charge does not: the void is held.
    const expected = await drawerCash();
    await seedCashIn("cash_out", expected - (sale.totalIdr + 5_000));
    const before = await drawerCash();
    const heldBefore = await heldCorrectionCash();

    const { response } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    const { rows } = await owner.query<{ needs_approval: boolean }>(
      `SELECT needs_approval FROM pos_order_voids
       WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(sale.orderId)],
    );
    expect(rows[0]?.needs_approval, "the void is held").toBe(true);
    expect(await chargeStatus(sale.chargeId)).not.toBe("paid");
    // Held cash is not in the drawer figures yet ...
    expect(await drawerCash()).toBe(before);
    // ... it is held correction cash, the charge cash included ...
    expect(await heldCorrectionCash()).toBe(
      heldBefore + sale.totalIdr + CHARGE.amountIdr,
    );
    // ... and no cash movement waits in the cash-approval queue for it.
    const queued = await owner.query(
      `SELECT 1 FROM cash_movements
       WHERE tenant_id = $1 AND shift_id = $2 AND needs_approval`,
      [tenant.tenantId, shiftId],
    );
    expect(queued.rows).toHaveLength(0);

    // The journal reverses the charge once: balanced, nothing parked.
    await deliverOutboxOf(sale.orderId);
    await sweep();
    expect(await parkedCount()).toBe(0);
    await expectRolesNetZero();
    expect(await unbalancedEntries()).toBe(0);
    expect(await chargeRefundJournalCount(sale.chargeId)).toBe(1);
  });

  it("B5 two cash charges on one held void: each reverses once under its own key, nothing parked, roles net 0", async () => {
    CHARGE = chargeOf(20_000);
    const sale = await saleWithCashCharge();
    const secondCash = await seedCashIn();
    const secondLink = await seedLink(CHARGE.amountIdr);
    const secondId = await seedPaidCharge(sale.orderId, {
      intentId: null,
      cashMovementId: secondCash,
      linkId: secondLink,
    });
    await postSale(sale.orderId);
    for (const [chargeId, movementId] of [
      [sale.chargeId, sale.cashMovementId],
      [secondId, secondCash],
    ] as const) {
      const posted = await deliver(
        chargePaidEvent(sale.orderId, chargeId, movementId),
      );
      expect(posted.status, JSON.stringify(posted)).toBe("posted");
    }
    const expected = await drawerCash();
    await seedCashIn("cash_out", expected - (sale.totalIdr + 5_000));
    const before = await drawerCash();
    const heldBefore = await heldCorrectionCash();

    const { response } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await drawerCash()).toBe(before);
    expect(await heldCorrectionCash()).toBe(
      heldBefore + sale.totalIdr + 2 * CHARGE.amountIdr,
    );
    expect(await chargeStatus(sale.chargeId)).not.toBe("paid");
    expect(await chargeStatus(secondId)).not.toBe("paid");

    await deliverOutboxOf(sale.orderId);
    await sweep();
    expect(await parkedCount()).toBe(0);
    await expectRolesNetZero();
    expect(await unbalancedEntries()).toBe(0);
    expect(await chargeRefundJournalCount(sale.chargeId)).toBe(1);
    expect(await chargeRefundJournalCount(secondId)).toBe(1);
  });
});
