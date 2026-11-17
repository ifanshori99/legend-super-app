// legend-qr3sd (PRD F39 "Wi-Fi Berbasis Belanja"): WFC minimum spend reminder
// for a participant WITHOUT an account. Follow-up of legend-e24cz
// (wfc-min-spend-reminder.test.ts), whose known limitation was: an anonymous
// participant (session_participants.user_id null) gets no reminder because
// notifications.user_id is NOT NULL.
//
// Fail-first: written before the feature exists (migration 0596 reserved for
// qr3sd). It must fail for missing behavior: no new columns/table, no reminder.
//
// Rules under test (brief-993.md, card qr3sd):
// - A WFC participant without an account who left a session contact (WhatsApp
//   number and/or email) gets ONE reminder per session + completed hour.
// - No contact = no reminder and no charge.
// - MONEY: the reminder is a message only. min-spend never bills more: no
//   order, payment or session change is created or modified, and a session that
//   met the requirement (or is off-peak/closed/pending) gets nothing.
// - Another tenant's (or outlet's) sessions are never touched or read.
// - The existing signed-in path is unchanged (still one `notifications` row
//   per distinct user) and a signed-in participant is not reminded twice.
//
// CONTRACT ASSUMPTIONS (docs/CONTRACT.md has no entry yet; the brief leaves the
// recipient model open, so these names are the engineer's to confirm or
// rename together with this file):
// 1. Session contact lives on the participant: two new nullable columns on
//    `session_participants`: `contact_whatsapp` (text, E.164 like
//    '+628123456789') and `contact_email` (text). A blank/whitespace-only value
//    counts as no contact.
// 2. Anonymous reminders are recorded in a new tenant+outlet scoped table
//    `wfc_guest_reminders` (RLS like the other tenant tables) with columns:
//    id, tenant_id, outlet_id, table_session_id, participant_id (uuid, the
//    chosen participant), hours (int, the completed hour h), channel
//    ('whatsapp' | 'email'), destination (text, the normalised contact),
//    dedupe_key (text, unique per tenant, starts with
//    `wfc_min_spend:<sessionId>:<h>:`), created_at. Delivery of these rows
//    (WA/email send) is the existing outbound path and is out of scope here.
// 3. One reminder per distinct destination per session + hour: two devices that
//    left the same number get one; different numbers get one each. A
//    participant with both a number and an email gets exactly ONE reminder
//    (WhatsApp preferred; the test accepts either channel).
// 4. A participant with user_id set is handled by the old `notifications`
//    path only, even if they also left a contact: no `wfc_guest_reminders` row.
// 5. `evaluateMinSpend(tx, { context, tenantId, outletId, now })` keeps its
//    signature; the thresholds, peak window, spend and h rules of
//    wfc-min-spend-reminder.test.ts are unchanged and not re-tested here beyond
//    the money guards.
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

type Guest = {
  /** Signed-in user id; omit for an anonymous participant. */
  userId?: string;
  whatsapp?: string | null;
  email?: string | null;
};

type Seed = {
  outletId?: string;
  minSpendPerHourIdr?: number;
  peakSchedule?: unknown;
  /** Hours (can be fractional) the session has been open at NOW. */
  openedHoursAgo?: number;
  closed?: boolean;
  status?: "open" | "bill_requested" | "pending_confirmation";
  guests: Guest[];
};

type Scenario = { zoneId: string; tableId: string; sessionId: string };

async function seedScenario(world: World, seed: Seed): Promise<Scenario> {
  const outletId = seed.outletId ?? world.outletA;
  const zoneId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const openedAt = new Date(
    NOW.getTime() - (seed.openedHoursAgo ?? 2.5) * HOUR,
  );
  for (const guest of seed.guests)
    if (guest.userId)
      await owner.query(
        'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
        [guest.userId, "WFC guest", `${guest.userId}@example.com`],
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
        seed.minSpendPerHourIdr ?? 30_000,
      ],
    );
    await client.query(
      `INSERT INTO table_sessions
         (id, tenant_id, outlet_id, table_id, pax, payment_mode, status, session_token_hash,
          session_token_sealed, opened_at, last_activity_at, closed_at, closed_reason,
          bill_requested_at)
       VALUES ($1, $2, $3, $4, 2, $10, $5, $6, 'sealed', $7, $7, $8, $9, $11)`,
      [
        sessionId,
        world.tenantId,
        outletId,
        tableId,
        seed.closed ? "closed" : (seed.status ?? "open"),
        hex64(),
        openedAt.toISOString(),
        seed.closed ? NOW.toISOString() : null,
        seed.closed ? "paid_and_cleaned" : null,
        seed.status === "pending_confirmation" ? "open_bill" : "pay_first",
        seed.status === "bill_requested" ? NOW.toISOString() : null,
      ],
    );
    for (const guest of seed.guests)
      await client.query(
        `INSERT INTO session_participants
           (id, tenant_id, outlet_id, table_session_id, device_hash, user_id, contact_whatsapp, contact_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          world.tenantId,
          outletId,
          sessionId,
          `dev-${randomUUID()}`,
          guest.userId ?? null,
          guest.whatsapp ?? null,
          guest.email ?? null,
        ],
      );
  });
  return { zoneId, tableId, sessionId };
}

async function seedOrder(
  world: World,
  sessionId: string,
  subtotal: number,
  outletId: string = world.outletA,
): Promise<void> {
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode, table_session_id,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          prices_include_tax, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'qr', 'dine_in', 'pay_first', $5, $6, 0, 0, 0, 0, $6, false, 'completed', $7, $8)`,
      [
        ulidToUuid(createUlid()),
        world.tenantId,
        outletId,
        `WA-${short()}`.toUpperCase(),
        sessionId,
        subtotal,
        BUSINESS_DATE,
        new Date(NOW.getTime() - HOUR).toISOString(),
      ],
    );
  });
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

type GuestReminder = {
  outlet_id: string;
  table_session_id: string;
  hours: number;
  channel: string;
  destination: string;
  dedupe_key: string;
};

/** Anonymous-guest reminders of the tenant, optionally of one session. */
async function guestReminders(
  world: World,
  sessionId?: string,
): Promise<GuestReminder[]> {
  return asTenant(world.tenantId, async (client) => {
    const result = await client.query<GuestReminder>(
      `SELECT outlet_id, table_session_id, hours, channel, destination, dedupe_key
       FROM wfc_guest_reminders
       WHERE tenant_id = $1 AND ($2::uuid IS NULL OR table_session_id = $2)
       ORDER BY hours, destination`,
      [world.tenantId, sessionId ?? null],
    );
    return result.rows;
  });
}

/** Old path: wfc_min_spend notifications of the tenant for one session. */
async function accountReminderCount(
  world: World,
  sessionId: string,
): Promise<number> {
  return asTenant(world.tenantId, async (client) => {
    const result = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notifications
       WHERE tenant_id = $1 AND category = 'wfc_min_spend' AND dedupe_key LIKE $2`,
      [world.tenantId, `wfc_min_spend:${sessionId}:%`],
    );
    return Number(result.rows[0]?.n ?? 0);
  });
}

/** Everything a charge would touch: orders, payment intents, session state. */
async function moneyState(world: World, sessionId: string) {
  return asTenant(world.tenantId, async (client) => {
    const orders = await client.query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, COALESCE(sum(total_idr), 0)::text AS total
       FROM orders WHERE tenant_id = $1`,
      [world.tenantId],
    );
    const intents = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM payment_intents WHERE tenant_id = $1",
      [world.tenantId],
    );
    const session = await client.query<{ status: string; closed_at: Date }>(
      "SELECT status, closed_at FROM table_sessions WHERE tenant_id = $1 AND id = $2",
      [world.tenantId, sessionId],
    );
    return {
      orders: orders.rows[0],
      paymentIntents: intents.rows[0]?.n,
      session: session.rows[0],
    };
  });
}

describe("legend-qr3sd WFC minimum spend reminder for a participant without an account", () => {
  it("reminds an anonymous participant with a WhatsApp contact exactly once for the session hour", async () => {
    const world = await createWorld();
    // 2.5 hours open -> h = 2, required 60.000, spend 0.
    const { sessionId } = await seedScenario(world, {
      guests: [{ whatsapp: "+628123456789" }],
    });

    await evaluate(world);

    const rows = await guestReminders(world, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outlet_id: world.outletA,
      table_session_id: sessionId,
      hours: 2,
      channel: "whatsapp",
      destination: "+628123456789",
    });
    expect(
      rows[0]?.dedupe_key.startsWith(`wfc_min_spend:${sessionId}:2:`),
    ).toBe(true);
  });

  it("reminds an anonymous participant who left only an email, by email", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      guests: [{ email: "tamu@example.com" }],
    });

    await evaluate(world);

    const rows = await guestReminders(world, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hours: 2,
      channel: "email",
      destination: "tamu@example.com",
    });
  });

  it("sends exactly one reminder to a participant who left both a number and an email", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      guests: [{ whatsapp: "+628111222333", email: "dua@example.com" }],
    });

    await evaluate(world);

    const rows = await guestReminders(world, sessionId);
    expect(rows).toHaveLength(1);
    expect(["whatsapp", "email"]).toContain(rows[0]?.channel);
  });

  it("is idempotent: repeat runs inside the same hour add nothing", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      guests: [{ whatsapp: "+628123456789" }],
    });

    await evaluate(world);
    await evaluate(world);
    // A later run inside the same completed hour (2.5h -> 2.75h) adds nothing.
    await evaluate(world, new Date(NOW.getTime() + 0.25 * HOUR));

    expect(await guestReminders(world, sessionId)).toHaveLength(1);
  });

  it("sends another reminder for the next completed hour, once", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      guests: [{ whatsapp: "+628123456789" }],
    });

    await evaluate(world);
    // 3.5 hours open -> h = 3, required 90.000, still unmet.
    await evaluate(world, new Date(NOW.getTime() + HOUR));
    await evaluate(world, new Date(NOW.getTime() + HOUR));

    const rows = await guestReminders(world, sessionId);
    expect(rows.map((row) => row.hours)).toEqual([2, 3]);
  });

  it("sends one reminder per distinct contact and one when two devices share a contact", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      guests: [
        { whatsapp: "+628100000001" },
        { whatsapp: "+628100000001" }, // same number, another device
        { whatsapp: "+628100000002" },
      ],
    });

    await evaluate(world);
    await evaluate(world);

    const rows = await guestReminders(world, sessionId);
    expect(rows.map((row) => row.destination)).toEqual([
      "+628100000001",
      "+628100000002",
    ]);
  });

  it("sends the same contact a separate reminder for a different session", async () => {
    const world = await createWorld();
    const first = await seedScenario(world, {
      guests: [{ whatsapp: "+628123456789" }],
    });
    const second = await seedScenario(world, {
      guests: [{ whatsapp: "+628123456789" }],
    });

    await evaluate(world);

    expect(await guestReminders(world, first.sessionId)).toHaveLength(1);
    expect(await guestReminders(world, second.sessionId)).toHaveLength(1);
  });

  it("sends no reminder and writes nothing when the anonymous participant left no contact", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, { guests: [{}, {}] });

    await evaluate(world);

    expect(await guestReminders(world, sessionId)).toHaveLength(0);
    expect(await accountReminderCount(world, sessionId)).toBe(0);
  });

  it("treats a blank or whitespace-only contact as no contact", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      guests: [{ whatsapp: "", email: "   " }, { whatsapp: "  " }],
    });

    await evaluate(world);

    expect(await guestReminders(world, sessionId)).toHaveLength(0);
  });

  it("charges nothing when there is no contact: orders, payments and session stay untouched", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, { guests: [{}] });
    await seedOrder(world, sessionId, 10_000); // below the 60.000 requirement
    const before = await moneyState(world, sessionId);

    await evaluate(world);

    expect(await moneyState(world, sessionId)).toEqual(before);
    expect(await guestReminders(world, sessionId)).toHaveLength(0);
  });

  it("never bills: a reminder to an anonymous guest leaves orders, payments and session unchanged", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      guests: [{ whatsapp: "+628123456789" }],
    });
    await seedOrder(world, sessionId, 10_000);
    const before = await moneyState(world, sessionId);

    await evaluate(world);
    await evaluate(world, new Date(NOW.getTime() + HOUR));

    expect(await guestReminders(world, sessionId)).toHaveLength(2);
    expect(await moneyState(world, sessionId)).toEqual(before);
  });

  it("sends nothing when spend meets the requirement, even with a contact", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      guests: [{ whatsapp: "+628123456789" }],
    });
    await seedOrder(world, sessionId, 60_000); // = 2 x 30.000

    await evaluate(world);

    expect(await guestReminders(world, sessionId)).toHaveLength(0);
  });

  it("sends nothing before one full hour, off-peak, for a closed or a pending session", async () => {
    const world = await createWorld();
    const contact = [{ whatsapp: "+628123456789" }];
    const early = await seedScenario(world, {
      guests: contact,
      openedHoursAgo: 0.9,
    });
    const offPeak = await seedScenario(world, {
      guests: contact,
      peakSchedule: [
        { daysOfWeek: ALL_DAYS, startsAt: "17:00", endsAt: "20:00" },
      ],
    });
    const closed = await seedScenario(world, { guests: contact, closed: true });
    const pending = await seedScenario(world, {
      guests: contact,
      status: "pending_confirmation",
    });

    await evaluate(world);

    for (const scenario of [early, offPeak, closed, pending])
      expect(await guestReminders(world, scenario.sessionId)).toHaveLength(0);
  });

  it("still reminds a bill-requested session", async () => {
    const world = await createWorld();
    const { sessionId } = await seedScenario(world, {
      guests: [{ whatsapp: "+628123456789" }],
      status: "bill_requested",
    });

    await evaluate(world);

    expect(await guestReminders(world, sessionId)).toHaveLength(1);
  });

  it("keeps the signed-in path: one notification per user, no anonymous row, and no double reminder", async () => {
    const world = await createWorld();
    const user = randomUUID();
    const { sessionId } = await seedScenario(world, {
      guests: [
        // Signed in and also left a contact: only the notification path.
        { userId: user, whatsapp: "+628199999999" },
        { whatsapp: "+628123456789" },
      ],
    });

    await evaluate(world);
    await evaluate(world);

    expect(await accountReminderCount(world, sessionId)).toBe(1);
    const rows = await guestReminders(world, sessionId);
    expect(rows.map((row) => row.destination)).toEqual(["+628123456789"]);
  });

  it("evaluates only the requested outlet", async () => {
    const world = await createWorld();
    const here = await seedScenario(world, {
      guests: [{ whatsapp: "+628100000001" }],
    });
    const elsewhere = await seedScenario(world, {
      outletId: world.outletB,
      guests: [{ whatsapp: "+628100000002" }],
    });

    await evaluate(world, NOW, world.outletA);

    expect(await guestReminders(world, here.sessionId)).toHaveLength(1);
    expect(await guestReminders(world, elsewhere.sessionId)).toHaveLength(0);

    await evaluate(world, NOW, world.outletB);

    const rows = await guestReminders(world, elsewhere.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outlet_id).toBe(world.outletB);
  });

  it("never reads, writes or exposes another tenant", async () => {
    const mine = await createWorld();
    const theirs = await createWorld();
    const mineScenario = await seedScenario(mine, {
      guests: [{ whatsapp: "+628100000001" }],
    });
    const theirScenario = await seedScenario(theirs, {
      guests: [{ whatsapp: "+628100000002" }],
    });
    await seedOrder(theirs, theirScenario.sessionId, 5_000);
    const theirMoneyBefore = await moneyState(theirs, theirScenario.sessionId);

    await evaluate(mine);

    expect(await guestReminders(mine, mineScenario.sessionId)).toHaveLength(1);
    // The other tenant's session is untouched: no reminder, no money change.
    expect(await guestReminders(theirs, theirScenario.sessionId)).toHaveLength(
      0,
    );
    expect(await moneyState(theirs, theirScenario.sessionId)).toEqual(
      theirMoneyBefore,
    );
    // Row level security: the other tenant cannot see my reminders either.
    expect(await guestReminders(theirs, mineScenario.sessionId)).toHaveLength(
      0,
    );

    // Asking for their outlet through my tenant context finds nothing.
    await evaluate(mine, NOW, theirs.outletA).catch(() => undefined);
    expect(await guestReminders(theirs, theirScenario.sessionId)).toHaveLength(
      0,
    );
  });
});
