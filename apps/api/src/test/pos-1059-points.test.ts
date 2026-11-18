// legend-1059 (areas B): points redeem hardening after second opinion round 2.
//
// Written from docs/briefs (brief 1059, finding R2-01 of
// docs/qa/second-opinion-pos-936-ronde2-1058.md and bead weexf), the shared
// CRM contract (member QR token, orderCustomerAttachViaSchema) and the
// routes used by pos-936-so-points.test.ts, not from the service code.
//
//   POST /api/pos/orders/:orderId/points/redeem { points, idempotencyKey, memberToken? }
//
// Feature ids: R2-01 (tests R2-01-nn) and weexf (tests weexf-nn).
//
// Rules proven (founder: nobody is paid more, the outlet never loses, points
// are never spent twice):
// - R2-01: a redeem whose loyalty program belongs to another legal entity
//   (PT) than the paying outlet, or whose owner PT is ambiguous, or whose PT is
//   being changed right now, is refused BEFORE any debit: no ledger row, no
//   tender. The same-PT control still works and a replay stays one debit.
// - weexf: the member QR used to redeem is single-use, bound to the order and
//   the amount, valid 120 s, of this member and tenant; concurrent use of one
//   QR pays once; a training order never moves points.
//
// Assumptions (also in the report):
// - refusals are any HTTP 4xx (the brief names no code), except training
//   which keeps 409 POINTS_TRAINING_REFUSED.
// - "ambiguous" = the tenant has two PT and the program has no PT.
// - "PT change running" = another transaction holds the advisory lock
//   `loyalty-entity:<tenantId>` (as crm-promo-db.test.ts does); redeem must
//   answer without waiting for it.
// - the weexf API shape is described in the block above the weexf tests.

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
import type { PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { issueMemberQrToken } from "../lib/member-qr-token.ts";
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
  seededTenantId,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  asTenant,
  balanceOf,
  ledgerOf,
  markTraining,
  owner as memberOwner,
  seedMember,
  seedProgram,
  type Profile,
} from "./member-loyalty-helpers.ts";
import { grantPoints } from "./member-rewards-helpers.ts";
import { memberQrFor } from "./member-qr-redeem-helper.ts";

const KOPI_IDR = 25_000;
/** Kopi x2 = Rp50.000 + PBJT 10%. */
const ORDER_TOTAL_IDR = 55_000;
const POINT_VALUE_IDR = 70;

const CASHIER_PERMISSIONS = [
  "order.view",
  "pos.sale.create",
  "pos.payment.accept",
  "pos.discount.apply",
  "pos.refund.request",
  "shift.cash.operate",
];
const DEVICE_ID = randomUUID();

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
        number: `P1059-${String(next).padStart(6, "0")}`,
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
};
let world: World;

async function seedWorld(): Promise<World> {
  const tenant = await createIsolatedTenant(
    `p1059-${randomUUID().slice(0, 6)}`,
  );
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    tenant.tenantId,
    JSON.stringify({
      modules: ["qr_order", "loyalty"],
      integrationProviders: [],
    }),
  ]);
  // The fixture role also carries everything the seeded cashier template
  // carries (member attach), so it is a real cashier.
  const template = await owner.query<{ permissions: string[] }>(
    "SELECT permissions FROM roles WHERE tenant_id = $1 AND template_key = 'cashier'",
    [seededTenantId],
  );
  const permissions = [
    ...new Set([
      ...CASHIER_PERMISSIONS,
      ...(template.rows[0]?.permissions ?? []),
    ]),
  ];
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Poin 1059', false, NULL, $3, false, '["tenant","outlet"]')`,
    [roleId, tenant.tenantId, JSON.stringify(permissions)],
  );
  const client = agent(app);
  const email = await signUp(client, "Kasir Poin 1059");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  const cashier: Staff = { client, userId, email };
  // The member attach route may ask for a verified session (member-earn).
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
  const sessionContext = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });
  await openPosShift(
    establishScopedTenantContext(sessionContext, { kind: "tenant" }),
    { userId: userIdSchema.parse(cashier.userId), deviceId: DEVICE_ID },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  const category = randomUUID();
  const kopi = randomUUID();
  await asTenant(tenant.tenantId, async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Poin Uji 1059', 0)`,
      [category, tenant.tenantId, tenant.brandId],
    );
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [kopi, tenant.tenantId, tenant.brandId, category, randomUUID()],
    );
    const priceList = randomUUID();
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [priceList, tenant.tenantId, tenant.outletId],
    );
    await db.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, priceList, kopi, KOPI_IDR],
    );
    await db.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await db.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-1059', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
  });
  await seedProgram(tenant.tenantId, { pointValueIdr: POINT_VALUE_IDR });
  return { tenant, headers: { Host: tenant.hostname }, kopi, cashier };
}

beforeAll(async () => {
  app = createApp();
  world = await seedWorld();
}, 120_000);

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  await memberOwner.end();
  await owner.end();
});

// ---- helpers ------------------------------------------------------------------

type AttachedVia =
  "member_qr" | "phone_lookup" | "pwa_session" | "receipt_claim";
type CreatedOrder = { id: string; outletId: string };

/** A real submitted POS order (Kopi x2 = Rp55.000) with `member` on the bill. */
async function newOrder(
  options: { member?: Profile | null; via?: AttachedVia | null } = {},
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
  if (options.member) {
    const via = options.via === undefined ? "member_qr" : options.via;
    await asTenant(world.tenant.tenantId, (client) =>
      client.query(
        `UPDATE orders
            SET customer_profile_id = $3, customer_attached_via = $4::varchar,
                customer_attached_at = CASE WHEN $4::varchar IS NULL THEN NULL ELSE now() END
          WHERE tenant_id = $1 AND id = $2`,
        [world.tenant.tenantId, ulidToUuid(id), options.member!.id, via],
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

/** A member with `points` on the books (granted through the ledger service). */
async function memberWith(points: number): Promise<Profile> {
  const member = await seedMember(world.tenant.tenantId);
  await grantPoints(world.tenant.tenantId, member.id, points);
  expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(points);
  return member;
}

/**
 * Without an explicit `memberToken`, a bill whose member came by QR gets a
 * fresh valid QR (the R2-01 tests are about the PT rule, not the QR); the weexf
 * tests always pass their own token.
 */
const redeem = async (
  order: CreatedOrder,
  points: number,
  options: { key?: string; memberToken?: string } = {},
) => {
  const memberToken =
    options.memberToken ??
    (await memberQrFor(world.tenant.tenantId, order.id, points));
  return world.cashier.client
    .post(`/api/pos/orders/${order.id}/points/redeem`)
    .set(world.headers)
    .set(originHeader)
    .send({
      points,
      idempotencyKey: options.key ?? randomUUID(),
      ...(memberToken === undefined ? {} : { memberToken }),
    });
};

const errorCodeOf = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

const redeemed = (status: number) => [200, 201].includes(status);

/** A refusal is a client error, never a crash and never a success. */
function expectRefused(response: { status: number; body: unknown }) {
  expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(
    400,
  );
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(500);
}

async function tenderRows(order: CreatedOrder) {
  const { rows } = await asTenant(world.tenant.tenantId, (client) =>
    client.query<{ method: string; status: string }>(
      `SELECT method, status FROM pos_order_tenders
        WHERE tenant_id = $1 AND order_id = $2`,
      [world.tenant.tenantId, ulidToUuid(order.id)],
    ),
  );
  return rows;
}

async function redeemRows(member: Profile) {
  return (await ledgerOf(world.tenant.tenantId, member.id)).filter(
    (row) => row.type === "redeem",
  );
}

/** The refusal changed nothing: no tender, no redeem row, full balance. */
async function expectNothingSpent(
  order: CreatedOrder,
  member: Profile,
  balance: number,
) {
  expect(await tenderRows(order)).toHaveLength(0);
  expect(await redeemRows(member)).toHaveLength(0);
  expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(balance);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `run` with the tenant split into two legal entities (PT): the POS
 * outlet stays in `world.tenant.legalEntityId` (PT-A), a second outlet lives
 * in a new PT-B. `programOwner` says whom the loyalty program belongs to:
 * "pos" = the PT of the POS outlet, "other" = PT-B, "none" = no PT chosen.
 * Everything is put back afterwards, so the other tests see one PT again.
 */
async function withTwoEntities(
  programOwner: "pos" | "other" | "none",
  run: () => Promise<void>,
) {
  const entityB = randomUUID();
  const outletB = randomUUID();
  await asTenant(world.tenant.tenantId, async (client) => {
    await client.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B 1059', false)",
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
        programOwner === "pos"
          ? world.tenant.legalEntityId
          : programOwner === "other"
            ? entityB
            : null,
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

// ---- R2-01: points cannot be redeemed across legal entities (PT) -----------------

describe("R2-01 redeem refuses a program owned by another PT", () => {
  it("R2-01-01 the program belongs to PT-B but the bill is paid at an outlet of PT-A: refused, no ledger row, no tender", async () => {
    await withTwoEntities("other", async () => {
      const member = await memberWith(1_000);
      const order = await newOrder({ member, via: "member_qr" });

      const response = await redeem(order, 100);
      expectRefused(response);
      await expectNothingSpent(order, member, 1_000);
      // The bill still owes the whole amount.
      expect(await tenderRows(order)).toEqual([]);
    });
  });

  it("R2-01-02 control: the program belongs to the PT of the paying outlet: redeem works, one debit, and a replay stays ONE debit", async () => {
    await withTwoEntities("pos", async () => {
      const member = await memberWith(1_000);
      const order = await newOrder({ member, via: "member_qr" });
      const key = randomUUID();

      const first = await redeem(order, 100, { key });
      const replay = await redeem(order, 100, { key });
      expect(redeemed(first.status), JSON.stringify(first.body)).toBe(true);
      expect(redeemed(replay.status), JSON.stringify(replay.body)).toBe(true);
      expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
      expect(await redeemRows(member)).toHaveLength(1);
      expect(await tenderRows(order)).toEqual([
        { method: "points", status: "captured" },
      ]);
    });
  });

  it("R2-01-03 the tenant has two PT and the program names none: the owner is ambiguous, redeem is refused with nothing spent", async () => {
    // Assumption: with more than one PT and no PT on the program, the
    // loyalty entity cannot be decided, so the payment-limiting answer is no.
    await withTwoEntities("none", async () => {
      const member = await memberWith(1_000);
      const order = await newOrder({ member, via: "member_qr" });

      expectRefused(await redeem(order, 100));
      await expectNothingSpent(order, member, 1_000);
    });
  });

  it("R2-01-04 a PT change that is still running (entity lock held by another transaction): redeem is refused promptly, nothing spent; once it ends redeem works", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member, via: "member_qr" });
    // The same advisory lock the loyalty journal and the PT change take
    // (see crm-promo-db.test.ts, member-rewards.test.ts).
    const holder = await owner.connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    };
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`loyalty-entity:${world.tenant.tenantId}`],
      );
      const attempt = redeem(order, 100).then((response) => response);
      const outcome = await Promise.race([
        attempt,
        sleep(8_000).then(() => "still waiting" as const),
      ]);
      if (outcome === "still waiting") {
        await release();
        await attempt;
        expect.fail(
          "redeem waited for the running PT change instead of refusing",
        );
      } else {
        expectRefused(outcome);
        expect(errorCodeOf(outcome.body)).toBe("POINTS_ENTITY_BUSY");
      }
    } finally {
      await release();
    }
    await expectNothingSpent(order, member, 1_000);

    const after = await redeem(order, 100);
    expect(redeemed(after.status), JSON.stringify(after.body)).toBe(true);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
  }, 30_000);
});

// ---- weexf: the member QR for redeeming points is single-use, order-bound, 120 s ---
//
// ASSUMED API SHAPE (not decided by the spec; mark for the engineer):
// - the redeem body gets an optional `memberToken` (the member's QR token):
//   POST /api/pos/orders/:orderId/points/redeem { points, idempotencyKey, memberToken }
// - the QR token is minted with `issueMemberQrToken(claims, now)` from
//   lib/member-qr-token.ts, extended with two claims, `orderId` (the order
//   ULID as the API returns it) and `points` (the exact amount). The token
//   already lives 120 s and holds a nonce; redeeming consumes that nonce
//   (table of migration 0490).
// - a token used once, used on another order, with another amount, older
//   than 120 s, of another member or tenant, or altered is refused with a
//   4xx and spends nothing. Replaying the SAME idempotency key stays a
//   legitimate replay (same answer, one debit).
// Every refusal test ends with a control: a fresh valid token for the same
// bill redeems, so a test cannot pass merely because the body is rejected.

type QrOptions = { at?: Date; tenantId?: string; profile?: Profile };

function mintRedeemQr(
  member: Profile,
  order: CreatedOrder,
  points: number,
  options: QrOptions = {},
): string {
  const claims = {
    tenantId: options.tenantId ?? world.tenant.tenantId,
    customerProfileId: (options.profile ?? member).id,
    orderId: order.id,
    points,
  };
  return issueMemberQrToken(
    claims as Parameters<typeof issueMemberQrToken>[0],
    options.at ?? new Date(),
  ).token;
}

/** A fresh valid QR redeems exactly once: the balance is `before - points`. */
async function expectControlRedeems(
  member: Profile,
  order: CreatedOrder,
  points: number,
  before: number,
) {
  const response = await redeem(order, points, {
    memberToken: mintRedeemQr(member, order, points),
  });
  expect(redeemed(response.status), JSON.stringify(response.body)).toBe(true);
  expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(
    before - points,
  );
  expect(await redeemRows(member)).toHaveLength(1);
  expect(await tenderRows(order)).toEqual([
    { method: "points", status: "captured" },
  ]);
}

describe("weexf member QR for redeeming points", () => {
  it("weexf-01 a fresh QR minted for this order and amount redeems: one debit, one points tender", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member });
    await expectControlRedeems(member, order, 100, 1_000);
  });

  it("weexf-02 the same QR sent again with a new key is refused: still exactly one debit", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member });
    const token = mintRedeemQr(member, order, 100);

    const first = await redeem(order, 100, { memberToken: token });
    expect(redeemed(first.status), JSON.stringify(first.body)).toBe(true);
    const replay = await redeem(order, 100, { memberToken: token });
    expectRefused(replay);

    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
    expect(await tenderRows(order)).toHaveLength(1);
  });

  it("weexf-03 a legitimate replay (same QR, same idempotency key) still answers the same result and stays ONE debit", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member });
    const token = mintRedeemQr(member, order, 100);
    const key = randomUUID();

    const first = await redeem(order, 100, { memberToken: token, key });
    const again = await redeem(order, 100, { memberToken: token, key });
    expect(redeemed(first.status), JSON.stringify(first.body)).toBe(true);
    expect(redeemed(again.status), JSON.stringify(again.body)).toBe(true);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
    expect(await tenderRows(order)).toHaveLength(1);
  });

  it("weexf-04 a QR minted for one order cannot be used on another order of the same member", async () => {
    const member = await memberWith(1_000);
    const mine = await newOrder({ member });
    const other = await newOrder({ member });
    const token = mintRedeemQr(member, mine, 100);

    expectRefused(await redeem(other, 100, { memberToken: token }));
    await expectNothingSpent(other, member, 1_000);
    await expectNothingSpent(mine, member, 1_000);
    await expectControlRedeems(member, other, 100, 1_000);
  });

  it("weexf-05 after a QR paid order one, the same QR is refused on order two: one debit in total", async () => {
    const member = await memberWith(1_000);
    const first = await newOrder({ member });
    const second = await newOrder({ member });
    const token = mintRedeemQr(member, first, 100);

    const used = await redeem(first, 100, { memberToken: token });
    expect(redeemed(used.status), JSON.stringify(used.body)).toBe(true);
    expectRefused(await redeem(second, 100, { memberToken: token }));

    expect(await tenderRows(second)).toHaveLength(0);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
  });

  it.each([
    ["more points than the QR carries", 200],
    ["fewer points than the QR carries", 50],
  ])(
    "weexf-06 a QR for 100 points used for %s is refused, nothing spent",
    async (_label, requested) => {
      const member = await memberWith(1_000);
      const order = await newOrder({ member });
      const token = mintRedeemQr(member, order, 100);

      expectRefused(await redeem(order, requested, { memberToken: token }));
      await expectNothingSpent(order, member, 1_000);
      await expectControlRedeems(member, order, 100, 1_000);
    },
  );

  it("weexf-07 a QR older than 120 seconds is refused, nothing spent", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member });
    // 150 s old: clearly past the 120 s life of the token.
    const stale = mintRedeemQr(member, order, 100, {
      at: new Date(Date.now() - 150_000),
    });

    expectRefused(await redeem(order, 100, { memberToken: stale }));
    await expectNothingSpent(order, member, 1_000);
    await expectControlRedeems(member, order, 100, 1_000);
  });

  it("weexf-08 the QR of another member cannot spend this member's points (nor its own)", async () => {
    const member = await memberWith(1_000);
    const stranger = await memberWith(1_000);
    const order = await newOrder({ member });
    const strangers = mintRedeemQr(member, order, 100, { profile: stranger });

    expectRefused(await redeem(order, 100, { memberToken: strangers }));
    await expectNothingSpent(order, member, 1_000);
    expect(await balanceOf(world.tenant.tenantId, stranger.id)).toBe(1_000);
    expect(await redeemRows(stranger)).toHaveLength(0);
    await expectControlRedeems(member, order, 100, 1_000);
  });

  it("weexf-09 a QR minted for another tenant is refused, nothing spent", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member });
    const foreign = mintRedeemQr(member, order, 100, {
      tenantId: seededTenantId,
    });

    expectRefused(await redeem(order, 100, { memberToken: foreign }));
    await expectNothingSpent(order, member, 1_000);
    await expectControlRedeems(member, order, 100, 1_000);
  });

  it("weexf-10 an altered QR is refused, nothing spent", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member });
    const token = mintRedeemQr(member, order, 100);
    const tail = token.slice(-4);
    const altered = token.slice(0, -4) + (tail === "AAAA" ? "BBBB" : "AAAA");

    expectRefused(await redeem(order, 100, { memberToken: altered }));
    await expectNothingSpent(order, member, 1_000);
    await expectControlRedeems(member, order, 100, 1_000);
  });

  it("weexf-11 four requests at once with the same QR and different keys: exactly one pays, one debit, one tender", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member });
    const token = mintRedeemQr(member, order, 100);

    const responses = await Promise.all(
      [1, 2, 3, 4].map(() => redeem(order, 100, { memberToken: token })),
    );
    const paid = responses.filter((response) => redeemed(response.status));
    expect(
      paid,
      JSON.stringify(responses.map((response) => response.body)),
    ).toHaveLength(1);
    for (const response of responses)
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(500);

    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
    expect(await tenderRows(order)).toHaveLength(1);
  });

  it("weexf-12 one QR sent at once to its own order and to another order: only its own order is paid", async () => {
    const member = await memberWith(1_000);
    const mine = await newOrder({ member });
    const other = await newOrder({ member });
    const token = mintRedeemQr(member, mine, 100);

    const [forMine, forOther] = await Promise.all([
      redeem(mine, 100, { memberToken: token }),
      redeem(other, 100, { memberToken: token }),
    ]);
    expect(redeemed(forMine.status), JSON.stringify(forMine.body)).toBe(true);
    expectRefused(forOther);

    expect(await tenderRows(mine)).toHaveLength(1);
    expect(await tenderRows(other)).toHaveLength(0);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
  });

  it("weexf-13 the same QR racing with a fresh QR of the same amount on one bill: the bill takes at most the points of one payment per QR", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member });
    const token = mintRedeemQr(member, order, 100);
    const spare = mintRedeemQr(member, order, 100);

    const responses = await Promise.all([
      redeem(order, 100, { memberToken: token }),
      redeem(order, 100, { memberToken: token }),
      redeem(order, 100, { memberToken: spare }),
    ]);
    for (const response of responses)
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(500);
    const paid = responses.filter((response) => redeemed(response.status));
    // Each QR pays once: the two sends of `token` give one payment; `spare`
    // is a different QR (its own nonce) and may also pay: 100 or 200 points
    // leave, never 300, and ledger, balance and tenders agree.
    expect(paid.length).toBeGreaterThanOrEqual(1);
    expect(paid.length).toBeLessThanOrEqual(2);
    const debits = await redeemRows(member);
    expect(debits.length).toBe(paid.length);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(
      1_000 - 100 * debits.length,
    );
    expect(await tenderRows(order)).toHaveLength(debits.length);
  });
});

// ---- weexf: training mode never moves points ------------------------------------

describe("weexf training mode", () => {
  it("weexf-14 a training order with a valid QR is refused (POINTS_TRAINING_REFUSED): no ledger row, no tender, balance unchanged; a real bill still redeems", async () => {
    const member = await memberWith(1_000);
    const training = await newOrder({ member });
    await markTraining(world.tenant.tenantId, training.id);
    const token = mintRedeemQr(member, training, 100);

    const response = await redeem(training, 100, { memberToken: token });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(errorCodeOf(response.body)).toBe("POINTS_TRAINING_REFUSED");
    await expectNothingSpent(training, member, 1_000);

    const real = await newOrder({ member });
    await expectControlRedeems(member, real, 100, 1_000);
    // Still nothing on the training bill.
    expect(await tenderRows(training)).toHaveLength(0);
  });
});
