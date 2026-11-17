// legend-e24cz (PRD F39 "Wi-Fi Berbasis Belanja", WFC minimum spend per hour):
// `evaluateMinSpend(tx, { tenantId, outletId, now })` in
// src/services/wfc-min-spend.service.ts sends a polite reminder to a guest who
// sat for completed full hours without reaching `min_spend_per_hour_idr`.
//
// Source of the rules: the card brief (brief-987.md, legend-e24cz) and the
// schema columns it names. Written before the service exists (fail-first: the
// import below cannot resolve yet).
//
// Rules under test:
// - Per wifi_policies row of the outlet with min_spend_per_hour_idr not null,
//   every open table session (closedAt null) on a table of the policy's zone.
// - Only while `now` is inside the policy's peak_schedule window; off-peak is
//   relaxed (no reminder).
// - h = floor((now - openedAt) / 1 hour) completed hours, h >= 1;
//   required = h * min_spend_per_hour_idr; spend = net order total of the
//   session (completed orders, tax and service charge excluded).
//   spend < required -> a reminder; spend >= required -> none.
// - Recipients (CTO decision, no migration): every DISTINCT signed-in
//   participant (session_participants.user_id not null). Anonymous
//   participants get nothing; no staff user is notified.
// - One notifications row per user: category `wfc_min_spend`, dedupe key
//   `wfc_min_spend:<sessionId>:<h>:<userId>`, outlet_id set, link null.
// - Idempotent per hour: running twice in the same period adds nothing; the
//   next completed hour adds another reminder.
//
// Assumptions (the brief leaves them open):
// - Peak windows (`startsAt`/`endsAt`, `daysOfWeek` 0 = Sunday) are read in the
//   outlet timezone (Asia/Jakarta, UTC+7). NOW below is Tuesday 13:00 WIB.
// - Only 'completed' orders count as spend; 'voided' and 'draft' never do.
//   'sent' and 'awaiting_payment' are not exercised (open-bill ambiguity).
// - Net order total = subtotal - discount for a price-exclusive order, and
//   total - tax - service charge for a tax-inclusive order (harga nett).
// - Exactly one hour (h = 1) already counts as a completed hour.
// - The reminder title/body are fixed Indonesian wording (the text catalog only
//   holds renameable terms); the test only requires them to be non-empty.
// - Delivery goes through the shared notification path: the row, a
//   `notification.created` event and a delivery attempt per channel, all keyed
//   by the same dedupe key. `evaluateMinSpend` therefore also takes the trusted
//   `context` of the tenant, and signed-in guests are real `user` rows.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { evaluateMinSpend } from "../services/wfc-min-spend.service.ts";
import {
  asTenant,
  createWorld,
  hex64,
  owner,
  short,
  type World,
} from "./member-loyalty-helpers.ts";

if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
  throw new Error("Requires the disposable test database");

const HOUR = 3_600_000;
/** Tuesday 2026-11-17 13:00 in Jakarta (UTC+7). */
const NOW = new Date("2026-11-17T06:00:00Z");
const BUSINESS_DATE = "2026-11-17";
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const PEAK_NOW = [{ daysOfWeek: ALL_DAYS, startsAt: "10:00", endsAt: "23:00" }];

type Seed = {
  outletId?: string;
  minSpendPerHourIdr?: number | null;
  peakSchedule?: unknown;
  /** Hours (can be fractional) the session has been open at NOW. */
  openedHoursAgo?: number;
  closed?: boolean;
  withPolicy?: boolean;
  /** Distinct sign-in user ids, one device each. */
  signedInUsers?: string[];
  anonymousDevices?: number;
  /** Extra devices of the first signed-in user (same user, other device). */
  extraDevicesOfFirstUser?: number;
  confirmedBy?: string | null;
};

type Scenario = { zoneId: string; tableId: string; sessionId: string };

async function seedScenario(world: World, seed: Seed = {}): Promise<Scenario> {
  const outletId = seed.outletId ?? world.outletA;
  const zoneId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const openedAt = new Date(
    NOW.getTime() - (seed.openedHoursAgo ?? 2.5) * HOUR,
  );
  // Delivery needs a real account for every signed-in guest.
  for (const userId of seed.signedInUsers ?? [])
    await owner.query(
      'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [userId, "WFC guest", `${userId}@example.com`],
    );
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, service_charge_bp, minimum_spend_idr, hours, is_wfc)
       VALUES ($1, $2, $3, $4, 'pay_first', 0, 0, $5, true)`,
      [
        zoneId,
        world.tenantId,
        outletId,
        `WFC ${short()}`,
        JSON.stringify([
          { daysOfWeek: ALL_DAYS, start: "08:00", end: "23:00" },
        ]),
      ],
    );
    await client.query(
      `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type, layout)
       VALUES ($1, $2, $3, $4, $5, 4, 'regular', $6)`,
      [
        tableId,
        world.tenantId,
        outletId,
        zoneId,
        `W${short()}`.toUpperCase(),
        JSON.stringify({
          x: 10,
          y: 10,
          width: 60,
          height: 60,
          rotation: 0,
          shape: "rect",
        }),
      ],
    );
    if (seed.withPolicy !== false)
      await client.query(
        `INSERT INTO wifi_policies
           (id, tenant_id, outlet_id, zone_id, free_minutes, peak_free_minutes, spend_per_extra_hour_idr,
            extra_minutes, max_devices, peak_schedule, base_speed_kbps, full_speed_kbps,
            min_spend_per_hour_idr, tier_bonus_minutes)
         VALUES ($1, $2, $3, $4, 60, 30, 20000, 60, 3, $5, 2000, 10000, $6, '{}')`,
        [
          randomUUID(),
          world.tenantId,
          outletId,
          zoneId,
          JSON.stringify(seed.peakSchedule ?? PEAK_NOW),
          seed.minSpendPerHourIdr === undefined
            ? 30_000
            : seed.minSpendPerHourIdr,
        ],
      );
    await client.query(
      `INSERT INTO table_sessions
         (id, tenant_id, outlet_id, table_id, pax, payment_mode, status, session_token_hash,
          session_token_sealed, confirmed_by, opened_at, last_activity_at, closed_at, closed_reason)
       VALUES ($1, $2, $3, $4, 2, 'pay_first', $5, $6, 'sealed', $7, $8, $8, $9, $10)`,
      [
        sessionId,
        world.tenantId,
        outletId,
        tableId,
        seed.closed ? "closed" : "open",
        hex64(),
        seed.confirmedBy ?? null,
        openedAt.toISOString(),
        seed.closed ? NOW.toISOString() : null,
        seed.closed ? "paid_and_cleaned" : null,
      ],
    );
    const participants: Array<string | null> = [
      ...(seed.signedInUsers ?? []),
      ...Array.from(
        { length: seed.extraDevicesOfFirstUser ?? 0 },
        () => (seed.signedInUsers ?? [])[0] ?? null,
      ),
      ...Array.from({ length: seed.anonymousDevices ?? 0 }, () => null),
    ];
    for (const userId of participants)
      await client.query(
        `INSERT INTO session_participants (id, tenant_id, outlet_id, table_session_id, device_hash, user_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          world.tenantId,
          outletId,
          sessionId,
          `dev-${randomUUID()}`,
          userId,
        ],
      );
  });
  return { zoneId, tableId, sessionId };
}

type OrderSeed = {
  outletId?: string;
  sessionId: string;
  status?: "completed" | "voided" | "draft";
  subtotal: number;
  discount?: number;
  service?: number;
  tax?: number;
  inclusive?: boolean;
};

async function seedOrder(world: World, seed: OrderSeed): Promise<void> {
  const discount = seed.discount ?? 0;
  const service = seed.service ?? 0;
  const tax = seed.tax ?? 0;
  const total = seed.inclusive
    ? seed.subtotal - discount
    : seed.subtotal - discount + service + tax;
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode, table_session_id,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          prices_include_tax, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'qr', 'dine_in', 'pay_first', $5, $6, $7, $8, $9, 0, $10, $11, $12, $13, $14)`,
      [
        ulidToUuid(createUlid()),
        world.tenantId,
        seed.outletId ?? world.outletA,
        `WF-${short()}`.toUpperCase(),
        seed.sessionId,
        seed.subtotal,
        discount,
        service,
        tax,
        total,
        seed.inclusive ?? false,
        seed.status ?? "completed",
        BUSINESS_DATE,
        new Date(NOW.getTime() - HOUR).toISOString(),
      ],
    ),
  );
}

function evaluate(
  world: World,
  at: Date = NOW,
  outletId: string = world.outletA,
) {
  return withTenant(db, world.context, (tx) =>
    evaluateMinSpend(tx, {
      context: world.context,
      tenantId: tenantIdSchema.parse(world.tenantId),
      outletId: outletIdSchema.parse(outletId),
      now: at,
    }),
  );
}

type Reminder = {
  user_id: string;
  outlet_id: string | null;
  category: string;
  title: string;
  body: string;
  link: string | null;
  dedupe_key: string;
};

/** All wfc_min_spend notifications of the tenant, optionally of one session. */
async function reminders(
  world: World,
  sessionId?: string,
): Promise<Reminder[]> {
  return asTenant(world.tenantId, async (client) => {
    const result = await client.query<Reminder>(
      `SELECT user_id, outlet_id, category, title, body, link, dedupe_key
       FROM notifications
       WHERE tenant_id = $1 AND category = 'wfc_min_spend'
         AND ($2::text IS NULL OR dedupe_key LIKE $3)
       ORDER BY dedupe_key`,
      [world.tenantId, sessionId ?? null, `wfc_min_spend:${sessionId ?? ""}:%`],
    );
    return result.rows;
  });
}

const key = (sessionId: string, hours: number, userId: string) =>
  `wfc_min_spend:${sessionId}:${hours}:${userId}`;

describe("legend-e24cz WFC minimum spend per hour reminder", () => {
  it("reminds a signed-in participant who spent less than hours x minimum, with the specified row shape", async () => {
    const world = await createWorld();
    const user = randomUUID();
    // 2.5 hours open -> h = 2 -> required 60.000; spend 50.000 < 60.000.
    const { sessionId } = await seedScenario(world, { signedInUsers: [user] });
    await seedOrder(world, { sessionId, subtotal: 50_000 });

    await evaluate(world);

    const rows = await reminders(world, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: user,
      outlet_id: world.outletA,
      category: "wfc_min_spend",
      link: null,
      dedupe_key: key(sessionId, 2, user),
    });
    expect(rows[0]?.title.trim()).not.toBe("");
    expect(rows[0]?.body.trim()).not.toBe("");
  });

  it("sums several completed orders of the session before comparing", async () => {
    const world = await createWorld();
    const user = randomUUID();
    const { sessionId } = await seedScenario(world, { signedInUsers: [user] });
    await seedOrder(world, { sessionId, subtotal: 25_000 });
    await seedOrder(world, { sessionId, subtotal: 35_000 }); // 60.000 = required

    await evaluate(world);

    expect(await reminders(world, sessionId)).toHaveLength(0);
  });

  it("sends nothing when spend meets or exceeds the requirement", async () => {
    const world = await createWorld();
    const meets = await seedScenario(world, { signedInUsers: [randomUUID()] });
    await seedOrder(world, { sessionId: meets.sessionId, subtotal: 60_000 });
    const exceeds = await seedScenario(world, {
      signedInUsers: [randomUUID()],
    });
    await seedOrder(world, { sessionId: exceeds.sessionId, subtotal: 90_000 });

    await evaluate(world);

    expect(await reminders(world)).toHaveLength(0);
  });

  it("reminds a session with no orders at all", async () => {
    const world = await createWorld();
    const user = randomUUID();
    const { sessionId } = await seedScenario(world, { signedInUsers: [user] });

    await evaluate(world);

    const rows = await reminders(world, sessionId);
    expect(rows.map((row) => row.dedupe_key)).toEqual([
      key(sessionId, 2, user),
    ]);
  });

  it("does not count voided or draft orders as spend", async () => {
    const world = await createWorld();
    const user = randomUUID();
    const { sessionId } = await seedScenario(world, { signedInUsers: [user] });
    await seedOrder(world, {
      sessionId,
      subtotal: 100_000,
      status: "voided",
    });
    await seedOrder(world, { sessionId, subtotal: 100_000, status: "draft" });

    await evaluate(world);

    expect(await reminders(world, sessionId)).toHaveLength(1);
  });

  it("excludes tax and service charge from spend (price-exclusive order)", async () => {
    const world = await createWorld();
    const user = randomUUID();
    // required 60.000. Net 55.000 < 60.000 although the total 65.500 would pass.
    const { sessionId } = await seedScenario(world, { signedInUsers: [user] });
    await seedOrder(world, {
      sessionId,
      subtotal: 55_000,
      service: 5_000,
      tax: 5_500,
    });

    await evaluate(world);

    expect(await reminders(world, sessionId)).toHaveLength(1);
  });

  it("excludes tax from spend of a tax-inclusive order", async () => {
    const world = await createWorld();
    const user = randomUUID();
    // min 50.000/h -> required 100.000 at h = 2. Total 105.000 includes tax
    // 11.000 -> net 94.000 < 100.000.
    const { sessionId } = await seedScenario(world, {
      signedInUsers: [user],
      minSpendPerHourIdr: 50_000,
    });
    await seedOrder(world, {
      sessionId,
      subtotal: 105_000,
      tax: 11_000,
      inclusive: true,
    });

    await evaluate(world);

    expect(await reminders(world, sessionId)).toHaveLength(1);
  });

  it("subtracts a discount from spend", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      signedInUsers: [randomUUID()],
    });
    // 70.000 - 20.000 = 50.000 < 60.000.
    await seedOrder(world, { sessionId, subtotal: 70_000, discount: 20_000 });

    await evaluate(world);

    expect(await reminders(world, sessionId)).toHaveLength(1);
  });

  it("counts only the orders of the session itself", async () => {
    const world = await createWorld();
    const lacking = await seedScenario(world, {
      signedInUsers: [randomUUID()],
    });
    const rich = await seedScenario(world, { signedInUsers: [randomUUID()] });
    await seedOrder(world, { sessionId: rich.sessionId, subtotal: 500_000 });

    await evaluate(world);

    expect(await reminders(world, lacking.sessionId)).toHaveLength(1);
    expect(await reminders(world, rich.sessionId)).toHaveLength(0);
  });

  it("reminds every distinct signed-in participant once and nobody anonymous", async () => {
    const world = await createWorld();
    const [first, second] = [randomUUID(), randomUUID()] as const;
    const { sessionId } = await seedScenario(world, {
      signedInUsers: [first, second],
      extraDevicesOfFirstUser: 1,
      anonymousDevices: 2,
    });

    await evaluate(world);

    const rows = await reminders(world, sessionId);
    expect(rows.map((row) => row.user_id).sort()).toEqual(
      [first, second].sort(),
    );
    expect(rows.map((row) => row.dedupe_key).sort()).toEqual(
      [key(sessionId, 2, first), key(sessionId, 2, second)].sort(),
    );
  });

  it("sends exactly one reminder when only one of two participants is signed in", async () => {
    const world = await createWorld();
    const user = randomUUID();
    const { sessionId } = await seedScenario(world, {
      signedInUsers: [user],
      anonymousDevices: 1,
    });

    await evaluate(world);
    await evaluate(world);

    const rows = await reminders(world, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(user);
  });

  it("creates no reminder when every participant is anonymous", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, { anonymousDevices: 2 });

    await evaluate(world);

    expect(await reminders(world, sessionId)).toHaveLength(0);
  });

  it("never notifies the staff user who confirmed the session", async () => {
    const world = await createWorld();
    const staff = randomUUID();
    const guest = randomUUID();
    await seedScenario(world, {
      signedInUsers: [guest],
      confirmedBy: staff,
    });

    await evaluate(world);

    const rows = await reminders(world);
    expect(rows.map((row) => row.user_id)).toEqual([guest]);
  });

  it("is idempotent: running twice in the same hour creates one reminder", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      signedInUsers: [randomUUID()],
    });

    await evaluate(world);
    await evaluate(world);
    // A later run inside the same completed hour (2.5h -> 2.75h) adds nothing.
    await evaluate(world, new Date(NOW.getTime() + 0.25 * HOUR));

    expect(await reminders(world, sessionId)).toHaveLength(1);
  });

  it("delivers through the notification path once: delivery attempts, no duplicate on a repeat run", async () => {
    const world = await createWorld();
    const user = randomUUID();
    const { sessionId } = await seedScenario(world, { signedInUsers: [user] });
    const countDelivery = () =>
      asTenant(world.tenantId, async (client) => {
        const result = await client.query<{ channel: string; keys: string }>(
          `SELECT d.channel, d.idempotency_key AS keys
           FROM delivery_attempts d
           JOIN notifications n ON n.tenant_id = d.tenant_id AND n.id = d.notification_id
           WHERE n.tenant_id = $1 AND n.dedupe_key = $2
           ORDER BY d.channel`,
          [world.tenantId, key(sessionId, 2, user)],
        );
        return result.rows;
      });

    await evaluate(world);
    const first = await countDelivery();
    await evaluate(world);
    const second = await countDelivery();

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(first.map((row) => row.channel)).toContain("web_push");
    expect(first[0]?.keys).toBe(
      `${key(sessionId, 2, user)}:${first[0]?.channel}`,
    );
  });

  it("sends another reminder for the next completed hour", async () => {
    const world = await createWorld();
    const user = randomUUID();
    const { sessionId } = await seedScenario(world, { signedInUsers: [user] });

    await evaluate(world);
    // 3.5 hours open -> h = 3 -> required 90.000, still unmet.
    await evaluate(world, new Date(NOW.getTime() + HOUR));
    await evaluate(world, new Date(NOW.getTime() + HOUR));

    const rows = await reminders(world, sessionId);
    expect(rows.map((row) => row.dedupe_key)).toEqual([
      key(sessionId, 2, user),
      key(sessionId, 3, user),
    ]);
  });

  it("stops reminding once the spend catches up with the new requirement", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      signedInUsers: [randomUUID()],
    });
    await evaluate(world); // h = 2, no spend -> reminder
    await seedOrder(world, { sessionId, subtotal: 90_000 });

    await evaluate(world, new Date(NOW.getTime() + HOUR)); // h = 3, 90.000 >= 90.000

    expect(await reminders(world, sessionId)).toHaveLength(1);
  });

  it("sends nothing before one full hour has completed", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      signedInUsers: [randomUUID()],
      openedHoursAgo: 0.9,
    });

    await evaluate(world);

    expect(await reminders(world, sessionId)).toHaveLength(0);
  });

  it("counts exactly one hour as a completed hour (h = 1)", async () => {
    const world = await createWorld();
    const user = randomUUID();
    const { sessionId } = await seedScenario(world, {
      signedInUsers: [user],
      openedHoursAgo: 1,
    });
    await seedOrder(world, { sessionId, subtotal: 29_999 }); // < 30.000

    await evaluate(world);

    const rows = await reminders(world, sessionId);
    expect(rows.map((row) => row.dedupe_key)).toEqual([
      key(sessionId, 1, user),
    ]);
  });

  it("ignores a closed session", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      signedInUsers: [randomUUID()],
      closed: true,
    });

    await evaluate(world);

    expect(await reminders(world, sessionId)).toHaveLength(0);
  });

  it("stays relaxed outside the peak window (hours of day)", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      signedInUsers: [randomUUID()],
      // NOW is 13:00 WIB, the peak is 17:00-20:00.
      peakSchedule: [
        { daysOfWeek: ALL_DAYS, startsAt: "17:00", endsAt: "20:00" },
      ],
    });

    await evaluate(world);

    expect(await reminders(world, sessionId)).toHaveLength(0);
  });

  it("stays relaxed on a day that is not in the peak window (Tuesday excluded)", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      signedInUsers: [randomUUID()],
      peakSchedule: [
        { daysOfWeek: [0, 1, 3, 4, 5, 6], startsAt: "10:00", endsAt: "23:00" },
      ],
    });

    await evaluate(world);

    expect(await reminders(world, sessionId)).toHaveLength(0);
  });

  it("starts reminding when the evaluation time enters the peak window", async () => {
    const world = await createWorld();
    const user = randomUUID();
    const { sessionId } = await seedScenario(world, {
      signedInUsers: [user],
      // Peak 14:00-20:00 WIB: 13:00 is off-peak; 15:00 is peak with 4.5h open (h = 4).
      peakSchedule: [
        { daysOfWeek: ALL_DAYS, startsAt: "14:00", endsAt: "20:00" },
      ],
    });

    await evaluate(world);
    expect(await reminders(world, sessionId)).toHaveLength(0);

    await evaluate(world, new Date(NOW.getTime() + 2 * HOUR)); // 15:00 WIB, 4.5h open
    expect(
      (await reminders(world, sessionId)).map((r) => r.dedupe_key),
    ).toEqual([key(sessionId, 4, user)]);
  });

  it("ignores a policy without a minimum spend and a zone without a policy", async () => {
    const world = await createWorld();
    const noMinimum = await seedScenario(world, {
      signedInUsers: [randomUUID()],
      minSpendPerHourIdr: null,
    });
    const noPolicy = await seedScenario(world, {
      signedInUsers: [randomUUID()],
      withPolicy: false,
    });

    await evaluate(world);

    expect(await reminders(world, noMinimum.sessionId)).toHaveLength(0);
    expect(await reminders(world, noPolicy.sessionId)).toHaveLength(0);
  });

  it("evaluates only the requested outlet", async () => {
    const world = await createWorld();
    const here = await seedScenario(world, { signedInUsers: [randomUUID()] });
    const elsewhere = await seedScenario(world, {
      outletId: world.outletB,
      signedInUsers: [randomUUID()],
    });

    await evaluate(world, NOW, world.outletA);

    expect(await reminders(world, here.sessionId)).toHaveLength(1);
    expect(await reminders(world, elsewhere.sessionId)).toHaveLength(0);

    await evaluate(world, NOW, world.outletB);

    const rows = await reminders(world, elsewhere.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outlet_id).toBe(world.outletB);
  });

  it("never reads or writes another tenant", async () => {
    const mine = await createWorld();
    const theirs = await createWorld();
    const mineScenario = await seedScenario(mine, {
      signedInUsers: [randomUUID()],
    });
    const theirScenario = await seedScenario(theirs, {
      signedInUsers: [randomUUID()],
    });

    await evaluate(mine);
    expect(await reminders(mine, mineScenario.sessionId)).toHaveLength(1);
    expect(await reminders(theirs, theirScenario.sessionId)).toHaveLength(0);

    // Asking for the other tenant's outlet through my tenant context finds nothing.
    await evaluate(mine, NOW, theirs.outletA).catch(() => undefined);
    expect(await reminders(theirs, theirScenario.sessionId)).toHaveLength(0);
  });
});
