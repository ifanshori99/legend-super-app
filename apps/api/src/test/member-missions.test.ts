// legend-m4p5: missions and stamp cards (brief 290c "Tes gagal-dulu", "Misi";
// 290c-slices "Slice T2"; design M5). Progress moves in the `loyalty-earn`
// consumer, after the visit row, in the same transaction.
//
// Events are synthetic `order.paid` envelopes delivered with `deliver`
// (member-loyalty-helpers.ts). Missions are seeded with raw SQL (columns of
// brief 290c-slices "Slice S"); rows are read back as the migration owner.
// Every service-level test owns a fresh tenant, so missions never leak across tests.
//
// Assumptions (the spec does not spell all of them out):
// - Test ids: missions have no LOY-xx criterion; they are named "F17 mission"
//   after PRD feature F17 (Loyalty: poin, tier, mission, ...).
// - One paid order of an eligible member is one visit / one stamp, also when
//   two orders share a business date (customer_visits is one row per order).
//   Only the stamp_card test pins the same-date case.
// - Period keys: monthly `YYYY-MM`, weekly ISO `YYYY-Www` (zero padded), both
//   from the order's BUSINESS date (not the paidAt instant); date_range
//   `<start>..<end>`, both ends inclusive.
// - weekday_visit weekdays are 0 = Sunday .. 6 = Saturday, read from the
//   business date. The "late Sunday" order is paid 2026-10-18T20:30Z, which is
//   Monday 03:30 in Jakarta, before the 04:00 cut-off: its business date is
//   still Sunday.
// - try_new_item reads the order's lines (`order_items`, one `menu_item_id`
//   per line). "Earlier paid orders" are the member's orders delivered before
//   (earlier business dates, in any period). The same item twice in one order
//   counts once. An empty `menuItemIds` means every item counts.
// - Progress is capped at the target; the bonus is posted once; a voucher
//   reward posts no points.
// - The mission voucher is valid `validDays` days (plus or minus one day: the
//   spec does not say if the clock starts at paidAt or at issue time).
// - GET /api/member/missions: an inactive mission is not listed for members;
//   a mission without progress has `progress: null` (or a zero progress row).
//   Each item is `{ mission, progress, voucherCode }`, the code is null until
//   a voucher reward is issued.
// - The HTTP test seeds wide-range missions in the shared seeded tenant (a
//   date_range from 2026-10-01 to 2099-12-31, so "now" is always inside it) and
//   removes them after the file runs.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { ulidToUuid } from "@starter/shared/core";
import { createApp } from "../app";
import { hashPromoCode } from "../services/crm-promo-engine.ts";
import { agent, originHeader } from "./helpers";
import { seededOutletA, seededTenantId } from "./floor-test-helpers";
import {
  asTenant,
  balanceOf,
  contextOf,
  createWorld,
  deliver,
  ensureConsentPolicies,
  ledgerOf,
  memberHeaders,
  newMemberUser,
  orderPaidEvent,
  owner,
  seedMember,
  seedOrder,
  seedProfile,
  seedProgram,
  short,
  type World,
} from "./member-loyalty-helpers.ts";

const created: string[] = [];

afterAll(async () => {
  if (created.length > 0)
    await asTenant(seededTenantId, async (client) => {
      await client.query(
        "DELETE FROM mission_progress WHERE tenant_id = $1 AND mission_id = ANY($2::uuid[])",
        [seededTenantId, created],
      );
      await client.query(
        "DELETE FROM missions WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [seededTenantId, created],
      );
    });
  await owner.end();
});

// ---- seeding ------------------------------------------------------------------

type MissionSeed = {
  type: "visit_count" | "try_new_item" | "weekday_visit" | "stamp_card";
  rule: Record<string, unknown>;
  reward?: Record<string, unknown>;
  period?: Record<string, unknown>;
  isActive?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
};

async function seedMission(
  tenantId: string,
  seed: MissionSeed,
): Promise<string> {
  const id = randomUUID();
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO missions
         (id, tenant_id, name, description, type, rule, reward, period, is_active,
          starts_at, ends_at, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, '', $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, 'seed', now(), now())`,
      [
        id,
        tenantId,
        `Misi uji ${short()}`,
        seed.type,
        JSON.stringify(seed.rule),
        JSON.stringify(seed.reward ?? { kind: "points", points: 100 }),
        JSON.stringify(seed.period ?? { kind: "monthly" }),
        seed.isActive ?? true,
        seed.startsAt ?? null,
        seed.endsAt ?? null,
      ],
    ),
  );
  return id;
}

const visitMission = (target: number, extra: Partial<MissionSeed> = {}) =>
  ({
    type: "visit_count",
    rule: { kind: "visit_count", targetVisits: target },
    ...extra,
  }) satisfies MissionSeed;

const weekdayMission = (
  weekdays: number[],
  target: number,
  extra: Partial<MissionSeed> = {},
) =>
  ({
    type: "weekday_visit",
    rule: { kind: "weekday_visit", weekdays, targetVisits: target },
    ...extra,
  }) satisfies MissionSeed;

const newItemMission = (
  target: number,
  menuItemIds: string[] = [],
  extra: Partial<MissionSeed> = {},
) =>
  ({
    type: "try_new_item",
    rule: { kind: "try_new_item", targetItems: target, menuItemIds },
    ...extra,
  }) satisfies MissionSeed;

const stampMission = (stamps: number, extra: Partial<MissionSeed> = {}) =>
  ({
    type: "stamp_card",
    rule: { kind: "stamp_card", stampsRequired: stamps },
    ...extra,
  }) satisfies MissionSeed;

async function worldWithProgram(): Promise<World> {
  const world = await createWorld();
  await seedProgram(world.tenantId);
  return world;
}

/** Menu items of the world's brand (for try_new_item). */
async function seedMenu(world: World, count: number): Promise<string[]> {
  const categoryId = randomUUID();
  const ids = Array.from({ length: count }, () => randomUUID());
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Kategori Misi', 0)`,
      [categoryId, world.tenantId, world.brandId],
    );
    for (const [index, id] of ids.entries())
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [
          id,
          world.tenantId,
          world.brandId,
          categoryId,
          `Menu ${index} ${short()}`,
        ],
      );
  });
  return ids;
}

type PayOptions = {
  items?: string[];
  grossSalesIdr?: number;
  paidAt?: string;
  businessDate?: string;
  outletId?: string;
};

/** Seeds an order (with lines) and delivers `order.paid` for the member. */
async function payOn(
  world: World,
  member: { id: string },
  date: string,
  options: PayOptions = {},
) {
  const outletId = options.outletId ?? world.outletA;
  const paidAt = options.paidAt ?? `${date}T05:00:00.000Z`;
  const businessDate = options.businessDate ?? date;
  const grossSalesIdr = options.grossSalesIdr ?? 100_000;
  const orderUlid = await seedOrder(world.tenantId, {
    outletId,
    profileId: member.id,
    grossSalesIdr,
    businessDate,
  });
  const items = options.items ?? [];
  if (items.length > 0)
    await asTenant(world.tenantId, async (client) => {
      for (const menuItemId of items)
        await client.query(
          `INSERT INTO order_items
             (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
              unit_price_idr, modifiers_total_idr, line_total_idr, fire_status, status,
              reserved_business_date)
           VALUES ($1, $2, $3, $4, $5, 'Menu uji', 1, 20000, 0, 20000, 'fired', 'served', $6)`,
          [
            randomUUID(),
            world.tenantId,
            outletId,
            ulidToUuid(orderUlid),
            menuItemId,
            businessDate,
          ],
        );
    });
  const input = {
    orderUlid,
    outletId,
    grossSalesIdr,
    paidAt,
    businessDate,
  };
  const event = orderPaidEvent(world, input);
  await deliver(world, event);
  return { orderUlid, event, input };
}

// ---- reads ----------------------------------------------------------------------

type ProgressRow = {
  id: string;
  mission_id: string;
  customer_profile_id: string;
  period_key: string;
  progress: number;
  target: number;
  completed_at: Date | null;
  reward_issued_at: Date | null;
  voucher_id: string | null;
  voucher_code: string | null;
};

async function progressRows(
  tenantId: string,
  missionId: string,
  profileId?: string,
): Promise<ProgressRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<ProgressRow>(
      `SELECT id, mission_id, customer_profile_id, period_key, progress, target,
              completed_at, reward_issued_at, voucher_id, voucher_code
         FROM mission_progress
        WHERE tenant_id = $1 AND mission_id = $2
          AND ($3::uuid IS NULL OR customer_profile_id = $3)
        ORDER BY period_key`,
      [tenantId, missionId, profileId ?? null],
    );
    return rows;
  });
}

/** Progress of the one period row; 0 when the mission never moved. */
async function progressValue(
  tenantId: string,
  missionId: string,
  profileId: string,
  periodKey?: string,
): Promise<number> {
  const rows = await progressRows(tenantId, missionId, profileId);
  return (
    rows.find((row) => periodKey === undefined || row.period_key === periodKey)
      ?.progress ?? 0
  );
}

const bonusRows = async (tenantId: string, profileId: string) =>
  (await ledgerOf(tenantId, profileId)).filter((row) => row.type === "bonus");

type VoucherRow = {
  id: string;
  customer_profile_id: string | null;
  promotion_id: string | null;
  code_hash: string;
  source: string;
  status: string;
  value_idr: string;
  valid_from: Date;
  valid_until: Date | null;
};

async function vouchersOf(
  tenantId: string,
  profileId: string,
): Promise<VoucherRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<VoucherRow>(
      `SELECT id, customer_profile_id, promotion_id, code_hash, source, status,
              value_idr::text, valid_from, valid_until
         FROM vouchers WHERE tenant_id = $1 AND customer_profile_id = $2 ORDER BY issued_at`,
      [tenantId, profileId],
    );
    return rows;
  });
}

const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;

// ---- visit_count ----------------------------------------------------------------

describe("F17 mission: visit_count", () => {
  it("F17 mission: completes at the target and posts ONE bonus; a replay posts nothing", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const missionId = await seedMission(
      world.tenantId,
      visitMission(3, { reward: { kind: "points", points: 100 } }),
    );

    await payOn(world, member, "2026-10-10");
    await payOn(world, member, "2026-10-12");
    let rows = await progressRows(world.tenantId, missionId, member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      period_key: "2026-10",
      progress: 2,
      target: 3,
      completed_at: null,
      reward_issued_at: null,
    });
    expect(await bonusRows(world.tenantId, member.id)).toHaveLength(0);
    expect(await balanceOf(world.tenantId, member.id)).toBe(20);

    const third = await payOn(world, member, "2026-10-14");
    rows = await progressRows(world.tenantId, missionId, member.id);
    expect(rows).toHaveLength(1);
    const progress = rows[0]!;
    expect(progress.progress).toBe(3);
    expect(progress.completed_at).not.toBeNull();
    expect(progress.reward_issued_at).not.toBeNull();
    const bonus = await bonusRows(world.tenantId, member.id);
    expect(bonus).toHaveLength(1);
    expect(bonus[0]).toMatchObject({
      type: "bonus",
      points: "100",
      source_type: "mission",
      source_id: progress.id,
    });
    // Expires like an earn row: paidAt of the completing order + 12 months.
    expect(bonus[0]!.expires_at?.toISOString()).toBe(
      "2027-10-14T05:00:00.000Z",
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(130);

    // The same event again, and the same order under a new event id.
    await deliver(world, third.event);
    await deliver(world, orderPaidEvent(world, third.input));
    rows = await progressRows(world.tenantId, missionId, member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.progress).toBe(3);
    expect(await bonusRows(world.tenantId, member.id)).toHaveLength(1);
    expect(await balanceOf(world.tenantId, member.id)).toBe(130);
  });

  it("F17 mission: visits after completion stay capped at the target and pay no second bonus", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const missionId = await seedMission(world.tenantId, visitMission(2));
    await payOn(world, member, "2026-10-10");
    await payOn(world, member, "2026-10-12");
    await payOn(world, member, "2026-10-14");
    await payOn(world, member, "2026-10-16");
    const rows = await progressRows(world.tenantId, missionId, member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.progress).toBe(2);
    expect(await bonusRows(world.tenantId, member.id)).toHaveLength(1);
  });

  it("F17 mission: the next month starts its own progress and can pay its own bonus", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const missionId = await seedMission(world.tenantId, visitMission(1));
    await payOn(world, member, "2026-10-10");
    await payOn(world, member, "2026-11-02");
    const rows = await progressRows(world.tenantId, missionId, member.id);
    expect(rows.map((row) => [row.period_key, row.progress])).toEqual([
      ["2026-10", 1],
      ["2026-11", 1],
    ]);
    expect(await bonusRows(world.tenantId, member.id)).toHaveLength(2);
  });
});

// ---- period keys ----------------------------------------------------------------

describe("F17 mission: period keys follow the business date", () => {
  it("F17 mission: monthly key is YYYY-MM of the business date, not of the paid instant", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const missionId = await seedMission(world.tenantId, visitMission(5));
    // Paid 2026-11-01 03:30 in Jakarta (before the 04:00 cut-off): business date Oct 31.
    await payOn(world, member, "2026-10-31", {
      paidAt: "2026-10-31T20:30:00.000Z",
    });
    await payOn(world, member, "2026-11-01");
    const rows = await progressRows(world.tenantId, missionId, member.id);
    expect(rows.map((row) => [row.period_key, row.progress])).toEqual([
      ["2026-10", 1],
      ["2026-11", 1],
    ]);
  });

  it("F17 mission: weekly key is the ISO week YYYY-Www; Sunday closes a week, Monday opens the next", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const missionId = await seedMission(
      world.tenantId,
      visitMission(5, { period: { kind: "weekly" } }),
    );
    await payOn(world, member, "2026-10-12"); // Monday, week 42
    await payOn(world, member, "2026-10-18"); // Sunday, week 42
    await payOn(world, member, "2026-10-19"); // Monday, week 43
    const rows = await progressRows(world.tenantId, missionId, member.id);
    expect(rows.map((row) => [row.period_key, row.progress])).toEqual([
      ["2026-W42", 2],
      ["2026-W43", 1],
    ]);
  });

  it("F17 mission: weekly key is zero padded (2026-W01, 2026-W02)", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const missionId = await seedMission(
      world.tenantId,
      visitMission(5, { period: { kind: "weekly" } }),
    );
    await payOn(world, member, "2026-01-04"); // Sunday, ISO week 1 of 2026
    await payOn(world, member, "2026-01-05"); // Monday, ISO week 2
    const rows = await progressRows(world.tenantId, missionId, member.id);
    expect(rows.map((row) => [row.period_key, row.progress])).toEqual([
      ["2026-W01", 1],
      ["2026-W02", 1],
    ]);
  });

  it("F17 mission: date_range key is start..end; visits outside the range move nothing", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const missionId = await seedMission(
      world.tenantId,
      visitMission(10, {
        period: { kind: "date_range", start: "2026-10-10", end: "2026-10-20" },
      }),
    );
    await payOn(world, member, "2026-10-09"); // day before the range
    await payOn(world, member, "2026-10-10"); // first day
    await payOn(world, member, "2026-10-15");
    await payOn(world, member, "2026-10-20"); // last day
    await payOn(world, member, "2026-10-21"); // day after the range
    const rows = await progressRows(world.tenantId, missionId, member.id);
    expect(rows.map((row) => [row.period_key, row.progress])).toEqual([
      ["2026-10-10..2026-10-20", 3],
    ]);
  });
});

// ---- weekday_visit --------------------------------------------------------------

describe("F17 mission: weekday_visit", () => {
  it("F17 mission: counts only the listed weekdays (0 = Sunday), read from the business date", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const sunday = await seedMission(world.tenantId, weekdayMission([0], 5));
    const monday = await seedMission(world.tenantId, weekdayMission([1], 5));
    const workdays = await seedMission(
      world.tenantId,
      weekdayMission([1, 2, 3, 4, 5], 5),
    );

    await payOn(world, member, "2026-10-12"); // Monday
    await payOn(world, member, "2026-10-13"); // Tuesday
    await payOn(world, member, "2026-10-17"); // Saturday: listed nowhere
    await payOn(world, member, "2026-10-18", {
      paidAt: "2026-10-18T20:30:00.000Z", // Monday 03:30 in Jakarta, business date Sunday
    });

    expect(await progressValue(world.tenantId, sunday, member.id)).toBe(1);
    expect(await progressValue(world.tenantId, monday, member.id)).toBe(1);
    expect(await progressValue(world.tenantId, workdays, member.id)).toBe(2);
  });

  it("F17 mission: completes at the target and pays the bonus once", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const missionId = await seedMission(
      world.tenantId,
      weekdayMission([1, 2, 3, 4, 5], 2, {
        reward: { kind: "points", points: 50 },
      }),
    );
    await payOn(world, member, "2026-10-12");
    await payOn(world, member, "2026-10-13");
    const [row] = await progressRows(world.tenantId, missionId, member.id);
    expect(row).toMatchObject({ progress: 2, target: 2 });
    expect(row!.completed_at).not.toBeNull();
    const bonus = await bonusRows(world.tenantId, member.id);
    expect(bonus).toHaveLength(1);
    expect(bonus[0]).toMatchObject({
      points: "50",
      source_type: "mission",
      source_id: row!.id,
    });
  });
});

// ---- try_new_item ---------------------------------------------------------------

describe("F17 mission: try_new_item", () => {
  it("F17 mission: counts distinct items the member never ordered before; the same item twice in one order counts once", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const [a, b, c] = await seedMenu(world, 3);
    const missionId = await seedMission(world.tenantId, newItemMission(3));

    await payOn(world, member, "2026-10-10", { items: [a!, a!, b!] });
    expect(await progressValue(world.tenantId, missionId, member.id)).toBe(2);

    // b was ordered before, c is new.
    await payOn(world, member, "2026-10-12", { items: [b!, c!] });
    const [row] = await progressRows(world.tenantId, missionId, member.id);
    expect(row).toMatchObject({ progress: 3, target: 3 });
    expect(row!.completed_at).not.toBeNull();
    expect(await bonusRows(world.tenantId, member.id)).toHaveLength(1);
  });

  it("F17 mission: with menuItemIds only the listed items count, and only the first time", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const [a, b, c] = await seedMenu(world, 3);
    const missionId = await seedMission(
      world.tenantId,
      newItemMission(2, [a!, c!]),
    );

    await payOn(world, member, "2026-10-10", { items: [a!, b!] });
    expect(await progressValue(world.tenantId, missionId, member.id)).toBe(1);
    await payOn(world, member, "2026-10-12", { items: [a!] }); // a is not new any more
    expect(await progressValue(world.tenantId, missionId, member.id)).toBe(1);
    await payOn(world, member, "2026-10-14", { items: [c!] });
    const [row] = await progressRows(world.tenantId, missionId, member.id);
    expect(row).toMatchObject({ progress: 2, target: 2 });
    expect(row!.completed_at).not.toBeNull();
  });

  it("F17 mission: an item ordered in an earlier month is not new; another member's orders do not count", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const other = await seedMember(world.tenantId);
    const [a, b] = await seedMenu(world, 2);
    const missionId = await seedMission(world.tenantId, newItemMission(5));

    await payOn(world, member, "2026-09-20", { items: [a!] });
    await payOn(world, other, "2026-10-05", { items: [a!, b!] });

    await payOn(world, member, "2026-10-10", { items: [a!, b!] });
    // a was ordered in September; b was only ever ordered by someone else.
    expect(
      await progressValue(world.tenantId, missionId, member.id, "2026-10"),
    ).toBe(1);
    // The other member saw neither item before their own order.
    expect(
      await progressValue(world.tenantId, missionId, other.id, "2026-10"),
    ).toBe(2);
  });
});

// ---- stamp_card -----------------------------------------------------------------

describe("F17 mission: stamp_card", () => {
  it("F17 mission: +1 stamp per paid order (also on one business date); the full card pays once", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const missionId = await seedMission(
      world.tenantId,
      stampMission(3, { reward: { kind: "points", points: 150 } }),
    );

    await payOn(world, member, "2026-10-10");
    await payOn(world, member, "2026-10-10");
    expect(await progressValue(world.tenantId, missionId, member.id)).toBe(2);
    expect(await bonusRows(world.tenantId, member.id)).toHaveLength(0);

    await payOn(world, member, "2026-10-11");
    const [row] = await progressRows(world.tenantId, missionId, member.id);
    expect(row).toMatchObject({ progress: 3, target: 3 });
    const bonus = await bonusRows(world.tenantId, member.id);
    expect(bonus).toHaveLength(1);
    expect(bonus[0]).toMatchObject({
      points: "150",
      source_type: "mission",
      source_id: row!.id,
    });

    await payOn(world, member, "2026-10-12");
    expect(await progressValue(world.tenantId, missionId, member.id)).toBe(3);
    expect(await bonusRows(world.tenantId, member.id)).toHaveLength(1);
  });
});

// ---- who and when counts --------------------------------------------------------

describe("F17 mission: only active missions, inside their window, for real members, move", () => {
  it("F17 mission: an inactive mission and a mission outside its starts_at / ends_at get no progress", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    // The order below is paid 2026-10-15T05:00:00Z.
    const inactive = await seedMission(
      world.tenantId,
      visitMission(5, { isActive: false }),
    );
    const notStarted = await seedMission(
      world.tenantId,
      visitMission(5, { startsAt: "2026-10-16T00:00:00.000Z" }),
    );
    const ended = await seedMission(
      world.tenantId,
      visitMission(5, { endsAt: "2026-10-15T04:00:00.000Z" }),
    );
    const inWindow = await seedMission(
      world.tenantId,
      visitMission(5, {
        startsAt: "2026-10-15T04:00:00.000Z",
        endsAt: "2026-10-15T06:00:00.000Z",
      }),
    );
    const always = await seedMission(world.tenantId, visitMission(5));

    await payOn(world, member, "2026-10-15");

    for (const missionId of [inactive, notStarted, ended])
      expect(await progressRows(world.tenantId, missionId)).toHaveLength(0);
    expect(await progressValue(world.tenantId, inWindow, member.id)).toBe(1);
    expect(await progressValue(world.tenantId, always, member.id)).toBe(1);
  });

  it("F17 mission: an order without a member, or of a member who is not active yet, moves nothing", async () => {
    const world = await worldWithProgram();
    const missionId = await seedMission(world.tenantId, visitMission(5));
    const pending = await seedProfile(world.tenantId, {
      status: "pending_verification",
    });

    const anonymousOrder = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: null,
    });
    await deliver(
      world,
      orderPaidEvent(world, {
        orderUlid: anonymousOrder,
        outletId: world.outletA,
      }),
    );
    await payOn(world, pending, "2026-10-15");

    expect(await progressRows(world.tenantId, missionId)).toHaveLength(0);
  });

  it("F17 mission: an order blocked as self-serve (staff's own order) moves no mission", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const missionId = await seedMission(
      world.tenantId,
      visitMission(1, { reward: { kind: "points", points: 100 } }),
    );
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: member.id,
      cashierId: member.userId,
    });
    await deliver(
      world,
      orderPaidEvent(world, {
        orderUlid,
        outletId: world.outletA,
        cashierId: member.userId,
      }),
    );

    expect(await progressRows(world.tenantId, missionId)).toHaveLength(0);
    expect(await bonusRows(world.tenantId, member.id)).toHaveLength(0);
    // An order of the same member without a staff cashier does move it.
    await payOn(world, member, "2026-10-15");
    expect(await progressValue(world.tenantId, missionId, member.id)).toBe(1);
  });

  it("F17 mission: a mission of another tenant never moves", async () => {
    const mine = await worldWithProgram();
    const theirs = await worldWithProgram();
    const theirMission = await seedMission(theirs.tenantId, visitMission(1));
    const member = await seedMember(mine.tenantId);

    await payOn(mine, member, "2026-10-15");

    expect(await progressRows(theirs.tenantId, theirMission)).toHaveLength(0);
    expect(await bonusRows(mine.tenantId, member.id)).toHaveLength(0);
  });
});

// ---- voucher reward -------------------------------------------------------------

describe("F17 mission: voucher reward", () => {
  it("F17 mission: completing issues one loyalty_reward voucher, its code is on the progress row, no points", async () => {
    const world = await worldWithProgram();
    const member = await seedMember(world.tenantId);
    const missionId = await seedMission(
      world.tenantId,
      visitMission(1, {
        reward: { kind: "voucher", valueIdr: 20_000, validDays: 30 },
      }),
    );

    const paid = await payOn(world, member, "2026-10-15");

    const [progress] = await progressRows(world.tenantId, missionId, member.id);
    expect(progress!.completed_at).not.toBeNull();
    expect(progress!.reward_issued_at).not.toBeNull();
    expect(progress!.voucher_id).not.toBeNull();
    expect(progress!.voucher_code).toMatch(CODE);

    const vouchers = await vouchersOf(world.tenantId, member.id);
    expect(vouchers).toHaveLength(1);
    const voucher = vouchers[0]!;
    expect(voucher).toMatchObject({
      id: progress!.voucher_id,
      customer_profile_id: member.id,
      promotion_id: null,
      source: "loyalty_reward",
      status: "issued",
      value_idr: "20000",
      code_hash: hashPromoCode(progress!.voucher_code!),
    });
    const days =
      (voucher.valid_until!.getTime() - voucher.valid_from.getTime()) /
      86_400_000;
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(31);

    // A voucher reward posts no bonus points; only the earn row exists.
    expect(await bonusRows(world.tenantId, member.id)).toHaveLength(0);
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);

    // Replay: still one voucher, same code.
    await deliver(world, paid.event);
    await deliver(world, orderPaidEvent(world, paid.input));
    expect(await vouchersOf(world.tenantId, member.id)).toHaveLength(1);
    const [again] = await progressRows(world.tenantId, missionId, member.id);
    expect(again!.voucher_code).toBe(progress!.voucher_code);
  });
});

// ---- GET /api/member/missions ---------------------------------------------------

describe("F17 mission: GET /api/member/missions", () => {
  let app: Express;
  const otherEntityId = randomUUID();
  const otherOutletId = randomUUID();
  let previousProgramEntity: string | null;
  const WIDE = {
    kind: "date_range",
    start: "2026-10-01",
    end: "2099-12-31",
  } as const;
  let mission: {
    counting: string;
    untouched: string;
    inactive: string;
    voucher: string;
  };
  const seeded = {
    tenantId: seededTenantId,
    context: contextOf(seededTenantId),
    brandId: "",
    outletA: seededOutletA,
    outletB: seededOutletA,
  } satisfies World;

  type Item = {
    mission: { id: string };
    progress: {
      progress: number;
      target: number;
      completedAt: string | null;
      rewardIssuedAt: string | null;
    } | null;
    voucherCode: string | null;
  };
  const find = (items: Item[], id: string) =>
    items.find((item) => item.mission.id === id);

  beforeAll(async () => {
    app = createApp();
    await ensureConsentPolicies();
    await seedProgram(seededTenantId);
    await asTenant(seededTenantId, async (client) => {
      const program = await client.query<{ legal_entity_id: string | null }>(
        "SELECT legal_entity_id FROM loyalty_programs WHERE tenant_id = $1",
        [seededTenantId],
      );
      previousProgramEntity = program.rows[0]!.legal_entity_id;
      // Other suites also add outlets of other PTs to this shared tenant.
      // Reproduce that shape here, then select this fixture's PT per Q80.
      await client.query(
        "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Misi Lain', false)",
        [otherEntityId, seededTenantId],
      );
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
         SELECT $1, tenant_id, brand_id, $3, $4, 'Outlet Misi Lain', 'Jl. Uji', 'Asia/Jakarta', '04:00', opening_hours, 'active'
         FROM outlets WHERE tenant_id = $2 AND id = $5`,
        [
          otherOutletId,
          seededTenantId,
          otherEntityId,
          `MI-${short()}`.toUpperCase(),
          seededOutletA,
        ],
      );
      await client.query(
        `UPDATE loyalty_programs SET legal_entity_id =
           (SELECT legal_entity_id FROM outlets WHERE tenant_id = $1 AND id = $2)
         WHERE tenant_id = $1`,
        [seededTenantId, seededOutletA],
      );
    });
    mission = {
      // Never reached by the member: 2 of 5.
      counting: await seedMission(
        seededTenantId,
        visitMission(5, { period: WIDE }),
      ),
      // Sundays only: the member's orders are on Thursday and Friday.
      untouched: await seedMission(
        seededTenantId,
        weekdayMission([0], 5, { period: WIDE }),
      ),
      inactive: await seedMission(
        seededTenantId,
        visitMission(5, { period: WIDE, isActive: false }),
      ),
      voucher: await seedMission(
        seededTenantId,
        visitMission(1, {
          period: WIDE,
          reward: { kind: "voucher", valueIdr: 15_000, validDays: 30 },
        }),
      ),
    };
    created.push(...Object.values(mission));
  });

  afterAll(async () => {
    await asTenant(seededTenantId, async (client) => {
      await client.query(
        "UPDATE loyalty_programs SET legal_entity_id = $2 WHERE tenant_id = $1",
        [seededTenantId, previousProgramEntity],
      );
      await client.query(
        "DELETE FROM outlets WHERE tenant_id = $1 AND id = $2",
        [seededTenantId, otherOutletId],
      );
      await client.query(
        "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
        [seededTenantId, otherEntityId],
      );
    });
  });

  it("F17 mission: lists active missions with the member's own progress and voucher code", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const first = await payOn(seeded, { id: member.profileId! }, "2026-10-15"); // Thursday
    await payOn(seeded, { id: member.profileId! }, "2026-10-16"); // Friday

    const response = await member.client
      .get("/api/member/missions")
      .set(memberHeaders);
    expect(response.status).toBe(200);
    const items = response.body.data as Item[];

    const counting = find(items, mission.counting);
    expect(counting?.progress).toMatchObject({
      progress: 2,
      target: 5,
      completedAt: null,
      rewardIssuedAt: null,
    });
    expect(counting?.voucherCode).toBeNull();

    const untouched = find(items, mission.untouched);
    expect(untouched).toBeDefined();
    expect(
      untouched!.progress === null || untouched!.progress.progress === 0,
    ).toBe(true);

    const voucher = find(items, mission.voucher);
    expect(voucher?.progress?.completedAt).not.toBeNull();
    expect(voucher?.progress?.rewardIssuedAt).not.toBeNull();
    expect(voucher?.voucherCode).toMatch(CODE);
    const [row] = await progressRows(
      seededTenantId,
      mission.voucher,
      member.profileId!,
    );
    expect(voucher?.voucherCode).toBe(row!.voucher_code);
    expect(await vouchersOf(seededTenantId, member.profileId!)).toHaveLength(1);
    expect(await bonusRows(seededTenantId, member.profileId!)).toHaveLength(0);
    expect(await balanceOf(seededTenantId, member.profileId!)).toBe(20);

    await deliver(seeded, first.event);
    await deliver(seeded, orderPaidEvent(seeded, first.input));
    expect(await vouchersOf(seededTenantId, member.profileId!)).toHaveLength(1);
    expect(await bonusRows(seededTenantId, member.profileId!)).toHaveLength(0);
    expect(await balanceOf(seededTenantId, member.profileId!)).toBe(20);
    const [replayed] = await progressRows(
      seededTenantId,
      mission.counting,
      member.profileId!,
    );
    expect(replayed!.progress).toBe(2);

    // Assumption: members do not see inactive missions.
    expect(find(items, mission.inactive)).toBeUndefined();
  });

  it("F17 mission: another member sees no progress and no voucher code of this member", async () => {
    const a = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const b = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    await payOn(seeded, { id: a.profileId! }, "2026-10-15");
    const [aRow] = await progressRows(
      seededTenantId,
      mission.voucher,
      a.profileId!,
    );
    expect(aRow!.voucher_code).toMatch(CODE);

    const response = await b.client
      .get("/api/member/missions")
      .set(memberHeaders);
    expect(response.status).toBe(200);
    const items = response.body.data as Item[];
    expect(find(items, mission.counting)?.progress ?? null).toBeNull();
    expect(find(items, mission.voucher)?.voucherCode).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain(aRow!.voucher_code!);
    expect(JSON.stringify(response.body)).not.toContain(a.profileId!);
  });

  it("F17 mission: a member without a profile gets 404 CUSTOMER_NOT_FOUND; anonymous gets 401", async () => {
    const stranger = await newMemberUser(app, { profile: false });
    const noProfile = await stranger.client
      .get("/api/member/missions")
      .set(memberHeaders);
    expect(noProfile.status).toBe(404);
    expect(noProfile.body.error.code).toBe("CUSTOMER_NOT_FOUND");

    const anonymous = await agent(app)
      .get("/api/member/missions")
      .set({ ...memberHeaders, ...originHeader });
    expect(anonymous.status).toBe(401);
  });
});
