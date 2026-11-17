// legend-v5z4h + legend-9e21l (brief 985, money, "Jangan sampai rugi"):
// the status of a swap charge after its order is voided, and the index behind
// the refund lookup of the outbox. Written BEFORE the behavior exists (red
// first). Expected behavior comes from docs/briefs 985 "KEPUTUSAN DESAIN" and
// the shared event contracts, not from the services.
//
// v5z4h rules under test (void route
// `POST /api/outlets/:outletId/pos/orders/:orderId/corrections/void`):
// - A paid GATEWAY charge whose intent is fully refunded already (completed
//   payment_refunds) is marked `voided` by the void (closed_at set), with no new
//   money (no new refund row, no cash_out) and no new journal entry (the refund
//   already reversed it); the journal stays balanced and the charge is not
//   counted as revenue (every revenue/tax role nets to 0).
// - A manual refund (`order_issue_charge_manual_refunds`, brief card mrwtp)
//   still `requested` when the order is voided: 409, nothing changes.
// - Manual cash refund of the whole charge, then void: `voided`, NO new
//   cash_out (`void-charge:<chargeId>`), the drawer only gives back the sale.
// - Partial manual cash refund, then void: cash_out of the REMAINDER only
//   (key `void-charge:<chargeId>`); manual + void never pass the charge.
// - EDC charge with a partial manual refund: remainder cannot go back through
//   the till -> void 409. EDC fully manual-refunded: `voided`, no cash.
// v9e21l: an expression partial index on domain_event_outbox
//   (tenant_id, event->'payload'->>'refundId') WHERE event->>'name' =
//   'order_issue.charge_refunded' (migration 0565) serves the refund lookup:
//   EXPLAIN with enable_seqscan=off uses it.
//
// Harness as order-charge-void-982-s61sg.test.ts (Express app, Better Auth,
// RBAC, POS void route, PostgreSQL with RLS, isolated tenant). Events are
// delivered to the auto-journal consumer by hand.
//
// Assumptions (spec silent, repeated in the report):
// - Manual refund rows are SEEDED by SQL with the columns of the brief (the
//   endpoints are a separate card); ids are uuid values, requested_by is the
//   cashier, decided_by the supervisor. The table does not exist yet, so the
//   manual-refund tests also fail on that until migration 0566 lands.
// - The charge's payment method is told by its columns: cash_movement_id set =
//   cash; no intent and no cash = EDC; payment_intent_id = gateway.
// - The void answers 2xx on success (201 today, as order-charge-fix-982-B).
// - "No new journal entry" is measured on the two charge keys
//   (`aj:order-charge:<chargeId>`, `aj:order-charge-refund:<refundId>`).
// - The EXPLAIN test inlines the predicate text of the brief; the index is
//   found by definition (refundId + order_issue.charge_refunded) because its
//   name is not specified.

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
import { liveExpectedCashIdr } from "../services/pos-shift-support.ts";
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

const CHARGE = {
  differenceIdr: 20_000,
  grossSalesIdr: 20_000,
  serviceChargeIdr: 2_000,
  pbjtIdr: 2_200,
  amountIdr: 24_200,
} as const;

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
  };
}

async function pinApproval(input: {
  action: "void";
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
  tenant = await createIsolatedTenant(`v985-${randomUUID().slice(0, 6)}`);
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

// ---- Cash movements, gateway intent, manual refunds ------------------------------

async function seedCashMovement(
  type: "cash_in" | "cash_out",
  amountIdr: number,
  key: string | null = null,
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
      key ?? `v9-cash-${id}`,
      randomBytes(32).toString("hex"),
      type,
    ],
  );
  return id;
}

/** The cash_in movement of the open shift that collected the charge. */
const seedCashIn = () => seedCashMovement("cash_in", CHARGE.amountIdr);

/** A paid gateway intent on the link, with its evidence. */
async function seedPaidIntent(linkId: string): Promise<string> {
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
      CHARGE.amountIdr,
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
      CHARGE.amountIdr,
    ],
  );
  return intentId;
}

async function seedCompletedRefund(intentId: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, unallocated_fund_id)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', 'completed', 'requester', 'approver', now(), now(), NULL)`,
    [id, tenant.tenantId, tenant.outletId, intentId, CHARGE.amountIdr],
  );
  return id;
}

type ManualRefund = {
  chargeId: string;
  method: "cash" | "edc";
  amountIdr: number;
  status: "requested" | "completed";
};

/** A manual refund row of a charge paid at the till (card legend-mrwtp). */
async function seedManualRefund(input: ManualRefund): Promise<string> {
  const id = randomUUID();
  const completed = input.status === "completed";
  const cash = input.method === "cash";
  const cashMovementId =
    completed && cash
      ? await seedCashMovement(
          "cash_out",
          input.amountIdr,
          `manual-charge-refund:${id}`,
        )
      : null;
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO order_issue_charge_manual_refunds
         (id, tenant_id, outlet_id, charge_id, method, amount_idr, reason, reference, status,
          requested_by, requested_at, decided_by, decided_at, shift_id, cash_movement_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'Tamu komplain', $7, $8,
               $9, now(), $10, $11::timestamptz, $12, $13)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        input.chargeId,
        input.method,
        input.amountIdr,
        cash ? null : `EDC-${id.slice(0, 8)}`,
        input.status,
        cashier.userId,
        completed ? supervisor.userId : null,
        completed ? new Date().toISOString() : null,
        completed && cash ? shiftId : null,
        cashMovementId,
      ],
    ),
  );
  return id;
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

/** A sale whose swap charge was paid by EDC card: no intent, no drawer cash. */
async function saleWithEdcCharge() {
  const sale = await completedCashSale();
  const linkId = await seedLink(CHARGE.amountIdr);
  const chargeId = await seedPaidCharge(sale.orderId, {
    intentId: null,
    linkId,
  });
  return { ...sale, chargeId };
}

/** A sale whose swap charge was paid by gateway and refunded in full already. */
async function saleWithRefundedGatewayCharge() {
  const sale = await completedCashSale();
  const linkId = await seedLink(CHARGE.amountIdr);
  const intentId = await seedPaidIntent(linkId);
  const refundId = await seedCompletedRefund(intentId);
  const chargeId = await seedPaidCharge(sale.orderId, { intentId, linkId });
  return { ...sale, chargeId, intentId, refundId };
}

type ChargeEventName =
  "order_issue.charge_paid" | "order_issue.charge_refunded";

function chargeEvent(
  name: ChargeEventName,
  chargeId: string,
  payload: Record<string, unknown>,
): EventEnvelope {
  const definition = qrOrderEvents[name];
  const issueId = issueOfCharge.get(chargeId) ?? randomUUID();
  const id = createUlid();
  return definition.envelopeSchema.parse({
    id,
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: issueId,
    sequence: 1,
    occurredAt: new Date().toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `v9-${name}-${id}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: { orderIssueId: issueId, chargeId, ...payload },
  }) as EventEnvelope;
}

const SPLIT = {
  grossSalesIdr: CHARGE.grossSalesIdr,
  serviceChargeIdr: CHARGE.serviceChargeIdr,
  pbjtIdr: CHARGE.pbjtIdr,
  amountIdr: CHARGE.amountIdr,
};

function gatewayPaidEvent(
  orderId: string,
  chargeId: string,
  intentId: string,
): EventEnvelope {
  return chargeEvent("order_issue.charge_paid", chargeId, {
    orderId,
    paymentIntentId: intentId,
    method: "qr_link",
    differenceIdr: CHARGE.differenceIdr,
    ...SPLIT,
    paidAt: new Date().toISOString(),
  });
}

function gatewayRefundedEvent(
  orderId: string,
  chargeId: string,
  intentId: string,
  refundId: string,
): EventEnvelope {
  return chargeEvent("order_issue.charge_refunded", chargeId, {
    orderId,
    refundId,
    paymentIntentId: intentId,
    method: "gateway",
    ...SPLIT,
    refundedAt: new Date().toISOString(),
  });
}

// ---- Observers ----------------------------------------------------------------

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

/** Journal entries of the charge: its paid entry and its refund entry. */
async function chargeJournalEntries(
  chargeId: string,
  refundId: string,
): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries
     WHERE tenant_id = $1 AND idempotency_key = ANY($2::text[])`,
    [
      tenant.tenantId,
      [`aj:order-charge:${chargeId}`, `aj:order-charge-refund:${refundId}`],
    ],
  );
  return Number(rows[0]!.n);
}

async function chargeRow(chargeId: string) {
  const { rows } = await owner.query<{
    status: string;
    closed_at: Date | null;
  }>(
    "SELECT status, closed_at FROM order_issue_charges WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, chargeId],
  );
  return rows[0]!;
}

async function voidChargeCashOut(chargeId: string): Promise<number[]> {
  const { rows } = await owner.query<{ amount_idr: number }>(
    `SELECT amount_idr::int AS amount_idr FROM cash_movements
     WHERE tenant_id = $1 AND type = 'cash_out' AND idempotency_key = $2`,
    [tenant.tenantId, `void-charge:${chargeId}`],
  );
  return rows.map((row) => row.amount_idr);
}

async function refundRowsOfIntent(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenant.tenantId, intentId],
  );
  return Number(rows[0]!.n);
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

/** What a void of a plain cash sale does to the drawer (control). */
async function controlVoidDelta(): Promise<number> {
  const before = await drawerCash();
  const sale = await completedCashSale();
  const { response } = await voidOrder(sale);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return (await drawerCash()) - before;
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

// ============================================================================

describe("legend-v5z4h status of a swap charge after its order is voided", () => {
  it("v5z4h-1 gateway charge already fully refunded: void goes through, charge becomes voided (closed_at set), no new refund, no cash_out, no new journal entry, journal balanced, not counted as revenue", async () => {
    const control = await controlVoidDelta();
    const beforeSale = await drawerCash();
    const sale = await saleWithRefundedGatewayCharge();
    await postSale(sale.orderId);
    const paid = await deliver(
      gatewayPaidEvent(sale.orderId, sale.chargeId, sale.intentId),
    );
    expect(paid.status, JSON.stringify(paid)).toBe("posted");
    const refunded = await deliver(
      gatewayRefundedEvent(
        sale.orderId,
        sale.chargeId,
        sale.intentId,
        sale.refundId,
      ),
    );
    expect(refunded.status, JSON.stringify(refunded)).toBe("posted");
    expect(await chargeJournalEntries(sale.chargeId, sale.refundId)).toBe(2);
    expect((await chargeRow(sale.chargeId)).status).toBe("paid");

    const { response, approval } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect(await voidRowCount(sale.orderId)).toBe(1);
    expect(await approvalUses(approval.overrideId)).toBe(1);

    // Same transaction as the void: the closed charge is visible at once.
    const charge = await chargeRow(sale.chargeId);
    expect(charge.status).toBe("voided");
    expect(charge.closed_at).not.toBeNull();
    // No new money: the one refund stays one, nothing leaves the drawer for it.
    expect(await refundRowsOfIntent(sale.intentId)).toBe(1);
    expect(await voidChargeCashOut(sale.chargeId)).toEqual([]);
    expect((await drawerCash()) - beforeSale).toBe(control);

    await deliverOutboxOf(sale.orderId);
    await sweep();
    // No new journal entry for the charge; revenue/tax/cash net to 0.
    expect(await chargeJournalEntries(sale.chargeId, sale.refundId)).toBe(2);
    await expectRolesNetZero();
    expect(await unbalancedEntries()).toBe(0);
    expect(await parkedCount()).toBe(0);
  });

  it("v5z4h-2 charge events reaching the journal AFTER the void of a voided gateway charge: nothing parks, revenue nets to 0, entries balanced", async () => {
    const sale = await saleWithRefundedGatewayCharge();
    await postSale(sale.orderId);

    const { response } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect((await chargeRow(sale.chargeId)).status).toBe("voided");
    await deliverOutboxOf(sale.orderId);

    await deliver(gatewayPaidEvent(sale.orderId, sale.chargeId, sale.intentId));
    await deliver(
      gatewayRefundedEvent(
        sale.orderId,
        sale.chargeId,
        sale.intentId,
        sale.refundId,
      ),
    );
    await sweep();
    expect(await parkedCount()).toBe(0);
    await expectRolesNetZero();
    expect(await unbalancedEntries()).toBe(0);
  });

  it("v5z4h-3 a manual refund still requested blocks the void: 409, order stays completed, no void row, approval unused, charge paid, drawer untouched", async () => {
    const sale = await saleWithCashCharge();
    await seedManualRefund({
      chargeId: sale.chargeId,
      method: "cash",
      amountIdr: 10_000,
      status: "requested",
    });
    const before = await drawerCash();

    const { response, approval } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBe(409);

    expect(await voidRowCount(sale.orderId)).toBe(0);
    expect(await approvalUses(approval.overrideId)).toBe(0);
    expect((await pos().get(sale.orderId)).body.data.status).toBe("completed");
    expect((await chargeRow(sale.chargeId)).status).toBe("paid");
    expect(await voidChargeCashOut(sale.chargeId)).toEqual([]);
    expect(await drawerCash()).toBe(before);
  });

  it("v5z4h-4 cash charge fully manual-refunded, then void: voided, NO new cash_out, the drawer only gives back the sale", async () => {
    const control = await controlVoidDelta();
    const beforeSale = await drawerCash();
    const sale = await saleWithCashCharge();
    await seedManualRefund({
      chargeId: sale.chargeId,
      method: "cash",
      amountIdr: CHARGE.amountIdr,
      status: "completed",
    });
    // Sale in, charge in, charge back out by the manual refund.
    expect(await drawerCash()).toBe(beforeSale + sale.totalIdr);

    const { response, approval } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect(await voidRowCount(sale.orderId)).toBe(1);
    expect(await approvalUses(approval.overrideId)).toBe(1);

    const charge = await chargeRow(sale.chargeId);
    expect(charge.status).toBe("voided");
    expect(charge.closed_at).not.toBeNull();
    expect(await voidChargeCashOut(sale.chargeId)).toEqual([]);
    expect((await drawerCash()) - beforeSale).toBe(control);
  });

  it("v5z4h-5 cash charge partly manual-refunded, then void: cash_out of the remainder only, total returned equals the charge, voided", async () => {
    const MANUAL = 10_000;
    const control = await controlVoidDelta();
    const beforeSale = await drawerCash();
    const sale = await saleWithCashCharge();
    await seedManualRefund({
      chargeId: sale.chargeId,
      method: "cash",
      amountIdr: MANUAL,
      status: "completed",
    });

    const { response } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);

    expect(await voidChargeCashOut(sale.chargeId)).toEqual([
      CHARGE.amountIdr - MANUAL,
    ]);
    expect((await chargeRow(sale.chargeId)).status).toBe("voided");
    // Manual + void return exactly the charge, never more: the drawer ends
    // where a plain sale + void ends.
    expect((await drawerCash()) - beforeSale).toBe(control);
  });

  it("v5z4h-6 EDC charge partly manual-refunded: the remainder cannot go back through the till, void 409, nothing changes", async () => {
    const sale = await saleWithEdcCharge();
    await seedManualRefund({
      chargeId: sale.chargeId,
      method: "edc",
      amountIdr: 10_000,
      status: "completed",
    });
    const before = await drawerCash();

    const { response, approval } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBe(409);

    expect(await voidRowCount(sale.orderId)).toBe(0);
    expect(await approvalUses(approval.overrideId)).toBe(0);
    expect((await pos().get(sale.orderId)).body.data.status).toBe("completed");
    expect((await chargeRow(sale.chargeId)).status).toBe("paid");
    expect(await voidChargeCashOut(sale.chargeId)).toEqual([]);
    expect(await drawerCash()).toBe(before);
  });

  it("v5z4h-7 EDC charge fully manual-refunded, then void: voided, no cash_out, nothing left to return", async () => {
    const control = await controlVoidDelta();
    const beforeSale = await drawerCash();
    const sale = await saleWithEdcCharge();
    await seedManualRefund({
      chargeId: sale.chargeId,
      method: "edc",
      amountIdr: CHARGE.amountIdr,
      status: "completed",
    });

    const { response } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);

    expect((await chargeRow(sale.chargeId)).status).toBe("voided");
    expect(await voidChargeCashOut(sale.chargeId)).toEqual([]);
    expect((await drawerCash()) - beforeSale).toBe(control);
  });
});

describe("legend-9e21l index for the charge-refund lookup on the outbox", () => {
  it("9e21l-1 the refund lookup (tenant_id, payload refundId, name charge_refunded) uses the partial expression index of migration 0565, not a seq scan", async () => {
    const { rows: indexes } = await owner.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'domain_event_outbox'
         AND indexdef ILIKE '%refundId%'
         AND indexdef ILIKE '%order_issue.charge_refunded%'`,
    );
    expect(
      indexes,
      "an index on domain_event_outbox keyed by payload refundId, partial on order_issue.charge_refunded",
    ).toHaveLength(1);
    const indexName = indexes[0]!.indexname;

    const refundId = randomUUID();
    const plan = await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query("SET LOCAL enable_seqscan = off");
      const { rows } = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT 1 FROM domain_event_outbox
         WHERE tenant_id = '${tenant.tenantId}'
           AND event->>'name' = 'order_issue.charge_refunded'
           AND event->'payload'->>'refundId' = '${refundId}'
         LIMIT 1`,
      );
      return JSON.stringify(rows[0]!["QUERY PLAN"]);
    });
    expect(plan).toContain(indexName);
    expect(plan).not.toContain('"Seq Scan"');
  });
});
