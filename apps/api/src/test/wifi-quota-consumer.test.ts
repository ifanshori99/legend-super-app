// legend-kmd3 S2: the Wi-Fi spend ledger, the daily quota and the outbox
// consumer (`deliverWifiQuotaEvent`, brief docs/briefs/sub-kmd3-wifi-quota.md
// design 1-10; PRD v1.7 §3 F25, FAC-12/13/14).
//
// Events are synthetic envelopes delivered through
// `withTenant(db, ctx, tx => deliverWifiQuotaEvent(ctx, event, tx, now))`
// (pattern of member-earn.test.ts). Fixtures are raw SQL as the migration
// owner; every tenant is fresh, so ledger and sessions never leak across tests.
//
// Assumptions:
// - NOW is Tuesday 14:30 in Jakarta (business date 2026-11-10, off-peak with
//   the seeded schedule 11:30-14:00 / 18:00-21:00 on weekdays).
// - The refund event of `member-loyalty-helpers` carries its own (later)
//   business date; the quota is recomputed for the date of the PAID entry.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ulidToUuid, type OutletId } from "@starter/shared/core";
import type { WifiPolicy } from "@starter/shared/facility";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  installWifiEnforcement,
  type WifiEnforcement,
} from "../edge/wifi/port.ts";
import { deliverWifiQuotaEvent } from "../services/wifi-quota-consumer.ts";
import {
  accrueUsage,
  applyWifiQuotaToEdge,
  computeAccountQuota,
} from "../services/wifi-quota.service.ts";
import {
  asTenant,
  createWorld,
  hex64,
  orderPaidEvent,
  orderRefundedEvent,
  orderVoidedEvent,
  outboxEvents,
  owner,
  seedMember,
  seedOrder,
  type World,
} from "./member-loyalty-helpers.ts";

afterAll(async () => {
  await owner.end();
});

afterEach(() => {
  installWifiEnforcement(null);
});

const NOW = new Date("2026-11-10T07:30:00Z");
const TODAY = "2026-11-10";
const YESTERDAY = "2026-11-09";
/** End of business day 2026-11-10 (04:00 Jakarta on the 11th). */
const DAY_END = "2026-11-10T21:00:00.000Z";

type Setup = {
  world: World;
  zoneId: string;
  policyId: string;
};

async function setup(
  options: { spendMode?: "per_day_multiple" | "per_order" | null } = {},
): Promise<Setup> {
  const world = await createWorld();
  const zoneId = randomUUID();
  const policyId = randomUUID();
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
       VALUES ($1, $2, $3, 'Zona Wifi', 'pay_first', '[]')`,
      [zoneId, world.tenantId, world.outletA],
    );
    await client.query(
      `INSERT INTO wifi_policies
         (id, tenant_id, outlet_id, zone_id, free_minutes, peak_free_minutes,
          spend_per_extra_hour_idr, extra_minutes, max_devices, peak_schedule,
          base_speed_kbps, full_speed_kbps, tier_bonus_minutes, spend_mode)
       VALUES ($1, $2, $3, $4, 120, 60, 30000, 60, 2, $5, 2000, 20000, $6, $7)`,
      [
        policyId,
        world.tenantId,
        world.outletA,
        zoneId,
        JSON.stringify([
          { daysOfWeek: [1, 2, 3, 4, 5], startsAt: "11:30", endsAt: "14:00" },
          { daysOfWeek: [1, 2, 3, 4, 5], startsAt: "18:00", endsAt: "21:00" },
          { daysOfWeek: [0, 6], startsAt: "00:00", endsAt: "24:00" },
        ]),
        JSON.stringify({ gold: 60, platinum: 120 }),
        options.spendMode ?? null,
      ],
    );
  });
  return { world, zoneId, policyId };
}

type SessionSeed = {
  profileId: string;
  quota?: number;
  used?: number;
  speedTier?: "full" | "base";
  businessDate?: string;
  accruedAt?: Date;
  outletId?: string;
};

async function seedSession(s: Setup, seed: SessionSeed): Promise<string> {
  const id = randomUUID();
  const accrued = seed.accruedAt ?? NOW;
  await asTenant(s.world.tenantId, (client) =>
    client.query(
      `INSERT INTO wifi_sessions
         (id, tenant_id, outlet_id, customer_profile_id, zone_id, policy_id,
          device_hash, business_date, quota_minutes, used_minutes, speed_tier,
          started_at, accrued_at, quota_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $12)`,
      [
        id,
        s.world.tenantId,
        seed.outletId ?? s.world.outletA,
        seed.profileId,
        s.zoneId,
        s.policyId,
        hex64(),
        seed.businessDate ?? TODAY,
        seed.quota ?? 120,
        seed.used ?? 0,
        seed.speedTier ?? "full",
        accrued.toISOString(),
      ],
    ),
  );
  return id;
}

type SessionState = {
  quota_minutes: number;
  used_minutes: number;
  speed_tier: string;
  ended_at: Date | null;
  accrued_at: Date;
};

async function sessionOf(
  tenantId: string,
  sessionId: string,
): Promise<SessionState> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<SessionState>(
      `SELECT quota_minutes, used_minutes, speed_tier, ended_at, accrued_at
         FROM wifi_sessions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, sessionId],
    );
    return rows[0]!;
  });
}

type EntryRow = {
  kind: string;
  source_id: string;
  amount_idr: string;
  business_date: string;
  customer_profile_id: string;
};

async function entriesOf(tenantId: string): Promise<EntryRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<EntryRow>(
      `SELECT kind, source_id, amount_idr::text, business_date::text, customer_profile_id
         FROM wifi_spend_entries WHERE tenant_id = $1 ORDER BY created_at, kind`,
      [tenantId],
    );
    return rows;
  });
}

function deliver(world: World, event: EventEnvelope, now = NOW) {
  return withTenant(db, world.context, (tx) =>
    deliverWifiQuotaEvent(world.context, event, tx, now),
  );
}

/** Seeds an order of the member and the `order.paid` event for it. */
async function pay(
  s: Setup,
  profileId: string | null,
  input: {
    cash?: number;
    gateway?: number;
    edc?: number;
    points?: number;
    businessDate?: string;
    training?: boolean;
    outletId?: string;
  } = {},
) {
  const outletId = input.outletId ?? s.world.outletA;
  const cash = input.cash ?? 45_000;
  const gateway = input.gateway ?? 0;
  const edc = input.edc ?? 0;
  const points = input.points ?? 0;
  const gross = cash + gateway + edc + points;
  const orderUlid = await seedOrder(s.world.tenantId, {
    outletId,
    profileId,
    grossSalesIdr: gross,
    businessDate: input.businessDate ?? TODAY,
    // A final order's pos_orders row is immutable: flag the practice order first.
    status: input.training ? "draft" : "completed",
  });
  if (input.training)
    await asTenant(s.world.tenantId, (client) =>
      client.query(
        "UPDATE pos_orders SET is_training = true WHERE tenant_id = $1 AND order_id = $2",
        [s.world.tenantId, ulidToUuid(orderUlid)],
      ),
    );
  const base = orderPaidEvent(s.world, {
    orderUlid,
    outletId,
    grossSalesIdr: gross,
    businessDate: input.businessDate ?? TODAY,
    paidAt: NOW.toISOString(),
    paidPointsIdr: points,
  });
  const event = {
    ...base,
    payload: {
      ...base.payload,
      paidCashIdr: cash,
      paidGatewayIdr: gateway,
      paidEdcIdr: edc,
    },
  } as EventEnvelope;
  await deliver(s.world, event);
  return { orderUlid, event };
}

function refundEvent(
  s: Setup,
  orderUlid: string,
  amountIdr: number,
  refundId: `${string}-${string}-${string}-${string}-${string}` = randomUUID(),
): EventEnvelope {
  return orderRefundedEvent(s.world, {
    orderUlid,
    outletId: s.world.outletA,
    refundId,
    grossSalesIdr: amountIdr,
  });
}

function fakeAgent() {
  const applySession = vi.fn(async () => undefined);
  const endSession = vi.fn(async () => undefined);
  installWifiEnforcement({
    applySession,
    endSession,
  } as unknown as WifiEnforcement);
  return { applySession, endSession };
}

describe("wifi spend ledger (design 1-2)", () => {
  it("records money spend only (cash + gateway + EDC), one row per order, replay safe", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const { event, orderUlid } = await pay(s, member.id, {
      cash: 10_000,
      gateway: 20_000,
      edc: 15_000,
      points: 5_000,
    });
    await deliver(s.world, event);
    await deliver(s.world, event);
    const rows = await entriesOf(s.world.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "paid",
      source_id: orderUlid,
      amount_idr: "45000",
      business_date: TODAY,
      customer_profile_id: member.id,
    });
  });

  it("ignores an order without a member, a practice order and a points-only order", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    await pay(s, null);
    await pay(s, member.id, { points: 30_000, cash: 0 });
    await pay(s, member.id, { training: true });
    expect(await entriesOf(s.world.tenantId)).toEqual([]);
  });

  it("ignores a malformed payload and an event of another tenant", async () => {
    const s = await setup();
    const other = await setup();
    const member = await seedMember(s.world.tenantId);
    const { event } = await pay(s, member.id);
    const broken = {
      ...event,
      payload: { orderId: "nope" },
    } as unknown as EventEnvelope;
    await deliver(s.world, broken);
    // Context of another tenant: the event is dropped, nothing is written there.
    await deliver(other.world, event);
    expect(await entriesOf(other.world.tenantId)).toEqual([]);
    expect(await entriesOf(s.world.tenantId)).toHaveLength(1);
  });

  it("books a refund once, keyed by refund id, against the paid entry", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const { orderUlid } = await pay(s, member.id, { cash: 60_000 });
    const refundId = randomUUID();
    const refund = refundEvent(s, orderUlid, 30_000, refundId);
    await deliver(s.world, refund);
    await deliver(s.world, refund);
    const rows = await entriesOf(s.world.tenantId);
    expect(
      rows.map((row) => [row.kind, row.source_id, row.amount_idr]),
    ).toEqual([
      ["paid", orderUlid, "60000"],
      ["refund", refundId, "30000"],
    ]);
  });

  it("ignores a refund of an order that has no paid entry", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const orderUlid = await seedOrder(s.world.tenantId, {
      outletId: s.world.outletA,
      profileId: member.id,
    });
    await deliver(s.world, refundEvent(s, orderUlid, 10_000));
    expect(await entriesOf(s.world.tenantId)).toEqual([]);
  });

  it("a final void books a full refund of the remaining net paid, once, keyed by void id", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const sessionId = await seedSession(s, { profileId: member.id });
    const { orderUlid } = await pay(s, member.id, { cash: 60_000 });
    await deliver(s.world, refundEvent(s, orderUlid, 20_000));
    const voidId = randomUUID();
    const voided = orderVoidedEvent(s.world, {
      orderUlid,
      outletId: s.world.outletA,
      voidId,
      voidedFinalOrder: true,
    });
    await deliver(s.world, voided);
    await deliver(s.world, voided);
    const rows = await entriesOf(s.world.tenantId);
    expect(rows.filter((row) => row.source_id === voidId)).toEqual([
      expect.objectContaining({ kind: "refund", amount_idr: "40000" }),
    ]);
    expect(rows).toHaveLength(3);
    // Net spend is zero: only the free hours remain.
    expect((await sessionOf(s.world.tenantId, sessionId)).quota_minutes).toBe(
      120,
    );
  });

  it("ignores a void that is not final, has no void id or has no paid entry", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const { orderUlid } = await pay(s, member.id, { cash: 60_000 });
    await deliver(
      s.world,
      orderVoidedEvent(s.world, {
        orderUlid,
        outletId: s.world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: false,
      }),
    );
    await deliver(
      s.world,
      orderVoidedEvent(s.world, {
        orderUlid,
        outletId: s.world.outletA,
        voidId: null,
        voidedFinalOrder: true,
      }),
    );
    const unpaid = await seedOrder(s.world.tenantId, {
      outletId: s.world.outletA,
      profileId: member.id,
    });
    await deliver(
      s.world,
      orderVoidedEvent(s.world, {
        orderUlid: unpaid,
        outletId: s.world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );
    expect(await entriesOf(s.world.tenantId)).toHaveLength(1);
  });

  it("a void of an already fully refunded order books nothing", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const { orderUlid } = await pay(s, member.id, { cash: 60_000 });
    await deliver(s.world, refundEvent(s, orderUlid, 60_000));
    await deliver(
      s.world,
      orderVoidedEvent(s.world, {
        orderUlid,
        outletId: s.world.outletA,
        voidId: randomUUID(),
        voidedFinalOrder: true,
      }),
    );
    expect(await entriesOf(s.world.tenantId)).toHaveLength(2);
  });
});

describe("quota recompute from spend (design 3, 8)", () => {
  it("adds an hour for Rp45.000 to the open session and emits wifi_quota.updated", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const sessionId = await seedSession(s, { profileId: member.id });
    await pay(s, member.id, { cash: 45_000 });
    expect(await sessionOf(s.world.tenantId, sessionId)).toMatchObject({
      quota_minutes: 180,
      speed_tier: "full",
      ended_at: null,
    });
    const events = await outboxEvents(
      s.world.tenantId,
      "wifi_quota.updated",
      member.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      sessionId,
      zoneId: s.zoneId,
      quotaMinutes: 180,
      speedTier: "full",
      reason: "spend",
    });
  });

  it("per_day_multiple: Rp20.000 + Rp20.000 earns an hour; per_order earns nothing", async () => {
    const multiple = await setup({ spendMode: "per_day_multiple" });
    const a = await seedMember(multiple.world.tenantId);
    const sessionA = await seedSession(multiple, { profileId: a.id });
    await pay(multiple, a.id, { cash: 20_000 });
    await pay(multiple, a.id, { cash: 20_000 });
    expect(
      (await sessionOf(multiple.world.tenantId, sessionA)).quota_minutes,
    ).toBe(180);

    const perOrder = await setup({ spendMode: "per_order" });
    const b = await seedMember(perOrder.world.tenantId);
    const sessionB = await seedSession(perOrder, { profileId: b.id });
    await pay(perOrder, b.id, { cash: 20_000 });
    await pay(perOrder, b.id, { cash: 20_000 });
    expect(
      (await sessionOf(perOrder.world.tenantId, sessionB)).quota_minutes,
    ).toBe(120);
    await pay(perOrder, b.id, { cash: 45_000 });
    expect(
      (await sessionOf(perOrder.world.tenantId, sessionB)).quota_minutes,
    ).toBe(180);
  });

  it("recomputes every open session of the account for that business date only", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const phone = await seedSession(s, { profileId: member.id });
    const laptop = await seedSession(s, { profileId: member.id });
    const otherMember = await seedMember(s.world.tenantId);
    const stranger = await seedSession(s, { profileId: otherMember.id });
    await pay(s, member.id, { cash: 90_000 });
    expect((await sessionOf(s.world.tenantId, phone)).quota_minutes).toBe(300);
    expect((await sessionOf(s.world.tenantId, laptop)).quota_minutes).toBe(300);
    expect((await sessionOf(s.world.tenantId, stranger)).quota_minutes).toBe(
      120,
    );
  });

  it("a refund lowers the quota below usage: throttled to base, never ended (FAC-13)", async () => {
    const s = await setup();
    const agent = fakeAgent();
    const member = await seedMember(s.world.tenantId);
    const sessionId = await seedSession(s, {
      profileId: member.id,
      quota: 120,
      used: 100,
    });
    const { orderUlid } = await pay(s, member.id, { cash: 60_000 });
    // 120 free + 120 spend = 240; usage 100 -> still full.
    expect(await sessionOf(s.world.tenantId, sessionId)).toMatchObject({
      quota_minutes: 240,
      speed_tier: "full",
    });
    await asTenant(s.world.tenantId, (client) =>
      client.query(
        "UPDATE wifi_sessions SET used_minutes = 200 WHERE tenant_id = $1 AND id = $2",
        [s.world.tenantId, sessionId],
      ),
    );
    await deliver(s.world, refundEvent(s, orderUlid, 60_000));
    const after = await sessionOf(s.world.tenantId, sessionId);
    expect(after).toMatchObject({
      quota_minutes: 120,
      used_minutes: 200,
      speed_tier: "base",
      ended_at: null,
    });
    const events = await outboxEvents(
      s.world.tenantId,
      "wifi_quota.updated",
      member.id,
    );
    expect(events.at(-1)!.payload).toMatchObject({
      speedTier: "base",
      reason: "quota_spent",
    });
    expect(agent.endSession).not.toHaveBeenCalled();
  });

  it("a partial refund nets the order: Rp60.000 - Rp30.000 = one extra hour", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const sessionId = await seedSession(s, { profileId: member.id });
    const { orderUlid } = await pay(s, member.id, { cash: 60_000 });
    await deliver(s.world, refundEvent(s, orderUlid, 30_000));
    expect((await sessionOf(s.world.tenantId, sessionId)).quota_minutes).toBe(
      180,
    );
  });

  it("applies the tier bonus from loyalty_tiers (lowercased name)", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const tierId = randomUUID();
    await asTenant(s.world.tenantId, async (client) => {
      await client.query(
        `INSERT INTO loyalty_tiers (id, tenant_id, name, rank, threshold_spend_idr, threshold_visits, benefits)
         VALUES ($1, $2, 'Gold', 1, 0, 0, '{}')`,
        [tierId, s.world.tenantId],
      );
      await client.query(
        "UPDATE customer_profiles SET tier_id = $3 WHERE tenant_id = $1 AND id = $2",
        [s.world.tenantId, member.id, tierId],
      );
    });
    const sessionId = await seedSession(s, { profileId: member.id });
    await pay(s, member.id, { cash: 45_000 });
    expect((await sessionOf(s.world.tenantId, sessionId)).quota_minutes).toBe(
      240,
    );
  });

  it("accrues elapsed minutes before the recompute", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const sessionId = await seedSession(s, {
      profileId: member.id,
      used: 10,
      accruedAt: new Date(NOW.getTime() - 90 * 60_000 - 30_000),
    });
    await pay(s, member.id, { cash: 45_000 });
    const after = await sessionOf(s.world.tenantId, sessionId);
    expect(after.used_minutes).toBe(100);
    expect(after.accrued_at.toISOString()).toBe("2026-11-10T07:29:30.000Z");
  });

  it("another tenant's sessions are untouched", async () => {
    const s = await setup();
    const other = await setup();
    const member = await seedMember(s.world.tenantId);
    const stranger = await seedMember(other.world.tenantId);
    const mine = await seedSession(s, { profileId: member.id });
    const theirs = await seedSession(other, { profileId: stranger.id });
    await pay(s, member.id, { cash: 90_000 });
    expect((await sessionOf(s.world.tenantId, mine)).quota_minutes).toBe(300);
    expect((await sessionOf(other.world.tenantId, theirs)).quota_minutes).toBe(
      120,
    );
  });

  it("ends a session of a closed business day with day_closed", async () => {
    const s = await setup();
    const agent = fakeAgent();
    const member = await seedMember(s.world.tenantId);
    const stale = await seedSession(s, {
      profileId: member.id,
      businessDate: YESTERDAY,
    });
    await pay(s, member.id, { cash: 45_000, businessDate: YESTERDAY });
    expect((await sessionOf(s.world.tenantId, stale)).ended_at).not.toBeNull();
    expect(agent.endSession).toHaveBeenCalledWith(expect.anything(), {
      outletId: s.world.outletA,
      wifiSessionId: stale,
      reason: "day_closed",
    });
    expect(agent.applySession).not.toHaveBeenCalled();
  });
});

describe("edge enforcement (design 7)", () => {
  async function grantFor(s: Setup, sessionId: string, mac: string) {
    await asTenant(s.world.tenantId, (client) =>
      client.query(
        `INSERT INTO wifi_device_grants
           (id, tenant_id, outlet_id, wifi_session_id, device_hash, controller_device_id,
            speed_tier, bandwidth_kbps, base_bandwidth_kbps, duration_seconds, status,
            renew_until, requested_at, authorized_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'full', 20000, 2000, 3900, 'active',
                 now() + interval '8 hours', now(), now(), now() + interval '65 minutes')`,
        [
          randomUUID(),
          s.world.tenantId,
          s.world.outletA,
          sessionId,
          hex64(),
          mac,
        ],
      ),
    );
  }

  it("re-applies the new quota at the edge with the controller id of the live grant", async () => {
    const s = await setup();
    const agent = fakeAgent();
    const member = await seedMember(s.world.tenantId);
    const sessionId = await seedSession(s, { profileId: member.id });
    await grantFor(s, sessionId, "aa:bb:cc:dd:ee:ff");
    await pay(s, member.id, { cash: 45_000 });
    expect(agent.applySession).toHaveBeenCalledTimes(1);
    expect(agent.applySession).toHaveBeenCalledWith(expect.anything(), {
      outletId: s.world.outletA,
      wifiSessionId: sessionId,
      controllerDeviceId: "aa:bb:cc:dd:ee:ff",
      speedTier: "full",
      fullSpeedKbps: 20_000,
      baseSpeedKbps: 2_000,
      remainingSeconds: 180 * 60,
      sessionEndsAt: DAY_END,
    });
  });

  it("a spent quota is applied as base speed, with 0 seconds left", async () => {
    const s = await setup();
    const agent = fakeAgent();
    const member = await seedMember(s.world.tenantId);
    const sessionId = await seedSession(s, {
      profileId: member.id,
      used: 180,
    });
    await grantFor(s, sessionId, "aa:bb:cc:dd:ee:01");
    await pay(s, member.id, { cash: 45_000 });
    expect(agent.applySession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ speedTier: "base", remainingSeconds: 0 }),
    );
    expect(agent.endSession).not.toHaveBeenCalled();
  });

  it("without an installed agent (cloud) the event still lands and the outbox event is written", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const sessionId = await seedSession(s, { profileId: member.id });
    await grantFor(s, sessionId, "aa:bb:cc:dd:ee:02");
    await pay(s, member.id, { cash: 45_000 });
    expect((await sessionOf(s.world.tenantId, sessionId)).quota_minutes).toBe(
      180,
    );
    expect(
      await outboxEvents(s.world.tenantId, "wifi_quota.updated", member.id),
    ).toHaveLength(1);
  });

  it("applyWifiQuotaToEdge swallows WIFI_AGENT_NOT_READY and skips an unknown device", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const sessionId = await seedSession(s, { profileId: member.id });
    const row = await asTenant(s.world.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, tenant_id AS "tenantId", outlet_id AS "outletId",
                customer_profile_id AS "customerProfileId", zone_id AS "zoneId",
                policy_id AS "policyId", device_hash AS "deviceHash",
                business_date::text AS "businessDate", quota_minutes AS "quotaMinutes",
                used_minutes AS "usedMinutes", speed_tier AS "speedTier",
                started_at AS "startedAt", ended_at AS "endedAt",
                accrued_at AS "accruedAt", quota_updated_at AS "quotaUpdatedAt",
                created_at AS "createdAt", updated_at AS "updatedAt"
           FROM wifi_sessions WHERE id = $1`,
        [sessionId],
      );
      return rows[0];
    });
    const policy = {
      fullSpeedKbps: 20_000,
      baseSpeedKbps: 2_000,
    } as WifiPolicy;
    await expect(
      applyWifiQuotaToEdge(s.world.context, row, policy, "aa:bb:cc:dd:ee:03"),
    ).resolves.toBeUndefined();
    const agent = fakeAgent();
    await applyWifiQuotaToEdge(s.world.context, row, policy);
    expect(agent.applySession).not.toHaveBeenCalled();
  });
});

describe("accrueUsage (design 4)", () => {
  const base = {
    usedMinutes: 10,
    accruedAt: new Date("2026-11-10T06:00:00Z"),
    endedAt: null,
  } as Parameters<typeof accrueUsage>[0];

  it("adds whole elapsed minutes and moves accrued_at by exactly those minutes", () => {
    expect(accrueUsage(base, new Date("2026-11-10T06:05:45Z"))).toEqual({
      usedMinutes: 15,
      accruedAt: new Date("2026-11-10T06:05:00Z"),
    });
  });

  it("adds nothing under a minute, or when the clock is behind", () => {
    expect(accrueUsage(base, new Date("2026-11-10T06:00:59Z"))).toEqual({
      usedMinutes: 10,
      accruedAt: base.accruedAt,
    });
    expect(accrueUsage(base, new Date("2026-11-10T05:00:00Z"))).toEqual({
      usedMinutes: 10,
      accruedAt: base.accruedAt,
    });
  });

  it("caps at 1440 and never accrues an ended session", () => {
    expect(
      accrueUsage(
        { ...base, usedMinutes: 1430 },
        new Date("2026-11-10T08:00:00Z"),
      ).usedMinutes,
    ).toBe(1440);
    const ended = { ...base, endedAt: new Date("2026-11-10T06:01:00Z") };
    expect(accrueUsage(ended, new Date("2026-11-10T09:00:00Z"))).toEqual({
      usedMinutes: 10,
      accruedAt: base.accruedAt,
    });
  });
});

/** Zone + policy (same numbers as `setup`) at the second outlet of the world. */
async function seedOutletBPolicy(s: Setup): Promise<{
  zoneId: string;
  policyId: string;
}> {
  const zoneId = randomUUID();
  const policyId = randomUUID();
  await asTenant(s.world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
       VALUES ($1, $2, $3, 'Zona Wifi B', 'pay_first', '[]')`,
      [zoneId, s.world.tenantId, s.world.outletB],
    );
    await client.query(
      `INSERT INTO wifi_policies
         (id, tenant_id, outlet_id, zone_id, free_minutes, peak_free_minutes,
          spend_per_extra_hour_idr, extra_minutes, max_devices, peak_schedule,
          base_speed_kbps, full_speed_kbps, tier_bonus_minutes)
       VALUES ($1, $2, $3, $4, 120, 60, 30000, 60, 2, '[]', 2000, 20000, '{}')`,
      [policyId, s.world.tenantId, s.world.outletB, zoneId],
    );
  });
  return { zoneId, policyId };
}

describe("computeAccountQuota (design 3)", () => {
  const policy = {
    freeMinutes: 120,
    peakFreeMinutes: 60,
    spendPerExtraHourIdr: 30_000,
    extraMinutes: 60,
    tierBonusMinutes: { gold: 60 },
    peakSchedule: [
      { daysOfWeek: [1, 2, 3, 4, 5], startsAt: "11:30", endsAt: "14:00" },
    ],
  } as unknown as WifiPolicy;

  it("uses the peak allowance inside a peak window and the off-peak one outside", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    const compute = (now: Date) =>
      withTenant(db, s.world.context, (tx) =>
        computeAccountQuota(tx, s.world.context, {
          policy,
          outletTimeZone: "Asia/Jakarta",
          outletId: s.world.outletA as OutletId,
          customerProfileId: member.id,
          businessDate: TODAY,
          now,
        }),
      );
    // 12:00 Jakarta on a Tuesday.
    expect(await compute(new Date("2026-11-10T05:00:00Z"))).toMatchObject({
      quotaMinutes: 60,
      isPeak: true,
    });
    expect(await compute(NOW)).toMatchObject({
      quotaMinutes: 120,
      isPeak: false,
    });
  });

  it("caps at one day of minutes", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    await pay(s, member.id, { cash: 1_000_000 });
    const result = await withTenant(db, s.world.context, (tx) =>
      computeAccountQuota(tx, s.world.context, {
        policy,
        outletTimeZone: "Asia/Jakarta",
        outletId: s.world.outletA as OutletId,
        customerProfileId: member.id,
        businessDate: TODAY,
        now: NOW,
      }),
    );
    expect(result.quotaMinutes).toBe(1440);
  });

  // legend-415 finding 1: spend is per outlet. Assumption: one account, one
  // business date, two outlets of the tenant; spend at outlet A must not add
  // quota at outlet B (and the reverse), so each outlet nets only its own rows.
  it("counts only the spend of the asked outlet (no cross-outlet quota)", async () => {
    const s = await setup();
    const member = await seedMember(s.world.tenantId);
    await pay(s, member.id, { cash: 45_000, outletId: s.world.outletA });
    const quotaAt = (outletId: string) =>
      withTenant(db, s.world.context, (tx) =>
        computeAccountQuota(tx, s.world.context, {
          policy,
          outletTimeZone: "Asia/Jakarta",
          customerProfileId: member.id,
          businessDate: TODAY,
          now: NOW,
          outletId: outletId as OutletId,
        }),
      );
    // Rp45.000 at A earns one hour at A only: 120 free + 60.
    expect((await quotaAt(s.world.outletA)).quotaMinutes).toBe(180);
    expect((await quotaAt(s.world.outletB)).quotaMinutes).toBe(120);
    await pay(s, member.id, { cash: 90_000, outletId: s.world.outletB });
    expect((await quotaAt(s.world.outletA)).quotaMinutes).toBe(180);
    expect((await quotaAt(s.world.outletB)).quotaMinutes).toBe(300);
  });

  it("spend at outlet A does not raise the quota of the session at outlet B", async () => {
    const s = await setup();
    const b = await seedOutletBPolicy(s);
    const member = await seedMember(s.world.tenantId);
    const sessionA = await seedSession(s, { profileId: member.id });
    const sessionB = await seedSession(s, {
      profileId: member.id,
      outletId: s.world.outletB,
    });
    // Point the B session at the outlet-B zone and policy.
    await asTenant(s.world.tenantId, (client) =>
      client.query(
        "UPDATE wifi_sessions SET zone_id = $3, policy_id = $4 WHERE tenant_id = $1 AND id = $2",
        [s.world.tenantId, sessionB, b.zoneId, b.policyId],
      ),
    );
    await pay(s, member.id, { cash: 45_000, outletId: s.world.outletA });
    expect((await sessionOf(s.world.tenantId, sessionA)).quota_minutes).toBe(
      180,
    );
    expect((await sessionOf(s.world.tenantId, sessionB)).quota_minutes).toBe(
      120,
    );
  });
});
