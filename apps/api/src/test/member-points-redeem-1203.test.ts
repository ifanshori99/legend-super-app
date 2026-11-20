// legend-1203 (card legend-0ne0z): member "tukar poin" flow A, backend.
//
// Written from docs/briefs/sub-1203-tukar-poin-backend.md and the shared contract
// packages/shared/src/crm/member-points-redeem.ts (plus the existing member QR
// mint contract), not from the service code. Same fixtures as
// pos-1059-points.test.ts and pos-936-so-refund.test.ts (real POS orders of an
// isolated tenant; Kopi x2 = Rp55.000 incl. PBJT; 1 point = Rp70).
//
//   GET  /api/member/open-bills
//   GET  /api/member/open-bills/:orderId/points-quote
//   POST /api/member/points-redeem/status { orderId, token }
//   POST /api/member/qr-token { orderId, points }            (existing, new checks)
//   POST /api/pos/orders/:orderId/points/redeem               (existing, cashier)
//
// Feature id: 1203. Tests are named 1203-nn. Money rules of the brief:
//   M1 points value <= bill remainder, balance never negative
//   M2 redeem is idempotent / a token is single use
//   M3 balance or remainder changed after mint: redeem refused, never adjusted
//   M4 void after redeem gives the points back exactly once
//   M5 tenant / member / PT isolation in SQL
//   M6 mint refuses foreign, settled, voided, other-PT orders and points > max
//
// Every refusal test is paired with a control that works (the same call for
// the legitimate member), so a missing route (404) alone never turns a test
// green and a test only goes red because behaviour is missing or wrong.
//
// Assumptions (also in the report):
// - A refusal of mint / quote is any HTTP 4xx without `data` (the brief names no
//   code). Quote for an order the member may not see (other member, other
//   tenant, unknown id) is 4xx. A bill that is visible but cannot be redeemed
//   answers 200 with `refusal` set and maxPoints 0 (program_inactive,
//   membership_inactive, bill_settled are asserted exactly).
// - order_not_eligible is asserted loosely: a bill attached by phone lookup is
//   either hidden (4xx) or 200 with a refusal and maxPoints 0.
// - A captured points or cash tender counts as paid: remainingIdr = total - paid.
// - Status endpoint answers 200 with state "invalid" (not 4xx) for a tampered,
//   foreign-order, foreign-member or garbage token; for an order that is not
//   the caller's it answers 4xx or "invalid" with no points, no discount.
// - "pending" = minted, not yet redeemed; "consumed" also covers a bill the
//   cashier redeemed without QR (pwa_session) after the member minted a token.
// - 1203-70..82 (second round, CTO decisions of 20 Nov):
//   * one live token per bill: a second mint for a bill that already has a live
//     (minted, unexpired, unconsumed) token is refused; another bill still mints.
//     Whether a new mint is allowed while the old token is stale (balance changed)
//     is NOT tested (ambiguous).
//   * outlet_offline = the bill's outlet has an active edge node with an OPEN
//     `edge_offline` alert (edge_node_alerts, docs/design/edge-status-cloud.md D11:
//     30 minutes without heartbeat while open). The brief does not define it.
//   * the token binds the member's balance (ledger version) at mint: if the
//     balance changed afterwards, even upward or still enough, the till refuses
//     the whole redeem (4xx) and nothing is spent. State shown to the member is
//     only asserted "not consumed".
//   * mixed bill void: brief 1048 (Group R) and SO-R-09 keep a bill with CAPTURED
//     points + cash refused (409). So 1203-75 (fail-first) uses a points bill with a
//     non-captured (voided) cash row; 1203-76 and 1203-77 are guards that accept
//     "refused, nothing changes" or "restored exactly once". A refund of a bill
//     with a captured points tender is refused today (REFUND_POINTS_TENDER_UNSUPPORTED,
//     POS-936-PTS-60); the guard only demands points never come back twice.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
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
import {
  memberOpenBillSchema,
  memberPointsQuoteSchema,
  memberPointsRedeemStatusSchema,
} from "@starter/shared/crm";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import type { PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  issueMemberQrToken,
  verifyMemberQrRedeemToken,
} from "../lib/member-qr-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  seededTenantId,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  asTenant,
  balanceOf,
  hex64,
  ledgerOf,
  owner as memberOwner,
  seedConsent,
  seedOrder,
  seedProfile,
  seedProgram,
  type Profile,
} from "./member-loyalty-helpers.ts";
import { grantPoints } from "./member-rewards-helpers.ts";

const KOPI_IDR = 25_000;
/** Kopi x2 = Rp50.000 + PBJT 10%. */
const ORDER_TOTAL_IDR = 55_000;
const POINT_VALUE_IDR = 70;
/** floor(55.000 / 70): 786 points would be worth Rp55.020 > the bill. */
const MAX_POINTS_FULL_BILL = 785;
const PIN = "582914";
const DEVICE_ID = randomUUID();

const POS_PERMISSIONS = [
  "order.view",
  "pos.sale.create",
  "pos.payment.accept",
  "pos.discount.apply",
  "pos.refund.request",
  "pos.void.request",
  "shift.cash.operate",
];

/** Receipt numbering double (the production port is wired elsewhere). */
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
        deviceId: input.deviceId ?? DEVICE_ID,
        number: `P1203-${String(next).padStart(6, "0")}`,
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

let app: Express;

type Staff = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
};
type World = {
  tenant: IsolatedTenant;
  headers: { Host: string };
  kopi: string;
  cashier: Staff;
  supervisor: Staff;
};
let world: World;
/** A second tenant: its bills must never reach a member of `world`. */
let other: { tenant: IsolatedTenant; member: Profile };

async function insertRole(
  tenantId: string,
  name: string,
  permissions: string[],
  scopes: string[],
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [id, tenantId, name, JSON.stringify(permissions), JSON.stringify(scopes)],
  );
  return id;
}

async function staff(
  tenant: IsolatedTenant,
  roleId: string,
  label: string,
): Promise<Staff> {
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
  return { client, userId, email };
}

const tenantContext = (tenantId: string) =>
  establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });

async function seedWorld(): Promise<World> {
  const tenant = await createIsolatedTenant(
    `p1203-${randomUUID().slice(0, 6)}`,
  );
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    tenant.tenantId,
    JSON.stringify({
      modules: ["qr_order", "loyalty"],
      integrationProviders: [],
    }),
  ]);
  const template = await owner.query<{ permissions: string[] }>(
    "SELECT permissions FROM roles WHERE tenant_id = $1 AND template_key = 'cashier'",
    [seededTenantId],
  );
  const cashierRole = await insertRole(
    tenant.tenantId,
    "Kasir Poin 1203",
    [
      ...new Set([
        ...POS_PERMISSIONS,
        ...(template.rows[0]?.permissions ?? []),
      ]),
    ],
    ["tenant", "outlet"],
  );
  const supervisorRole = await insertRole(
    tenant.tenantId,
    "Supervisor Poin 1203",
    ["order.view", "pos.void.approve", "pos.refund.approve"],
    ["tenant"],
  );
  const cashier = await staff(tenant, cashierRole, "Kasir Poin 1203");
  const supervisor = await staff(
    tenant,
    supervisorRole,
    "Supervisor Poin 1203",
  );
  await verifySessionMfa(cashier.email);
  setPosReceiptPort(memoryReceiptPort());
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === DEVICE_ID
      ? tenant.outletId
      : null,
  );
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: DEVICE_ID,
  });
  const context = tenantContext(tenant.tenantId);
  await setStaffPin(
    context,
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
  await openPosShift(
    establishScopedTenantContext(context, { kind: "tenant" }),
    { userId: userIdSchema.parse(cashier.userId), deviceId: DEVICE_ID },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  const category = randomUUID();
  const kopi = randomUUID();
  await asTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Poin Uji 1203', 0)`,
      [category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [kopi, tenant.tenantId, tenant.brandId, category, randomUUID()],
    );
    const priceList = randomUUID();
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, priceList, kopi, KOPI_IDR],
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
       VALUES ($1, $2, NULL, 'PBJT-1203', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
  });
  await seedProgram(tenant.tenantId, { pointValueIdr: POINT_VALUE_IDR });
  return {
    tenant,
    headers: { Host: tenant.hostname },
    kopi,
    cashier,
    supervisor,
  };
}

async function seedOtherTenant(): Promise<typeof other> {
  const tenant = await createIsolatedTenant(
    `p1203x-${randomUUID().slice(0, 6)}`,
  );
  await seedProgram(tenant.tenantId, { pointValueIdr: POINT_VALUE_IDR });
  const member = await seedProfile(tenant.tenantId);
  await seedConsent(tenant.tenantId, member.id);
  await grantPoints(tenant.tenantId, member.id, 5_000);
  return { tenant, member };
}

beforeAll(async () => {
  app = createApp();
  world = await seedWorld();
  other = await seedOtherTenant();
}, 180_000);

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  await memberOwner.end();
  await owner.end();
});

// ---- fixtures -----------------------------------------------------------------

type AttachedVia = "member_qr" | "phone_lookup" | "pwa_session";
type CreatedOrder = { id: string; outletId: string };
type Member = { client: ReturnType<typeof agent>; profile: Profile };

/** A real member account with a profile of this tenant and `points` on the books. */
async function newMember(points: number): Promise<Member> {
  const client = agent(app);
  await signUp(client, "Member 1203");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const profile = await seedProfile(world.tenant.tenantId, {
    userId,
    name: `Member ${randomUUID().slice(0, 6)}`,
  });
  await seedConsent(world.tenant.tenantId, profile.id);
  if (points > 0) await grantPoints(world.tenant.tenantId, profile.id, points);
  expect(await balanceOf(world.tenant.tenantId, profile.id)).toBe(points);
  return { client, profile };
}

/** A real submitted POS order (Kopi x2 = Rp55.000) with `member` on the bill. */
async function newOrder(
  member: Member | null,
  via: AttachedVia = "member_qr",
): Promise<CreatedOrder> {
  const outletId = world.tenant.outletId;
  const created = await world.cashier.client
    .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/orders`)
    .set(world.headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: world.kopi, quantity: 2, modifierIds: [] }],
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.totalIdr).toBe(ORDER_TOTAL_IDR);
  const id = created.body.data.id as string;
  if (member) {
    await asTenant(world.tenant.tenantId, (client) =>
      client.query(
        `UPDATE orders
            SET customer_profile_id = $3, customer_attached_via = $4::varchar,
                customer_attached_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [world.tenant.tenantId, ulidToUuid(id), member.profile.id, via],
      ),
    );
  }
  const submitted = await world.cashier.client
    .post(
      `/api/outlets/${encodeURIComponent(outletId)}/pos/orders/${id}/submit`,
    )
    .set(world.headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      expectedStatus: created.body.data.status as string,
    });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  return { id, outletId };
}

/** A paid-out (completed) bill of `member` in the member's own outlet. */
async function settledBillOf(member: Member): Promise<string> {
  return seedOrder(world.tenant.tenantId, {
    outletId: world.tenant.outletId,
    profileId: member.profile.id,
    attachedVia: "member_qr",
    grossSalesIdr: 50_000,
    pbjtIdr: 5_000,
    status: "completed",
  });
}

async function seedCashTender(order: CreatedOrder, amountIdr: number) {
  await asTenant(world.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr,
          received_idr, change_idr, points_used, payment_intent_id, reference, status,
          requested_at, resolved_at)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, NULL, NULL, NULL, 'captured', now(), now())`,
      [world.tenant.tenantId, order.outletId, ulidToUuid(order.id), amountIdr],
    ),
  );
}

async function pointsTenders(order: CreatedOrder) {
  const { rows } = await asTenant(world.tenant.tenantId, (client) =>
    client.query<{ points_used: number; status: string }>(
      `SELECT points_used, status FROM pos_order_tenders
        WHERE tenant_id = $1 AND order_id = $2 AND method = 'points'
        ORDER BY created_at, id`,
      [world.tenant.tenantId, ulidToUuid(order.id)],
    ),
  );
  return rows;
}

async function redeemRows(member: Member) {
  return (await ledgerOf(world.tenant.tenantId, member.profile.id)).filter(
    (row) => row.type === "redeem",
  );
}

/** Ledger rows that are neither the earn grant nor a redeem: the restores. */
async function restoreRows(member: Member) {
  return (await ledgerOf(world.tenant.tenantId, member.profile.id)).filter(
    (row) => row.type !== "earn" && row.type !== "redeem",
  );
}

const balanceNow = (member: Member) =>
  balanceOf(world.tenant.tenantId, member.profile.id);

// ---- API calls ----------------------------------------------------------------

const asMember = (client: ReturnType<typeof agent>) => client;

const getOpenBills = (client: ReturnType<typeof agent>) =>
  asMember(client).get("/api/member/open-bills").set(world.headers);

const getQuote = (client: ReturnType<typeof agent>, orderId: string) =>
  asMember(client)
    .get(`/api/member/open-bills/${encodeURIComponent(orderId)}/points-quote`)
    .set(world.headers);

const postStatus = (
  client: ReturnType<typeof agent>,
  body: Record<string, unknown>,
  headers: Record<string, string> = originHeader,
) =>
  asMember(client)
    .post("/api/member/points-redeem/status")
    .set(world.headers)
    .set(headers)
    .send(body);

const postMint = (
  client: ReturnType<typeof agent>,
  orderId: string,
  points: number,
) =>
  asMember(client)
    .post("/api/member/qr-token")
    .set(world.headers)
    .set(originHeader)
    .send({ orderId, points });

const cashierRedeem = (
  order: CreatedOrder,
  points: number,
  options: { token?: string; key?: string } = {},
) =>
  world.cashier.client
    .post(`/api/pos/orders/${order.id}/points/redeem`)
    .set(world.headers)
    .set(originHeader)
    .send({
      points,
      idempotencyKey: options.key ?? randomUUID(),
      ...(options.token === undefined ? {} : { memberToken: options.token }),
    });

const redeemed = (status: number) => [200, 201].includes(status);

/** A refusal is a client error without data: never a crash, never a success. */
function expectRefused(response: { status: number; body: unknown }) {
  const text = JSON.stringify(response.body);
  expect(response.status, text).toBeGreaterThanOrEqual(400);
  expect(response.status, text).toBeLessThan(500);
  expect((response.body as { data?: unknown }).data, text).toBeUndefined();
}

async function listedBills(member: Member) {
  const response = await getOpenBills(member.client);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return memberOpenBillSchema.array().parse(response.body.data);
}

async function quoteOk(member: Member, orderId: string) {
  const response = await getQuote(member.client, orderId);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return memberPointsQuoteSchema.parse(response.body.data);
}

async function statusOk(member: Member, orderId: string, token: string) {
  const response = await postStatus(member.client, { orderId, token });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return memberPointsRedeemStatusSchema.parse(response.body.data);
}

/** Mint through the real endpoint and return the token (the happy path). */
async function mintOk(member: Member, orderId: string, points: number) {
  const response = await postMint(member.client, orderId, points);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const token = response.body.data.token as string;
  expect(
    verifyMemberQrRedeemToken(token, world.tenant.tenantId, new Date()),
  ).toMatchObject({
    customerProfileId: member.profile.id,
    orderId,
    points,
  });
  return token;
}

/** A token signed locally (never minted through the API): for the invalid / expired cases. */
function localToken(
  member: Member,
  orderId: string,
  points: number,
  at: Date = new Date(),
): string {
  return issueMemberQrToken(
    {
      tenantId: world.tenant.tenantId,
      customerProfileId: member.profile.id,
      orderId,
      points,
    },
    at,
  ).token;
}

/** A quote of a bill the member may not use: hidden (4xx) or 200 with a refusal and no points. */
async function expectQuoteUnusable(member: Member, orderId: string) {
  const response = await getQuote(member.client, orderId);
  if (response.status === 200) {
    const quote = memberPointsQuoteSchema.parse(response.body.data);
    expect(quote.refusal, JSON.stringify(quote)).not.toBeNull();
    expect(quote.maxPoints).toBe(0);
  } else {
    expectRefused(response);
  }
}

// ---- void helpers (copied from the SO-R tests) ----------------------------------

const deviceToken = () =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: world.tenant.tenantId,
    brandId: null,
    deviceId: DEVICE_ID,
  });

async function posStatusOf(order: CreatedOrder): Promise<string> {
  const detail = await world.cashier.client
    .get(
      `/api/outlets/${encodeURIComponent(order.outletId)}/pos/orders/${order.id}`,
    )
    .set(world.headers)
    .set(originHeader);
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  return detail.body.data.status as string;
}

async function voidApproval(order: CreatedOrder) {
  const { override } = await createPosOverride(
    tenantContext(world.tenant.tenantId),
    world.cashier.userId,
    {
      outletId: order.outletId,
      action: "void",
      valueIdr: ORDER_TOTAL_IDR,
      reason: "Pelanggan batal bayar",
      objectType: "order",
      objectId: order.id,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(world.supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: world.supervisor.userId, overrideId: override.id };
}

async function voidNow(order: CreatedOrder) {
  const expectedStatus = await posStatusOf(order);
  const approval = await voidApproval(order);
  return world.cashier.client
    .post(
      `/api/outlets/${encodeURIComponent(order.outletId)}/pos/orders/${order.id}/void`,
    )
    .set(world.headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken())
    .send({
      idempotencyKey: randomUUID(),
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal sebelum bayar lunas",
      expectedStatus,
      ...approval,
    });
}

// ---- PT helper (as pos-1059-points.test.ts) ---------------------------------------

/**
 * Runs `run` with the tenant split into two legal entities (PT): the POS outlet
 * stays in PT-A, a second outlet lives in PT-B. `programOwner` says whom the
 * loyalty program belongs to: "pos" = PT-A (the outlet), "other" = PT-B.
 * Everything is put back afterwards.
 */
async function withTwoEntities(
  programOwner: "pos" | "other",
  run: () => Promise<void>,
) {
  const entityB = randomUUID();
  const outletB = randomUUID();
  await asTenant(world.tenant.tenantId, async (client) => {
    await client.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B 1203', false)",
      [entityB, world.tenant.tenantId],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet PT B', 'Jl. B', 'Asia/Jakarta', '{}', 'active')`,
      [
        outletB,
        world.tenant.tenantId,
        world.tenant.brandId,
        entityB,
        `PB-${outletB.slice(0, 6).toUpperCase()}`,
      ],
    );
    await client.query(
      "UPDATE loyalty_programs SET legal_entity_id = $2 WHERE tenant_id = $1",
      [
        world.tenant.tenantId,
        programOwner === "pos" ? world.tenant.legalEntityId : entityB,
      ],
    );
  });
  try {
    await run();
  } finally {
    await asTenant(world.tenant.tenantId, async (client) => {
      await client.query(
        "UPDATE loyalty_programs SET legal_entity_id = NULL WHERE tenant_id = $1",
        [world.tenant.tenantId],
      );
      await client.query(
        "DELETE FROM outlets WHERE tenant_id = $1 AND id = $2",
        [world.tenant.tenantId, outletB],
      );
      await client.query(
        "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
        [world.tenant.tenantId, entityB],
      );
    });
  }
}

// ================================================================================
// GET /api/member/open-bills
// ================================================================================

describe("1203 GET /api/member/open-bills", () => {
  it("1203-01 a member sees the open bill attached to them, with server-owned figures and no redeem yet", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member, "member_qr");

    const bills = await listedBills(member);
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({
      orderId: order.id,
      totalIdr: ORDER_TOTAL_IDR,
      paidIdr: 0,
      remainingIdr: ORDER_TOTAL_IDR,
      attachedVia: "member_qr",
      pointsRedeemed: null,
    });
    expect(bills[0]!.billNumber.length).toBeGreaterThan(0);
    expect(bills[0]!.outletName.length).toBeGreaterThan(0);
  });

  it("1203-02 empty state: a member with no attached bill gets an empty list", async () => {
    const member = await newMember(500);
    const response = await getOpenBills(member.client);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual([]);
  });

  it("1203-03 only open bills of this member attached by QR or PWA session are listed: not phone lookup, settled, voided, another member's or another tenant's", async () => {
    const member = await newMember(1_000);
    const stranger = await newMember(1_000);
    const qr = await newOrder(member, "member_qr");
    const pwa = await newOrder(member, "pwa_session");
    await newOrder(member, "phone_lookup");
    await settledBillOf(member);
    const voided = await newOrder(member, "member_qr");
    const voidResponse = await voidNow(voided);
    expect(voidResponse.status, JSON.stringify(voidResponse.body)).toBe(200);
    const strangerBill = await newOrder(stranger, "member_qr");
    // A bill of another tenant that even names this member's profile id.
    await seedOrder(other.tenant.tenantId, {
      outletId: other.tenant.outletId,
      profileId: other.member.id,
      status: "draft",
    });

    const bills = await listedBills(member);
    expect(bills.map((bill) => bill.orderId).sort()).toEqual(
      [qr.id, pwa.id].sort(),
    );
    expect(bills.find((bill) => bill.orderId === pwa.id)?.attachedVia).toBe(
      "pwa_session",
    );
    // The stranger still sees only theirs.
    const theirs = await listedBills(stranger);
    expect(theirs.map((bill) => bill.orderId)).toEqual([strangerBill.id]);
  });

  it("1203-04 after a points redeem the bill shows what was redeemed and the lower remainder", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const token = await mintOk(member, order.id, 100);
    const done = await cashierRedeem(order, 100, { token });
    expect(redeemed(done.status), JSON.stringify(done.body)).toBe(true);

    const [bill] = await listedBills(member);
    expect(bill).toMatchObject({
      orderId: order.id,
      totalIdr: ORDER_TOTAL_IDR,
      remainingIdr: ORDER_TOTAL_IDR - 100 * POINT_VALUE_IDR,
    });
    expect(bill!.pointsRedeemed).toMatchObject({
      points: 100,
      discountIdr: 100 * POINT_VALUE_IDR,
    });
  });

  it("1203-05 a bill of another PT than the member's loyalty program is not listed; with the program in the outlet's PT it is", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    await withTwoEntities("other", async () => {
      expect(await listedBills(member)).toEqual([]);
    });
    await withTwoEntities("pos", async () => {
      const bills = await listedBills(member);
      expect(bills.map((bill) => bill.orderId)).toEqual([order.id]);
    });
  });

  it("1203-06 without a session the list is 401 (control: with a session 200)", async () => {
    const member = await newMember(0);
    expect((await getOpenBills(member.client)).status).toBe(200);
    const anonymous = await getOpenBills(agent(app));
    expect(anonymous.status).toBe(401);
  });
});

// ================================================================================
// GET /api/member/open-bills/:orderId/points-quote
// ================================================================================

describe("1203 GET points-quote", () => {
  it("1203-10 quote on a full bill with plenty of points: max is floor(remainder / point value)", async () => {
    const member = await newMember(5_000);
    const order = await newOrder(member);
    const quote = await quoteOk(member, order.id);
    expect(quote).toMatchObject({
      orderId: order.id,
      balancePoints: 5_000,
      pointValueIdr: POINT_VALUE_IDR,
      remainingIdr: ORDER_TOTAL_IDR,
      maxPoints: MAX_POINTS_FULL_BILL,
      refusal: null,
    });
    expect(quote.minPoints).toBeGreaterThanOrEqual(1);
    expect(quote.maxPoints * POINT_VALUE_IDR).toBeLessThanOrEqual(
      ORDER_TOTAL_IDR,
    );
  });

  it("1203-11 a balance below the bill's worth caps the max at the balance", async () => {
    const member = await newMember(300);
    const order = await newOrder(member);
    const quote = await quoteOk(member, order.id);
    expect(quote).toMatchObject({
      balancePoints: 300,
      maxPoints: 300,
      refusal: null,
    });
  });

  it("1203-12 the quote follows the remainder: after cash on the bill the max shrinks and never exceeds what is still owed", async () => {
    const member = await newMember(5_000);
    const order = await newOrder(member);
    await seedCashTender(order, 30_000);
    const quote = await quoteOk(member, order.id);
    expect(quote.remainingIdr).toBe(25_000);
    expect(quote.maxPoints).toBe(Math.floor(25_000 / POINT_VALUE_IDR));
    expect(quote.maxPoints * POINT_VALUE_IDR).toBeLessThanOrEqual(25_000);
  });

  it("1203-13 program switched off: 200 with refusal program_inactive and max 0, and mint is refused", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    expect((await quoteOk(member, order.id)).refusal).toBeNull();
    await seedProgram(world.tenant.tenantId, {
      pointValueIdr: POINT_VALUE_IDR,
      isActive: false,
    });
    try {
      const quote = await quoteOk(member, order.id);
      expect(quote).toMatchObject({
        refusal: "program_inactive",
        maxPoints: 0,
      });
      expectRefused(await postMint(member.client, order.id, 1));
    } finally {
      await seedProgram(world.tenant.tenantId, {
        pointValueIdr: POINT_VALUE_IDR,
      });
    }
  });

  it("1203-14 suspended membership: 200 with refusal membership_inactive and max 0", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    expect((await quoteOk(member, order.id)).refusal).toBeNull();
    await asTenant(world.tenant.tenantId, (client) =>
      client.query(
        "UPDATE customer_profiles SET membership_status = 'suspended' WHERE tenant_id = $1 AND id = $2",
        [world.tenant.tenantId, member.profile.id],
      ),
    );
    try {
      const quote = await quoteOk(member, order.id);
      expect(quote).toMatchObject({
        refusal: "membership_inactive",
        maxPoints: 0,
      });
    } finally {
      await asTenant(world.tenant.tenantId, (client) =>
        client.query(
          "UPDATE customer_profiles SET membership_status = 'active' WHERE tenant_id = $1 AND id = $2",
          [world.tenant.tenantId, member.profile.id],
        ),
      );
    }
  });

  it("1203-15 a bill already settled: 200 with refusal bill_settled and max 0", async () => {
    const member = await newMember(1_000);
    const open = await newOrder(member);
    expect((await quoteOk(member, open.id)).refusal).toBeNull();
    const settled = await settledBillOf(member);
    const quote = await quoteOk(member, settled);
    expect(quote).toMatchObject({ refusal: "bill_settled", maxPoints: 0 });
  });

  it("1203-16 a bill attached by phone lookup is not eligible: hidden or refused with max 0", async () => {
    const member = await newMember(1_000);
    const eligible = await newOrder(member, "member_qr");
    expect((await quoteOk(member, eligible.id)).maxPoints).toBeGreaterThan(0);
    const phone = await newOrder(member, "phone_lookup");
    await expectQuoteUnusable(member, phone.id);
  });

  it("1203-17 a member cannot quote another member's bill, another tenant's bill, an unknown or a malformed id", async () => {
    const member = await newMember(1_000);
    const stranger = await newMember(2_000);
    const own = await newOrder(member);
    const theirs = await newOrder(stranger);
    const foreign = await seedOrder(other.tenant.tenantId, {
      outletId: other.tenant.outletId,
      profileId: other.member.id,
      status: "draft",
    });
    // Control: the own bill quotes.
    expect((await quoteOk(member, own.id)).balancePoints).toBe(1_000);
    for (const orderId of [
      theirs.id,
      foreign,
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "not-an-order",
    ]) {
      const response = await getQuote(member.client, orderId);
      expectRefused(response);
    }
  });

  it("1203-18 without a session the quote is 401 (control: with a session 200)", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    expect((await getQuote(member.client, order.id)).status).toBe(200);
    expect((await getQuote(agent(app), order.id)).status).toBe(401);
  });
});

// ================================================================================
// POST /api/member/points-redeem/status
// ================================================================================

describe("1203 POST points-redeem/status", () => {
  it("1203-20 a minted token not yet used is pending, with its points and value, and nothing is spent", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const token = await mintOk(member, order.id, 100);
    const status = await statusOk(member, order.id, token);
    expect(status).toMatchObject({
      orderId: order.id,
      state: "pending",
      points: 100,
      discountIdr: 100 * POINT_VALUE_IDR,
      remainingIdr: ORDER_TOTAL_IDR,
      balancePoints: 1_000,
    });
    expect(await balanceNow(member)).toBe(1_000);
  });

  it("1203-21 after the cashier scans the QR the state is consumed, with the new remainder and balance", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const token = await mintOk(member, order.id, 100);
    expect((await statusOk(member, order.id, token)).state).toBe("pending");
    const done = await cashierRedeem(order, 100, { token });
    expect(redeemed(done.status), JSON.stringify(done.body)).toBe(true);
    expect(await statusOk(member, order.id, token)).toMatchObject({
      orderId: order.id,
      state: "consumed",
      points: 100,
      discountIdr: 7_000,
      remainingIdr: ORDER_TOTAL_IDR - 7_000,
      balancePoints: 900,
    });
  });

  it("1203-22 a pwa_session bill the cashier redeemed without QR shows as consumed on the member's side", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member, "pwa_session");
    const token = await mintOk(member, order.id, 100);
    expect((await statusOk(member, order.id, token)).state).toBe("pending");
    const done = await cashierRedeem(order, 100);
    expect(redeemed(done.status), JSON.stringify(done.body)).toBe(true);
    expect(await statusOk(member, order.id, token)).toMatchObject({
      state: "consumed",
      points: 100,
      discountIdr: 7_000,
      balancePoints: 900,
    });
  });

  it("1203-23 a token older than its 120 s life is expired, and nothing is spent", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const live = await mintOk(member, order.id, 100);
    expect((await statusOk(member, order.id, live)).state).toBe("pending");
    const old = localToken(
      member,
      order.id,
      100,
      new Date(Date.now() - 200_000),
    );
    const status = await statusOk(member, order.id, old);
    expect(status.state).toBe("expired");
    expect(status.balancePoints).toBe(1_000);
    expect(status.remainingIdr).toBe(ORDER_TOTAL_IDR);
    expect(await balanceNow(member)).toBe(1_000);
  });

  it("1203-24 a tampered token, a token of another order, another member's token and garbage are invalid with no points or value", async () => {
    const member = await newMember(1_000);
    const stranger = await newMember(1_000);
    const order = await newOrder(member);
    const otherOrder = await newOrder(member);
    const good = await mintOk(member, order.id, 100);
    expect((await statusOk(member, order.id, good)).state).toBe("pending");

    const tampered = `${good.slice(0, -2)}${good.endsWith("AA") ? "BB" : "AA"}`;
    const wrongOrder = localToken(member, otherOrder.id, 100);
    const wrongMember = localToken(stranger, order.id, 100);
    for (const token of [tampered, wrongOrder, wrongMember, "not-a-token"]) {
      const status = await statusOk(member, order.id, token);
      expect(status.state, token).toBe("invalid");
      expect(status.points).toBeNull();
      expect(status.discountIdr).toBeNull();
    }
    expect(await balanceNow(member)).toBe(1_000);
  });

  it("1203-25 another member cannot read the state of someone else's bill, even with the real token", async () => {
    const member = await newMember(1_000);
    const stranger = await newMember(777);
    const order = await newOrder(member);
    const token = await mintOk(member, order.id, 100);
    // Control: the owner reads it.
    expect((await statusOk(member, order.id, token)).state).toBe("pending");

    const response = await postStatus(stranger.client, {
      orderId: order.id,
      token,
    });
    if (response.status === 200) {
      const status = memberPointsRedeemStatusSchema.parse(response.body.data);
      expect(status.state).toBe("invalid");
      expect(status.points).toBeNull();
      expect(status.discountIdr).toBeNull();
      expect(status.remainingIdr).not.toBe(ORDER_TOTAL_IDR);
      expect(status.balancePoints).not.toBe(1_000);
    } else {
      expectRefused(response);
    }
  });

  it("1203-26 a bill of another tenant is not readable: refused or invalid, never its figures", async () => {
    const member = await newMember(1_000);
    const own = await newOrder(member);
    expect(
      (await statusOk(member, own.id, await mintOk(member, own.id, 50))).state,
    ).toBe("pending");
    const foreign = await seedOrder(other.tenant.tenantId, {
      outletId: other.tenant.outletId,
      profileId: other.member.id,
      status: "draft",
    });
    const response = await postStatus(member.client, {
      orderId: foreign,
      token: localToken(member, foreign, 10),
    });
    if (response.status === 200) {
      const status = memberPointsRedeemStatusSchema.parse(response.body.data);
      expect(status.state).toBe("invalid");
      expect(status.points).toBeNull();
      expect(status.balancePoints).not.toBe(5_000);
    } else {
      expectRefused(response);
    }
  });

  it("1203-27 input and access checks: no session 401, foreign origin refused, extra or missing fields 422 (control: valid call 200)", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const token = await mintOk(member, order.id, 100);
    const body = { orderId: order.id, token };
    expect((await postStatus(member.client, body)).status).toBe(200);

    expect((await postStatus(agent(app), body)).status).toBe(401);
    const foreignOrigin = await postStatus(member.client, body, {
      Origin: "https://evil.example",
    });
    expectRefused(foreignOrigin);
    for (const bad of [
      { orderId: order.id },
      { token },
      { orderId: order.id, token, extra: true },
      { orderId: "", token },
    ]) {
      expect((await postStatus(member.client, bad)).status).toBe(422);
    }
  });
});

// ================================================================================
// POST /api/member/qr-token: new checks on mint (M1, M5, M6)
// ================================================================================

describe("1203 mint checks (POST /api/member/qr-token with orderId and points)", () => {
  it("1203-30 points up to the quote's max mint; one point more is refused (value never above the bill)", async () => {
    const member = await newMember(5_000);
    const order = await newOrder(member);
    const quote = await quoteOk(member, order.id);
    expect(quote.maxPoints).toBe(MAX_POINTS_FULL_BILL);

    expectRefused(await postMint(member.client, order.id, quote.maxPoints + 1));
    expectRefused(await postMint(member.client, order.id, 4_000));
    // Nothing was spent by the refusals, and exactly the max still mints.
    expect(await balanceNow(member)).toBe(5_000);
    await mintOk(member, order.id, quote.maxPoints);
  });

  it("1203-31 points above the balance are refused; the balance itself mints", async () => {
    const member = await newMember(50);
    const order = await newOrder(member);
    expectRefused(await postMint(member.client, order.id, 51));
    await mintOk(member, order.id, 50);
  });

  it("1203-32 the cap follows what is still owed: after a redeem and cash, points beyond the new remainder are refused", async () => {
    const member = await newMember(5_000);
    const order = await newOrder(member);
    const first = await mintOk(member, order.id, 100);
    const done = await cashierRedeem(order, 100, { token: first });
    expect(redeemed(done.status), JSON.stringify(done.body)).toBe(true);
    await seedCashTender(order, 20_000);
    // Owed now: 55.000 - 7.000 - 20.000 = 28.000 -> 400 points.
    const quote = await quoteOk(member, order.id);
    expect(quote.remainingIdr).toBe(28_000);
    expect(quote.maxPoints).toBe(400);
    expectRefused(await postMint(member.client, order.id, 401));
    await mintOk(member, order.id, 400);
  });

  it("1203-33 mint refuses another member's bill (control: the owner mints for the same bill)", async () => {
    const owner1 = await newMember(1_000);
    const stranger = await newMember(1_000);
    const order = await newOrder(owner1);
    expectRefused(await postMint(stranger.client, order.id, 10));
    await mintOk(owner1, order.id, 10);
  });

  it("1203-34 mint refuses a bill of another tenant, an unknown bill and a malformed id", async () => {
    const member = await newMember(1_000);
    const own = await newOrder(member);
    const foreign = await seedOrder(other.tenant.tenantId, {
      outletId: other.tenant.outletId,
      profileId: other.member.id,
      status: "draft",
    });
    for (const orderId of [
      foreign,
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      randomUUID(),
      "not-an-order",
    ]) {
      expectRefused(await postMint(member.client, orderId, 10));
    }
    await mintOk(member, own.id, 10);
  });

  it("1203-35 mint refuses a bill already settled and a bill that was voided", async () => {
    const member = await newMember(1_000);
    const open = await newOrder(member);
    const settled = await settledBillOf(member);
    const voided = await newOrder(member);
    const voidResponse = await voidNow(voided);
    expect(voidResponse.status, JSON.stringify(voidResponse.body)).toBe(200);

    expectRefused(await postMint(member.client, settled, 10));
    expectRefused(await postMint(member.client, voided.id, 10));
    await mintOk(member, open.id, 10);
  });

  it("1203-36 mint refuses a bill whose PT differs from the loyalty program's PT; with the same PT it mints", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    await withTwoEntities("other", async () => {
      expectRefused(await postMint(member.client, order.id, 10));
      await expectQuoteUnusable(member, order.id);
    });
    await withTwoEntities("pos", async () => {
      await mintOk(member, order.id, 10);
    });
  });

  it("1203-37 mint without a session is 401 (control: with a session 200)", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const anonymous = await postMint(agent(app), order.id, 10);
    expect(anonymous.status).toBe(401);
    await mintOk(member, order.id, 10);
  });
});

// ================================================================================
// M2: idempotent / single-use redeem, reported to the member
// ================================================================================

describe("1203 redeem is idempotent and single use", () => {
  it("1203-40 a retry with the same key and token is one debit; the member sees consumed once", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const token = await mintOk(member, order.id, 100);
    const key = randomUUID();
    const first = await cashierRedeem(order, 100, { token, key });
    const replay = await cashierRedeem(order, 100, { token, key });
    expect(redeemed(first.status), JSON.stringify(first.body)).toBe(true);
    expect(redeemed(replay.status), JSON.stringify(replay.body)).toBe(true);

    expect(await balanceNow(member)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
    expect(await pointsTenders(order)).toEqual([
      { points_used: 100, status: "captured" },
    ]);
    expect(await statusOk(member, order.id, token)).toMatchObject({
      state: "consumed",
      balancePoints: 900,
      remainingIdr: ORDER_TOTAL_IDR - 7_000,
    });
  });

  it("1203-41 the same token under a new key is refused: still one debit, still consumed", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const token = await mintOk(member, order.id, 100);
    const first = await cashierRedeem(order, 100, { token });
    expect(redeemed(first.status), JSON.stringify(first.body)).toBe(true);

    const second = await cashierRedeem(order, 100, { token });
    expect(second.status, JSON.stringify(second.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(second.status).toBeLessThan(500);
    expect(await balanceNow(member)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
    expect((await statusOk(member, order.id, token)).state).toBe("consumed");
  });

  it("1203-42 two cashiers scanning the same QR at once: one debit, one points tender", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const token = await mintOk(member, order.id, 100);
    const results = await Promise.all([
      cashierRedeem(order, 100, { token }),
      cashierRedeem(order, 100, { token }),
    ]);
    for (const result of results) expect(result.status).toBeLessThan(500);
    expect(
      results.filter((result) => redeemed(result.status)),
      JSON.stringify(results.map((result) => result.body)),
    ).toHaveLength(1);
    expect(await balanceNow(member)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
    expect(await pointsTenders(order)).toHaveLength(1);
    expect((await statusOk(member, order.id, token)).state).toBe("consumed");
  });
});

// ================================================================================
// M3: a stale quote is refused, never silently adjusted
// ================================================================================

describe("1203 a stale quote is refused, never adjusted", () => {
  it("1203-50 balance fell after mint: the redeem is refused whole, nothing is spent, the status is not consumed", async () => {
    const member = await newMember(1_000);
    const billA = await newOrder(member);
    const billB = await newOrder(member);
    const tokenA = await mintOk(member, billA.id, 500);
    const tokenB = await mintOk(member, billB.id, 700);
    // Bill B is redeemed first: 1.000 - 700 = 300 left, less than token A's 500.
    const paidB = await cashierRedeem(billB, 700, { token: tokenB });
    expect(redeemed(paidB.status), JSON.stringify(paidB.body)).toBe(true);
    expect(await balanceNow(member)).toBe(300);
    expect((await statusOk(member, billB.id, tokenB)).state).toBe("consumed");

    const refused = await cashierRedeem(billA, 500, { token: tokenA });
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(refused.status).toBeLessThan(500);
    // Not adjusted down to the 300 left, and no tender on the bill.
    expect(await balanceNow(member)).toBe(300);
    expect(await pointsTenders(billA)).toEqual([]);
    const status = await statusOk(member, billA.id, tokenA);
    expect(status.state).not.toBe("consumed");
    expect(status.balancePoints).toBe(300);
    expect(status.remainingIdr).toBe(ORDER_TOTAL_IDR);
  });

  it("1203-51 an expired token is refused at the till and the member sees expired; a fresh token for the same bill works", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const old = localToken(
      member,
      order.id,
      100,
      new Date(Date.now() - 200_000),
    );
    const refused = await cashierRedeem(order, 100, { token: old });
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(refused.status).toBeLessThan(500);
    expect(await balanceNow(member)).toBe(1_000);
    expect((await statusOk(member, order.id, old)).state).toBe("expired");

    const fresh = await mintOk(member, order.id, 100);
    const done = await cashierRedeem(order, 100, { token: fresh });
    expect(redeemed(done.status), JSON.stringify(done.body)).toBe(true);
    expect(await balanceNow(member)).toBe(900);
  });

  it("1203-52 cash taken after mint left less owed than the token's value: the redeem is refused whole, not shrunk to fit", async () => {
    const member = await newMember(5_000);
    const order = await newOrder(member);
    // 500 points = Rp35.000 fits the Rp55.000 bill when minted.
    const token = await mintOk(member, order.id, 500);
    await seedCashTender(order, 30_000);
    // Now Rp25.000 is owed (max 357 points): 500 points would pay Rp10.000 too much.
    const quote = await quoteOk(member, order.id);
    expect(quote.maxPoints).toBe(357);

    const refused = await cashierRedeem(order, 500, { token });
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(refused.status).toBeLessThan(500);
    expect(await balanceNow(member)).toBe(5_000);
    expect(await pointsTenders(order)).toEqual([]);
    expect(await redeemRows(member)).toHaveLength(0);
    const status = await statusOk(member, order.id, token);
    expect(status.state).not.toBe("consumed");
    expect(status.balancePoints).toBe(5_000);
  });
});

// ================================================================================
// M4: void after redeem gives the points back exactly once
// ================================================================================

describe("1203 void after redeem", () => {
  it("1203-60 voiding the bill twice restores the points once; the member sees the balance back and the bill gone", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const token = await mintOk(member, order.id, 100);
    const done = await cashierRedeem(order, 100, { token });
    expect(redeemed(done.status), JSON.stringify(done.body)).toBe(true);
    expect((await statusOk(member, order.id, token)).balancePoints).toBe(900);
    expect(await listedBills(member)).toHaveLength(1);

    const first = await voidNow(order);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await voidNow(order);
    // Refused or an idempotent answer, never a server error, never a second give-back.
    expect(second.status).toBeLessThan(500);

    expect(await balanceNow(member)).toBe(1_000);
    expect(await restoreRows(member)).toHaveLength(1);
    expect((await pointsTenders(order)).map((row) => row.status)).toEqual([
      "voided",
    ]);
    // What the member's screen reads agrees with the books.
    const status = await statusOk(member, order.id, token);
    expect(status.balancePoints).toBe(1_000);
    expect(await listedBills(member)).toEqual([]);
    await expectQuoteUnusable(member, order.id);
  });

  it("1203-61 a voided bill cannot be redeemed again with the old token, and the balance stays whole", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const token = await mintOk(member, order.id, 100);
    expect(redeemed((await cashierRedeem(order, 100, { token })).status)).toBe(
      true,
    );
    const voided = await voidNow(order);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await balanceNow(member)).toBe(1_000);

    const again = await cashierRedeem(order, 100, { token });
    expect(again.status, JSON.stringify(again.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(again.status).toBeLessThan(500);
    expect(await balanceNow(member)).toBe(1_000);
    expect((await statusOk(member, order.id, token)).balancePoints).toBe(1_000);
  });
});

// ================================================================================
// Second round (20 Nov): one live token per bill, outlet_offline, balance bound
// to the token, void / refund give-back, pwa_session retry, money invariant
// ================================================================================

/** The cashier refuses (4xx), never a crash and never a success. */
function expectTillRefused(response: { status: number; body: unknown }) {
  const text = JSON.stringify(response.body);
  expect(response.status, text).toBeGreaterThanOrEqual(400);
  expect(response.status, text).toBeLessThan(500);
}

describe("1203 one live token per bill", () => {
  it("1203-70 a second token for a bill that already has a live one is refused at mint; the first stays pending; another bill still mints", async () => {
    const member = await newMember(5_000);
    const billA = await newOrder(member);
    const billB = await newOrder(member);
    const first = await mintOk(member, billA.id, 100);

    expectRefused(await postMint(member.client, billA.id, 50));
    expectRefused(await postMint(member.client, billA.id, 100));

    // The refusals took nothing, and the first token is untouched and usable.
    expect(await balanceNow(member)).toBe(5_000);
    expect((await statusOk(member, billA.id, first)).state).toBe("pending");
    // The rule is per bill, not per member: a second bill mints (control).
    await mintOk(member, billB.id, 100);
    const done = await cashierRedeem(billA, 100, { token: first });
    expect(redeemed(done.status), JSON.stringify(done.body)).toBe(true);
    expect(await balanceNow(member)).toBe(4_900);
  });
});

describe("1203 outlet_offline refusal", () => {
  it("1203-71 an outlet whose edge node has an open edge_offline alert quotes outlet_offline with max 0 and refuses mint; when the alert resolves the quote is normal again", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);

    const nodeId = randomUUID();
    const alertId = randomUUID();
    const tenantId = world.tenant.tenantId;
    await asTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, label, credential_hash, last_heartbeat_at)
         VALUES ($1, $2, $3, 'primary', 'Mini PC 1203', $4, now() - interval '2 hours')`,
        [nodeId, tenantId, world.tenant.outletId, hex64()],
      );
      await client.query(
        `INSERT INTO edge_node_alerts (id, tenant_id, outlet_id, edge_node_id, kind, raised_at, last_seen_at)
         VALUES ($1, $2, $3, $4, 'edge_offline', now() - interval '90 minutes', now() - interval '2 hours')`,
        [alertId, tenantId, world.tenant.outletId, nodeId],
      );
    });
    try {
      // The fixture is in place (checked before any HTTP call).
      const open = await asTenant(tenantId, (client) =>
        client.query(
          "SELECT 1 FROM edge_node_alerts WHERE tenant_id = $1 AND id = $2 AND resolved_at IS NULL",
          [tenantId, alertId],
        ),
      );
      expect(open.rowCount).toBe(1);
      const quote = await quoteOk(member, order.id);
      expect(quote).toMatchObject({
        refusal: "outlet_offline",
        maxPoints: 0,
      });
      expectRefused(await postMint(member.client, order.id, 10));
      expect(await balanceNow(member)).toBe(1_000);

      await asTenant(tenantId, (client) =>
        client.query(
          "UPDATE edge_node_alerts SET resolved_at = now() WHERE tenant_id = $1 AND id = $2",
          [tenantId, alertId],
        ),
      );
      const back = await quoteOk(member, order.id);
      expect(back.refusal).toBeNull();
      expect(back.maxPoints).toBeGreaterThan(0);
      await mintOk(member, order.id, 10);
    } finally {
      // Edge nodes are revoked, never deleted (DB rule); alerts are resolved.
      await asTenant(tenantId, async (client) => {
        await client.query(
          "UPDATE edge_node_alerts SET resolved_at = COALESCE(resolved_at, now()) WHERE tenant_id = $1 AND id = $2",
          [tenantId, alertId],
        );
        await client.query(
          "UPDATE edge_nodes SET status = 'revoked', revoked_at = now() WHERE tenant_id = $1 AND id = $2",
          [tenantId, nodeId],
        );
      });
    }
  });
});

describe("1203 the token binds the balance at mint (CTO decision): a changed balance is refused, never adjusted", () => {
  it("1203-72 the balance rose after mint (still enough for the token): the redeem is refused whole; a token minted after the change works", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const stale = await mintOk(member, order.id, 100);
    expect((await statusOk(member, order.id, stale)).state).toBe("pending");

    await grantPoints(world.tenant.tenantId, member.profile.id, 500);
    expect(await balanceNow(member)).toBe(1_500);

    const refused = await cashierRedeem(order, 100, { token: stale });
    expectTillRefused(refused);
    expect(await balanceNow(member)).toBe(1_500);
    expect(await pointsTenders(order)).toEqual([]);
    expect(await redeemRows(member)).toHaveLength(0);
    const status = await statusOk(member, order.id, stale);
    expect(status.state).not.toBe("consumed");
    expect(status.remainingIdr).toBe(ORDER_TOTAL_IDR);

    // Control: a token minted at the new balance (on a second bill) redeems.
    const other2 = await newOrder(member);
    const fresh = await mintOk(member, other2.id, 100);
    const done = await cashierRedeem(other2, 100, { token: fresh });
    expect(redeemed(done.status), JSON.stringify(done.body)).toBe(true);
    expect(await balanceNow(member)).toBe(1_400);
  });

  it("1203-73 the balance fell after mint but still covers the token (another bill was redeemed): the redeem is refused whole, not adjusted", async () => {
    const member = await newMember(1_000);
    const billA = await newOrder(member);
    const billB = await newOrder(member);
    const tokenA = await mintOk(member, billA.id, 500);
    const tokenB = await mintOk(member, billB.id, 300);
    const paidB = await cashierRedeem(billB, 300, { token: tokenB });
    expect(redeemed(paidB.status), JSON.stringify(paidB.body)).toBe(true);
    // 700 left: more than token A's 500, yet the balance is no longer the one it was minted at.
    expect(await balanceNow(member)).toBe(700);

    const refused = await cashierRedeem(billA, 500, { token: tokenA });
    expectTillRefused(refused);
    expect(await balanceNow(member)).toBe(700);
    expect(await pointsTenders(billA)).toEqual([]);
    expect(await redeemRows(member)).toHaveLength(1);
    const status = await statusOk(member, billA.id, tokenA);
    expect(status.state).not.toBe("consumed");
    expect(status.balancePoints).toBe(700);
    expect(status.remainingIdr).toBe(ORDER_TOTAL_IDR);
  });
});

describe("1203 give-back on void and refund (exactly once)", () => {
  async function seedVoidedCashTender(order: CreatedOrder, amountIdr: number) {
    await asTenant(world.tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO pos_order_tenders
           (tenant_id, outlet_id, order_id, method, provider, amount_idr,
            received_idr, change_idr, points_used, payment_intent_id, reference, status,
            requested_at, resolved_at)
         VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, NULL, NULL, NULL, 'voided', now(), now())`,
        [
          world.tenant.tenantId,
          order.outletId,
          ulidToUuid(order.id),
          amountIdr,
        ],
      ),
    );
  }

  it("1203-75 a bill with a points tender and a cash tender that never captured (voided): void gives the points back exactly once, twice too", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    await seedVoidedCashTender(order, 20_000);
    const token = await mintOk(member, order.id, 100);
    const done = await cashierRedeem(order, 100, { token });
    expect(redeemed(done.status), JSON.stringify(done.body)).toBe(true);
    expect(await balanceNow(member)).toBe(900);

    const first = await voidNow(order);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await voidNow(order);
    expect(second.status).toBeLessThan(500);

    expect(await balanceNow(member)).toBe(1_000);
    expect(await restoreRows(member)).toHaveLength(1);
    expect((await pointsTenders(order)).map((row) => row.status)).toEqual([
      "voided",
    ]);
    expect(await listedBills(member)).toEqual([]);
  });

  it("1203-76 guard: a bill with points and captured cash: void is refused with nothing changed, or gives the points back exactly once (never lost, never twice)", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    await seedCashTender(order, 20_000);
    const token = await mintOk(member, order.id, 100);
    const done = await cashierRedeem(order, 100, { token });
    expect(redeemed(done.status), JSON.stringify(done.body)).toBe(true);
    expect(await balanceNow(member)).toBe(900);

    const first = await voidNow(order);
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(500);
    const second = await voidNow(order);
    expect(second.status).toBeLessThan(500);

    const restores = await restoreRows(member);
    expect(restores.length).toBeLessThanOrEqual(1);
    expect(await balanceNow(member)).toBe(900 + 100 * restores.length);
    const tenderStates = (await pointsTenders(order)).map((row) => row.status);
    expect(tenderStates).toEqual([
      restores.length === 1 ? "voided" : "captured",
    ]);
    // A restore only ever goes with a bill that really left the till.
    if (restores.length === 1) expect(first.status).toBe(200);
  });

  it("1203-77 guard: refund of a paid bill that took points and cash never returns the points twice, and the balance always matches the ledger", async () => {
    const member = await newMember(5_000);
    const order = await newOrder(member);
    // Rp50 cash first so that 785 points (Rp54.950) settle the rest exactly.
    await seedCashTender(
      order,
      ORDER_TOTAL_IDR - MAX_POINTS_FULL_BILL * POINT_VALUE_IDR,
    );
    const token = await mintOk(member, order.id, MAX_POINTS_FULL_BILL);
    const paid = await cashierRedeem(order, MAX_POINTS_FULL_BILL, { token });
    expect(redeemed(paid.status), JSON.stringify(paid.body)).toBe(true);
    const expectedStatus = await posStatusOf(order);
    const completed = await world.cashier.client
      .post(
        `/api/outlets/${encodeURIComponent(order.outletId)}/pos/orders/${order.id}/complete`,
      )
      .set(world.headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken())
      .send({ idempotencyKey: randomUUID(), expectedStatus });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    const afterSale = 5_000 - MAX_POINTS_FULL_BILL;
    expect(await balanceNow(member)).toBe(afterSale);

    const { override } = await createPosOverride(
      tenantContext(world.tenant.tenantId),
      world.cashier.userId,
      {
        outletId: order.outletId,
        action: "refund",
        valueIdr: 10_000,
        reason: "Pelanggan salah pesan",
        objectType: "order",
        objectId: order.id,
        approval: {
          method: "supervisor_pin",
          approverUserId: userIdSchema.parse(world.supervisor.userId),
          pin: PIN,
        },
      } as Parameters<typeof createPosOverride>[2],
      { idempotencyKey: randomUUID() },
    );
    expect(override.status).toBe("approved");
    const refundBody = {
      idempotencyKey: randomUUID(),
      amountIdr: 10_000,
      reason: "customer_cancelled",
      reasonNote: "Pelanggan salah pesan",
      approvedBy: world.supervisor.userId,
      overrideId: override.id,
    };
    const send = () =>
      world.cashier.client
        .post(
          `/api/outlets/${encodeURIComponent(order.outletId)}/pos/orders/${order.id}/corrections/refund`,
        )
        .set(world.headers)
        .set(originHeader)
        .set(DEVICE_TOKEN_HEADER, deviceToken())
        .send(refundBody);
    const first = await send();
    expect(first.status).toBeLessThan(500);
    const replay = await send();
    expect(replay.status).toBeLessThan(500);

    const restores = await restoreRows(member);
    expect(restores.length).toBeLessThanOrEqual(1);
    expect(await balanceNow(member)).toBe(
      afterSale + MAX_POINTS_FULL_BILL * restores.length,
    );
    expect(await redeemRows(member)).toHaveLength(1);
  });
});

describe("1203 pwa_session bill redeemed by the cashier without QR: a retry never deducts twice", () => {
  it("1203-78 the same idempotency key sent again is one debit; the member sees the bill redeemed once and the status consumed", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member, "pwa_session");
    const token = await mintOk(member, order.id, 100);
    const key = randomUUID();
    const first = await cashierRedeem(order, 100, { key });
    const retry = await cashierRedeem(order, 100, { key });
    expect(redeemed(first.status), JSON.stringify(first.body)).toBe(true);
    expect(retry.status, JSON.stringify(retry.body)).toBeLessThan(500);

    expect(await balanceNow(member)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
    expect(await pointsTenders(order)).toEqual([
      { points_used: 100, status: "captured" },
    ]);
    const [bill] = await listedBills(member);
    expect(bill!.pointsRedeemed).toMatchObject({
      points: 100,
      discountIdr: 7_000,
    });
    expect(bill!.remainingIdr).toBe(ORDER_TOTAL_IDR - 7_000);
    expect(await statusOk(member, order.id, token)).toMatchObject({
      state: "consumed",
      points: 100,
      balancePoints: 900,
    });
  });

  it("1203-79 the same key sent twice at once, and the same key with other points, still make one debit", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member, "pwa_session");
    const key = randomUUID();
    const both = await Promise.all([
      cashierRedeem(order, 100, { key }),
      cashierRedeem(order, 100, { key }),
    ]);
    for (const result of both) expect(result.status).toBeLessThan(500);
    expect(
      both.some((result) => redeemed(result.status)),
      JSON.stringify(both.map((result) => result.body)),
    ).toBe(true);
    const changed = await cashierRedeem(order, 200, { key });
    expect(changed.status).toBeLessThan(500);

    expect(await balanceNow(member)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
    expect(await pointsTenders(order)).toEqual([
      { points_used: 100, status: "captured" },
    ]);
    const [bill] = await listedBills(member);
    expect(bill!.pointsRedeemed).toMatchObject({ points: 100 });
  });
});

describe("1203 money invariant: points never pay more than the bill, the balance never goes below zero", () => {
  it("1203-80 a redeem worth more than the bill is refused; after the biggest allowed one nothing more can be minted or redeemed", async () => {
    const member = await newMember(5_000);
    const tooMuch = await newOrder(member, "pwa_session");
    // 786 points = Rp55.020 > Rp55.000.
    expectTillRefused(await cashierRedeem(tooMuch, MAX_POINTS_FULL_BILL + 1));
    expect(await balanceNow(member)).toBe(5_000);
    expect(await pointsTenders(tooMuch)).toEqual([]);

    const order = await newOrder(member, "pwa_session");
    const done = await cashierRedeem(order, MAX_POINTS_FULL_BILL);
    expect(redeemed(done.status), JSON.stringify(done.body)).toBe(true);
    const value = MAX_POINTS_FULL_BILL * POINT_VALUE_IDR;
    expect(value).toBeLessThanOrEqual(ORDER_TOTAL_IDR);
    expect(await balanceNow(member)).toBe(5_000 - MAX_POINTS_FULL_BILL);

    // Rp50 is still owed: not worth one whole point (Rp70).
    const quote = await quoteOk(member, order.id);
    expect(quote.remainingIdr).toBe(ORDER_TOTAL_IDR - value);
    expect(quote.maxPoints).toBe(0);
    expectRefused(await postMint(member.client, order.id, 1));
    expectTillRefused(await cashierRedeem(order, 1));
    expect(await balanceNow(member)).toBe(5_000 - MAX_POINTS_FULL_BILL);
    expect(await redeemRows(member)).toHaveLength(1);
  });

  it("1203-81 two cashiers redeeming big amounts on one bill at once: the points value taken never exceeds the bill", async () => {
    const member = await newMember(5_000);
    const order = await newOrder(member, "pwa_session");
    // 500 points = Rp35.000 each: both would be Rp70.000 on a Rp55.000 bill.
    const results = await Promise.all([
      cashierRedeem(order, 500),
      cashierRedeem(order, 500),
    ]);
    for (const result of results) expect(result.status).toBeLessThan(500);
    expect(
      results.filter((result) => redeemed(result.status)),
      JSON.stringify(results.map((result) => result.body)),
    ).toHaveLength(1);
    expect(await balanceNow(member)).toBe(4_500);
    expect(await pointsTenders(order)).toEqual([
      { points_used: 500, status: "captured" },
    ]);
    const [bill] = await listedBills(member);
    expect(bill!.remainingIdr).toBe(ORDER_TOTAL_IDR - 500 * POINT_VALUE_IDR);
    expect(bill!.remainingIdr).toBeGreaterThanOrEqual(0);
  });

  it("1203-82 two bills redeemed at once with a balance that covers only one: one succeeds, the balance is 20 and never negative", async () => {
    const member = await newMember(100);
    const billA = await newOrder(member, "pwa_session");
    const billB = await newOrder(member, "pwa_session");
    const results = await Promise.all([
      cashierRedeem(billA, 80),
      cashierRedeem(billB, 80),
    ]);
    for (const result of results) expect(result.status).toBeLessThan(500);
    expect(
      results.filter((result) => redeemed(result.status)),
      JSON.stringify(results.map((result) => result.body)),
    ).toHaveLength(1);
    expect(await balanceNow(member)).toBe(20);
    expect(await redeemRows(member)).toHaveLength(1);
    const quoteA = await quoteOk(member, billA.id);
    const quoteB = await quoteOk(member, billB.id);
    for (const quote of [quoteA, quoteB]) {
      expect(quote.balancePoints).toBe(20);
      expect(quote.maxPoints).toBeLessThanOrEqual(20);
    }
  });
});

// ================================================================================
// Architect review fixes (card legend-1203): lock order, training bills, QR version
// ================================================================================

async function mintRows(order: CreatedOrder) {
  const { rows } = await asTenant(world.tenant.tenantId, (client) =>
    client.query<{ id: string }>(
      `SELECT id FROM member_qr_redeem_mints
        WHERE tenant_id = $1 AND order_id = $2`,
      [world.tenant.tenantId, ulidToUuid(order.id)],
    ),
  );
  return rows;
}

describe("1203 review fixes", () => {
  it("1203-90 a till holding the bill's order row while it waits for the member never deadlocks a mint of that bill: no 500", async () => {
    const member = await newMember(2_000);
    const order = await newOrder(member, "pwa_session");
    // The till's lock order: the order row FOR UPDATE, then the member.
    const till = await owner.connect();
    try {
      await till.query("BEGIN");
      await till.query(
        "SELECT 1 FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [world.tenant.tenantId, ulidToUuid(order.id)],
      );
      const minting = postMint(member.client, order.id, 100).then(
        (response) => response,
      );
      // Let the mint reach its first lock and wait on the till.
      await new Promise((resolve) => setTimeout(resolve, 600));
      await till.query(
        "SELECT 1 FROM customer_profiles WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE",
        [world.tenant.tenantId, member.profile.id],
      );
      await till.query("COMMIT");
      const minted = await minting;
      expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    } finally {
      await till.query("ROLLBACK").catch(() => undefined);
      till.release();
    }
    expect(await balanceNow(member)).toBe(2_000);
    expect(await mintRows(order)).toHaveLength(1);
  });

  it("1203-91 a training bill is not listed and cannot be minted; the same bill as a real one is (control)", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const setTraining = (value: boolean) =>
      asTenant(world.tenant.tenantId, (client) =>
        client.query(
          "UPDATE pos_orders SET is_training = $3 WHERE tenant_id = $1 AND order_id = $2",
          [world.tenant.tenantId, ulidToUuid(order.id), value],
        ),
      );
    expect((await listedBills(member)).map((bill) => bill.orderId)).toContain(
      order.id,
    );
    await setTraining(true);
    expect(
      (await listedBills(member)).map((bill) => bill.orderId),
    ).not.toContain(order.id);
    expectRefused(await postMint(member.client, order.id, 100));
    expect(await mintRows(order)).toHaveLength(0);
    await setTraining(false);
    await mintOk(member, order.id, 100);
  });

  it("1203-92 the till refuses a QR token without the ledger version (v): nothing is spent; a minted token works (control)", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    // Validly signed for this member and bill, but minted without `v`.
    const bare = localToken(member, order.id, 100);
    const refused = await cashierRedeem(order, 100, { token: bare });
    expectRefused(refused);
    expect(await balanceNow(member)).toBe(1_000);
    expect(await pointsTenders(order)).toHaveLength(0);
    const token = await mintOk(member, order.id, 100);
    const done = await cashierRedeem(order, 100, { token });
    expect(redeemed(done.status), JSON.stringify(done.body)).toBe(true);
    expect(await balanceNow(member)).toBe(900);
  });

  it("1203-93 two mints for one bill at the same moment leave exactly one live token", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const results = await Promise.all([
      postMint(member.client, order.id, 100),
      postMint(member.client, order.id, 100),
    ]);
    for (const result of results)
      expect(result.status, JSON.stringify(result.body)).toBeLessThan(500);
    const won = results.filter((result) => result.status === 200);
    expect(won, JSON.stringify(results.map((r) => r.body))).toHaveLength(1);
    expectRefused(results.find((result) => result.status !== 200)!);
    expect(await mintRows(order)).toHaveLength(1);
    expect(await balanceNow(member)).toBe(1_000);
  });
});

// ================================================================================
// legend-v6is2: a points-paid bill that still holds an apology / CRM voucher
// ================================================================================

/** A kitchen issue on the bill's first line that stores a live CRM voucher. */
async function voucherOnBill(order: CreatedOrder, member: Member) {
  const voucherId = randomUUID();
  await asTenant(world.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO vouchers (id, tenant_id, customer_profile_id, code_hash, source, value_idr, valid_from)
       VALUES ($1, $2, $3, $4, 'loyalty_reward', 5000, now() - interval '1 hour')`,
      [
        voucherId,
        world.tenant.tenantId,
        member.profile.id,
        randomUUID().replace(/-/g, "").repeat(2),
      ],
    );
    const line = await client.query<{ id: string }>(
      `SELECT id FROM order_items WHERE tenant_id = $1 AND order_id = $2 LIMIT 1`,
      [world.tenant.tenantId, ulidToUuid(order.id)],
    );
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
       reason_note, reported_by, cost_idr, idempotency_key, voucher_id)
       VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock', 'v6is2', $6, 0, $7, $8)`,
      [
        randomUUID(),
        world.tenant.tenantId,
        order.outletId,
        ulidToUuid(order.id),
        line.rows[0]!.id,
        world.cashier.userId,
        `v6is2-${randomUUID()}`,
        voucherId,
      ],
    );
  });
  return voucherId;
}

describe("legend-v6is2 void of a points-paid bill with a live voucher", () => {
  it("v6is2-01 the void is refused 409 while the voucher is live: no points back, tender stays captured", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const token = await mintOk(member, order.id, 100);
    const done = await cashierRedeem(order, 100, { token });
    expect(redeemed(done.status), JSON.stringify(done.body)).toBe(true);
    await voucherOnBill(order, member);

    const refused = await voidNow(order);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error?.code).toBe("VOID_POINTS_HAS_VOUCHER");
    expect(await balanceNow(member)).toBe(900);
    expect(await restoreRows(member)).toHaveLength(0);
    expect((await pointsTenders(order)).map((row) => row.status)).toEqual([
      "captured",
    ]);
  });

  it("v6is2-02 once the voucher is cancelled the void goes through and gives the points back once", async () => {
    const member = await newMember(1_000);
    const order = await newOrder(member);
    const token = await mintOk(member, order.id, 100);
    expect(redeemed((await cashierRedeem(order, 100, { token })).status)).toBe(
      true,
    );
    const voucherId = await voucherOnBill(order, member);
    await asTenant(world.tenant.tenantId, (client) =>
      client.query(
        `UPDATE vouchers SET status = 'cancelled', cancelled_reason = 'v6is2' WHERE tenant_id = $1 AND id = $2`,
        [world.tenant.tenantId, voucherId],
      ),
    );

    const voided = await voidNow(order);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await balanceNow(member)).toBe(1_000);
    expect(await restoreRows(member)).toHaveLength(1);
  });
});
