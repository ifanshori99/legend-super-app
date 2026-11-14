// Auto-journals for `cash_movement.recorded` (legend-89pn). POS cash_in,
// cash_out and drop (CASH_MOVEMENT_TYPES) had no posting rule, so a cash out
// never reached the ledger (and since legend-utqr the shift close difference
// excludes held cash outs too). Written from docs/design/auto-journals.md,
// the shared event/posting contracts and the DB schema, not from the consumer.
//
// Runs the real consumer (`deliverAutoJournalEvent`) against the disposable
// PostgreSQL database with a synthetic envelope, plus the real shift and
// cash_movements rows (so it passes whether the consumer reads the payload or
// the row).
//
// Assumptions (the card and design leave these open):
// - Account roles are NOT pinned: every role of POSTING_ACCOUNT_ROLES is mapped
//   to its own account, so a role the engineer adds still resolves. Tests check
//   the cash_on_hand effect, balance, the amount bound, and which roles must
//   never be used (cash_over_short, sales_revenue, bank), not the counter role.
// - cash_out: Cr cash_on_hand, Dr one counter account (an expense-type role).
//   With no mapped counter account it parks retryable ACCOUNT_MAPPING_MISSING
//   (never a wrong or partial journal) and posts after the mapping is added.
// - cash_in: Dr cash_on_hand = amount, Cr a counter account that is not
//   sales_revenue / cash_over_short (not a sale, not a count difference).
// - drop (drawer to safe, still the outlet's cash): net effect on cash_on_hand
//   is 0 and no P&L account is touched. Either `ignored` or a balanced journal
//   with zero net cash effect passes. NOTE: this test may already pass on the
//   base (no rule -> nothing posted); it is a regression guard.
// - Journal idempotency key contains the movement id (design: aj:cash-movement:
//   <movementId>); the test only looks for the id inside the key.
// - Parked rows are found by event name + outlet, not by an exact key.
// - A held cash out (needs_approval, may expire or be rejected at shift close)
//   is NOT covered: whether it posts is a product decision (open question).
// - Shift consistency: for a closed shift without held cash, cash_on_hand
//   movement journals + the cashier_shift.closed difference journal must equal
//   counted - opening float for the non-drop movements (the drop stays in the
//   outlet's cash).

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { POSTING_ACCOUNT_ROLES } from "@starter/shared/accounting";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  deliverAutoJournalEvent,
  retryParkedAutoJournals,
  type AutoJournalResult,
} from "../services/accounting-auto-journal-consumer.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 8,
});

const short = () => randomUUID().slice(0, 6);
const NOW = new Date("2026-11-08T03:00:00Z");
const SWEEP_AT = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
/** 2026-10-15 12:00 Jakarta: business date 2026-10-15. */
const DAY = "2026-10-15T05:00:00.000Z";
const FLOAT_IDR = 500_000;
const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});

type Role = keyof typeof POSTING_ACCOUNT_ROLES;
type MovementType = "cash_in" | "cash_out" | "drop";
type Tenant = { id: string; brandId: string };
type World = {
  tenant: Tenant;
  entity: string;
  outletId: string;
  accounts: Partial<Record<Role, string>>;
};
type Movement = {
  id: string;
  shiftId: string;
  type: MovementType;
  amountIdr: number;
  cashierId: string;
  deviceId: string;
};

let shared: Tenant;

function contextOf(tenant: Tenant): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.id),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

async function makeTenant(): Promise<Tenant> {
  const id = randomUUID();
  const brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Auto Jurnal Kas', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-ajcm-${id.slice(0, 8)}`,
      FLAGS_ON,
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
    [brandId, id],
  );
  return { id, brandId };
}

async function asTenant<T>(
  tenant: Tenant,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
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

const GROUP_OF_TYPE = {
  asset: "current_asset",
  liability: "current_liability",
  equity: "equity",
  revenue: "revenue",
  expense: "operating_expense",
} as const;

/** Role-flexible account for a role: its fixed type, else an expense account. */
const typeOfRole = (role: Role) =>
  (POSTING_ACCOUNT_ROLES[role] ?? "expense") as keyof typeof GROUP_OF_TYPE;

async function addAccount(
  world: World,
  role: Role,
  code: string,
): Promise<string> {
  const type = typeOfRole(role);
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      world.tenant.id,
      world.entity,
      code,
      `Akun ${role}`,
      type,
      GROUP_OF_TYPE[type],
    ],
  );
  world.accounts[role] = rows[0]!.id;
  return rows[0]!.id;
}

async function mapRole(world: World, role: Role): Promise<void> {
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, $3, $4)`,
    [world.tenant.id, world.entity, role, world.accounts[role]],
  );
}

/**
 * A legal entity + outlet + open periods. `only` maps just those roles (a
 * restricted chart); the default maps every posting role.
 */
async function makeWorld(options: { only?: Role[] } = {}): Promise<World> {
  const tenant = shared;
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenant.id, `Entity CM ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet CM', 'Jl. CM', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `CM-${short()}`.toUpperCase(),
    ],
  );
  const world: World = { tenant, entity, outletId, accounts: {} };
  const roles = (Object.keys(POSTING_ACCOUNT_ROLES) as Role[]).filter(
    (role) => !options.only || options.only.includes(role),
  );
  let n = 0;
  for (const role of roles) {
    n += 1;
    await addAccount(world, role, `9${String(n).padStart(3, "0")}`);
    await mapRole(world, role);
  }
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenant.id, entity, period],
    );
  return world;
}

/** Maps every role that is still missing (the tenant fixed its chart). */
async function mapAllRemainingRoles(world: World): Promise<void> {
  let n = 500;
  for (const role of Object.keys(POSTING_ACCOUNT_ROLES) as Role[]) {
    if (world.accounts[role]) continue;
    n += 1;
    await addAccount(world, role, `9${n}`);
    await mapRole(world, role);
  }
}

async function seedUser(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, "Kasir CM", `${id}@example.com`],
  );
  return id;
}

type SeededShift = { shiftId: string; cashierId: string; deviceId: string };

/** An open shift (movements may only land on an open shift). */
async function seedOpenShift(world: World): Promise<SeededShift> {
  const cashierId = await seedUser();
  const shiftId = randomUUID();
  const deviceId = randomUUID();
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO pos_shifts
         (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
          opened_at, opening_float_idr, open_key, open_fingerprint)
       VALUES ($1, $2, $3, $4, $5, '2026-10-15', 'open', $6, $7, $8, $9)`,
      [
        shiftId,
        world.tenant.id,
        world.outletId,
        deviceId,
        cashierId,
        DAY,
        FLOAT_IDR,
        randomUUID(),
        "a".repeat(64),
      ],
    ),
  );
  return { shiftId, cashierId, deviceId };
}

async function seedMovement(
  world: World,
  shift: SeededShift,
  type: MovementType,
  amountIdr: number,
): Promise<Movement> {
  const id = randomUUID();
  await asTenant(world.tenant, (client) =>
    client.query(
      `INSERT INTO cash_movements
         (id, tenant_id, outlet_id, shift_id, type, amount_idr, reason_note,
          recorded_by, recorded_at, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, 'Alasan uji kas', $7, $8, $9, $10)`,
      [
        id,
        world.tenant.id,
        world.outletId,
        shift.shiftId,
        type,
        amountIdr,
        shift.cashierId,
        DAY,
        randomUUID(),
        "d".repeat(64),
      ],
    ),
  );
  return {
    id,
    shiftId: shift.shiftId,
    type,
    amountIdr,
    cashierId: shift.cashierId,
    deviceId: shift.deviceId,
  };
}

/** One open shift with one movement: the common fixture. */
async function seedSingle(
  world: World,
  type: MovementType,
  amountIdr: number,
): Promise<Movement> {
  return seedMovement(world, await seedOpenShift(world), type, amountIdr);
}

/** Closes the shift with the real totals; counted = expected + differenceIdr. */
async function closeShift(
  world: World,
  shift: SeededShift,
  totals: { inIdr: number; outIdr: number; dropIdr: number },
  differenceIdr: number,
): Promise<{ expectedIdr: number; countedIdr: number }> {
  const approverId = await seedUser();
  const expectedIdr = FLOAT_IDR + totals.inIdr - totals.outIdr - totals.dropIdr;
  const countedIdr = expectedIdr + differenceIdr;
  const countId = randomUUID();
  await asTenant(world.tenant, async (client) => {
    await client.query(
      `INSERT INTO pos_shift_counts
         (id, tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
          counted_idr, expected_idr, variance_idr, submitted_by, submitted_at, forced,
          idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, 1, '[]'::jsonb, $5, $6, $7, $8, $9, now(), false, $10, $5)`,
      [
        countId,
        world.tenant.id,
        world.outletId,
        shift.shiftId,
        "b".repeat(64),
        countedIdr,
        expectedIdr,
        differenceIdr,
        shift.cashierId,
        randomUUID(),
      ],
    );
    await client.query(
      `UPDATE pos_shifts SET status = 'closed', expected_idr = $3, counted_idr = $4,
          variance_idr = $5, variance_note = $6, counts = '[]'::jsonb, count_id = $7,
          approved_by = $8, approval_request_id = $9, approval_override_id = $10,
          approved_at = $11, closed_at = $11, closed_by = $12, close_key = $13,
          close_fingerprint = $14, cash_in_idr = $15, cash_out_idr = $16,
          cash_drop_idr = $17, version = version + 1
        WHERE tenant_id = $1 AND id = $2`,
      [
        world.tenant.id,
        shift.shiftId,
        expectedIdr,
        countedIdr,
        differenceIdr,
        differenceIdr === 0 ? null : "Selisih hitung",
        countId,
        approverId,
        randomUUID(),
        randomUUID(),
        DAY,
        shift.cashierId,
        randomUUID(),
        "c".repeat(64),
        totals.inIdr,
        totals.outIdr,
        totals.dropIdr,
      ],
    );
  });
  return { expectedIdr, countedIdr };
}

function envelope(
  world: World,
  input: {
    id?: string;
    name: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  },
): EventEnvelope {
  const id = input.id ?? createUlid();
  return eventEnvelopeSchema.parse({
    id,
    tenantId: world.tenant.id,
    outletId: world.outletId,
    name: input.name,
    version: 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sequence: 1,
    occurredAt: DAY,
    actor: { type: "system" },
    idempotencyKey: `aj-cm-test-${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

function movementRecorded(
  world: World,
  movement: Movement,
  extra: { id?: string; amountIdr?: number } = {},
): EventEnvelope {
  return envelope(world, {
    ...(extra.id === undefined ? {} : { id: extra.id }),
    name: "cash_movement.recorded",
    aggregateType: "cash_movement",
    aggregateId: movement.id,
    payload: {
      movementId: movement.id,
      shiftId: movement.shiftId,
      outletId: world.outletId,
      deviceId: movement.deviceId,
      type: movement.type,
      amountIdr: extra.amountIdr ?? movement.amountIdr,
      reasonNote: "Alasan uji kas",
      recordedBy: movement.cashierId,
      recordedAt: DAY,
    },
  });
}

function shiftClosed(
  world: World,
  shift: SeededShift,
  totals: { inIdr: number; outIdr: number; dropIdr: number },
  closed: { expectedIdr: number; countedIdr: number },
  differenceIdr: number,
): EventEnvelope {
  return envelope(world, {
    name: "cashier_shift.closed",
    aggregateType: "cashier_shift",
    aggregateId: shift.shiftId,
    payload: {
      shiftId: shift.shiftId,
      outletId: world.outletId,
      deviceId: shift.deviceId,
      cashierId: shift.cashierId,
      businessDate: "2026-10-15",
      openingFloatIdr: FLOAT_IDR,
      cashSalesIdr: 0,
      cashRefundsIdr: 0,
      cashInIdr: totals.inIdr,
      cashOutIdr: totals.outIdr,
      cashDropIdr: totals.dropIdr,
      expectedIdr: closed.expectedIdr,
      countedIdr: closed.countedIdr,
      differenceIdr,
      varianceNote: differenceIdr === 0 ? null : "Selisih hitung",
      approvedBy: randomUUID(),
      approvalRequestId: randomUUID(),
      closedAt: DAY,
    },
  });
}

function deliver(
  tenant: Tenant,
  event: EventEnvelope,
): Promise<AutoJournalResult> {
  const context = contextOf(tenant);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, NOW),
  );
}

let sweepCount = 0;
function sweep(tenant: Tenant) {
  sweepCount += 1;
  return retryParkedAutoJournals(
    contextOf(tenant),
    new Date(SWEEP_AT.getTime() + sweepCount * 60 * 60 * 1000),
  );
}

// ---- reads ------------------------------------------------------------------

type Line = { role: Role; type: string; debit: number; credit: number };

async function journalIds(world: World): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 ORDER BY created_at",
    [world.tenant.id, world.entity],
  );
  return rows.map((row) => row.id);
}

async function journalCount(world: World): Promise<number> {
  return (await journalIds(world)).length;
}

/** Lines of one journal, summed per account, with role and account type. */
async function linesOf(world: World, entryId: string): Promise<Line[]> {
  const { rows } = await owner.query<{
    account_id: string;
    type: string;
    debit: string;
    credit: string;
  }>(
    `SELECT l.account_id, a.type, sum(l.debit_idr)::text AS debit, sum(l.credit_idr)::text AS credit
       FROM journal_lines l
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE l.tenant_id = $1 AND l.entry_id = $2 GROUP BY l.account_id, a.type`,
    [world.tenant.id, entryId],
  );
  const roleOf = new Map(
    (Object.entries(world.accounts) as [Role, string][]).map(([role, id]) => [
      id,
      role,
    ]),
  );
  return rows.map((row) => ({
    role: roleOf.get(row.account_id)!,
    type: row.type,
    debit: Number(row.debit),
    credit: Number(row.credit),
  }));
}

/** Debit minus credit over every journal of the world, for one role. */
async function balanceOf(world: World, role: Role): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, world.accounts[role]],
  );
  return Number(rows[0]!.balance ?? 0);
}

async function keyOf(world: World, entryId: string): Promise<string> {
  const { rows } = await owner.query<{ idempotency_key: string | null }>(
    "SELECT idempotency_key FROM journal_entries WHERE tenant_id = $1 AND id = $2",
    [world.tenant.id, entryId],
  );
  return rows[0]!.idempotency_key ?? "";
}

type Parked = { error_code: string; retryable: boolean; event_name: string };

async function parkedOf(world: World): Promise<Parked[]> {
  return asTenant(world.tenant, async (client) => {
    const { rows } = await client.query<Parked>(
      `SELECT error_code, retryable, event_name FROM auto_journal_parked
        WHERE tenant_id = $1 AND outlet_id = $2 AND event_name = 'cash_movement.recorded'`,
      [world.tenant.id, world.outletId],
    );
    return rows;
  });
}

// ---- shared assertions ------------------------------------------------------

/**
 * Whatever the counter account is, a movement journal balances, stays within
 * the movement amount (never pays or books more than was recorded) and never
 * touches the sale, count-difference or bank roles.
 */
async function expectSafeBooking(
  world: World,
  entryId: string,
  amountIdr: number,
): Promise<Line[]> {
  const lines = await linesOf(world, entryId);
  const debit = lines.reduce((sum, line) => sum + line.debit, 0);
  const credit = lines.reduce((sum, line) => sum + line.credit, 0);
  expect(debit).toBe(credit);
  for (const line of lines) {
    expect(line.debit, JSON.stringify(line)).toBeLessThanOrEqual(amountIdr);
    expect(line.credit, JSON.stringify(line)).toBeLessThanOrEqual(amountIdr);
    expect(
      ["cash_over_short", "sales_revenue", "bank"],
      `${line.role} must not be used`,
    ).not.toContain(line.role);
  }
  return lines;
}

async function expectPostedOnce(
  world: World,
  movement: Movement,
  result: AutoJournalResult,
): Promise<string> {
  expect(result.status).toBe("posted");
  if (result.status !== "posted") throw new Error("not posted");
  expect(await journalCount(world)).toBe(1);
  expect(await keyOf(world, result.journalEntryId)).toContain(movement.id);
  return result.journalEntryId;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  shared = await makeTenant();
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

// ============================================================================

describe("legend-89pn cash_movement.recorded posts a balanced journal per type", () => {
  it("AJ-CM-01 cash_out: Cr cash_on_hand by the amount, Dr one expense-type counter account by the same amount", async () => {
    const world = await makeWorld();
    const movement = await seedSingle(world, "cash_out", 30_000);

    const result = await deliver(
      world.tenant,
      movementRecorded(world, movement),
    );
    const entryId = await expectPostedOnce(world, movement, result);

    const lines = await expectSafeBooking(world, entryId, 30_000);
    expect(lines.find((line) => line.role === "cash_on_hand")).toMatchObject({
      debit: 0,
      credit: 30_000,
    });
    const counter = lines.filter((line) => line.role !== "cash_on_hand");
    expect(counter).toHaveLength(1);
    expect(counter[0]).toMatchObject({
      type: "expense",
      debit: 30_000,
      credit: 0,
    });
    expect(await balanceOf(world, "cash_on_hand")).toBe(-30_000);
  });

  it("AJ-CM-02 cash_in: Dr cash_on_hand by the amount, Cr a counter account by the same amount (not a sale, not a count difference)", async () => {
    const world = await makeWorld();
    const movement = await seedSingle(world, "cash_in", 75_000);

    const result = await deliver(
      world.tenant,
      movementRecorded(world, movement),
    );
    const entryId = await expectPostedOnce(world, movement, result);

    const lines = await expectSafeBooking(world, entryId, 75_000);
    expect(lines.find((line) => line.role === "cash_on_hand")).toMatchObject({
      debit: 75_000,
      credit: 0,
    });
    const counter = lines.filter((line) => line.role !== "cash_on_hand");
    expect(counter).toHaveLength(1);
    expect(counter[0]).toMatchObject({ debit: 0, credit: 75_000 });
    expect(await balanceOf(world, "cash_on_hand")).toBe(75_000);
  });

  it("AJ-CM-03 drop (drawer to safe, still outlet cash): cash_on_hand does not change and no P&L account is touched", async () => {
    const world = await makeWorld();
    const movement = await seedSingle(world, "drop", 200_000);

    const result = await deliver(
      world.tenant,
      movementRecorded(world, movement),
    );
    expect(["ignored", "posted"]).toContain(result.status);
    if (result.status === "posted") {
      const lines = await expectSafeBooking(
        world,
        result.journalEntryId,
        200_000,
      );
      expect(lines.map((line) => line.type)).not.toContain("expense");
      expect(lines.map((line) => line.type)).not.toContain("revenue");
    } else {
      expect(await journalCount(world)).toBe(0);
    }
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);
    expect(await parkedOf(world)).toEqual([]);
  });

  it("AJ-CM-04 a cash_out larger than the drawer float still books exactly its amount, never more", async () => {
    const world = await makeWorld();
    const movement = await seedSingle(world, "cash_out", FLOAT_IDR + 1_000);

    const result = await deliver(
      world.tenant,
      movementRecorded(world, movement),
    );
    const entryId = await expectPostedOnce(world, movement, result);
    await expectSafeBooking(world, entryId, FLOAT_IDR + 1_000);
    expect(await balanceOf(world, "cash_on_hand")).toBe(-(FLOAT_IDR + 1_000));
  });
});

describe("legend-89pn cash_movement.recorded fails closed", () => {
  it("AJ-CM-05 cash_out with no mapped counter account parks retryable ACCOUNT_MAPPING_MISSING and posts nothing", async () => {
    const world = await makeWorld({ only: ["cash_on_hand"] });
    const movement = await seedSingle(world, "cash_out", 30_000);

    const result = await deliver(
      world.tenant,
      movementRecorded(world, movement),
    );
    expect(result).toMatchObject({
      status: "parked",
      code: "ACCOUNT_MAPPING_MISSING",
      retryable: true,
    });
    expect(await journalCount(world)).toBe(0);
    expect(await balanceOf(world, "cash_on_hand")).toBe(0);
    expect(await parkedOf(world)).toEqual([
      expect.objectContaining({
        error_code: "ACCOUNT_MAPPING_MISSING",
        retryable: true,
      }),
    ]);
  });

  it("AJ-CM-06 a parked cash_out posts once after the tenant maps its accounts, and a second sweep adds nothing", async () => {
    const world = await makeWorld({ only: ["cash_on_hand"] });
    const movement = await seedSingle(world, "cash_out", 45_000);
    const first = await deliver(
      world.tenant,
      movementRecorded(world, movement),
    );
    expect(first.status).toBe("parked");

    await mapAllRemainingRoles(world);
    await sweep(world.tenant);
    expect(await journalCount(world)).toBe(1);
    const [entryId] = await journalIds(world);
    expect(await keyOf(world, entryId!)).toContain(movement.id);
    await expectSafeBooking(world, entryId!, 45_000);
    expect(await balanceOf(world, "cash_on_hand")).toBe(-45_000);

    await sweep(world.tenant);
    expect(await journalCount(world)).toBe(1);
  });

  it("AJ-CM-07 an amount that disagrees with the stored movement never posts the larger figure", async () => {
    const world = await makeWorld();
    const movement = await seedSingle(world, "cash_out", 30_000);

    const result = await deliver(
      world.tenant,
      movementRecorded(world, movement, { amountIdr: 90_000 }),
    );
    // Either rejected (parked, nothing posted) or booked at the stored 30.000;
    // the 90.000 of the payload must never reach the ledger.
    if (result.status === "posted") {
      await expectSafeBooking(world, result.journalEntryId, 30_000);
      expect(await balanceOf(world, "cash_on_hand")).toBe(-30_000);
    } else {
      expect(result.status).toBe("parked");
      expect(await journalCount(world)).toBe(0);
    }
  });
});

describe("legend-89pn cash_movement.recorded is idempotent", () => {
  it("AJ-CM-08 re-delivering the same event, or the same movement under a new event id, posts once", async () => {
    const world = await makeWorld();
    const movement = await seedSingle(world, "cash_out", 30_000);
    const event = movementRecorded(world, movement);
    const first = await deliver(world.tenant, event);
    const entryId = await expectPostedOnce(world, movement, first);

    for (const again of [event, movementRecorded(world, movement)])
      expect(await deliver(world.tenant, again)).toEqual({
        status: "already_posted",
        journalEntryId: entryId,
      });
    expect(await journalCount(world)).toBe(1);
    expect(await balanceOf(world, "cash_on_hand")).toBe(-30_000);
  });

  it("AJ-CM-09 a re-delivery carrying a different amount does not post a second journal", async () => {
    const world = await makeWorld();
    const movement = await seedSingle(world, "cash_out", 30_000);
    const first = await deliver(
      world.tenant,
      movementRecorded(world, movement),
    );
    await expectPostedOnce(world, movement, first);

    await deliver(
      world.tenant,
      movementRecorded(world, movement, { amountIdr: 60_000 }),
    );
    expect(await journalCount(world)).toBe(1);
    expect(await balanceOf(world, "cash_on_hand")).toBe(-30_000);
  });

  it("AJ-CM-10 six concurrent deliveries of one movement (distinct event ids) leave exactly one journal", async () => {
    const world = await makeWorld();
    const movement = await seedSingle(world, "cash_out", 30_000);

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        deliver(world.tenant, movementRecorded(world, movement)),
      ),
    );
    expect(results.filter((r) => r.status === "posted")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_posted")).toHaveLength(
      5,
    );
    expect(await journalCount(world)).toBe(1);
    expect(await balanceOf(world, "cash_on_hand")).toBe(-30_000);
    expect(await parkedOf(world)).toEqual([]);
  });

  it("AJ-CM-11 two different movements of the same amount in one shift post two journals", async () => {
    const world = await makeWorld();
    const shift = await seedOpenShift(world);
    const a = await seedMovement(world, shift, "cash_out", 10_000);
    const b = await seedMovement(world, shift, "cash_out", 10_000);

    await deliver(world.tenant, movementRecorded(world, a));
    await deliver(world.tenant, movementRecorded(world, b));
    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "cash_on_hand")).toBe(-20_000);
  });
});

describe("legend-89pn shift close stays consistent with the movements", () => {
  it("AJ-CM-12 cash in/out plus a counted shortage: cash_on_hand moves by counted - opening float, shortage booked once as cash_over_short", async () => {
    const world = await makeWorld();
    const shift = await seedOpenShift(world);
    const cashIn = await seedMovement(world, shift, "cash_in", 20_000);
    const cashOut = await seedMovement(world, shift, "cash_out", 50_000);
    const totals = { inIdr: 20_000, outIdr: 50_000, dropIdr: 0 };
    const closed = await closeShift(world, shift, totals, -5_000);

    await deliver(world.tenant, movementRecorded(world, cashIn));
    await deliver(world.tenant, movementRecorded(world, cashOut));
    const close = await deliver(
      world.tenant,
      shiftClosed(world, shift, totals, closed, -5_000),
    );
    expect(close.status).toBe("posted");

    expect(await journalCount(world)).toBe(3);
    // counted 465.000 = float 500.000 + 20.000 - 50.000 - 5.000
    expect(await balanceOf(world, "cash_on_hand")).toBe(
      closed.countedIdr - FLOAT_IDR,
    );
    expect(await balanceOf(world, "cash_over_short")).toBe(5_000);
  });

  it("AJ-CM-13 a shift that closes exact still ignores the close and the movements carry the whole cash change", async () => {
    const world = await makeWorld();
    const shift = await seedOpenShift(world);
    const cashOut = await seedMovement(world, shift, "cash_out", 30_000);
    const totals = { inIdr: 0, outIdr: 30_000, dropIdr: 0 };
    const closed = await closeShift(world, shift, totals, 0);

    await deliver(world.tenant, movementRecorded(world, cashOut));
    expect(
      await deliver(world.tenant, shiftClosed(world, shift, totals, closed, 0)),
    ).toEqual({ status: "ignored" });
    expect(await journalCount(world)).toBe(1);
    expect(await balanceOf(world, "cash_on_hand")).toBe(
      closed.countedIdr - FLOAT_IDR,
    );
    expect(await balanceOf(world, "cash_over_short")).toBe(0);
  });

  it("AJ-CM-14 delivering the close before the movement gives the same ledger (order does not matter, nothing double counted)", async () => {
    const world = await makeWorld();
    const shift = await seedOpenShift(world);
    const cashOut = await seedMovement(world, shift, "cash_out", 40_000);
    const totals = { inIdr: 0, outIdr: 40_000, dropIdr: 0 };
    const closed = await closeShift(world, shift, totals, 7_000);

    const close = await deliver(
      world.tenant,
      shiftClosed(world, shift, totals, closed, 7_000),
    );
    expect(close.status).toBe("posted");
    await deliver(world.tenant, movementRecorded(world, cashOut));

    expect(await journalCount(world)).toBe(2);
    expect(await balanceOf(world, "cash_on_hand")).toBe(
      closed.countedIdr - FLOAT_IDR,
    );
    expect(await balanceOf(world, "cash_over_short")).toBe(-7_000);
  });
});
