// legend-hpgyw second opinion (POS 936), group P: the points redeem service.
//
// Written from docs/briefs/1048-so-fixes.md (decisions 3, 4 and the P2 expiry
// clock), the shared CRM contract (orderCustomerAttachViaSchema,
// setOrderCustomer) and the routes of pos-936-points.test.ts, not from the
// service code.
//
//   POST /api/pos/orders/:orderId/points/redeem { points, idempotencyKey }
//   PUT  /api/pos/orders/:orderId/customer { memberToken | whatsappNumber | customerProfileId: null }
//
// Feature id: legend-hpgyw. Test names are SO-P-nn.
//
// Rules proven here (founder: nobody is paid more, the outlet never loses):
// - a training order never spends real member points (409 POINTS_TRAINING_REFUSED,
//   no ledger row, no tender);
// - points are spent only with proof the member is present: the order was
//   attached by `member_qr` or `pwa_session`. A typed phone (`phone_lookup`),
//   a `receipt_claim` or no attach record is refused (409
//   POINTS_NEED_MEMBER_PROOF) with no ledger row and no tender;
// - re-scanning the member QR upgrades a phone-attached order, then redeem works;
// - a legit replay (same key) stays ONE debit;
// - expiry is judged by the clock after the locks: a grant that expires while
//   the redeem waits for the profile lock cannot pay.
//
// Assumptions (also in the report):
// - the refusals are HTTP 409 with `error.code` as written in the brief.
// - `pwa_session` has no cashier route, so the order row is stamped directly
//   (as pos-936-points.test.ts stamps member_qr).
// - a training order is stamped through markTraining (pos_orders.is_training),
//   the same stamp the training-device flow leaves.
// - the expiry test holds the member's profile row lock from a second
//   connection (the lock every balance writer takes) and waits until the
//   redeem request is blocked on it before the grant's expiry passes.

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
        number: `SOP-${String(next).padStart(6, "0")}`,
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
  const tenant = await createIsolatedTenant(`sop-${randomUUID().slice(0, 6)}`);
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
     VALUES ($1, $2, 'Kasir Poin SO', false, NULL, $3, false, '["tenant","outlet"]')`,
    [roleId, tenant.tenantId, JSON.stringify(permissions)],
  );
  const client = agent(app);
  const email = await signUp(client, "Kasir Poin SO");
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
       VALUES ($1, $2, $3, 'Poin Uji SO', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-SO', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
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

/**
 * A real submitted POS order (Kopi x2 = Rp55.000) made through the public API.
 * `via` is how the member got onto the bill: stamped on the order row (null =
 * a member on the bill with no attach record, like an edge-ingested order).
 */
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
async function memberWith(points: number, expiresAt?: Date): Promise<Profile> {
  const member = await seedMember(world.tenant.tenantId);
  await grantPoints(world.tenant.tenantId, member.id, points, expiresAt);
  expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(points);
  return member;
}

const redeem = async (
  order: CreatedOrder,
  points: number,
  options: { key?: string } = {},
) => {
  const memberToken = await memberQrFor(
    world.tenant.tenantId,
    order.id,
    points,
  );
  return world.cashier.client
    .post(`/api/pos/orders/${order.id}/points/redeem`)
    .set(world.headers)
    .set(originHeader)
    .send({
      points,
      idempotencyKey: options.key ?? randomUUID(),
      ...(memberToken ? { memberToken } : {}),
    });
};

const setCustomer = (order: CreatedOrder, body: Record<string, unknown>) =>
  world.cashier.client
    .put(`/api/pos/orders/${order.id}/customer`)
    .set(world.headers)
    .set(originHeader)
    .send(body);

const errorCodeOf = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

const redeemed = (status: number) => [200, 201].includes(status);

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

// ---- training (decision 3) ------------------------------------------------------

describe("SO-P training order", () => {
  it("SO-P-01 a training order cannot redeem points: 409 POINTS_TRAINING_REFUSED, no ledger row, no tender", async () => {
    const member = await memberWith(1_000);
    // Proof of presence is in order, so only the training stamp can refuse.
    const order = await newOrder({ member, via: "member_qr" });
    await markTraining(world.tenant.tenantId, order.id);

    const response = await redeem(order, 100);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(errorCodeOf(response.body)).toBe("POINTS_TRAINING_REFUSED");
    await expectNothingSpent(order, member, 1_000);
  });

  it("SO-P-02 a real order of the same member in the same tenant still redeems (control)", async () => {
    const member = await memberWith(1_000);
    const training = await newOrder({ member, via: "member_qr" });
    await markTraining(world.tenant.tenantId, training.id);
    const real = await newOrder({ member, via: "member_qr" });

    expect((await redeem(training, 100)).status).toBe(409);
    const response = await redeem(real, 100);
    expect(redeemed(response.status), JSON.stringify(response.body)).toBe(true);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
  });
});

// ---- proof the member is present (decision 4) -------------------------------------

describe("SO-P member proof", () => {
  it.each<[string, AttachedVia | null]>([
    ["typed phone number (phone_lookup)", "phone_lookup"],
    ["no attach record (null)", null],
    ["receipt claim (receipt_claim)", "receipt_claim"],
  ])(
    "SO-P-03 a member attached by %s cannot redeem: 409 POINTS_NEED_MEMBER_PROOF, nothing spent",
    async (_label, via) => {
      const member = await memberWith(1_000);
      const order = await newOrder({ member, via });

      const response = await redeem(order, 100);
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(errorCodeOf(response.body)).toBe("POINTS_NEED_MEMBER_PROOF");
      await expectNothingSpent(order, member, 1_000);
    },
  );

  it.each<[AttachedVia]>([["member_qr"], ["pwa_session"]])(
    "SO-P-04 a member attached by %s can redeem: one debit, one points tender",
    async (via) => {
      const member = await memberWith(1_000);
      const order = await newOrder({ member, via });

      const response = await redeem(order, 100);
      expect(redeemed(response.status), JSON.stringify(response.body)).toBe(
        true,
      );
      expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
      expect(await redeemRows(member)).toHaveLength(1);
      expect(await tenderRows(order)).toEqual([
        { method: "points", status: "captured" },
      ]);
    },
  );

  it("SO-P-05 a phone-attached order refused for proof is upgraded by re-scanning the member QR, then redeem works", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member, via: "phone_lookup" });

    const before = await redeem(order, 100);
    expect(before.status, JSON.stringify(before.body)).toBe(409);
    expect(errorCodeOf(before.body)).toBe("POINTS_NEED_MEMBER_PROOF");
    await expectNothingSpent(order, member, 1_000);

    // The cashier scans the member's own QR (a fresh token of this member).
    const { token } = issueMemberQrToken(
      { tenantId: world.tenant.tenantId, customerProfileId: member.id },
      new Date(),
    );
    const rescan = await setCustomer(order, { memberToken: token });
    expect(rescan.status, JSON.stringify(rescan.body)).toBe(200);
    expect(rescan.body.data.attachedVia).toBe("member_qr");
    expect(rescan.body.data.customerProfileId).toBe(member.id);

    const after = await redeem(order, 100);
    expect(redeemed(after.status), JSON.stringify(after.body)).toBe(true);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
    expect(await tenderRows(order)).toHaveLength(1);
  });
});

// ---- replay of a legit redeem -----------------------------------------------------

describe("SO-P replay", () => {
  it("SO-P-07 replaying a legit redeem (same key) answers the same result and stays ONE debit", async () => {
    const member = await memberWith(1_000);
    const order = await newOrder({ member, via: "member_qr" });
    const key = randomUUID();

    const first = await redeem(order, 100, { key });
    const second = await redeem(order, 100, { key });
    expect(redeemed(first.status), JSON.stringify(first.body)).toBe(true);
    expect(redeemed(second.status), JSON.stringify(second.body)).toBe(true);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(900);
    expect(await redeemRows(member)).toHaveLength(1);
    expect(await tenderRows(order)).toHaveLength(1);
  });
});

// ---- expiry clock (P2) ------------------------------------------------------------

describe("SO-P expiry boundary while waiting for the lock", () => {
  it("SO-P-08 a grant that expires while the redeem waits for the profile lock cannot pay: refused, no debit, no tender", async () => {
    const order0 = await newOrder();
    // The bill is ready before the grant exists, so the clock below starts
    // right before the redeem request.
    const expiryMs = 6_000;
    const expiresAt = new Date(Date.now() + expiryMs);
    const member = await memberWith(500, expiresAt);
    await asTenant(world.tenant.tenantId, (client) =>
      client.query(
        `UPDATE orders
            SET customer_profile_id = $3, customer_attached_via = 'member_qr',
                customer_attached_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [world.tenant.tenantId, ulidToUuid(order0.id), member.id],
      ),
    );

    // Hold the member's profile lock (the lock every balance writer takes).
    const holder = await owner.connect();
    let released = false;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [world.tenant.tenantId],
      );
      await holder.query(
        "SELECT id FROM customer_profiles WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE",
        [world.tenant.tenantId, member.id],
      );
      const pending = redeem(order0, 100).then((response) => response);

      // Wait until the redeem is really blocked on that lock.
      const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const waiting = await memberOwner.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND pid <> $1
              AND $2 = ANY(pg_blocking_pids(pid))`,
          [holderPid, holderPid],
        );
        blocked = waiting.rowCount !== null && waiting.rowCount > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked, "the redeem never waited for the profile lock").toBe(
        true,
      );
      // Precondition of the scenario: the grant was still valid when the
      // request started waiting.
      expect(Date.now()).toBeLessThan(expiresAt.getTime());

      // The boundary passes while the request waits.
      const left = expiresAt.getTime() - Date.now();
      await new Promise((resolve) => setTimeout(resolve, left + 1_000));
      await holder.query("COMMIT");
      released = true;

      const response = await pending;
      expect(
        response.status,
        JSON.stringify(response.body),
      ).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    } finally {
      if (!released) await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    await expectNothingSpent(order0, member, 500);
  }, 30_000);
});
