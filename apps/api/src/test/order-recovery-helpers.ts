// Shared world for the failed-item recovery tests (legend-4qu, ORD-08, ORD-09):
// order-recovery.test.ts and apology-voucher.test.ts. Setup follows
// e2e-az/az-a-qr-order-pay.test.ts (isolated tenant, QR seat, placeOrder,
// payVerified) and is copied here because the e2e-az suite exports nothing.
// This file has no tests and no production dependency beyond what that suite
// already imports.

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { Express } from "express";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import type { PaymentInstructions } from "@starter/shared/payment";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type GatewayPaymentStatus,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { deliverQrOrderPaymentEvent } from "../services/qr-order-payment.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

export const PRICES = {
  kopi: 25_000,
  roti: 18_000,
  extraShot: 5_000,
  /** Cheaper than roti: a valid swap for a failed roti (credit 6.000). */
  teh: 12_000,
  /** Same price as roti: a valid swap with no difference. */
  rotiLain: 18_000,
} as const;
/** Kopi x2 + extra shot, Roti x1 = 78.000; +5% service; +10% PBJT = 90.090. */
export const CART_TOTAL = 90_090;
/** Apology voucher approval matrix used by these tests (see createWorld). */
export const VOUCHER_APPROVAL_FLOOR_IDR = 100_000;
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];
const RECOVERY_PERMISSIONS = [
  "order.view",
  "order.create",
  "order.recovery.handle",
  "order.apology_voucher.issue",
  "kds.ticket.process",
  "kds.remake_comp.record",
  "floor.table.view",
];

class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  private readonly payments = new Map<string, GatewayPaymentStatus>();
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const providerRef = `REC-${randomBytes(6).toString("hex")}-${this.created}`;
    this.payments.set(providerRef, {
      status: "pending",
      providerRef,
      amountIdr: input.amountIdr,
    });
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226RECQR",
      issuer: null,
    };
    return { providerRef, instructions, expiresAt: input.expiresAt };
  }
  async getStatus(input: { providerRef: string }) {
    return (
      this.payments.get(input.providerRef) ?? {
        status: "pending" as const,
        providerRef: input.providerRef,
        amountIdr: null,
      }
    );
  }
  async channels() {
    return [];
  }
}

export type Guest = { token: string; sessionId: string };

export type OrderView = {
  id: string;
  status: string;
  items: { id: string; menuItemId: string; fireStatus: string }[];
};

export async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client as unknown as Client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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

async function userWithRole(
  app: Express,
  tenantId: string,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; outletId: string },
  label: string,
): Promise<Staff> {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.outletId : null,
    ],
  );
  return { client, userId, email };
}

export async function createWorld() {
  const app = createApp();
  const gateway = new FakeGateway();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);

  const tenant: IsolatedTenant = await createIsolatedTenant(
    `rec-${randomUUID().slice(0, 6)}`,
  );
  const headers = { Host: tenant.hostname };
  /** Holds only floor permissions: no `order.recovery.handle`. */
  const floorStaff = await staffOfIsolatedTenant(app, tenant);

  const ids = {
    category: randomUUID(),
    kopi: randomUUID(),
    roti: randomUUID(),
    habis: randomUUID(),
    teh: randomUUID(),
    rotiLain: randomUUID(),
    priceList: randomUUID(),
    group: randomUUID(),
    extraShot: randomUUID(),
    taxRule: randomUUID(),
    taxSettings: randomUUID(),
    supervisorRole: randomUUID(),
    outletRole: randomUUID(),
    otherOutlet: randomUUID(),
  };

  // Kitchen supervisor: tenant-wide, reports and resolves failed items.
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Supervisor Dapur Uji', false, NULL, $3, false, '["tenant"]')`,
    [ids.supervisorRole, tenant.tenantId, JSON.stringify(RECOVERY_PERMISSIONS)],
  );
  const supervisor = await userWithRole(
    app,
    tenant.tenantId,
    ids.supervisorRole,
    { type: "tenant" },
    "Supervisor Dapur",
  );

  // A second outlet in the same tenant, with a supervisor limited to it.
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Kedua Uji', 'Jl. Uji 2', timezone, opening_hours, 'active'
     FROM outlets WHERE id = $3 AND tenant_id = $4`,
    [
      ids.otherOutlet,
      `O2-${randomUUID().slice(0, 6)}`.toUpperCase(),
      tenant.outletId,
      tenant.tenantId,
    ],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Supervisor Outlet Uji', false, NULL, $3, false, '["tenant","outlet"]')`,
    [ids.outletRole, tenant.tenantId, JSON.stringify(RECOVERY_PERMISSIONS)],
  );
  const otherOutletSupervisor = await userWithRole(
    app,
    tenant.tenantId,
    ids.outletRole,
    { type: "outlet", outletId: ids.otherOutlet },
    "Supervisor Outlet Kedua",
  );

  // Supervisor limited to the main outlet: issues standalone vouchers there.
  const outletSupervisor = await userWithRole(
    app,
    tenant.tenantId,
    ids.outletRole,
    { type: "outlet", outletId: tenant.outletId },
    "Supervisor Outlet Utama",
  );

  /** A fresh supervisor limited to the main outlet, so a test can revoke it. */
  const newOutletSupervisor = () =>
    userWithRole(
      app,
      tenant.tenantId,
      ids.outletRole,
      { type: "outlet", outletId: tenant.outletId },
      "Supervisor Outlet Sementara",
    );
  /** Ends every role assignment of a user (the permission is revoked). */
  const revokeRoles = async (userId: string) => {
    await owner.query(
      `UPDATE role_assignments SET valid_until = now() - interval '10 seconds'
       WHERE tenant_id = $1 AND user_id = $2`,
      [tenant.tenantId, userId],
    );
  };

  // Approver: a distinct person (approval_requests forbids requester == approver).
  const approverClient = agent(app);
  await signUp(approverClient, "Penyetuju Uji");
  const approverSession = await approverClient.get("/api/auth/get-session");
  const approverUserId = approverSession.body.user.id as string;

  // Apology voucher approval matrix: nothing below Rp100.000 needs approval,
  // from Rp100.000 one approval by the supervisor role (distinct actor).
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     VALUES ($1, 'apology_voucher', $2, $3, 1, true)`,
    [tenant.tenantId, VOUCHER_APPROVAL_FLOOR_IDR, ids.supervisorRole],
  );

  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Pemulihan Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name] of [
      [ids.kopi, "Kopi Susu"],
      [ids.roti, "Roti Bakar"],
      [ids.habis, "Kue Habis"],
      [ids.teh, "Teh Tarik"],
      [ids.rotiLain, "Roti Panggang"],
    ] as const)
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [id, tenant.tenantId, tenant.brandId, ids.category, name, randomUUID()],
      );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    for (const [itemId, price] of [
      [ids.kopi, PRICES.kopi],
      [ids.roti, PRICES.roti],
      [ids.habis, 15_000],
      [ids.teh, PRICES.teh],
      [ids.rotiLain, PRICES.rotiLain],
    ] as const)
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, ids.priceList, itemId, price],
      );
    await client.query(
      `INSERT INTO modifier_groups (id, tenant_id, name, min_select, max_select)
       VALUES ($1, $2, 'Ekstra', 0, 1)`,
      [ids.group, tenant.tenantId],
    );
    await client.query(
      `INSERT INTO modifiers (id, tenant_id, group_id, name, price_idr)
       VALUES ($1, $2, $3, 'Extra shot', $4)`,
      [ids.extraShot, tenant.tenantId, ids.group, PRICES.extraShot],
    );
    await client.query(
      `INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, group_id, sort_order)
       VALUES ($1, $2, $3, 0)`,
      [tenant.tenantId, ids.kopi, ids.group],
    );
    await client.query(
      `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, status)
       VALUES ($1, $2, $3, $4, '[]', NULL, 'sold_out')`,
      [randomUUID(), tenant.tenantId, tenant.outletId, ids.habis],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxSettings, tenant.tenantId, floorStaff.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-REC', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, floorStaff.userId],
    );
  });

  // ---- guest-side helpers ---------------------------------------------------

  async function newTable(
    paymentMode: "pay_first" | "open_bill" = "pay_first",
  ) {
    const zone = await createZone(
      floorStaff.client,
      { paymentMode, serviceChargeBp: 500, hours: ALL_DAY },
      headers,
    );
    const table = await createTable(
      floorStaff.client,
      { zoneId: zone.id },
      headers,
    );
    const qr = await issueQr(floorStaff.client, table.id, headers);
    return { table, qrToken: qr.token as string };
  }

  async function seat(
    paymentMode: "pay_first" | "open_bill" = "pay_first",
  ): Promise<Guest> {
    const { qrToken } = await newTable(paymentMode);
    const response = await scan(app, {
      token: qrToken,
      pax: 2,
      hostname: tenant.hostname,
    });
    if (response.status !== 201)
      throw new Error(`Seating failed with ${response.status}`);
    return {
      token: response.body.data.sessionToken,
      sessionId: response.body.data.session.id,
    };
  }

  function as(guest: Guest) {
    const client = agent(app);
    const auth = (test: ReturnType<typeof client.get>) =>
      test
        .set("Host", tenant.hostname)
        .set("Authorization", `Bearer ${guest.token}`)
        .set(originHeader);
    const base = `/api/table-sessions/${guest.sessionId}`;
    return {
      add: (body: Record<string, unknown>) =>
        auth(client.post(`${base}/cart/lines`)).send({
          idempotencyKey: randomUUID(),
          modifierIds: [],
          ...body,
        }),
      checkout: (body: Record<string, unknown>) =>
        auth(client.post(`${base}/orders`)).send(body),
      pay: (target: Record<string, unknown>) =>
        auth(client.post(`${base}/payments`)).send({
          target,
          method: "qris",
          idempotencyKey: randomUUID(),
        }),
      issues: () => auth(client.get(`${base}/order-issues`)),
      issueOptions: (issueId: string) =>
        auth(client.get(`/api/order-issues/${issueId}/options`)),
      choose: (issueId: string, body: Record<string, unknown>) =>
        auth(client.post(`/api/order-issues/${issueId}/customer-choice`)).send(
          body,
        ),
    };
  }

  /** A guest without any token. */
  function anonymousGuestChoose(
    issueId: string,
    body: Record<string, unknown>,
  ) {
    return agent(app)
      .post(`/api/order-issues/${issueId}/customer-choice`)
      .set("Host", tenant.hostname)
      .set(originHeader)
      .send(body);
  }

  async function placeOrder(
    guest: Guest,
    lines: { menuItemId: string; quantity: number; modifierIds?: string[] }[],
  ): Promise<OrderView> {
    let version = 0;
    for (const line of lines) {
      const added = await as(guest).add({
        ...line,
        expectedCartVersion: version,
      });
      if (added.status !== 201)
        throw new Error(`Add to cart failed with ${added.status}`);
      version = added.body.data.cart.version as number;
    }
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    if (placed.status !== 201)
      throw new Error(`Checkout failed with ${placed.status}`);
    return placed.body.data.order as OrderView;
  }

  const STANDARD_LINES = [
    {
      menuItemId: ids.kopi,
      quantity: 2,
      modifierIds: [ids.extraShot],
    },
    { menuItemId: ids.roti, quantity: 1 },
  ];

  async function outboxRows(name: string, containing: string) {
    const { rows } = await owner.query<{ event: unknown; created_at: Date }>(
      `SELECT event, created_at FROM domain_event_outbox
       WHERE tenant_id = $1 AND event->>'name' = $2 AND event::text LIKE $3
       ORDER BY created_at, id`,
      [tenant.tenantId, name, `%${containing}%`],
    );
    return rows.map((row) => ({
      event: eventEnvelopeSchema.parse(row.event),
      createdAt: row.created_at,
    }));
  }

  /** The verified webhook settles the intent; its payment.paid reaches the order. */
  async function payVerified(intentId: string, amountIdr: number) {
    const context = tenantContext(tenant.tenantId);
    await confirmPayment(context, intentId, {
      source: "verified_webhook",
      method: "qris",
      amountIdr,
      providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
      at: new Date().toISOString(),
    });
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
       WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
         AND event->'payload'->>'intentId' = $2`,
      [tenant.tenantId, intentId],
    );
    const event = eventEnvelopeSchema.parse(rows[0]!.event);
    return withTenant(db, context, (tx) =>
      deliverQrOrderPaymentEvent(context, event, event.id, tx),
    );
  }

  /** A seated guest whose standard order (kopi x2 + shot, roti) is paid. */
  async function paidOrder() {
    const guest = await seat();
    const order = await placeOrder(guest, STANDARD_LINES);
    const payment = await as(guest).pay({ kind: "order", orderId: order.id });
    if (payment.status !== 201)
      throw new Error(`Payment intent failed with ${payment.status}`);
    const delivered = await payVerified(payment.body.data.id, CART_TOTAL);
    if (delivered !== true) throw new Error("Paid event was not delivered");
    return {
      guest,
      order,
      roti: order.items.find((item) => item.menuItemId === ids.roti)!,
      kopi: order.items.find((item) => item.menuItemId === ids.kopi)!,
    };
  }

  /** An order that is placed but NOT paid (awaiting payment). */
  async function unpaidOrder() {
    const guest = await seat();
    const order = await placeOrder(guest, STANDARD_LINES);
    return {
      guest,
      order,
      roti: order.items.find((item) => item.menuItemId === ids.roti)!,
    };
  }

  /**
   * An open-bill order: confirmed by a waiter and fired to the kitchen, but
   * the bill is not settled (the guest pays at the end of the meal).
   */
  async function openBillOrder() {
    const guest = await seat("open_bill");
    // The first order of an open-bill session waits for a waiter's confirmation.
    const confirmed = await floorStaff.client
      .post(`/api/table-sessions/${guest.sessionId}/confirm`)
      .set(headers)
      .set(originHeader);
    if (confirmed.status !== 200)
      throw new Error(`Waiter confirm failed with ${confirmed.status}`);
    const order = await placeOrder(guest, STANDARD_LINES);
    return {
      guest,
      order,
      roti: order.items.find((item) => item.menuItemId === ids.roti)!,
    };
  }

  // ---- staff-side helpers ---------------------------------------------------

  function staffPost(
    who: Staff,
    path: string,
    body: Record<string, unknown>,
    host: string = tenant.hostname,
  ) {
    return who.client.post(path).set("Host", host).set(originHeader).send(body);
  }

  function staffGet(who: Staff, path: string, host: string = tenant.hostname) {
    return who.client.get(path).set("Host", host).set(originHeader);
  }

  /** A real kitchen report: unfulfillable by default. */
  function report(
    orderItemId: string,
    body: Record<string, unknown> = {},
    who: Staff = supervisor,
  ) {
    return staffPost(who, `/api/order-items/${orderItemId}/issues`, {
      type: "unfulfillable",
      reason: "out_of_stock",
      reasonNote: "Roti habis di dapur",
      ...body,
    });
  }

  /**
   * An approval request row. `decidedBy` set means a decided request:
   * pass status "approved". The id doubles as the chain id (level 1).
   */
  async function insertApproval(input: {
    actionType: string;
    objectType: string;
    objectId: string;
    amountIdr: number | null;
    status: "approved" | "pending";
    requestedBy: string;
    decidedBy?: string;
  }) {
    const id = randomUUID();
    const decided = input.status === "approved";
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `INSERT INTO approval_requests
           (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type,
            object_id, payload, requested_by, source, level, required_levels,
            required_steps, amount_idr, status, request_reason, decided_by, decided_at,
            reason, deadline_at, created_at)
         VALUES ($1, $2, $3, $1, 'order_recovery', $4, $5, $6, '{}', $7, 'user', 1, 1,
                 '[]', $8, $9, 'Pemulihan item gagal', $10, $11, $12,
                 now() + interval '1 day', now() - interval '1 minute')`,
        [
          id,
          tenant.tenantId,
          tenant.outletId,
          input.actionType,
          input.objectType,
          input.objectId,
          input.requestedBy,
          input.amountIdr,
          input.status,
          decided ? (input.decidedBy ?? approverUserId) : null,
          decided ? new Date().toISOString() : null,
          decided ? "Disetujui" : null,
        ],
      );
    });
    return id;
  }

  /** Marks an existing pending request approved by the approver. */
  async function approveExisting(requestId: string) {
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `UPDATE approval_requests
         SET status = 'approved', decided_by = $3, decided_at = now(), reason = 'Disetujui'
         WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, requestId, approverUserId],
      );
    });
  }

  async function teardown() {
    setPaymentGateway(null);
    setTableSessionSettlementLookup(null);
    // Audit rows are append-only, so the tenant stays; give it a valid creator.
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenant.tenantId,
      randomUUID(),
    ]);
    await owner.end();
  }

  return {
    app,
    tenant,
    headers,
    ids,
    floorStaff,
    supervisor,
    otherOutletSupervisor,
    outletSupervisor,
    newOutletSupervisor,
    revokeRoles,
    approverUserId,
    as,
    anonymousGuestChoose,
    seat,
    placeOrder,
    paidOrder,
    payVerified,
    unpaidOrder,
    openBillOrder,
    outboxRows,
    staffPost,
    staffGet,
    report,
    insertApproval,
    approveExisting,
    teardown,
  };
}

export type World = Awaited<ReturnType<typeof createWorld>>;
