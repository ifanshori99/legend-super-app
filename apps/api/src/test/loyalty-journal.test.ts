// legend-msqvi: the loyalty points journal (PSAK 72 deferral), decision record
// docs/briefs/sub-304c-arch-decision.md and sub-brief sub-304c-points-journal.md.
//
// Feature id: legend-msqvi. Test names are LOY-JNL-nn.
//
// Path under test: a ledger row is posted through `postLedgerEntry` (the public
// service), the outbox event it emits is read back, and that event goes through
// `deliverAutoJournalEvent` like the worker does.
//
// Assumptions (the brief, not backend code, is the source):
// - Accounts: 2105 loyalty_liability, 4105 loyalty_points_deferral, 4104
//   loyalty_breakage_revenue. The fixture chart maps these three roles only.
// - Amount = signed `liability_idr` of the ledger row (1 point = Rp100).
// - Journal idempotency key `aj:loyalty:<ledgerEntryId>`, `source_type =
//   'loyalty'`, `source_id` = ledger id.
// - A replay answers `already_posted` with the same journal id.
// - A skipped event (training order, accounting off) answers `ignored` and
//   parks nothing.
// - Accounting off: the event is ignored. Enabling the module later and
//   delivering the same event again posts it (lookup-first consumer).
// - The ledger event carries no entry id: the consumer reads it from
//   `event.idempotencyKey` = "<event name>:<ledgerEntryId>". A key without an
//   id, or an id with no ledger row in the tenant, parks
//   AUTO_JOURNAL_PAYLOAD_INVALID.
// - A redeem row with a source other than reward_redemption (a POS points
//   payment, journaled by `order.paid` paidPointsIdr) cannot exist: the ledger
//   check constraint rejects it, so no journal and nothing parked (LOY-JNL-18).
// - An earn row's `business_date` (the earning order's date) is the journal
//   `entry_date`, not the day of created_at (LOY-JNL-19).
// - A missing 4105 mapping parks ACCOUNT_MAPPING_MISSING as retryable; the
//   sweep `retryParkedAutoJournals` posts it once the mapping is back, and a
//   second sweep posts nothing more (LOY-JNL-20).
// - Every test makes its own tenant, so counts are exact and nothing is shared.
// - The business date comes from the ledger row's created_at (real clock), so
//   fiscal periods are opened from 2026-09 to 24 months past the run date.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, idr, ulidToUuid } from "@starter/shared/core";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { withProfileLock } from "../db/member-scope.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  deliverAutoJournalEvent,
  retryParkedAutoJournals,
  type AutoJournalResult,
} from "../services/accounting-auto-journal-consumer.ts";
import {
  postLedgerEntry,
  type LedgerPostInput,
} from "../services/point-ledger.service.ts";
import { updateLoyaltyProgram } from "../services/loyalty-program.service.ts";
import { loyaltyAnchorOf } from "../services/accounting-auto-journal-amounts.ts";
import { deliverLoyaltyEarnEvent } from "../services/loyalty-earn-consumer.ts";
import {
  asTenant,
  balanceOf,
  contextOf,
  owner,
  orderPaidEvent,
  seedMember,
  seedOrder,
  seedProgram,
  short,
} from "./member-loyalty-helpers.ts";
import {
  key,
  markVoucherRedeemed,
  redeemAs,
  redemptionRow,
  scopeOf,
  seedReward,
  vouchersOf,
} from "./member-rewards-helpers.ts";

const FLAGS_ON = JSON.stringify({
  modules: ["accounting", "loyalty"],
  integrationProviders: [],
});
const FLAGS_OFF = JSON.stringify({
  modules: ["loyalty"],
  integrationProviders: [],
});

type Code = "2105" | "4104" | "4105";
const CHART: [string, Code, string, string, string][] = [
  [
    "loyalty_liability",
    "2105",
    "Utang Poin Loyalty",
    "liability",
    "current_liability",
  ],
  [
    "loyalty_breakage_revenue",
    "4104",
    "Pendapatan Poin Kedaluwarsa",
    "revenue",
    "revenue",
  ],
  [
    "loyalty_points_deferral",
    "4105",
    "Penangguhan Pendapatan Poin Loyalty",
    "revenue",
    "revenue",
  ],
];

type Entity = { id: string; outlets: string[] };
type World = {
  tenantId: string;
  context: ReturnType<typeof contextOf>;
  entities: Entity[];
  /** First entity, first outlet. */
  outletId: string;
};

function periods(): string[] {
  const list: string[] = [];
  const end = new Date();
  end.setUTCMonth(end.getUTCMonth() + 24);
  for (
    let cursor = new Date(Date.UTC(2026, 8, 1));
    cursor <= end;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  )
    list.push(cursor.toISOString().slice(0, 7));
  return list;
}

async function makeWorld(
  options: { accounting?: boolean; entities?: number } = {},
): Promise<World> {
  const tenantId = randomUUID();
  const brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Jurnal Poin', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantId,
      `uji-lj-${tenantId.slice(0, 8)}`,
      options.accounting === false ? FLAGS_OFF : FLAGS_ON,
      JSON.stringify({
        maxOutlets: 50,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, tenantId],
  );
  const entities: Entity[] = [];
  for (let index = 0; index < (options.entities ?? 1); index += 1) {
    const entity: Entity = { id: randomUUID(), outlets: [] };
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
      [entity.id, tenantId, `Entity LJ ${short()}`],
    );
    for (let outlet = 0; outlet < 2; outlet += 1) {
      const outletId = randomUUID();
      await owner.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
         VALUES ($1, $2, $3, $4, $5, 'Outlet LJ', 'Jl. LJ', 'Asia/Jakarta', '04:00', '{}', 'active')`,
        [outletId, tenantId, brandId, entity.id, `LJ-${short()}`.toUpperCase()],
      );
      entity.outlets.push(outletId);
    }
    for (const [role, code, name, type, group] of CHART) {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenantId, entity.id, code, name, type, group],
      );
      await owner.query(
        `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, entity.id, role, rows[0]!.id],
      );
    }
    for (const period of periods())
      await owner.query(
        `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
        [tenantId, entity.id, period],
      );
    entities.push(entity);
  }
  await seedProgram(tenantId);
  return {
    tenantId,
    context: contextOf(tenantId),
    entities,
    outletId: entities[0]!.outlets[0]!,
  };
}

// ---- ledger + event ----------------------------------------------------------

const IN_A_YEAR = () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

/** Posts one ledger row as legend_app under the profile lock. */
async function ledger(
  world: World,
  profileId: string,
  input: Omit<LedgerPostInput, "tenantId" | "customerProfileId">,
) {
  const result = await withTenant(db, world.context, async (tx) => {
    await withProfileLock(tx, world.tenantId, profileId);
    return postLedgerEntry(
      tx,
      world.context,
      { tenantId: world.tenantId, customerProfileId: profileId, ...input },
      new Date(),
    );
  });
  expect(result.inserted).toBe(true);
  return result.entry;
}

/** Earn from a real order of the tenant; `points` x Rp100 is the liability. */
async function earn(
  world: World,
  profileId: string,
  points: number,
  outletId = world.outletId,
) {
  const orderUlid = await seedOrder(world.tenantId, {
    outletId,
    profileId,
  });
  return ledger(world, profileId, {
    type: "earn",
    points,
    sourceType: "order",
    sourceId: orderUlid,
    outletId,
    expiresAt: IN_A_YEAR(),
  });
}

/** The outbox event the ledger row emitted, as the worker would deliver it. */
async function eventOf(
  world: World,
  name: string,
  ledgerId: string,
): Promise<EventEnvelope> {
  const rows = await asTenant(world.tenantId, async (client) => {
    const { rows } = await client.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'idempotencyKey' = $2`,
      [world.tenantId, `${name}:${ledgerId}`],
    );
    return rows;
  });
  expect(rows, `${name} event of ${ledgerId}`).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

function deliver(
  world: World,
  event: EventEnvelope,
): Promise<AutoJournalResult> {
  return withTenant(db, world.context, (tx) =>
    deliverAutoJournalEvent(world.context, event, tx, new Date()),
  );
}

async function post(world: World, event: EventEnvelope) {
  const result = await deliver(world, event);
  expect(result.status).toBe("posted");
  if (result.status !== "posted") throw new Error("not posted");
  return result;
}

// ---- reads (owner connection) -------------------------------------------------

type Line = { code: string; debit: number; credit: number };

async function linesOf(world: World, entryId: string): Promise<Line[]> {
  const { rows } = await owner.query<{
    code: string;
    debit: string;
    credit: string;
  }>(
    `SELECT c.code, sum(l.debit_idr)::text AS debit, sum(l.credit_idr)::text AS credit
       FROM journal_lines l JOIN chart_of_accounts c ON c.id = l.account_id
      WHERE l.tenant_id = $1 AND l.entry_id = $2 GROUP BY c.code ORDER BY c.code`,
    [world.tenantId, entryId],
  );
  return rows.map((row) => ({
    code: row.code,
    debit: Number(row.debit),
    credit: Number(row.credit),
  }));
}

async function expectBalanced(world: World, entryId: string): Promise<void> {
  const lines = await linesOf(world, entryId);
  const debit = lines.reduce((total, line) => total + line.debit, 0);
  const credit = lines.reduce((total, line) => total + line.credit, 0);
  expect(debit).toBeGreaterThan(0);
  expect(debit).toBe(credit);
}

type Entry = {
  id: string;
  source_type: string;
  source_id: string | null;
  outlet_id: string | null;
  legal_entity_id: string;
};

async function journalsOf(world: World, key?: string): Promise<Entry[]> {
  const { rows } = await owner.query<Entry>(
    `SELECT id, source_type, source_id::text AS source_id, outlet_id, legal_entity_id
       FROM journal_entries WHERE tenant_id = $1 AND ($2::text IS NULL OR idempotency_key = $2)`,
    [world.tenantId, key ?? null],
  );
  return rows;
}

async function parkedOf(world: World) {
  const { rows } = await owner.query<{
    error_code: string;
    retryable: boolean;
    event_name: string;
  }>(
    `SELECT error_code, retryable, event_name FROM auto_journal_parked WHERE tenant_id = $1`,
    [world.tenantId],
  );
  return rows;
}

/** Posts the event and returns the single journal keyed by the ledger id. */
async function journal(world: World, event: EventEnvelope, ledgerId: string) {
  const result = await post(world, event);
  const [entry] = await journalsOf(world, `aj:loyalty:${ledgerId}`);
  expect(entry, "journal by key aj:loyalty:<ledgerId>").toBeDefined();
  expect(entry!.id).toBe(result.journalEntryId);
  await expectBalanced(world, entry!.id);
  return entry!;
}

beforeAll(() => {
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  // Journals, parked rows and tenants stay (append-only, random names).
  await owner.end();
});

// ============================================================================

describe("legend-msqvi points journal: earn", () => {
  it("LOY-JNL-01 earning 1 000 points journals Dr 4105 = Cr 2105 = liability (Rp100.000), balanced, in the ledger outlet", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 1000);
    expect(row.liabilityIdr).toBe(100_000);

    const entry = await journal(
      world,
      await eventOf(world, "points.earned", row.id),
      row.id,
    );
    expect(await linesOf(world, entry.id)).toEqual([
      { code: "2105", debit: 0, credit: 100_000 },
      { code: "4105", debit: 100_000, credit: 0 },
    ]);
    expect(entry.source_type).toBe("loyalty");
    expect(entry.source_id).toBe(row.id);
    expect(entry.legal_entity_id).toBe(world.entities[0]!.id);
    expect(entry.outlet_id).toBe(world.outletId);
  });

  it("LOY-JNL-02 replaying the same event posts one journal and answers already_posted", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 10);
    const event = await eventOf(world, "points.earned", row.id);

    const first = await post(world, event);
    const second = await deliver(world, event);
    expect(second).toEqual({
      status: "already_posted",
      journalEntryId: first.journalEntryId,
    });
    expect(await journalsOf(world)).toHaveLength(1);
  });

  it("LOY-JNL-03 a bonus earn (mission) journals the same Dr 4105 / Cr 2105 with no outlet", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    const row = await ledger(world, member.id, {
      type: "bonus",
      points: 20,
      sourceType: "mission",
      sourceId: randomUUID(),
      expiresAt: IN_A_YEAR(),
    });
    const entry = await journal(
      world,
      await eventOf(world, "points.earned", row.id),
      row.id,
    );
    expect(await linesOf(world, entry.id)).toEqual([
      { code: "2105", debit: 0, credit: 2_000 },
      { code: "4105", debit: 2_000, credit: 0 },
    ]);
    expect(entry.outlet_id).toBeNull();
  });
});

describe("legend-msqvi points journal: reverse", () => {
  it("LOY-JNL-04 a partial refund reverse mirrors exactly the reversed amount; net 4105 and 2105 follow", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    const earned = await earn(world, member.id, 1000);
    await journal(
      world,
      await eventOf(world, "points.earned", earned.id),
      earned.id,
    );

    const reversed = await ledger(world, member.id, {
      type: "reverse",
      points: -400,
      sourceType: "refund",
      sourceId: randomUUID(),
      reversesEntryId: earned.id,
    });
    const entry = await journal(
      world,
      await eventOf(world, "points.reversed", reversed.id),
      reversed.id,
    );
    expect(await linesOf(world, entry.id)).toEqual([
      { code: "2105", debit: 40_000, credit: 0 },
      { code: "4105", debit: 0, credit: 40_000 },
    ]);
    expect(entry.source_type).toBe("loyalty");
    expect(entry.outlet_id).toBe(world.outletId);

    // The remaining 600 points are still deferred: Rp60.000 on both sides.
    const { rows } = await owner.query<{ code: string; net: string }>(
      `SELECT c.code, sum(l.debit_idr - l.credit_idr)::text AS net
         FROM journal_lines l JOIN chart_of_accounts c ON c.id = l.account_id
        WHERE l.tenant_id = $1 GROUP BY c.code ORDER BY c.code`,
      [world.tenantId],
    );
    expect(rows).toEqual([
      { code: "2105", net: "-60000" },
      { code: "4105", net: "60000" },
    ]);
  });

  it("LOY-JNL-05 a reverse with source_type void mirrors the voided earn", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    const earned = await earn(world, member.id, 50);
    const reversed = await ledger(world, member.id, {
      type: "reverse",
      points: -50,
      sourceType: "void",
      sourceId: randomUUID(),
      reversesEntryId: earned.id,
    });
    const entry = await journal(
      world,
      await eventOf(world, "points.reversed", reversed.id),
      reversed.id,
    );
    expect(await linesOf(world, entry.id)).toEqual([
      { code: "2105", debit: 5_000, credit: 0 },
      { code: "4105", debit: 0, credit: 5_000 },
    ]);
  });
});

describe("legend-msqvi points journal: redeem, expire, adjust", () => {
  it("LOY-JNL-06 a reward redemption journals Dr 2105 / Cr 4105 with no outlet", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    await earn(world, member.id, 100);
    const redemptionId = randomUUID();
    const row = await ledger(world, member.id, {
      type: "redeem",
      points: -30,
      sourceType: "reward_redemption",
      sourceId: redemptionId,
      event: { rewardId: randomUUID(), redemptionId },
    });
    const entry = await journal(
      world,
      await eventOf(world, "points.redeemed", row.id),
      row.id,
    );
    expect(await linesOf(world, entry.id)).toEqual([
      { code: "2105", debit: 3_000, credit: 0 },
      { code: "4105", debit: 0, credit: 3_000 },
    ]);
    expect(entry.outlet_id).toBeNull();
  });

  it("LOY-JNL-07 expiring points journals Dr 2105 / Cr 4104 breakage, not 4105", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    await earn(world, member.id, 100);
    const row = await ledger(world, member.id, {
      type: "expire",
      points: -25,
      sourceType: "expiry",
      sourceId: randomUUID(),
    });
    const entry = await journal(
      world,
      await eventOf(world, "points.expired", row.id),
      row.id,
    );
    expect(await linesOf(world, entry.id)).toEqual([
      { code: "2105", debit: 2_500, credit: 0 },
      { code: "4104", debit: 0, credit: 2_500 },
    ]);
  });

  it("LOY-JNL-08 a restore (points.adjusted, kind restore) mirrors the redeem: Dr 4105 / Cr 2105", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    await earn(world, member.id, 100);
    const redemptionId = randomUUID();
    const redeemed = await ledger(world, member.id, {
      type: "redeem",
      points: -30,
      sourceType: "reward_redemption",
      sourceId: redemptionId,
      event: { rewardId: randomUUID(), redemptionId },
    });
    const restored = await ledger(world, member.id, {
      type: "adjust",
      points: 30,
      sourceType: "adjustment",
      sourceId: randomUUID(),
      reversesEntryId: redeemed.id,
      reason: "Penukaran dibatalkan",
    });
    const event = await eventOf(world, "points.adjusted", restored.id);
    expect(event.payload).toMatchObject({ kind: "restore" });
    const entry = await journal(world, event, restored.id);
    expect(await linesOf(world, entry.id)).toEqual([
      { code: "2105", debit: 0, credit: 3_000 },
      { code: "4105", debit: 3_000, credit: 0 },
    ]);
  });

  it("LOY-JNL-09 a manual adjust (+) journals Dr 4105 / Cr 2105", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    const row = await ledger(world, member.id, {
      type: "adjust",
      points: 40,
      sourceType: "adjustment",
      sourceId: randomUUID(),
      reason: "Hadiah kompensasi",
      expiresAt: IN_A_YEAR(),
    });
    const event = await eventOf(world, "points.adjusted", row.id);
    expect(event.payload).toMatchObject({ kind: "manual" });
    const entry = await journal(world, event, row.id);
    expect(await linesOf(world, entry.id)).toEqual([
      { code: "2105", debit: 0, credit: 4_000 },
      { code: "4105", debit: 4_000, credit: 0 },
    ]);
  });

  it("LOY-JNL-10 a manual adjust (-) flips the sides: Dr 2105 / Cr 4105", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    await earn(world, member.id, 100);
    const row = await ledger(world, member.id, {
      type: "adjust",
      points: -15,
      sourceType: "adjustment",
      sourceId: randomUUID(),
      reason: "Koreksi kasir",
    });
    const entry = await journal(
      world,
      await eventOf(world, "points.adjusted", row.id),
      row.id,
    );
    expect(await linesOf(world, entry.id)).toEqual([
      { code: "2105", debit: 1_500, credit: 0 },
      { code: "4105", debit: 0, credit: 1_500 },
    ]);
  });
});

describe("legend-msqvi points journal: isolation and guards", () => {
  it("LOY-JNL-11 a tenant B sees no tenant A loyalty journal, and a tenant A event delivered to B posts nothing", async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    const member = await seedMember(a.tenantId);
    const row = await earn(a, member.id, 10);
    const event = await eventOf(a, "points.earned", row.id);

    // Wrong tenant context: not posted in B, nothing parked in B.
    expect((await deliver(b, event)).status).toBe("ignored");
    expect(await journalsOf(b)).toHaveLength(0);
    expect(await parkedOf(b)).toHaveLength(0);

    await post(a, event);
    expect(await journalsOf(a)).toHaveLength(1);
    expect(await journalsOf(b)).toHaveLength(0);
  });

  it("LOY-JNL-12 a tenant B event posts only in B and leaves tenant A journals untouched", async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    const memberA = await seedMember(a.tenantId);
    const rowA = await earn(a, memberA.id, 10);
    await post(a, await eventOf(a, "points.earned", rowA.id));
    const before = await journalsOf(a);

    const memberB = await seedMember(b.tenantId);
    const rowB = await earn(b, memberB.id, 20);
    await post(b, await eventOf(b, "points.earned", rowB.id));

    expect(await journalsOf(a)).toEqual(before);
    const journalsB = await journalsOf(b);
    expect(journalsB).toHaveLength(1);
    expect(journalsB[0]!.source_id).toBe(rowB.id);
    expect(await linesOf(b, journalsB[0]!.id)).toEqual([
      { code: "2105", debit: 0, credit: 2_000 },
      { code: "4105", debit: 2_000, credit: 0 },
    ]);
  });

  it("LOY-JNL-13 an earn from a training order is not journaled and parks nothing; the reverse of it is not journaled either", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletId,
      profileId: member.id,
    });
    // pos_orders of a completed order is frozen by a trigger: flag it the way
    // an operator backfill would (same as accounting-auto-journal-training).
    await asTenant(world.tenantId, async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "UPDATE pos_orders SET is_training = true WHERE tenant_id = $1 AND order_id = $2",
        [world.tenantId, ulidToUuid(orderUlid)],
      );
    });
    const earned = await ledger(world, member.id, {
      type: "earn",
      points: 30,
      sourceType: "order",
      sourceId: orderUlid,
      outletId: world.outletId,
      expiresAt: IN_A_YEAR(),
    });
    expect(
      (await deliver(world, await eventOf(world, "points.earned", earned.id)))
        .status,
    ).toBe("ignored");

    const reversed = await ledger(world, member.id, {
      type: "reverse",
      points: -30,
      sourceType: "refund",
      sourceId: randomUUID(),
      reversesEntryId: earned.id,
    });
    expect(
      (
        await deliver(
          world,
          await eventOf(world, "points.reversed", reversed.id),
        )
      ).status,
    ).toBe("ignored");

    expect(await journalsOf(world)).toHaveLength(0);
    expect(await parkedOf(world)).toHaveLength(0);
  });

  it("LOY-JNL-14 an accounting-disabled tenant posts and parks nothing; once enabled the same event posts", async () => {
    const world = await makeWorld({ accounting: false });
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 10);
    const event = await eventOf(world, "points.earned", row.id);

    expect((await deliver(world, event)).status).toBe("ignored");
    expect(await journalsOf(world)).toHaveLength(0);
    expect(await parkedOf(world)).toHaveLength(0);

    await owner.query(
      "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
      [world.tenantId, FLAGS_ON],
    );
    await post(world, event);
    expect(await journalsOf(world)).toHaveLength(1);
  });

  it("LOY-JNL-15 a tenant with two legal entities parks LOYALTY_LEGAL_ENTITY_AMBIGUOUS, not retryable, and posts nothing", async () => {
    const world = await makeWorld({ entities: 2 });
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 10);
    const result = await deliver(
      world,
      await eventOf(world, "points.earned", row.id),
    );
    expect(result).toEqual({
      status: "parked",
      code: "LOYALTY_LEGAL_ENTITY_AMBIGUOUS",
      retryable: false,
    });
    expect(await journalsOf(world)).toHaveLength(0);
    expect(await parkedOf(world)).toEqual([
      {
        error_code: "LOYALTY_LEGAL_ENTITY_AMBIGUOUS",
        retryable: false,
        event_name: "points.earned",
      },
    ]);
  });

  it.each(["unset", "assigned"] as const)(
    "keeps a pending earn when changing an %s entity and allows an unchanged update",
    async (initial) => {
      const world = await makeWorld({ entities: 2 });
      const input = {
        name: "Poin Member",
        earnRate: { spendIdr: idr(10_000), points: 1 },
        expiryMonths: 12,
        rollingMonths: 12,
        pointValueIdr: idr(100),
        isActive: true,
        legalEntityId: initial === "assigned" ? world.entities[0]!.id : null,
      };
      if (initial === "assigned")
        await updateLoyaltyProgram(world.context, randomUUID(), input);
      const member = await seedMember(world.tenantId);
      const orderUlid = await seedOrder(world.tenantId, {
        outletId: world.entities[1]!.outlets[0]!,
        profileId: member.id,
      });
      const event = orderPaidEvent(world, {
        orderUlid,
        outletId: world.entities[1]!.outlets[0]!,
      });
      await withTenant(db, world.context, (tx) =>
        deliverLoyaltyEarnEvent(world.context, event, tx),
      );
      const readParked = () =>
        asTenant(world.tenantId, (client) =>
          client.query(
            "SELECT event_id, event_name, payload, reason FROM loyalty_earn_parked WHERE tenant_id = $1 AND event_id = $2",
            [world.tenantId, event.id],
          ),
        );
      const before = (await readParked()).rows;
      expect(before).toHaveLength(1);
      expect(await balanceOf(world.tenantId, member.id)).toBe(0);
      const unchanged = await updateLoyaltyProgram(
        world.context,
        randomUUID(),
        { ...input, name: "Updated" },
      );
      expect(unchanged.legalEntityId).toBe(input.legalEntityId);
      await expect(
        updateLoyaltyProgram(world.context, randomUUID(), {
          ...input,
          legalEntityId: world.entities[1]!.id,
        }),
      ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
      expect((await readParked()).rows).toEqual(before);
      expect(await balanceOf(world.tenantId, member.id)).toBe(0);
      expect(await journalsOf(world)).toHaveLength(0);
    },
  );

  it.each(["unset", "assigned"] as const)(
    "keeps a pending points journal when changing an %s entity and allows an unchanged update",
    async (initial) => {
      const world = await makeWorld({ entities: 2 });
      const other = await makeWorld();
      const input = {
        name: "Poin Member",
        earnRate: { spendIdr: idr(10_000), points: 1 },
        expiryMonths: 12,
        rollingMonths: 12,
        pointValueIdr: idr(100),
        isActive: true,
        legalEntityId: initial === "assigned" ? world.entities[0]!.id : null,
      };
      if (initial === "assigned")
        await updateLoyaltyProgram(world.context, randomUUID(), input);
      const foreignMember = await seedMember(other.tenantId);
      const foreignRow = await earn(other, foreignMember.id, 10);
      const foreignEvent = await eventOf(other, "points.earned", foreignRow.id);
      const result = await deliver(world, {
        ...foreignEvent,
        tenantId: world.tenantId as typeof foreignEvent.tenantId,
      });
      expect(result).toMatchObject({
        status: "parked",
        code: "AUTO_JOURNAL_PAYLOAD_INVALID",
      });
      const before = await parkedOf(world);
      expect(before).toHaveLength(1);
      const unchanged = await updateLoyaltyProgram(
        world.context,
        randomUUID(),
        { ...input, name: "Updated" },
      );
      expect(unchanged.legalEntityId).toBe(input.legalEntityId);
      await expect(
        updateLoyaltyProgram(world.context, randomUUID(), {
          ...input,
          legalEntityId: world.entities[1]!.id,
        }),
      ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
      expect(await parkedOf(world)).toEqual(before);
      expect(await balanceOf(other.tenantId, foreignMember.id)).toBe(10);
      expect(await journalsOf(world)).toHaveLength(0);
    },
  );

  it("LOY-JNL-21 a parked earn with no historical entity snapshot cannot be assigned solely from the current outlet", async () => {
    const world = await makeWorld({ entities: 2 });
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 10, world.entities[1]!.outlets[0]);
    const event = await eventOf(world, "points.earned", row.id);
    expect(await deliver(world, event)).toMatchObject({
      status: "parked",
      code: "LOYALTY_LEGAL_ENTITY_AMBIGUOUS",
      retryable: false,
    });
    expect(await journalsOf(world)).toHaveLength(0);

    const input = {
      name: "Poin Member",
      earnRate: { spendIdr: idr(10_000), points: 1 },
      expiryMonths: 12,
      rollingMonths: 12,
      pointValueIdr: idr(100),
      isActive: true,
      legalEntityId: world.entities[1]!.id,
    };
    await expect(
      updateLoyaltyProgram(world.context, randomUUID(), input),
    ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
    const later = new Date(Date.now() + 60 * 60 * 1000);
    expect(await retryParkedAutoJournals(world.context, later)).toMatchObject({
      posted: 0,
      failed: 0,
    });
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
    expect(await journalsOf(world, `aj:loyalty:${row.id}`)).toHaveLength(0);
    expect(await parkedOf(world)).toHaveLength(1);
  });

  it("keeps historical liability parked when its outlet was moved to another entity", async () => {
    const world = await makeWorld({ entities: 2 });
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 10, world.entities[0]!.outlets[0]);
    const event = await eventOf(world, "points.earned", row.id);
    expect(await deliver(world, event)).toMatchObject({
      status: "parked",
      code: "LOYALTY_LEGAL_ENTITY_AMBIGUOUS",
      retryable: false,
    });
    await asTenant(world.tenantId, (client) =>
      client.query(
        "UPDATE outlets SET legal_entity_id = $3 WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, world.entities[0]!.outlets[0], world.entities[1]!.id],
      ),
    );
    await expect(
      updateLoyaltyProgram(world.context, randomUUID(), {
        name: "Poin Member",
        earnRate: { spendIdr: idr(10_000), points: 1 },
        expiryMonths: 12,
        rollingMonths: 12,
        pointValueIdr: idr(100),
        isActive: true,
        legalEntityId: world.entities[1]!.id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
    expect(await journalsOf(world)).toHaveLength(0);
    expect(await parkedOf(world)).toHaveLength(1);
  });

  it("LOY-JNL-22 a foreign tenant entity cannot configure the program or release its parked liability", async () => {
    const world = await makeWorld({ entities: 2 });
    const other = await makeWorld();
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 10);
    expect(
      await deliver(world, await eventOf(world, "points.earned", row.id)),
    ).toMatchObject({
      status: "parked",
      code: "LOYALTY_LEGAL_ENTITY_AMBIGUOUS",
    });
    const input = {
      name: "Poin Member",
      earnRate: { spendIdr: idr(10_000), points: 1 },
      expiryMonths: 12,
      rollingMonths: 12,
      pointValueIdr: idr(100),
      isActive: true,
      legalEntityId: other.entities[0]!.id,
    };
    await expect(
      updateLoyaltyProgram(world.context, randomUUID(), input),
    ).rejects.toMatchObject({ code: "LOYALTY_ENTITY_INVALID" });
    expect(await parkedOf(world)).toEqual([
      {
        error_code: "LOYALTY_LEGAL_ENTITY_AMBIGUOUS",
        retryable: false,
        event_name: "points.earned",
      },
    ]);
    expect(await journalsOf(world)).toHaveLength(0);
    expect(await journalsOf(other)).toHaveLength(0);
  });

  it("LOY-JNL-23 refuses to move an already journaled liability to another entity", async () => {
    const world = await makeWorld({ entities: 2 });
    const input = {
      name: "Poin Member",
      earnRate: { spendIdr: idr(10_000), points: 1 },
      expiryMonths: 12,
      rollingMonths: 12,
      pointValueIdr: idr(100),
      isActive: true,
      legalEntityId: world.entities[0]!.id,
    };
    await updateLoyaltyProgram(world.context, randomUUID(), input);
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 10);
    await post(world, await eventOf(world, "points.earned", row.id));
    await expect(
      updateLoyaltyProgram(world.context, randomUUID(), {
        ...input,
        legalEntityId: world.entities[1]!.id,
      }),
    ).rejects.toMatchObject({ code: "LOYALTY_ENTITY_LOCKED" });
    const journals = await journalsOf(world);
    expect(journals).toHaveLength(1);
    expect(journals[0]!.legal_entity_id).toBe(world.entities[0]!.id);
    expect(await linesOf(world, journals[0]!.id)).toEqual([
      { code: "2105", debit: 0, credit: 1_000 },
      { code: "4105", debit: 1_000, credit: 0 },
    ]);
  });

  it("keeps a zero-point mission voucher on its program entity without blocking another tenant", async () => {
    const world = await makeWorld({ entities: 2 });
    const other = await makeWorld({ entities: 2 });
    const input = {
      name: "Poin Member",
      earnRate: { spendIdr: idr(10_000), points: 1 },
      expiryMonths: 12,
      rollingMonths: 12,
      pointValueIdr: idr(100),
      isActive: true,
      legalEntityId: world.entities[0]!.id,
    };
    await updateLoyaltyProgram(world.context, randomUUID(), input);
    const member = await seedMember(world.tenantId);
    const missionId = randomUUID();
    await asTenant(world.tenantId, (client) =>
      client.query(
        `INSERT INTO missions (id, tenant_id, name, type, rule, reward, period)
       VALUES ($1, $2, 'Visit reward', 'visit_count', $3::jsonb, $4::jsonb, $5::jsonb)`,
        [
          missionId,
          world.tenantId,
          JSON.stringify({ kind: "visit_count", targetVisits: 1 }),
          JSON.stringify({ kind: "voucher", valueIdr: 1_000, validDays: 30 }),
          JSON.stringify({ kind: "monthly" }),
        ],
      ),
    );
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletId,
      profileId: member.id,
      grossSalesIdr: 1_000,
    });
    const event = orderPaidEvent(world, {
      orderUlid,
      outletId: world.outletId,
      grossSalesIdr: 1_000,
    });
    await withTenant(db, world.context, (tx) =>
      deliverLoyaltyEarnEvent(world.context, event, tx),
    );
    const facts = await asTenant(world.tenantId, async (client) => ({
      ledger: (
        await client.query("SELECT id FROM point_ledger WHERE tenant_id = $1", [
          world.tenantId,
        ])
      ).rows,
      voucher: (
        await client.query(
          "SELECT id, status, value_idr FROM vouchers WHERE tenant_id = $1 AND source = 'loyalty_reward'",
          [world.tenantId],
        )
      ).rows,
    }));
    expect(facts.ledger).toHaveLength(0);
    expect(facts.voucher).toMatchObject([
      { status: "issued", value_idr: "1000" },
    ]);
    for (const legalEntityId of [world.entities[1]!.id, null])
      await expect(
        updateLoyaltyProgram(world.context, randomUUID(), {
          ...input,
          legalEntityId,
        }),
      ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
    const unchanged = await updateLoyaltyProgram(world.context, randomUUID(), {
      ...input,
      name: "Updated",
    });
    expect(unchanged).toMatchObject({
      name: "Updated",
      legalEntityId: world.entities[0]!.id,
    });
    const assigned = await updateLoyaltyProgram(other.context, randomUUID(), {
      ...input,
      legalEntityId: other.entities[1]!.id,
    });
    expect(assigned.legalEntityId).toBe(other.entities[1]!.id);
    const voucher = await asTenant(world.tenantId, (client) =>
      client.query(
        "SELECT id, status, value_idr FROM vouchers WHERE tenant_id = $1 AND source = 'loyalty_reward'",
        [world.tenantId],
      ),
    );
    expect(voucher.rows).toEqual(facts.voucher);
  });

  it("refuses changing or clearing A when a member's paid event is still waiting for the earn consumer", async () => {
    const world = await makeWorld({ entities: 2 });
    const input = {
      name: "Poin Member",
      earnRate: { spendIdr: idr(10_000), points: 1 },
      expiryMonths: 12,
      rollingMonths: 12,
      pointValueIdr: idr(100),
      isActive: true,
      legalEntityId: world.entities[0]!.id,
    };
    await updateLoyaltyProgram(world.context, randomUUID(), input);
    const member = await seedMember(world.tenantId);
    const order = await seedOrder(world.tenantId, {
      outletId: world.outletId,
      profileId: member.id,
    });
    const event = orderPaidEvent(world, {
      orderUlid: order,
      outletId: world.outletId,
    });
    const outboxId = randomUUID();
    await asTenant(world.tenantId, (client) =>
      client.query(
        `INSERT INTO domain_event_outbox
       (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination, status)
       VALUES ($1, $2, $3, $4, 'order', $5, 1, $6::jsonb, 'cloud-sync', 'pending')`,
        [
          world.tenantId,
          outboxId,
          world.outletId,
          randomUUID(),
          ulidToUuid(order),
          JSON.stringify(event),
        ],
      ),
    );
    expect(await journalsOf(world)).toHaveLength(0);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    for (const legalEntityId of [world.entities[1]!.id, null])
      await expect(
        updateLoyaltyProgram(world.context, randomUUID(), {
          ...input,
          legalEntityId,
        }),
      ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
    const outbox = await asTenant(world.tenantId, (client) =>
      client.query(
        "SELECT status FROM domain_event_outbox WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, outboxId],
      ),
    );
    expect(outbox.rows).toEqual([{ status: "pending" }]);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    expect(await journalsOf(world)).toHaveLength(0);
  });

  it("refuses changing or clearing the entity while an earned liability is not yet journaled; replay remains single and on A", async () => {
    const world = await makeWorld({ entities: 2 });
    const input = {
      name: "Poin Member",
      earnRate: { spendIdr: idr(10_000), points: 1 },
      expiryMonths: 12,
      rollingMonths: 12,
      pointValueIdr: idr(100),
      isActive: true,
      legalEntityId: world.entities[0]!.id,
    };
    await updateLoyaltyProgram(world.context, randomUUID(), input);
    const member = await seedMember(world.tenantId);
    const earned = await earn(world, member.id, 10);
    const event = await eventOf(world, "points.earned", earned.id);
    expect(await journalsOf(world)).toHaveLength(0);
    for (const legalEntityId of [world.entities[1]!.id, null]) {
      await expect(
        updateLoyaltyProgram(world.context, randomUUID(), {
          ...input,
          legalEntityId,
        }),
      ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
    }
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
    expect((await deliver(world, event)).status).toBe("posted");
    expect((await deliver(world, event)).status).toBe("already_posted");
    const journals = await journalsOf(world, `aj:loyalty:${earned.id}`);
    expect(journals).toHaveLength(1);
    expect(journals[0]!.legal_entity_id).toBe(world.entities[0]!.id);
    expect(await linesOf(world, journals[0]!.id)).toEqual([
      { code: "2105", debit: 0, credit: 1_000 },
      { code: "4105", debit: 1_000, credit: 0 },
    ]);
  });

  it("keeps a used reward voucher and remaining points intact while its journals are pending", async () => {
    const world = await makeWorld({ entities: 2 });
    const input = {
      name: "Poin Member",
      earnRate: { spendIdr: idr(10_000), points: 1 },
      expiryMonths: 12,
      rollingMonths: 12,
      pointValueIdr: idr(100),
      isActive: true,
      legalEntityId: world.entities[0]!.id,
    };
    await updateLoyaltyProgram(world.context, randomUUID(), input);
    const member = await seedMember(world.tenantId);
    await earn(world, member.id, 100);
    const rewardId = await seedReward(world.tenantId, {
      type: "voucher",
      pointsCost: 50,
      voucherValueIdr: 5_000,
    });
    const redemption = await redeemAs(
      scopeOf(world.tenantId, member),
      rewardId,
      key(),
      new Date(),
    );
    const [voucher] = await vouchersOf(world.tenantId, member.id);
    const order = await seedOrder(world.tenantId, {
      outletId: world.outletId,
      profileId: member.id,
    });
    await markVoucherRedeemed(
      world.tenantId,
      voucher!.id,
      order,
      new Date().toISOString(),
    );
    expect(await journalsOf(world)).toHaveLength(0);
    for (const legalEntityId of [world.entities[1]!.id, null]) {
      await expect(
        updateLoyaltyProgram(world.context, randomUUID(), {
          ...input,
          legalEntityId,
        }),
      ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
    }
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
    expect((await vouchersOf(world.tenantId, member.id))[0]).toMatchObject({
      id: voucher!.id,
      status: "redeemed",
      redeemed_order_id: ulidToUuid(order),
    });
    expect(
      (await redemptionRow(world.tenantId, redemption.id)).voucher_id,
    ).toBe(voucher!.id);
  });

  it("refuses selecting an entity for ambiguous historical benefits from A and B and leaves the parked events unchanged", async () => {
    const world = await makeWorld({ entities: 2 });
    const member = await seedMember(world.tenantId);
    const a = await earn(world, member.id, 10, world.entities[0]!.outlets[0]);
    const b = await earn(world, member.id, 20, world.entities[1]!.outlets[0]);
    for (const row of [a, b])
      expect(
        await deliver(world, await eventOf(world, "points.earned", row.id)),
      ).toMatchObject({
        status: "parked",
        code: "LOYALTY_LEGAL_ENTITY_AMBIGUOUS",
        retryable: false,
      });
    await expect(
      updateLoyaltyProgram(world.context, randomUUID(), {
        name: "Poin Member",
        earnRate: { spendIdr: idr(10_000), points: 1 },
        expiryMonths: 12,
        rollingMonths: 12,
        pointValueIdr: idr(100),
        isActive: true,
        legalEntityId: world.entities[0]!.id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
    expect(await balanceOf(world.tenantId, member.id)).toBe(30);
    expect(await journalsOf(world)).toHaveLength(0);
    expect(
      (await parkedOf(world)).every((row) => row.retryable === false),
    ).toBe(true);
    expect(await parkedOf(world)).toHaveLength(2);
  });

  it("LOY-JNL-24 a concurrent entity change and earn posts exactly once to the effective entity", async () => {
    const world = await makeWorld({ entities: 2 });
    const input = {
      name: "Poin Member",
      earnRate: { spendIdr: idr(10_000), points: 1 },
      expiryMonths: 12,
      rollingMonths: 12,
      pointValueIdr: idr(100),
      isActive: true,
      legalEntityId: world.entities[0]!.id,
    };
    await updateLoyaltyProgram(world.context, randomUUID(), input);
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 10);
    const event = await eventOf(world, "points.earned", row.id);
    const [posting, change] = await Promise.allSettled([
      deliver(world, event),
      updateLoyaltyProgram(world.context, randomUUID(), {
        ...input,
        legalEntityId: world.entities[1]!.id,
      }),
    ]);
    expect(posting.status).toBe("fulfilled");
    if (change.status === "rejected")
      expect(change.reason).toMatchObject({ code: "LOYALTY_ENTITY_LOCKED" });
    const journals = await journalsOf(world, `aj:loyalty:${row.id}`);
    if (change.status === "fulfilled") {
      if (posting.status === "fulfilled")
        expect(posting.value).toMatchObject({
          status: "parked",
          code: "LOYALTY_LEGAL_ENTITY_AMBIGUOUS",
        });
      expect(journals).toHaveLength(0);
      return;
    }
    if (posting.status === "fulfilled")
      expect(posting.value.status).toBe("posted");
    expect(journals).toHaveLength(1);
    expect(journals[0]!.legal_entity_id).toBe(world.entities[0]!.id);
    expect(await linesOf(world, journals[0]!.id)).toEqual([
      { code: "2105", debit: 0, credit: 1_000 },
      { code: "4105", debit: 1_000, credit: 0 },
    ]);
    expect((await deliver(world, event)).status).toBe("already_posted");
    expect(await journalsOf(world)).toHaveLength(1);
  });

  it("LOY-JNL-25 omitting the entity in an older program update preserves it", async () => {
    const world = await makeWorld({ entities: 2 });
    const input = {
      name: "Poin Member",
      earnRate: { spendIdr: idr(10_000), points: 1 },
      expiryMonths: 12,
      rollingMonths: 12,
      pointValueIdr: idr(100),
      isActive: true,
    };
    await updateLoyaltyProgram(world.context, randomUUID(), {
      ...input,
      legalEntityId: world.entities[1]!.id,
    });
    const updated = await updateLoyaltyProgram(
      world.context,
      randomUUID(),
      input,
    );
    expect(updated.legalEntityId).toBe(world.entities[1]!.id);
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 10, world.entities[1]!.outlets[0]);
    await post(world, await eventOf(world, "points.earned", row.id));
    expect((await journalsOf(world))[0]!.legal_entity_id).toBe(
      world.entities[1]!.id,
    );
  });

  it("LOY-JNL-26 parks an earn and reversal from a different legal entity without a journal", async () => {
    const world = await makeWorld({ entities: 2 });
    await updateLoyaltyProgram(world.context, randomUUID(), {
      name: "Poin Member",
      earnRate: { spendIdr: idr(10_000), points: 1 },
      expiryMonths: 12,
      rollingMonths: 12,
      pointValueIdr: idr(100),
      isActive: true,
      legalEntityId: world.entities[0]!.id,
    });
    const member = await seedMember(world.tenantId);
    const earned = await earn(
      world,
      member.id,
      10,
      world.entities[1]!.outlets[0],
    );
    const reverse = await ledger(world, member.id, {
      type: "reverse",
      points: -10,
      sourceType: "refund",
      sourceId: randomUUID(),
      reversesEntryId: earned.id,
    });
    for (const [name, entryId] of [
      ["points.earned", earned.id],
      ["points.reversed", reverse.id],
    ] as const) {
      const event = await eventOf(world, name, entryId);
      expect(await deliver(world, event)).toMatchObject({
        status: "parked",
        code: "LOYALTY_LEGAL_ENTITY_AMBIGUOUS",
      });
      expect(await deliver(world, event)).toMatchObject({ status: "parked" });
    }
    expect(await journalsOf(world)).toHaveLength(0);
  });

  it("LOY-JNL-27 locks the selected outlet until its loyalty journal commits", async () => {
    const world = await makeWorld({ entities: 2 });
    await updateLoyaltyProgram(world.context, randomUUID(), {
      name: "Poin Member",
      earnRate: { spendIdr: idr(10_000), points: 1 },
      expiryMonths: 12,
      rollingMonths: 12,
      pointValueIdr: idr(100),
      isActive: true,
      legalEntityId: world.entities[0]!.id,
    });
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 10);
    const event = await eventOf(world, "points.earned", row.id);
    let release!: () => void;
    let ready!: (outletId: string) => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selected = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const posting = withTenant(db, world.context, async (tx) => {
      const anchor = await loyaltyAnchorOf(tx, world.context.tenant.tenantId);
      if (!anchor) throw new Error("No loyalty anchor");
      ready(anchor.outletId);
      await released;
      return deliverAutoJournalEvent(world.context, event, tx, new Date());
    });
    try {
      const outletId = await Promise.race([
        selected,
        posting.then(() => {
          throw new Error("Posting finished before the race");
        }),
      ]);
      await expect(
        asTenant(world.tenantId, async (client) => {
          await client.query("SET LOCAL lock_timeout = '250ms'");
          await client.query(
            "UPDATE outlets SET legal_entity_id = $1 WHERE tenant_id = $2 AND id = $3",
            [world.entities[1]!.id, world.tenantId, outletId],
          );
        }),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      release();
    }
    expect((await posting).status).toBe("posted");
    const journals = await journalsOf(world);
    expect(journals).toHaveLength(1);
    expect(journals[0]!.legal_entity_id).toBe(world.entities[0]!.id);
    expect(await linesOf(world, journals[0]!.id)).toEqual([
      { code: "2105", debit: 0, credit: 1_000 },
      { code: "4105", debit: 1_000, credit: 0 },
    ]);
  });

  it("LOY-JNL-28 a new outlet cannot change the fallback entity before its journal commits", async () => {
    const world = await makeWorld();
    const entityB = randomUUID();
    const outletB = randomUUID();
    const brands = (
      await owner.query<{ brand_id: string }>(
        "SELECT brand_id FROM outlets WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, world.outletId],
      )
    ).rows;
    const brandId = brands[0]!.brand_id;
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity kedua', false)",
      [entityB, world.tenantId],
    );
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 10);
    const event = await eventOf(world, "points.earned", row.id);
    let release!: () => void;
    let ready!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selected = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const posting = withTenant(db, world.context, async (tx) => {
      const anchor = await loyaltyAnchorOf(tx, world.context.tenant.tenantId);
      expect(anchor?.legalEntityId).toBe(world.entities[0]!.id);
      ready();
      await released;
      return deliverAutoJournalEvent(world.context, event, tx, new Date());
    });
    const insertOutlet = async (client: import("pg").PoolClient) => {
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
         VALUES ($1, $2, $3, $4, $5, 'Outlet baru', 'Jl. Uji', 'Asia/Jakarta', '04:00', '{}', 'active')`,
        [
          outletB,
          world.tenantId,
          brandId,
          entityB,
          `LJ-${short()}`.toUpperCase(),
        ],
      );
    };
    try {
      await Promise.race([
        selected,
        posting.then(() => {
          throw new Error("Posting finished before the race");
        }),
      ]);
      await expect(
        asTenant(world.tenantId, async (client) => {
          await client.query("SET LOCAL lock_timeout = '250ms'");
          await insertOutlet(client);
        }),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      release();
    }
    expect((await posting).status).toBe("posted");
    await asTenant(world.tenantId, insertOutlet);
    const next = await earn(world, member.id, 10);
    expect(
      await deliver(world, await eventOf(world, "points.earned", next.id)),
    ).toMatchObject({
      status: "parked",
      code: "LOYALTY_LEGAL_ENTITY_AMBIGUOUS",
    });
    const journals = await journalsOf(world);
    expect(journals).toHaveLength(1);
    expect(journals[0]!.legal_entity_id).toBe(world.entities[0]!.id);
    expect(await linesOf(world, journals[0]!.id)).toEqual([
      { code: "2105", debit: 0, credit: 1_000 },
      { code: "4105", debit: 1_000, credit: 0 },
    ]);
  });
});

describe("legend-msqvi points journal: invalid events", () => {
  it("LOY-JNL-16 an event whose key carries no ledger id parks AUTO_JOURNAL_PAYLOAD_INVALID and posts nothing", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 10);
    const event = await eventOf(world, "points.earned", row.id);
    const result = await deliver(world, {
      ...event,
      idempotencyKey: "points.earned",
    });
    expect(result).toMatchObject({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
    });
    expect(await journalsOf(world)).toHaveLength(0);
  });

  it("LOY-JNL-17 an event naming a ledger id that does not exist in the tenant parks AUTO_JOURNAL_PAYLOAD_INVALID", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    const member = await seedMember(other.tenantId);
    const foreign = await earn(other, member.id, 10);
    const event = await eventOf(other, "points.earned", foreign.id);
    // The ledger row belongs to another tenant: this tenant cannot read it.
    const result = await deliver(world, {
      ...event,
      tenantId: world.tenantId as typeof event.tenantId,
      idempotencyKey: `points.earned:${foreign.id}`,
    });
    expect(result).toMatchObject({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
    });
    expect(await journalsOf(world)).toHaveLength(0);
    expect(await journalsOf(other)).toHaveLength(0);
    // Unknown id (never existed) behaves the same.
    const unknown = await deliver(world, {
      ...event,
      id: createUlid(),
      tenantId: world.tenantId as typeof event.tenantId,
      idempotencyKey: `points.earned:${createUlid()}`,
    });
    expect(unknown).toMatchObject({
      status: "parked",
      code: "AUTO_JOURNAL_PAYLOAD_INVALID",
    });
  });
});

describe("legend-msqvi points journal: source, date, retry", () => {
  it("LOY-JNL-18 a redeem whose source is not a reward redemption (POS points payment) cannot be written to the ledger, so nothing is journaled or parked", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    await earn(world, member.id, 100);
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletId,
      profileId: member.id,
    });
    // The ledger's own check (point_ledger_source_type_check) only allows
    // reward_redemption for a redeem, so the consumer's "ignore other redeem
    // sources" branch cannot be reached through a stored row. A POS points
    // payment is journaled by order.paid paidPointsIdr, never by the ledger.
    await expect(
      ledger(world, member.id, {
        type: "redeem",
        points: -30,
        sourceType: "order",
        sourceId: orderUlid,
        outletId: world.outletId,
      }),
    ).rejects.toThrow();
    expect(await journalsOf(world)).toHaveLength(0);
    expect(await parkedOf(world)).toHaveLength(0);
  });

  it("LOY-JNL-19 an earn whose business_date differs from the created_at day is journaled on the business_date", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletId,
      profileId: member.id,
    });
    // Fixed past date in another month than any run date (periods open from
    // 2026-09, the suite runs on or after 2026-11).
    const businessDate = "2026-10-15";
    const row = await ledger(world, member.id, {
      type: "earn",
      points: 10,
      sourceType: "order",
      sourceId: orderUlid,
      outletId: world.outletId,
      expiresAt: IN_A_YEAR(),
      businessDate,
    });
    expect(row.createdAt.toISOString().slice(0, 10)).not.toBe(businessDate);

    const entry = await journal(
      world,
      await eventOf(world, "points.earned", row.id),
      row.id,
    );
    const { rows } = await owner.query<{ entry_date: string }>(
      "SELECT entry_date::text AS entry_date FROM journal_entries WHERE tenant_id = $1 AND id = $2",
      [world.tenantId, entry.id],
    );
    expect(rows).toEqual([{ entry_date: businessDate }]);
  });

  it("LOY-JNL-20 an earn parked ACCOUNT_MAPPING_MISSING posts exactly once after the 4105 mapping is restored and the sweep runs", async () => {
    const world = await makeWorld();
    const member = await seedMember(world.tenantId);
    const row = await earn(world, member.id, 10);
    const event = await eventOf(world, "points.earned", row.id);

    await owner.query(
      "DELETE FROM account_mappings WHERE tenant_id = $1 AND role = 'loyalty_points_deferral'",
      [world.tenantId],
    );
    const parked = await deliver(world, event);
    expect(parked).toMatchObject({
      status: "parked",
      code: "ACCOUNT_MAPPING_MISSING",
    });
    expect(await journalsOf(world)).toHaveLength(0);
    expect(await parkedOf(world)).toEqual([
      {
        error_code: "ACCOUNT_MAPPING_MISSING",
        retryable: true,
        event_name: "points.earned",
      },
    ]);

    // Finance restores the mapping to account 4105.
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       SELECT $1, $2, 'loyalty_points_deferral', id FROM chart_of_accounts
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '4105'`,
      [world.tenantId, world.entities[0]!.id],
    );
    const later = (hours: number) =>
      new Date(Date.now() + hours * 60 * 60 * 1000);
    expect(await retryParkedAutoJournals(world.context, later(48))).toEqual({
      posted: 1,
      stillParked: 0,
      failed: 0,
    });
    const journals = await journalsOf(world, `aj:loyalty:${row.id}`);
    expect(journals).toHaveLength(1);
    expect(await linesOf(world, journals[0]!.id)).toEqual([
      { code: "2105", debit: 0, credit: 1_000 },
      { code: "4105", debit: 1_000, credit: 0 },
    ]);

    // A second sweep finds nothing to post: still one journal.
    const again = await retryParkedAutoJournals(world.context, later(96));
    expect(again.posted).toBe(0);
    expect(await journalsOf(world)).toHaveLength(1);
  });
});
