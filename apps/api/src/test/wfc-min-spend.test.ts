// legend-bz9h (Area C, F39/F25, FAC-14): WFC min-spend monitor against
// PostgreSQL. Written from the card spec only (money rules M6 and M7), not from
// the implementation. Seeding uses raw SQL as the migration owner; the service
// runs through its own tenant scope.
//
// M6: the monitor only nudges (one notification event per nudge, polite, no
//     staff alert). At most `maxNudgesPerWindow` (2) per window, nudges >= 15
//     minutes apart, only once >= 30 minutes of the window have elapsed. It
//     never charges, blocks or ends a session and never edits orders.
// M7: spend counted = paid orders only (orders.status = 'completed' with
//     captured pos_order_tenders); refunds subtract; never negative.
//
// Assumptions (the spec leaves them open):
// - `evaluateMinSpend(context, { zoneId, now })` opens its own tenant scope and
//   resolves (the summary shape is not asserted); `now` is a Date.
// - The window is hour-aligned from the table session start: every session in
//   this file opens exactly on the hour (12:00 Jakarta = 05:00Z), so "window
//   start" and "session start" agree whichever anchor the implementation uses.
// - Peak windows use the outlet time zone (Asia/Jakarta, UTC+7), daysOfWeek
//   0 = Sunday, like `wifi_policies.peak_schedule`.
// - One nudge = one `domain_event_outbox` row in the fresh test tenant (nothing
//   else in these tests writes events).
// - Spend is the sum of captured tender amounts (cash and QRIS used here);
//   a completed gateway refund (payment_refunds) of the tender's intent subtracts.
import { randomUUID, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ulidToUuid, createUlid } from "@starter/shared/core";
import { evaluateMinSpend } from "../services/wfc-min-spend.service.ts";
import {
  asTenant,
  createWorld,
  owner,
  short,
  type World,
} from "./member-loyalty-helpers.ts";

afterAll(async () => {
  await owner.end();
});

const MIN = 60_000;
/** Monday 2026-11-02 12:00 Jakarta, on the hour. */
const T0 = Date.parse("2026-11-02T05:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * MIN);
const MIN_SPEND = 30_000;
const PEAK_NOW = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startsAt: "11:00", endsAt: "14:00" },
];
const PEAK_EVENING = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startsAt: "18:00", endsAt: "21:00" },
];

type Zone = { zoneId: string; outletId: string };

async function seedZone(
  world: World,
  options: {
    minSpend?: number | null;
    peak?: unknown[];
    policy?: boolean;
    outletId?: string;
  } = {},
): Promise<Zone> {
  const zoneId = randomUUID();
  const outletId = options.outletId ?? world.outletA;
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
       VALUES ($1, $2, $3, $4, 'pay_first', '[]')`,
      [zoneId, world.tenantId, outletId, `Zona WFC ${short()}`],
    );
    if (options.policy !== false)
      await client.query(
        `INSERT INTO wifi_policies
           (id, tenant_id, outlet_id, zone_id, free_minutes, peak_free_minutes,
            spend_per_extra_hour_idr, extra_minutes, max_devices, peak_schedule,
            base_speed_kbps, full_speed_kbps, min_spend_per_hour_idr, tier_bonus_minutes)
         VALUES ($1, $2, $3, $4, 120, 60, 30000, 60, 2, $5::jsonb, 512, 20000, $6, '{}')`,
        [
          randomUUID(),
          world.tenantId,
          outletId,
          zoneId,
          JSON.stringify(options.peak ?? PEAK_NOW),
          options.minSpend === undefined ? MIN_SPEND : options.minSpend,
        ],
      );
  });
  return { zoneId, outletId };
}

/** One table with one session opened at `openedAt` (default: on the hour). */
async function seedSession(
  world: World,
  zone: Zone,
  options: { status?: "open" | "bill_requested"; openedAt?: Date } = {},
): Promise<string> {
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const status = options.status ?? "open";
  const openedAt = options.openedAt ?? at(0);
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type, layout)
       VALUES ($1, $2, $3, $4, $5, 4, 'regular', '{"x":1,"y":1,"width":20,"height":20,"rotation":0,"shape":"rect"}'::jsonb)`,
      [
        tableId,
        world.tenantId,
        zone.outletId,
        zone.zoneId,
        `W-${short()}`.toUpperCase(),
      ],
    );
    await client.query(
      `INSERT INTO table_sessions (id, tenant_id, outlet_id, table_id, pax, payment_mode, status,
         session_token_hash, session_token_sealed, opened_at, bill_requested_at)
       VALUES ($1, $2, $3, $4, 2, 'pay_first', $5, $6, 'sealed', $7, $8)`,
      [
        sessionId,
        world.tenantId,
        zone.outletId,
        tableId,
        status,
        randomBytes(32).toString("hex"),
        openedAt,
        status === "bill_requested" ? at(20) : null,
      ],
    );
  });
  return sessionId;
}

/** A paid gateway (QRIS) intent with its payment link (refundable). */
async function seedIntent(world: World, outletId: string, amountIdr: number) {
  const linkId = randomUUID();
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
    [
      linkId,
      world.tenantId,
      outletId,
      randomBytes(32).toString("hex"),
      `WF-${linkId.slice(0, 8)}`,
      amountIdr,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
        status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', $7,
             '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [
      intentId,
      world.tenantId,
      outletId,
      linkId,
      amountIdr,
      `wf-${intentId}`,
      at(10),
    ],
  );
  return intentId;
}

async function seedRefund(
  world: World,
  outletId: string,
  intentId: string,
  amountIdr: number,
  completedAt: Date,
) {
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', 'completed', 'requester', 'approver', $6, $6)`,
    [randomUUID(), world.tenantId, outletId, intentId, amountIdr, completedAt],
  );
}

type OrderSeed = {
  amountIdr: number;
  method?: "cash" | "qris";
  orderStatus?: "completed" | "draft";
  tenderStatus?: "captured" | "authorized";
  paidAt?: Date;
  intentId?: string;
};

/** A table order (POS channel) with one tender, linked to the table session. */
async function seedOrder(
  world: World,
  zone: Zone,
  sessionId: string,
  seed: OrderSeed,
) {
  const orderId = ulidToUuid(createUlid());
  const paidAt = seed.paidAt ?? at(10);
  const method = seed.method ?? "cash";
  const orderStatus = seed.orderStatus ?? "completed";
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at, table_session_id)
       VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0, $5,
               $6, '2026-11-02', $7, $8)`,
      [
        orderId,
        world.tenantId,
        zone.outletId,
        `WF-${short()}`.toUpperCase(),
        seed.amountIdr,
        orderStatus,
        paidAt,
        sessionId,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', $4, $5)`,
      [
        orderId,
        world.tenantId,
        zone.outletId,
        paidAt,
        orderStatus === "completed" ? paidAt : null,
      ],
    );
    const cash = method === "cash";
    await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, payment_intent_id, amount_idr,
          received_idr, change_idr, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text, $11, CASE WHEN $10::text = 'authorized' THEN NULL ELSE $11::timestamptz END)`,
      [
        world.tenantId,
        zone.outletId,
        orderId,
        method,
        cash ? "manual" : "doit",
        seed.intentId ?? null,
        seed.amountIdr,
        cash ? seed.amountIdr : null,
        cash ? 0 : null,
        seed.tenderStatus ?? "captured",
        paidAt,
      ],
    );
  });
  return orderId;
}

type WindowRow = {
  min_spend_idr: string | number;
  spent_idr: string | number;
  status: string;
  nudge_count: number;
  last_nudged_at: Date | null;
};

async function windowsOf(
  world: World,
  sessionId: string,
): Promise<WindowRow[]> {
  return asTenant(world.tenantId, async (client) => {
    const { rows } = await client.query<WindowRow>(
      `SELECT min_spend_idr, spent_idr, status, nudge_count, last_nudged_at
         FROM wfc_spend_windows WHERE table_session_id = $1 ORDER BY window_start`,
      [sessionId],
    );
    return rows;
  });
}

/** Total nudges recorded for a session across its windows (0 when no row). */
async function nudgesOf(world: World, sessionId: string): Promise<number> {
  return (await windowsOf(world, sessionId)).reduce(
    (sum, row) => sum + row.nudge_count,
    0,
  );
}

async function outboxCount(world: World): Promise<number> {
  return asTenant(world.tenantId, async (client) => {
    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM domain_event_outbox WHERE tenant_id = $1",
      [world.tenantId],
    );
    return Number(rows[0]!.n);
  });
}

async function snapshotOf(world: World, sessionId: string) {
  return asTenant(world.tenantId, async (client) => {
    const session = await client.query(
      "SELECT status, closed_at FROM table_sessions WHERE id = $1",
      [sessionId],
    );
    const orders = await client.query(
      "SELECT id, status, total_idr FROM orders WHERE table_session_id = $1 ORDER BY id",
      [sessionId],
    );
    const tenders = await client.query(
      `SELECT t.order_id, t.status, t.amount_idr FROM pos_order_tenders t
         JOIN orders o ON o.id = t.order_id AND o.tenant_id = t.tenant_id
        WHERE o.table_session_id = $1 ORDER BY t.order_id, t.amount_idr`,
      [sessionId],
    );
    return {
      session: session.rows,
      orders: orders.rows,
      tenders: tenders.rows,
    };
  });
}

const evaluate = (world: World, zone: Zone, now: Date) =>
  evaluateMinSpend(world.context, { zoneId: zone.zoneId, now });

describe("M6 min-spend monitor only nudges", () => {
  it("M6 nudges a below-minimum session once after 30 minutes, snapshotting the policy", async () => {
    const world = await createWorld();
    const zone = await seedZone(world);
    const sessionId = await seedSession(world, zone);
    await seedOrder(world, zone, sessionId, { amountIdr: 10_000 });
    const events = await outboxCount(world);

    await evaluate(world, zone, at(45));

    const rows = await windowsOf(world, sessionId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.min_spend_idr)).toBe(MIN_SPEND);
    expect(Number(rows[0]!.spent_idr)).toBe(10_000);
    expect(rows[0]!.status).toBe("nudged");
    expect(rows[0]!.nudge_count).toBe(1);
    expect(rows[0]!.last_nudged_at?.getTime()).toBe(at(45).getTime());
    expect(await outboxCount(world)).toBe(events + 1);
  });

  it("M6 never charges, blocks or ends a session and never edits orders", async () => {
    const world = await createWorld();
    const zone = await seedZone(world);
    const sessionId = await seedSession(world, zone);
    await seedOrder(world, zone, sessionId, { amountIdr: 10_000 });
    const before = await snapshotOf(world, sessionId);

    await evaluate(world, zone, at(45));
    await evaluate(world, zone, at(50));

    expect(await nudgesOf(world, sessionId)).toBe(1);
    expect(await snapshotOf(world, sessionId)).toEqual(before);
    expect(before.session[0].status).toBe("open");
    expect(before.session[0].closed_at).toBeNull();
  });

  it("M6 does not nudge before 30 minutes of the window have elapsed", async () => {
    const world = await createWorld();
    const zone = await seedZone(world);
    const sessionId = await seedSession(world, zone);
    const events = await outboxCount(world);

    await evaluate(world, zone, at(20));

    expect(await nudgesOf(world, sessionId)).toBe(0);
    expect(await outboxCount(world)).toBe(events);
  });

  it("M6 does not nudge when spend reaches the minimum exactly", async () => {
    const world = await createWorld();
    const zone = await seedZone(world);
    const sessionId = await seedSession(world, zone);
    await seedOrder(world, zone, sessionId, { amountIdr: 20_000 });
    await seedOrder(world, zone, sessionId, {
      amountIdr: 10_000,
      method: "cash",
    });
    const events = await outboxCount(world);

    await evaluate(world, zone, at(45));

    expect(await nudgesOf(world, sessionId)).toBe(0);
    expect(await outboxCount(world)).toBe(events);
    const rows = await windowsOf(world, sessionId);
    for (const row of rows) {
      expect(row.status).toBe("ok");
      expect(Number(row.spent_idr)).toBe(30_000);
    }
  });

  it("M6 keeps nudges at least 15 minutes apart", async () => {
    const world = await createWorld();
    const zone = await seedZone(world);
    const sessionId = await seedSession(world, zone);

    await evaluate(world, zone, at(31));
    expect(await nudgesOf(world, sessionId)).toBe(1);

    await evaluate(world, zone, at(40)); // 9 minutes later: too soon
    expect(await nudgesOf(world, sessionId)).toBe(1);

    await evaluate(world, zone, at(46)); // 15 minutes later: allowed
    expect(await nudgesOf(world, sessionId)).toBe(2);
  });

  it("M6 nudges at most twice per window", async () => {
    const world = await createWorld();
    const zone = await seedZone(world);
    const sessionId = await seedSession(world, zone);
    const events = await outboxCount(world);

    for (const minute of [31, 46, 50, 55, 59])
      await evaluate(world, zone, at(minute));

    expect(await nudgesOf(world, sessionId)).toBe(2);
    expect(await outboxCount(world)).toBe(events + 2);
  });

  it("M6 a window already at the cap stays at 2 even when the last nudge is old enough", async () => {
    const world = await createWorld();
    const zone = await seedZone(world);
    const sessionId = await seedSession(world, zone);
    await asTenant(world.tenantId, (client) =>
      client.query(
        `INSERT INTO wfc_spend_windows
           (id, tenant_id, outlet_id, zone_id, table_session_id, window_start, window_end,
            min_spend_idr, spent_idr, status, nudge_count, last_nudged_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'nudged', 2, $9)`,
        [
          randomUUID(),
          world.tenantId,
          zone.outletId,
          zone.zoneId,
          sessionId,
          at(0),
          at(60),
          MIN_SPEND,
          at(31),
        ],
      ),
    );
    const events = await outboxCount(world);

    await evaluate(world, zone, at(50)); // 19 minutes after the last nudge

    expect(await nudgesOf(world, sessionId)).toBe(2);
    expect(await outboxCount(world)).toBe(events);
  });

  it("M6 also watches sessions that asked for the bill", async () => {
    const world = await createWorld();
    const zone = await seedZone(world);
    const sessionId = await seedSession(world, zone, {
      status: "bill_requested",
    });

    await evaluate(world, zone, at(45));

    expect(await nudgesOf(world, sessionId)).toBe(1);
    expect((await snapshotOf(world, sessionId)).session[0].status).toBe(
      "bill_requested",
    );
  });

  it("M6 skips a zone whose policy has no minimum spend (null)", async () => {
    const world = await createWorld();
    const zone = await seedZone(world, { minSpend: null });
    const sessionId = await seedSession(world, zone);
    const events = await outboxCount(world);

    await evaluate(world, zone, at(45));

    expect(await windowsOf(world, sessionId)).toHaveLength(0);
    expect(await outboxCount(world)).toBe(events);
  });

  it("M6 skips a zone whose minimum spend is 0", async () => {
    const world = await createWorld();
    const zone = await seedZone(world, { minSpend: 0 });
    const sessionId = await seedSession(world, zone);

    await evaluate(world, zone, at(45));

    expect(await nudgesOf(world, sessionId)).toBe(0);
  });

  it("M6 skips a zone with no wifi policy at all without failing", async () => {
    const world = await createWorld();
    const zone = await seedZone(world, { policy: false });
    const sessionId = await seedSession(world, zone);

    await evaluate(world, zone, at(45));

    expect(await windowsOf(world, sessionId)).toHaveLength(0);
  });

  it("M6 only nudges during the zone's peak windows", async () => {
    const world = await createWorld();
    const zone = await seedZone(world, { peak: PEAK_EVENING }); // 12:45 is off-peak
    const sessionId = await seedSession(world, zone);
    const events = await outboxCount(world);

    await evaluate(world, zone, at(45));

    expect(await nudgesOf(world, sessionId)).toBe(0);
    expect(await outboxCount(world)).toBe(events);
  });

  it("M6 only evaluates the requested zone", async () => {
    const world = await createWorld();
    const zone = await seedZone(world);
    const other = await seedZone(world);
    const sessionId = await seedSession(world, zone);
    const otherSessionId = await seedSession(world, other);

    await evaluate(world, zone, at(45));

    expect(await nudgesOf(world, sessionId)).toBe(1);
    expect(await nudgesOf(world, otherSessionId)).toBe(0);
  });
});

describe("M7 spend counts paid orders only; refunds subtract", () => {
  it("M7 ignores draft orders and tenders that were not captured", async () => {
    const world = await createWorld();
    const zone = await seedZone(world);
    const sessionId = await seedSession(world, zone);
    await seedOrder(world, zone, sessionId, { amountIdr: 10_000 });
    await seedOrder(world, zone, sessionId, {
      amountIdr: 50_000,
      orderStatus: "draft",
    });
    await seedOrder(world, zone, sessionId, {
      amountIdr: 50_000,
      tenderStatus: "authorized",
    });

    await evaluate(world, zone, at(45));

    const rows = await windowsOf(world, sessionId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.spent_idr)).toBe(10_000);
    expect(rows[0]!.nudge_count).toBe(1); // 10.000 < 30.000: the unpaid 100.000 did not count
  });

  it("M7 does not count orders of another table session", async () => {
    const world = await createWorld();
    const zone = await seedZone(world);
    const sessionId = await seedSession(world, zone);
    const otherSessionId = await seedSession(world, zone);
    await seedOrder(world, zone, otherSessionId, { amountIdr: 90_000 });

    await evaluate(world, zone, at(45));

    expect(await nudgesOf(world, sessionId)).toBe(1);
    expect(await nudgesOf(world, otherSessionId)).toBe(0);
  });

  it("M7 a refund subtracts from spend and can put a session below the minimum", async () => {
    const world = await createWorld();
    const zone = await seedZone(world);
    const sessionId = await seedSession(world, zone);
    const intentId = await seedIntent(world, zone.outletId, 40_000);
    await seedOrder(world, zone, sessionId, {
      amountIdr: 40_000,
      method: "qris",
      intentId,
    });

    await evaluate(world, zone, at(31)); // 40.000 >= 30.000
    expect(await nudgesOf(world, sessionId)).toBe(0);

    await seedRefund(world, zone.outletId, intentId, 25_000, at(35));
    await evaluate(world, zone, at(46)); // 15.000 < 30.000

    const rows = await windowsOf(world, sessionId);
    expect(rows.reduce((sum, row) => sum + row.nudge_count, 0)).toBe(1);
    expect(Number(rows.at(-1)!.spent_idr)).toBe(15_000);
  });

  it("M7 a fully refunded order counts as 0, never negative", async () => {
    const world = await createWorld();
    const zone = await seedZone(world);
    const sessionId = await seedSession(world, zone);
    const intentId = await seedIntent(world, zone.outletId, 40_000);
    await seedOrder(world, zone, sessionId, {
      amountIdr: 40_000,
      method: "qris",
      intentId,
    });
    await seedRefund(world, zone.outletId, intentId, 40_000, at(20));

    await evaluate(world, zone, at(45));

    const rows = await windowsOf(world, sessionId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.spent_idr)).toBe(0);
  });
});

describe("TEN-01 tenant isolation of the monitor", () => {
  it("TEN-01 another tenant's zone is never evaluated or nudged", async () => {
    const mine = await createWorld();
    const theirs = await createWorld();
    const theirZone = await seedZone(theirs);
    const theirSession = await seedSession(theirs, theirZone);
    const myEvents = await outboxCount(mine);
    const theirEvents = await outboxCount(theirs);

    // Either a rejection or a no-op is acceptable; nothing may change.
    await evaluateMinSpend(mine.context, {
      zoneId: theirZone.zoneId,
      now: at(45),
    }).catch(() => undefined);

    expect(await windowsOf(theirs, theirSession)).toHaveLength(0);
    expect(await outboxCount(theirs)).toBe(theirEvents);
    expect(await outboxCount(mine)).toBe(myEvents);
  });

  it("TEN-01 another tenant's spend never counts toward my session", async () => {
    const mine = await createWorld();
    const theirs = await createWorld();
    const myZone = await seedZone(mine);
    const mySession = await seedSession(mine, myZone);
    const theirZone = await seedZone(theirs);
    const theirSession = await seedSession(theirs, theirZone);
    await seedOrder(theirs, theirZone, theirSession, { amountIdr: 500_000 });

    await evaluate(mine, myZone, at(45));

    const rows = await windowsOf(mine, mySession);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.spent_idr)).toBe(0);
    expect(rows[0]!.nudge_count).toBe(1);
  });
});
