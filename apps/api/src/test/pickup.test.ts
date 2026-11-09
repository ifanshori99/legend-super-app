// Pickup display feed, call number allocation and the "Panggil" / "Diambil"
// actions (bead legend-mzhr0; PRD v1.7 §3 F12 "Pickup Display"; contract
// @starter/shared/kitchen `pickupDisplaySchema`, `pickupCallSchema`,
// `PICKUP_CALL_TRANSITIONS`; tables legend-aiksz).
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable
// server from `pnpm test`) in fresh isolated tenants. Fixtures (orders, pickup
// calls, promotions) are written as the migration owner with the tenant
// settings applied (FORCE RLS); behaviour runs through the service on
// `withTenant` transactions or through HTTP.
//
// Assumptions where the contract is silent:
//  - `orders.channel` has no `takeaway` value (ORDER_CHANNELS), so the cases
//    that need a supported channel use `gofood`; platform channels keep their
//    own channel on the call.
//  - legend-ggpoe: a POS/captain order gets a call by service type (takeaway ->
//    channel "takeaway", delivery -> "delivery"); dine_in has no call number.
//    The number never runs out: after 999 the code letter advances (B-001...).
//  - A service-level scope or tenant mismatch is a thrown CoreError
//    (OUTLET_OUT_OF_SCOPE) or HttpError (404); over HTTP that is 403 / 404.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { pickupCallSchema, pickupDisplaySchema } from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  allocatePickupCall,
  applyPickupAction,
  readPickupDisplay,
} from "../services/pickup.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const CLOCK = { timeZone: "Asia/Jakarta", cutoff: "04:00" };
const ROLE_OPERATE = randomUUID();
const ROLE_NO_ACCESS = randomUUID();
const HASH = "a".repeat(64);

let app: Express;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let outletA1: string;
let outletA2: string;
let outletB1: string;

type Member = { client: ReturnType<typeof agent>; userId: string };
let operator: Member; // kds.expo.operate, tenant scope
let operatorA1: Member; // kds.expo.operate, outlet A1 only
let noAccess: Member; // a role without kds.expo.operate
let operatorB: Member; // kds.expo.operate in tenant B

// ---- Fixtures ----------------------------------------------------------------

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

function contextOf(
  tenantId: string,
  outletIds?: string[],
): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });
  return establishScopedTenantContext(
    tenant,
    outletIds
      ? {
          kind: "outlets",
          outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
        }
      : { kind: "tenant" },
  );
}

const ctxA = () => contextOf(tenantA.tenantId);
const ctxB = () => contextOf(tenantB.tenantId);

/** A new outlet of the tenant, so a test gets its own call number sequence. */
async function createOutlet(forTenant: IsolatedTenant): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Pickup', 'Jl. Uji 2', timezone, opening_hours, 'active'
       FROM outlets WHERE tenant_id = $3 AND id = $4`,
      [
        id,
        `PK-${randomUUID().slice(0, 8)}`.toUpperCase(),
        forTenant.tenantId,
        forTenant.outletId,
      ],
    ),
  );
  return id;
}

const nowDate = () => businessDateOf(new Date(), CLOCK);
function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Inserts an order and returns its ULID (the form the service takes). */
async function seedOrder(
  forTenant: IsolatedTenant,
  outletId: string,
  input: {
    channel?: string;
    serviceType?: string;
    status?: string;
    businessDate?: string;
  } = {},
): Promise<string> {
  const ulid = createUlid();
  const status = input.status ?? "sent";
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at, voided_at, void_reason)
       VALUES ($1, $2, $3, $4, $5, $10, 'pay_first', 10000, 0, 0, 0, 0, 10000,
         $6, $7, now(), $8, $9)`,
      [
        ulidToUuid(ulid),
        forTenant.tenantId,
        outletId,
        `PU-${ulid.slice(-10)}`,
        input.channel ?? "gofood",
        status,
        input.businessDate ?? nowDate(),
        status === "voided" ? new Date() : null,
        status === "voided" ? "Batal di kasir" : null,
        input.serviceType ?? "delivery",
      ],
    ),
  );
  return ulid;
}

async function voidOrder(forTenant: IsolatedTenant, orderUlid: string) {
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `UPDATE orders SET status = 'voided', voided_at = now(), void_reason = 'Batal di kasir'
       WHERE tenant_id = $1 AND id = $2`,
      [forTenant.tenantId, ulidToUuid(orderUlid)],
    ),
  );
}

interface CallSeed {
  number: number;
  status?: "assigned" | "called" | "picked_up";
  businessDate?: string;
  calledAt?: string;
  pickedUpAt?: string;
  channel?: string;
}

/** Inserts an order and its pickup call; returns the call id and order ULID. */
async function seedCall(
  forTenant: IsolatedTenant,
  outletId: string,
  input: CallSeed,
): Promise<{ callId: string; orderId: string }> {
  const status = input.status ?? "assigned";
  const businessDate = input.businessDate ?? nowDate();
  const orderId = await seedOrder(forTenant, outletId, { businessDate });
  const callId = randomUUID();
  const calledAt =
    status === "assigned"
      ? null
      : (input.calledAt ?? "2031-03-15T10:00:00.000Z");
  const pickedUpAt =
    status === "picked_up"
      ? (input.pickedUpAt ?? "2031-03-15T10:05:00.000Z")
      : null;
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pickup_calls
         (id, tenant_id, outlet_id, order_id, channel, number, business_date,
          status, called_at, picked_up_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        callId,
        forTenant.tenantId,
        outletId,
        ulidToUuid(orderId),
        input.channel ?? "gofood",
        input.number,
        businessDate,
        status,
        calledAt,
        pickedUpAt,
      ],
    ),
  );
  return { callId, orderId };
}

async function callRows(forTenant: IsolatedTenant, outletId: string) {
  return asOwnerTenant(forTenant.tenantId, async (client) => {
    const result = await client.query<{ number: number; order_id: string }>(
      `SELECT number::int AS number, order_id FROM pickup_calls
       WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY number`,
      [forTenant.tenantId, outletId],
    );
    return result.rows;
  });
}

const allocate = (context: ScopedTenantContext, orderUlid: string) =>
  withTenant(db, context, (tx) => allocatePickupCall(tx, context, orderUlid));

async function member(
  forTenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" | "outlet"; id: string | null },
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [forTenant.tenantId, userId, roleId, scope.type, scope.id],
  );
  return { client, userId };
}

async function insertRole(
  tenantId: string,
  id: string,
  name: string,
  permissions: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [
      id,
      tenantId,
      name,
      JSON.stringify(permissions),
      JSON.stringify(["tenant", "outlet"]),
    ],
  );
}

interface PromoSeed {
  name: string;
  description?: string;
  status?: "draft" | "active" | "paused" | "ended";
  codeHash?: string | null;
  voucherRequired?: boolean;
  startsAt?: Date;
  endsAt?: Date | null;
  outletScope?: "all_except" | "only";
  priority?: number;
  quotaTotal?: number | null;
  quotaPerCustomer?: number | null;
  budgetIdr?: number | null;
  usesTotal?: number;
  spentIdr?: number;
  conditions?: Record<string, unknown>[];
}

async function seedPromo(
  forTenant: IsolatedTenant,
  input: PromoSeed,
): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
          conditions, benefit, stack_group, stackable, priority,
          quota_total, quota_per_customer, budget_idr, outlet_scope, uses_total, spent_idr)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $17, $10, $11, true, $12, $13, $14, $15, $16, $18, $19)`,
      [
        id,
        forTenant.tenantId,
        input.name,
        input.description ?? "Diskon akhir pekan",
        input.status ?? "active",
        input.codeHash ?? null,
        input.voucherRequired ?? false,
        input.startsAt ?? new Date(Date.now() - 2 * 3_600_000),
        input.endsAt === undefined ? null : input.endsAt,
        JSON.stringify({
          kind: "percent_off",
          percentBp: 1000,
          maxDiscountIdr: null,
        }),
        `g${id.slice(0, 8)}`,
        input.priority ?? 0,
        input.quotaTotal ?? null,
        input.quotaPerCustomer ?? null,
        input.budgetIdr ?? null,
        input.outletScope ?? "all_except",
        JSON.stringify(input.conditions ?? []),
        input.usesTotal ?? 0,
        input.spentIdr ?? 0,
      ],
    ),
  );
  return id;
}

async function setPromoOutlet(
  forTenant: IsolatedTenant,
  promotionId: string,
  outletId: string,
  enabled: boolean,
) {
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO promotion_outlets (tenant_id, promotion_id, outlet_id, enabled)
       VALUES ($1, $2, $3, $4)`,
      [forTenant.tenantId, promotionId, outletId, enabled],
    ),
  );
}

// ---- HTTP helpers ------------------------------------------------------------

function api(
  who: Member | null,
  forTenant: IsolatedTenant,
  outletId: string,
  extraHeaders: Record<string, string> = originHeader,
) {
  const client = who?.client ?? agent(app);
  const base = `/api/outlets/${encodeURIComponent(outletId)}`;
  const hostHeader = { Host: forTenant.hostname };
  return {
    display: () =>
      client.get(`${base}/pickup-display`).set(hostHeader).set(extraHeaders),
    call: (callId: string) =>
      client
        .post(`${base}/pickup-calls/${callId}/call`)
        .set(hostHeader)
        .set(extraHeaders)
        .send({}),
    pickup: (callId: string) =>
      client
        .post(`${base}/pickup-calls/${callId}/picked-up`)
        .set(hostHeader)
        .set(extraHeaders)
        .send({}),
  };
}

beforeAll(async () => {
  app = createApp();
  tenantA = await createIsolatedTenant(`pu-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`pub-${randomUUID().slice(0, 6)}`);
  outletA1 = tenantA.outletId;
  outletA2 = await createOutlet(tenantA);
  outletB1 = tenantB.outletId;

  await insertRole(tenantA.tenantId, ROLE_OPERATE, "Pickup Operator Uji", [
    "kds.expo.operate",
  ]);
  await insertRole(tenantA.tenantId, ROLE_NO_ACCESS, "Pickup Tanpa Akses", [
    "order.view",
  ]);
  const roleB = randomUUID();
  await insertRole(tenantB.tenantId, roleB, "Pickup Operator B", [
    "kds.expo.operate",
  ]);

  operator = await member(
    tenantA,
    ROLE_OPERATE,
    { type: "tenant", id: null },
    "Pickup Operator",
  );
  operatorA1 = await member(
    tenantA,
    ROLE_OPERATE,
    { type: "outlet", id: outletA1 },
    "Pickup Operator A1",
  );
  noAccess = await member(
    tenantA,
    ROLE_NO_ACCESS,
    { type: "tenant", id: null },
    "Pickup Tanpa Akses",
  );
  operatorB = await member(
    tenantB,
    roleB,
    { type: "tenant", id: null },
    "Pickup Operator B",
  );
});

afterAll(async () => {
  // Orders and calls stay in the disposable database; give the tenants a valid
  // creator so the platform tenant list parses (as kds.test.ts does).
  for (const t of [tenantA, tenantB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- Isolation ---------------------------------------------------------------

describe("pickup isolation: tenant and outlet", () => {
  it("another tenant cannot allocate for, read or act on this tenant's outlet", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedOrder(tenantA, outlet);
    const { callId } = await seedCall(tenantA, outlet, {
      number: 7,
      status: "called",
    });

    await expect(allocate(ctxB(), orderId)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    await expect(
      readPickupDisplay(ctxB(), outlet, new Date()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const action of ["call", "pickup"] as const)
      await expect(
        applyPickupAction(ctxB(), outlet, callId, action, new Date()),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

    // Nothing was written for the order by the refused attempt.
    expect((await callRows(tenantA, outlet)).map((r) => r.number)).toEqual([7]);
  });

  it("an outlet-limited caller cannot allocate, read or act on another outlet", async () => {
    const orderOfA1 = await seedOrder(tenantA, outletA1);
    const { callId } = await seedCall(tenantA, outletA1, {
      number: 8,
      status: "called",
    });
    const onlyA2 = contextOf(tenantA.tenantId, [outletA2]);

    // RLS hides the other outlet's order: 404, never a hint that it exists.
    await expect(allocate(onlyA2, orderOfA1)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    await expect(
      readPickupDisplay(onlyA2, outletA1, new Date()),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    for (const action of ["call", "pickup"] as const)
      await expect(
        applyPickupAction(onlyA2, outletA1, callId, action, new Date()),
      ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
  });

  it("a call is addressed through its own outlet only (same tenant, other outlet path -> 404)", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, {
      number: 1,
      status: "called",
    });
    for (const action of ["call", "pickup"] as const)
      await expect(
        applyPickupAction(ctxA(), outletA2, callId, action, new Date()),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("the feed of one outlet or tenant never shows another's numbers", async () => {
    const outlet = await createOutlet(tenantA);
    const other = await createOutlet(tenantA);
    await seedCall(tenantA, outlet, { number: 11, status: "called" });
    await seedCall(tenantA, other, { number: 12, status: "called" });
    const outletOfB = await createOutlet(tenantB);
    await seedCall(tenantB, outletOfB, { number: 13, status: "called" });

    const feed = await readPickupDisplay(ctxA(), outlet, new Date());
    expect(feed.calls.map((c) => c.number)).toEqual([11]);
    expect(feed.calls.every((c) => c.tenantId === tenantA.tenantId)).toBe(true);
    expect(feed.calls.every((c) => c.outletId === outlet)).toBe(true);
  });
});

// ---- Allocation --------------------------------------------------------------

describe("pickup number allocation", () => {
  it("25 parallel orders of one outlet get exactly the numbers 1..25, no duplicates", async () => {
    const outlet = await createOutlet(tenantA);
    const orderIds: string[] = [];
    for (let i = 0; i < 25; i += 1)
      orderIds.push(await seedOrder(tenantA, outlet));

    // Each call runs in its own transaction on its own pooled connection.
    const calls = await Promise.all(orderIds.map((id) => allocate(ctxA(), id)));

    const numbers = calls.map((c) => c.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(new Set(calls.map((c) => c.code)).size).toBe(25);
    expect(calls.map((c) => c.code).sort()).toEqual(
      Array.from(
        { length: 25 },
        (_, i) => `A-${String(i + 1).padStart(3, "0")}`,
      ),
    );
    expect(new Set(calls.map((c) => c.orderId)).size).toBe(25);
    expect(calls.every((c) => c.status === "assigned")).toBe(true);
    expect((await callRows(tenantA, outlet)).map((r) => r.number)).toEqual(
      numbers,
    );
  });

  it("numbering is per outlet: another outlet starts at 1 too", async () => {
    const outlet = await createOutlet(tenantA);
    const other = await createOutlet(tenantA);
    const a = await allocate(ctxA(), await seedOrder(tenantA, outlet));
    const b = await allocate(ctxA(), await seedOrder(tenantA, other));
    expect([a.number, b.number]).toEqual([1, 1]);
  });

  it("numbering restarts on a new business date", async () => {
    const outlet = await createOutlet(tenantA);
    const today = nowDate();
    const first = await allocate(
      ctxA(),
      await seedOrder(tenantA, outlet, { businessDate: today }),
    );
    const second = await allocate(
      ctxA(),
      await seedOrder(tenantA, outlet, { businessDate: today }),
    );
    const yesterday = await allocate(
      ctxA(),
      await seedOrder(tenantA, outlet, { businessDate: dayBefore(today) }),
    );
    expect([first.number, second.number]).toEqual([1, 2]);
    expect(yesterday.number).toBe(1);
    expect(yesterday.businessDate).toBe(dayBefore(today));
  });

  it("is idempotent per order: a repeat returns the same call and no new number", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedOrder(tenantA, outlet);
    const first = await allocate(ctxA(), orderId);
    const again = await allocate(ctxA(), orderId);
    expect(again).toEqual(first);
    const next = await allocate(ctxA(), await seedOrder(tenantA, outlet));
    expect(next.number).toBe(first.number + 1);
    expect(await callRows(tenantA, outlet)).toHaveLength(2);
  });

  it("parallel repeats for the same order still make one call", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedOrder(tenantA, outlet);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => allocate(ctxA(), orderId)),
    );
    expect(new Set(results.map((c) => c.id)).size).toBe(1);
    expect(new Set(results.map((c) => c.number))).toEqual(new Set([1]));
    expect(await callRows(tenantA, outlet)).toHaveLength(1);
  });

  it("gofood, grabfood and shopeefood orders get a call number carrying their channel", async () => {
    const outlet = await createOutlet(tenantA);
    const channels = ["gofood", "grabfood", "shopeefood"] as const;
    for (const channel of channels) {
      const call = await allocate(
        ctxA(),
        await seedOrder(tenantA, outlet, { channel }),
      );
      expect(call.channel).toBe(channel);
    }
  });

  it("number 999 is A-999 and the next order gets number 1000 with code B-001, never refused", async () => {
    const outlet = await createOutlet(tenantA);
    await seedCall(tenantA, outlet, { number: 998 });
    const last = await allocate(ctxA(), await seedOrder(tenantA, outlet));
    expect([last.number, last.code]).toEqual([999, "A-999"]);

    const next = await allocate(ctxA(), await seedOrder(tenantA, outlet));
    expect([next.number, next.code]).toEqual([1000, "B-001"]);
    const after = await allocate(ctxA(), await seedOrder(tenantA, outlet));
    expect([after.number, after.code]).toEqual([1001, "B-002"]);
    expect((await callRows(tenantA, outlet)).map((r) => r.number)).toEqual([
      998, 999, 1000, 1001,
    ]);
  });

  it("seeded at 999 the next order is B-001 and another outlet still starts at A-001", async () => {
    const outlet = await createOutlet(tenantA);
    await seedCall(tenantA, outlet, { number: 999 });
    const call = await allocate(ctxA(), await seedOrder(tenantA, outlet));
    expect([call.number, call.code]).toEqual([1000, "B-001"]);
    const fresh = await createOutlet(tenantA);
    const first = await allocate(ctxA(), await seedOrder(tenantA, fresh));
    expect([first.number, first.code]).toEqual([1, "A-001"]);
  });

  it("after Z-999 (number 25974) the code goes to two letters: AA-001", async () => {
    const outlet = await createOutlet(tenantA);
    await seedCall(tenantA, outlet, { number: 25974 });
    const call = await allocate(ctxA(), await seedOrder(tenantA, outlet));
    expect([call.number, call.code]).toEqual([25975, "AA-001"]);
    const next = await allocate(ctxA(), await seedOrder(tenantA, outlet));
    expect([next.number, next.code]).toEqual([25976, "AA-002"]);
  });

  it("a new business date restarts the code at A-001", async () => {
    const outlet = await createOutlet(tenantA);
    const today = nowDate();
    await seedCall(tenantA, outlet, {
      number: 1500,
      businessDate: dayBefore(today),
    });
    const yesterday = await allocate(
      ctxA(),
      await seedOrder(tenantA, outlet, { businessDate: dayBefore(today) }),
    );
    expect(yesterday.code).toBe("B-502");
    const fresh = await allocate(
      ctxA(),
      await seedOrder(tenantA, outlet, { businessDate: today }),
    );
    expect([fresh.number, fresh.code]).toEqual([1, "A-001"]);
  });

  it("a voided order gets no number: 409 PICKUP_ORDER_VOIDED", async () => {
    const outlet = await createOutlet(tenantA);
    const orderId = await seedOrder(tenantA, outlet, { status: "voided" });
    await expect(allocate(ctxA(), orderId)).rejects.toMatchObject({
      status: 409,
      code: "PICKUP_ORDER_VOIDED",
    });
    expect(await callRows(tenantA, outlet)).toHaveLength(0);
  });

  it("a dine-in order (pos or qr channel) gets no call: 409 PICKUP_CHANNEL_UNSUPPORTED", async () => {
    const outlet = await createOutlet(tenantA);
    for (const channel of ["pos", "qr"]) {
      const orderId = await seedOrder(tenantA, outlet, {
        channel,
        serviceType: "dine_in",
      });
      await expect(allocate(ctxA(), orderId)).rejects.toMatchObject({
        status: 409,
        code: "PICKUP_CHANNEL_UNSUPPORTED",
      });
    }
    expect(await callRows(tenantA, outlet)).toHaveLength(0);
  });

  it("a pos takeaway order gets channel takeaway and a pos delivery order gets channel delivery", async () => {
    const outlet = await createOutlet(tenantA);
    const takeaway = await allocate(
      ctxA(),
      await seedOrder(tenantA, outlet, {
        channel: "pos",
        serviceType: "takeaway",
      }),
    );
    const delivery = await allocate(
      ctxA(),
      await seedOrder(tenantA, outlet, {
        channel: "captain",
        serviceType: "delivery",
      }),
    );
    expect([takeaway.channel, takeaway.code]).toEqual(["takeaway", "A-001"]);
    expect([delivery.channel, delivery.code]).toEqual(["delivery", "A-002"]);
    expect(pickupCallSchema.parse(takeaway)).toEqual(takeaway);
    expect(pickupCallSchema.parse(delivery)).toEqual(delivery);
  });

  it("an unknown order is 404", async () => {
    await expect(allocate(ctxA(), createUlid())).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });
});

// ---- Voided orders after allocation -----------------------------------------

describe("pickup of a voided order", () => {
  it("a first call or pickup is 409 PICKUP_ORDER_VOIDED and the number leaves the feed", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId, orderId } = await seedCall(tenantA, outlet, {
      number: 3,
      status: "called",
    });
    const kept = await seedCall(tenantA, outlet, {
      number: 4,
      status: "called",
    });
    expect(
      (await readPickupDisplay(ctxA(), outlet, new Date())).calls.map(
        (c) => c.number,
      ),
    ).toEqual(expect.arrayContaining([3, 4]));

    await voidOrder(tenantA, orderId);

    // `pickup` on a called number is a first pickup; a repeat `call` is 200 (below).
    await expect(
      applyPickupAction(ctxA(), outlet, callId, "pickup", new Date()),
    ).rejects.toMatchObject({ status: 409, code: "PICKUP_ORDER_VOIDED" });
    const assigned = await seedCall(tenantA, outlet, { number: 6 });
    await voidOrder(tenantA, assigned.orderId);
    await expect(
      applyPickupAction(ctxA(), outlet, assigned.callId, "call", new Date()),
    ).rejects.toMatchObject({ status: 409, code: "PICKUP_ORDER_VOIDED" });
    const feed = await readPickupDisplay(ctxA(), outlet, new Date());
    expect(feed.calls.map((c) => c.number)).toEqual([4]);
    // The row stays: the number is not recycled.
    expect((await callRows(tenantA, outlet)).map((r) => r.number)).toEqual([
      3, 4, 6,
    ]);
    expect(kept.callId).toBeTruthy();
  });

  it("a repeat pickup on a picked_up call whose order was voided later is 200 and keeps the first pickedUpAt", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId, orderId } = await seedCall(tenantA, outlet, {
      number: 7,
      status: "picked_up",
    });
    await voidOrder(tenantA, orderId);
    const again = await applyPickupAction(
      ctxA(),
      outlet,
      callId,
      "pickup",
      new Date("2031-03-15T11:00:00.000Z"),
    );
    expect(again.status).toBe("picked_up");
    expect(again.pickedUpAt).toBe("2031-03-15T10:05:00.000Z");
    const response = await api(operator, tenantA, outlet).pickup(callId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it("a non-repeat action (call on assigned, voided order) stays 409 PICKUP_ORDER_VOIDED", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId, orderId } = await seedCall(tenantA, outlet, { number: 8 });
    await voidOrder(tenantA, orderId);
    await expect(
      applyPickupAction(ctxA(), outlet, callId, "call", new Date()),
    ).rejects.toMatchObject({ status: 409, code: "PICKUP_ORDER_VOIDED" });
  });

  it("over HTTP a first call or pickup on a voided order is 409 PICKUP_ORDER_VOIDED", async () => {
    const outlet = await createOutlet(tenantA);
    const first = await seedCall(tenantA, outlet, { number: 5 });
    const called = await seedCall(tenantA, outlet, {
      number: 9,
      status: "called",
    });
    await voidOrder(tenantA, first.orderId);
    await voidOrder(tenantA, called.orderId);
    const http = api(operator, tenantA, outlet);
    for (const response of [
      await http.call(first.callId),
      await http.pickup(called.callId),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe("PICKUP_ORDER_VOIDED");
    }
  });
});

// ---- Transitions -------------------------------------------------------------

describe("pickup call transitions", () => {
  const T1 = new Date("2031-03-15T10:00:00.000Z");
  const T2 = new Date("2031-03-15T10:10:00.000Z");
  const T3 = new Date("2031-03-15T10:20:00.000Z");

  it("call: assigned -> called stamps calledAt", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, { number: 1 });
    const call = await applyPickupAction(ctxA(), outlet, callId, "call", T1);
    expect(call.status).toBe("called");
    expect(call.calledAt).toBe(T1.toISOString());
    expect(call.pickedUpAt).toBeNull();
  });

  it("a repeat call keeps the first calledAt", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, { number: 1 });
    await applyPickupAction(ctxA(), outlet, callId, "call", T1);
    const again = await applyPickupAction(ctxA(), outlet, callId, "call", T2);
    expect(again.status).toBe("called");
    expect(again.calledAt).toBe(T1.toISOString());
  });

  it("pickup from assigned is 409 PICKUP_CALL_NOT_CALLED and changes nothing", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, { number: 1 });
    await expect(
      applyPickupAction(ctxA(), outlet, callId, "pickup", T1),
    ).rejects.toMatchObject({ status: 409, code: "PICKUP_CALL_NOT_CALLED" });
    const rows = await asOwnerTenant(tenantA.tenantId, (client) =>
      client.query<{ status: string }>(
        "SELECT status FROM pickup_calls WHERE id = $1",
        [callId],
      ),
    );
    expect(rows.rows[0]?.status).toBe("assigned");
  });

  it("pickup: called -> picked_up stamps pickedUpAt and keeps calledAt", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, { number: 1 });
    await applyPickupAction(ctxA(), outlet, callId, "call", T1);
    const call = await applyPickupAction(ctxA(), outlet, callId, "pickup", T2);
    expect(call.status).toBe("picked_up");
    expect(call.calledAt).toBe(T1.toISOString());
    expect(call.pickedUpAt).toBe(T2.toISOString());
  });

  it("a repeat pickup keeps the first pickedUpAt", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, { number: 1 });
    await applyPickupAction(ctxA(), outlet, callId, "call", T1);
    await applyPickupAction(ctxA(), outlet, callId, "pickup", T2);
    const again = await applyPickupAction(ctxA(), outlet, callId, "pickup", T3);
    expect(again.status).toBe("picked_up");
    expect(again.pickedUpAt).toBe(T2.toISOString());
  });

  it("call from picked_up is 409 PICKUP_CALL_CLOSED and the call stays closed", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, {
      number: 1,
      status: "picked_up",
    });
    await expect(
      applyPickupAction(ctxA(), outlet, callId, "call", T3),
    ).rejects.toMatchObject({ status: 409, code: "PICKUP_CALL_CLOSED" });
    const again = await applyPickupAction(ctxA(), outlet, callId, "pickup", T3);
    expect(again.status).toBe("picked_up");
    expect(again.pickedUpAt).toBe("2031-03-15T10:05:00.000Z");
  });

  it("an unknown call id is 404", async () => {
    await expect(
      applyPickupAction(ctxA(), outletA1, randomUUID(), "call", T1),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("two parallel first calls both succeed and keep one calledAt", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, { number: 1 });
    const [a, b] = await Promise.all([
      applyPickupAction(ctxA(), outlet, callId, "call", T1),
      applyPickupAction(ctxA(), outlet, callId, "call", T2),
    ]);
    expect(a.calledAt).toBe(b.calledAt);
    expect([T1.toISOString(), T2.toISOString()]).toContain(a.calledAt);
  });
});

// ---- Feed --------------------------------------------------------------------

describe("pickup display feed", () => {
  it("lists only called numbers of the outlet's current business date, newest call first", async () => {
    const outlet = await createOutlet(tenantA);
    const today = nowDate();
    await seedCall(tenantA, outlet, {
      number: 1,
      status: "called",
      calledAt: "2031-03-15T10:00:00.000Z",
    });
    await seedCall(tenantA, outlet, {
      number: 2,
      status: "called",
      calledAt: "2031-03-15T10:30:00.000Z",
    });
    await seedCall(tenantA, outlet, { number: 3, status: "assigned" });
    await seedCall(tenantA, outlet, { number: 4, status: "picked_up" });
    await seedCall(tenantA, outlet, {
      number: 5,
      status: "called",
      businessDate: dayBefore(today),
    });
    const voided = await seedCall(tenantA, outlet, {
      number: 6,
      status: "called",
    });
    await voidOrder(tenantA, voided.orderId);

    const feed = await readPickupDisplay(ctxA(), outlet, new Date());
    expect(pickupDisplaySchema.parse(feed)).toEqual(feed);
    expect(feed.tenantId).toBe(tenantA.tenantId);
    expect(feed.outletId).toBe(outlet);
    expect(feed.calls.every((c) => c.status === "called")).toBe(true);
    expect(feed.calls.every((c) => c.businessDate === today)).toBe(true);
    expect(feed.calls.map((c) => c.number)).toEqual([2, 1]);
    // Each feed row carries its display code next to the number.
    expect(feed.calls.map((c) => c.code)).toEqual(["A-002", "A-001"]);
  });

  it("the feed shows letter codes past 999 and keeps the number", async () => {
    const outlet = await createOutlet(tenantA);
    await seedCall(tenantA, outlet, {
      number: 999,
      status: "called",
      calledAt: "2031-03-15T10:00:00.000Z",
    });
    await seedCall(tenantA, outlet, {
      number: 1000,
      status: "called",
      calledAt: "2031-03-15T10:10:00.000Z",
    });
    const feed = await readPickupDisplay(ctxA(), outlet, new Date());
    expect(pickupDisplaySchema.parse(feed)).toEqual(feed);
    expect(feed.calls.map((c) => [c.number, c.code])).toEqual([
      [1000, "B-001"],
      [999, "A-999"],
    ]);
  });

  it("a number moves onto the feed when called and off it when picked up", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, { number: 1 });
    const numbers = async () =>
      (await readPickupDisplay(ctxA(), outlet, new Date())).calls.map(
        (c) => c.number,
      );
    expect(await numbers()).toEqual([]);
    await applyPickupAction(ctxA(), outlet, callId, "call", new Date());
    expect(await numbers()).toEqual([1]);
    await applyPickupAction(ctxA(), outlet, callId, "pickup", new Date());
    expect(await numbers()).toEqual([]);
  });

  it("an empty outlet answers 200 with empty lists", async () => {
    const outlet = await createOutlet(tenantA);
    const feed = await readPickupDisplay(ctxA(), outlet, new Date());
    expect(feed.calls).toEqual([]);
  });

  it("an unknown outlet is 404", async () => {
    await expect(
      readPickupDisplay(ctxA(), randomUUID(), new Date()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ---- Promotions on the feed --------------------------------------------------

describe("pickup display promotions", () => {
  const SAFE_KEYS = [
    "body",
    "id",
    "outletId",
    "tenantId",
    "title",
    "validUntil",
  ];
  const FORBIDDEN = [
    "codeHash",
    "code_hash",
    "budgetIdr",
    "spentIdr",
    "quotaTotal",
    "quotaPerCustomer",
    "usesTotal",
    "voucherRequired",
  ];

  it("shows active, running, ungated promotions and nothing else", async () => {
    // A tenant of its own: the feed is tenant wide, so the exact set is known.
    const promoTenant = await createIsolatedTenant(
      `pup-${randomUUID().slice(0, 6)}`,
    );
    const outlet = promoTenant.outletId;
    const otherOutlet = await createOutlet(promoTenant);
    const hour = 3_600_000;

    const shown = await seedPromo(promoTenant, {
      name: "Promo tampil",
      priority: 5,
      quotaTotal: 100,
      quotaPerCustomer: 2,
      budgetIdr: 5_000_000,
      endsAt: new Date(Date.now() + hour),
    });
    const openEnded = await seedPromo(promoTenant, {
      name: "Promo tanpa akhir",
      priority: 1,
    });
    const onlyHere = await seedPromo(promoTenant, {
      name: "Promo khusus outlet ini",
      outletScope: "only",
      priority: 0,
    });
    await setPromoOutlet(promoTenant, onlyHere, outlet, true);

    // Excluded.
    const off = await seedPromo(promoTenant, { name: "Dimatikan outlet" });
    await setPromoOutlet(promoTenant, off, outlet, false);
    const onlyElsewhere = await seedPromo(promoTenant, {
      name: "Khusus outlet lain",
      outletScope: "only",
    });
    await setPromoOutlet(promoTenant, onlyElsewhere, otherOutlet, true);
    await seedPromo(promoTenant, {
      name: "Allowlist tanpa baris",
      outletScope: "only",
    });
    await seedPromo(promoTenant, { name: "Pakai kode", codeHash: HASH });
    await seedPromo(promoTenant, {
      name: "Wajib voucher",
      codeHash: "b".repeat(64),
      voucherRequired: true,
    });
    await seedPromo(promoTenant, { name: "Draft", status: "draft" });
    await seedPromo(promoTenant, { name: "Dijeda", status: "paused" });
    await seedPromo(promoTenant, { name: "Selesai", status: "ended" });
    await seedPromo(promoTenant, {
      name: "Kedaluwarsa",
      startsAt: new Date(Date.now() - 3 * hour),
      endsAt: new Date(Date.now() - hour),
    });
    await seedPromo(promoTenant, {
      name: "Belum mulai",
      startsAt: new Date(Date.now() + hour),
    });
    // Another tenant's promotion never shows.
    await seedPromo(tenantB, { name: "Promo tenant lain" });

    const feed = await readPickupDisplay(
      contextOf(promoTenant.tenantId),
      outlet,
      new Date(),
    );
    expect(feed.promotions.map((p) => p.id)).toEqual([
      shown,
      openEnded,
      onlyHere,
    ]);
    expect(feed.promotions.map((p) => p.title)).toEqual([
      "Promo tampil",
      "Promo tanpa akhir",
      "Promo khusus outlet ini",
    ]);
    expect(feed.promotions[1]?.validUntil).toBeNull();
    expect(feed.promotions[0]?.validUntil).not.toBeNull();
  });

  it("the JSON carries exactly the display-safe keys and never campaign internals", async () => {
    const promoTenant = await createIsolatedTenant(
      `pus-${randomUUID().slice(0, 6)}`,
    );
    await seedPromo(promoTenant, {
      name: "Promo aman",
      quotaTotal: 10,
      quotaPerCustomer: 1,
      budgetIdr: 1_000_000,
    });
    await seedPromo(promoTenant, { name: "Promo berkode", codeHash: HASH });
    const roleId = randomUUID();
    await insertRole(promoTenant.tenantId, roleId, "Pickup Promo Operator", [
      "kds.expo.operate",
    ]);
    const viewer = await member(
      promoTenant,
      roleId,
      { type: "tenant", id: null },
      "Pickup Promo Viewer",
    );

    const response = await api(
      viewer,
      promoTenant,
      promoTenant.outletId,
    ).display();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const promotions = response.body.data.promotions as Record<
      string,
      unknown
    >[];
    expect(promotions).toHaveLength(1);
    expect(Object.keys(promotions[0]!).sort()).toEqual(SAFE_KEYS);
    const text = JSON.stringify(response.body);
    for (const key of FORBIDDEN) expect(text).not.toContain(key);
    expect(text).not.toContain(HASH);
  });

  it("the internal [ai:<id>] marker never reaches the feed body; an empty body falls back to the title", async () => {
    const promoTenant = await createIsolatedTenant(
      `pum-${randomUUID().slice(0, 6)}`,
    );
    const withText = await seedPromo(promoTenant, {
      name: "Promo AI",
      description: `Diskon akhir pekan\n[ai:${randomUUID()}]`,
      priority: 2,
    });
    const onlyMarker = await seedPromo(promoTenant, {
      name: "Promo hanya penanda",
      description: `[ai:${randomUUID()}]`,
      priority: 1,
    });
    const feed = await readPickupDisplay(
      contextOf(promoTenant.tenantId),
      promoTenant.outletId,
      new Date(),
    );
    const body = (id: string) => feed.promotions.find((p) => p.id === id)?.body;
    expect(body(withText)).toBe("Diskon akhir pekan");
    expect(body(onlyMarker)).toBe("Promo hanya penanda");
    expect(JSON.stringify(feed)).not.toContain("[ai:");
  });

  it("a promotion with used-up quota or budget is not shown; unused quota still is", async () => {
    const promoTenant = await createIsolatedTenant(
      `puq-${randomUUID().slice(0, 6)}`,
    );
    const quotaLeft = await seedPromo(promoTenant, {
      name: "Kuota tersisa",
      quotaTotal: 10,
      usesTotal: 9,
      budgetIdr: 1_000_000,
      spentIdr: 999_999,
    });
    await seedPromo(promoTenant, {
      name: "Kuota habis",
      quotaTotal: 10,
      usesTotal: 10,
    });
    await seedPromo(promoTenant, {
      name: "Anggaran habis",
      budgetIdr: 1_000_000,
      spentIdr: 1_000_000,
    });
    const feed = await readPickupDisplay(
      contextOf(promoTenant.tenantId),
      promoTenant.outletId,
      new Date(),
    );
    expect(feed.promotions.map((p) => p.id)).toEqual([quotaLeft]);
  });

  it("a time_window or channel condition hides the promotion; min_spend still shows it", async () => {
    const promoTenant = await createIsolatedTenant(
      `puc-${randomUUID().slice(0, 6)}`,
    );
    const minSpend = await seedPromo(promoTenant, {
      name: "Minimal belanja",
      conditions: [{ kind: "min_spend", amountIdr: 50_000 }],
    });
    await seedPromo(promoTenant, {
      name: "Happy hour",
      conditions: [
        {
          kind: "time_window",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          start: "17:00",
          end: "19:00",
        },
      ],
    });
    await seedPromo(promoTenant, {
      name: "Khusus kanal",
      conditions: [
        { kind: "min_spend", amountIdr: 50_000 },
        { kind: "channel", channels: ["gofood"] },
      ],
    });
    const feed = await readPickupDisplay(
      contextOf(promoTenant.tenantId),
      promoTenant.outletId,
      new Date(),
    );
    expect(feed.promotions.map((p) => p.id)).toEqual([minSpend]);
  });

  it("a long description is cut to 280 characters", async () => {
    const promoTenant = await createIsolatedTenant(
      `pul-${randomUUID().slice(0, 6)}`,
    );
    await seedPromo(promoTenant, {
      name: "Promo panjang",
      description: "x".repeat(900),
    });
    const feed = await readPickupDisplay(
      contextOf(promoTenant.tenantId),
      promoTenant.outletId,
      new Date(),
    );
    expect(feed.promotions[0]?.body).toHaveLength(280);
  });
});

// ---- Routes ------------------------------------------------------------------

describe("pickup routes", () => {
  it("an operator reads the feed, calls and marks picked up over HTTP", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, { number: 21 });
    const http = api(operator, tenantA, outlet);

    const before = await http.display();
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(pickupDisplaySchema.parse(before.body.data).calls).toEqual([]);

    const called = await http.call(callId);
    expect(called.status, JSON.stringify(called.body)).toBe(200);
    expect(called.body.data).toMatchObject({
      id: callId,
      number: 21,
      code: "A-021",
      status: "called",
    });
    const calledAt = called.body.data.calledAt as string;
    expect((await http.call(callId)).body.data.calledAt).toBe(calledAt);

    const during = await http.display();
    expect(
      pickupDisplaySchema.parse(during.body.data).calls.map((c) => c.number),
    ).toEqual([21]);

    const early = await http.pickup(callId);
    expect(early.status, JSON.stringify(early.body)).toBe(200);
    expect(early.body.data.status).toBe("picked_up");
    const closed = await http.call(callId);
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe("PICKUP_CALL_CLOSED");
  });

  it("pickup from assigned over HTTP is 409 PICKUP_CALL_NOT_CALLED", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, { number: 22 });
    const response = await api(operator, tenantA, outlet).pickup(callId);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PICKUP_CALL_NOT_CALLED");
  });

  it("an unknown call id is 404 over HTTP", async () => {
    const response = await api(operator, tenantA, outletA1).call(randomUUID());
    expect(response.status).toBe(404);
  });

  it("a user without kds.expo.operate gets 403 on every route", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, {
      number: 23,
      status: "called",
    });
    const http = api(noAccess, tenantA, outlet);
    expect((await http.display()).status).toBe(403);
    expect((await http.call(callId)).status).toBe(403);
    expect((await http.pickup(callId)).status).toBe(403);
    // And nothing changed.
    const rows = await asOwnerTenant(tenantA.tenantId, (client) =>
      client.query<{ status: string }>(
        "SELECT status FROM pickup_calls WHERE id = $1",
        [callId],
      ),
    );
    expect(rows.rows[0]?.status).toBe("called");
  });

  it("an operator limited to outlet A1 gets 403 for outlet A2", async () => {
    const { callId } = await seedCall(tenantA, outletA2, {
      number: 24,
      status: "called",
    });
    const http = api(operatorA1, tenantA, outletA2);
    expect((await http.display()).status).toBe(403);
    expect((await http.call(callId)).status).toBe(403);
    expect((await http.pickup(callId)).status).toBe(403);
    // The same operator may use its own outlet.
    expect((await api(operatorA1, tenantA, outletA1).display()).status).toBe(
      200,
    );
  });

  it("an anonymous caller gets 401 on every route", async () => {
    const http = api(null, tenantA, outletA1);
    const callId = randomUUID();
    expect((await http.display()).status).toBe(401);
    expect((await http.call(callId)).status).toBe(401);
    expect((await http.pickup(callId)).status).toBe(401);
  });

  it("a mutation from an untrusted or missing origin is 403 and changes nothing", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, { number: 25 });
    for (const headers of [
      { Origin: "https://evil.example" },
      {} as Record<string, string>,
    ]) {
      const http = api(operator, tenantA, outlet, headers);
      const called = await http.call(callId);
      expect(called.status, JSON.stringify(called.body)).toBe(403);
      expect(called.body.error.code).toBe("FORBIDDEN_ORIGIN");
      expect((await http.pickup(callId)).status).toBe(403);
    }
    const rows = await asOwnerTenant(tenantA.tenantId, (client) =>
      client.query<{ status: string }>(
        "SELECT status FROM pickup_calls WHERE id = $1",
        [callId],
      ),
    );
    expect(rows.rows[0]?.status).toBe("assigned");
  });

  it("another tenant's operator cannot read or act on this tenant's outlet or call", async () => {
    const outlet = await createOutlet(tenantA);
    const { callId } = await seedCall(tenantA, outlet, {
      number: 26,
      status: "called",
    });
    // Tenant B host with tenant A's outlet and call, and tenant A's host with
    // a tenant B account: either way the call is neither shown nor changed.
    const viaOwnHost = api(operatorB, tenantB, outlet);
    const viaForeignHost = api(operatorB, tenantA, outlet);
    for (const http of [viaOwnHost, viaForeignHost]) {
      for (const response of [
        await http.display(),
        await http.call(callId),
        await http.pickup(callId),
      ])
        expect([403, 404], JSON.stringify(response.body)).toContain(
          response.status,
        );
    }
    const own = await api(operatorB, tenantB, outletB1).display();
    expect(own.status).toBe(200);
    expect(own.body.data.calls).toEqual([]);
    const rows = await asOwnerTenant(tenantA.tenantId, (client) =>
      client.query<{ status: string }>(
        "SELECT status FROM pickup_calls WHERE id = $1",
        [callId],
      ),
    );
    expect(rows.rows[0]?.status).toBe("called");
  });
});
