// legend-4sesc: edge purge (audit retention + PIN proof purge inside the selfie
// sweep) cuts off at `clock.purgeSafeNow()`: the lower of the wall clock and the
// last cloud server time (aged by the monotonic clock). A wall clock set
// FORWARD, which the trusted clock itself accepts, must never delete early; no
// purge runs before the cloud was heard since boot; with server time the cutoff
// comes from server time, not the box clock.
//
// Audit rows cannot be seeded under a custom cutoff (the SQL, 0187, cuts off at
// the box CURRENT_TIMESTAMP), so the audit side is asserted at the query
// boundary: no due-tenants / purge query while the box wall clock is ahead of
// the safe time, and the check repeats before every query.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import * as schema from "../db/schema/index.ts";
import { startEdgeAuditRetention } from "./audit-retention.ts";
import { sweepEdgeSelfies } from "./selfie-retention.ts";
import { createTrustedClock } from "./trusted-clock.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 1,
});
const database = drizzle(appPool, { schema });
const roots: string[] = [];
const MIN = 60_000;
const DAY = 86_400_000;
const YEAR = 365 * DAY;
// Trusted time sits 10 days ahead of the box clock, so a purge that cuts off at
// the box clock (CURRENT_TIMESTAMP / Date.now()) keeps rows the trusted clock
// says are expired. Forward wall is accepted by the clock (see trusted-clock.test).
const BASE = new Date(Date.now() + 10 * DAY);

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await appPool.end();
  await owner.end();
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

function rig(persistedHighWater: Date | null, wallAtBoot: Date) {
  let wall = wallAtBoot.getTime();
  let mono = 1_000;
  const clock = createTrustedClock({
    wall: () => new Date(wall),
    mono: () => mono,
    persistedHighWater,
  });
  return {
    clock,
    tick: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    setWall: (date: Date) => {
      wall = date.getTime();
    },
    getWall: () => new Date(wall),
  };
}

/** Healthy clock: first boot, nothing persisted, cloud not heard yet. */
const trustedRig = () => rig(null, BASE);
/** The cloud answers: its time agrees with the box clock at BASE + offset. */
const hearCloud = (clock: ReturnType<typeof rig>["clock"], offsetMs: number) =>
  clock.proveWithServerTime(new Date(BASE.getTime() + offsetMs));

// ---------------------------------------------------------------- pin proofs

async function fixture() {
  const tenant = randomUUID();
  const brand = randomUUID();
  const legal = randomUUID();
  const outlet = randomUUID();
  const device = randomUUID();
  const user = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji jam edge', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenant,
      `uji-jam-edge-${tenant}`,
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      user,
    ],
  );
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [user, "Uji jam edge", `${user}@jam-edge.test`],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brand, tenant],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)",
    [legal, tenant],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, 'U-01', 'Uji', 'Jl Uji', '{}')`,
    [outlet, tenant, brand, legal],
  );
  await owner.query(
    "INSERT INTO devices (id, tenant_id, outlet_id, type, label) VALUES ($1, $2, $3, 'pos', 'Uji jam')",
    [device, tenant, outlet],
  );
  return { tenant, outlet, device, user };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A PIN proof created at `createdAt` (trusted-clock time). */
async function proof(fx: Fixture, createdAt: Date) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO staff_pin_proofs (id, tenant_id, outlet_id, device_id, user_id, purpose, token_hash, created_at, expires_at, consumed_at)
     VALUES ($1, $2, $3, $4, $5, 'attendance_clock', $6, $7, $8, NULL)`,
    [
      id,
      fx.tenant,
      fx.outlet,
      fx.device,
      fx.user,
      randomBytes(32),
      createdAt,
      new Date(createdAt.getTime() + 2 * MIN),
    ],
  );
  return id;
}

async function surviving(ids: string[]) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM staff_pin_proofs WHERE id = ANY($1::uuid[])",
    [ids],
  );
  return rows.map((row) => row.id).sort();
}

async function sweepWith(fx: Fixture, clock: ReturnType<typeof rig>["clock"]) {
  const dir = await mkdtemp(path.join(tmpdir(), "edge-untrusted-clock-"));
  roots.push(dir);
  return sweepEdgeSelfies({
    database,
    context: establishScopedTenantContext(
      establishTenantContext({
        tenantId: fx.tenant,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(fx.outlet)] },
    ),
    dir,
    maxAgeDays: 30,
    clock,
  });
}

/**
 * Expired at trusted time (2 days), expired at box time too (5 days; the box
 * clock deletes this one, so an untrusted sweep that still runs is caught), and
 * a fresh proof.
 */
async function seedProofs(fx: Fixture) {
  const expired = await proof(fx, new Date(BASE.getTime() - 2 * DAY));
  const ancient = await proof(fx, new Date(Date.now() - 5 * DAY));
  const fresh = await proof(fx, new Date(BASE.getTime() - MIN));
  return { expired, ancient, fresh, all: [expired, ancient, fresh] };
}

describe("legend-4sesc PIN proof purge follows the safe purge time", () => {
  it("(a) cloud never heard since boot: no proof is deleted, and the purge runs once it is heard", async () => {
    const fx = await fixture();
    const seeded = await seedProofs(fx);
    const { clock } = trustedRig();
    expect(clock.purgeSafeNow()).toBeNull();

    await sweepWith(fx, clock);
    expect(await surviving(seeded.all)).toEqual([...seeded.all].sort());

    hearCloud(clock, 0);
    await sweepWith(fx, clock);
    expect(await surviving(seeded.all)).toEqual([seeded.fresh]);
  });

  it("(b) cloud heard: proofs older than one day at server time are deleted, newer ones stay", async () => {
    const fx = await fixture();
    const seeded = await seedProofs(fx);
    const { clock } = trustedRig();
    hearCloud(clock, 0);

    await sweepWith(fx, clock);

    // The expired proof is only "old" relative to server time, which is 10 days
    // ahead of the real box clock: the cutoff comes from purgeSafeNow().
    expect(await surviving(seeded.all)).toEqual([seeded.fresh]);
  });

  it("(c) wall clock jumps 2+ years ahead with no server time: nothing is deleted", async () => {
    const fx = await fixture();
    // Everything here would be "expired" after a +2 year jump, including fresh.
    const seeded = await seedProofs(fx);
    const { clock, tick, setWall } = trustedRig();
    tick(MIN);
    setWall(new Date(BASE.getTime() + 2 * YEAR + DAY));
    // The trusted clock accepts a forward wall step; the purge must not.
    expect(clock.now().getTime()).toBeGreaterThan(BASE.getTime() + 2 * YEAR);

    await sweepWith(fx, clock);

    expect(await surviving(seeded.all)).toEqual([...seeded.all].sort());
  });

  it("(c) wall clock jumps 2+ years ahead, then the cloud is heard: the cutoff comes from server time", async () => {
    const fx = await fixture();
    const seeded = await seedProofs(fx);
    const { clock, tick, setWall } = trustedRig();
    tick(MIN);
    setWall(new Date(BASE.getTime() + 2 * YEAR + DAY));
    hearCloud(clock, MIN);

    await sweepWith(fx, clock);

    // Cutoff = server time - 1 day, not the jumped wall: fresh stays.
    expect(await surviving(seeded.all)).toEqual([seeded.fresh]);
  });

  it("(d) wall clock set back: the lower wall time is the cutoff base", async () => {
    const fx = await fixture();
    const seeded = await seedProofs(fx);
    const { clock, setWall } = trustedRig();
    hearCloud(clock, 0);
    setWall(new Date(BASE.getTime() - 3 * DAY));

    await sweepWith(fx, clock);

    // Cutoff = BASE - 4 days: the 2 day old proof stays, the 5 day old (box
    // time) proof is far older still and goes.
    expect(await surviving(seeded.all)).toEqual(
      [seeded.expired, seeded.fresh].sort(),
    );
  });
});

// -------------------------------------------------------------- audit retention

const TENANT = "11111111-1111-4111-8111-111111111111";
const DUE = "SELECT app.audit_retention_due_tenants() AS tenant_id";
const PURGE = "SELECT app.purge_audit_retention_batch($1, $2) AS deleted";
const source = {
  NODE_ENV: "test",
  MAINTENANCE_DATABASE_URL: "postgres://maint:secret@example.test/edge",
};

function fakePool() {
  const release = vi.fn();
  return {
    release,
    connect: vi.fn(async () => ({ release })),
    end: vi.fn(async () => undefined),
    query: vi.fn(
      async (
        text: string,
        _values?: unknown[],
      ): Promise<{ rows: Record<string, unknown>[] }> => {
        void _values;
        if (text === DUE) return { rows: [{ tenant_id: TENANT }] };
        return { rows: [{ deleted: "3" }] };
      },
    ),
  };
}

const purgeQueries = (pool: ReturnType<typeof fakePool>) =>
  pool.query.mock.calls.filter(([text]) => text === DUE || text === PURGE);

async function startAudit(
  pool: ReturnType<typeof fakePool>,
  rigged: ReturnType<typeof rig>,
) {
  const handle = await startEdgeAuditRetention({
    source,
    pool,
    clock: rigged.clock,
    wall: rigged.getWall,
    setTimer: () => "timer",
    clearTimer: () => undefined,
  });
  expect(handle).not.toBeNull();
  return handle!;
}

describe("legend-4sesc audit retention follows the safe purge time", () => {
  it("(a) cloud never heard since boot: no purge query, then it purges once heard", async () => {
    const pool = fakePool();
    const rigged = trustedRig();
    const handle = await startAudit(pool, rigged);

    await handle.runOnce();
    expect(purgeQueries(pool)).toEqual([]);

    hearCloud(rigged.clock, 0);
    const result = await handle.runOnce();

    expect(result).toMatchObject({ tenants: 1, deleted: 3, failedTenants: 0 });
    expect(pool.query).toHaveBeenCalledWith(PURGE, [TENANT, 1000]);
    await handle.stop();
  });

  it("(b) cloud heard, wall in step with server time: the due tenants are purged", async () => {
    const pool = fakePool();
    const rigged = trustedRig();
    hearCloud(rigged.clock, 0);
    const handle = await startAudit(pool, rigged);

    const result = await handle.runOnce();

    expect(result).toMatchObject({ tenants: 1, deleted: 3, failedTenants: 0 });
    await handle.stop();
  });

  it("(c) wall clock jumps 2+ years ahead: no purge query, with or without server time", async () => {
    const pool = fakePool();
    const rigged = trustedRig();
    rigged.tick(MIN);
    rigged.setWall(new Date(BASE.getTime() + 2 * YEAR + DAY));
    const handle = await startAudit(pool, rigged);

    await handle.runOnce();
    // Server time says the real time is BASE + 1 min: the wall is years ahead.
    hearCloud(rigged.clock, MIN);
    await handle.runOnce();

    expect(purgeQueries(pool)).toEqual([]);
    await handle.stop();
  });

  it("(c) wall clock set forward in the middle of a run: the next query is refused", async () => {
    const rigged = trustedRig();
    hearCloud(rigged.clock, 0);
    const pool = fakePool();
    pool.query.mockImplementation(async (text: string) => {
      if (text === DUE) {
        // Somebody moves the date forward after the sweep started.
        rigged.setWall(new Date(BASE.getTime() + 2 * YEAR + DAY));
        return { rows: [{ tenant_id: TENANT }] };
      }
      return { rows: [{ deleted: "3" }] };
    });
    const handle = await startAudit(pool, rigged);

    const result = await handle.runOnce();

    expect(result).toMatchObject({ tenants: 1, deleted: 0, failedTenants: 1 });
    expect(pool.query).not.toHaveBeenCalledWith(PURGE, [TENANT, 1000]);
    await handle.stop();
  });

  it("(d) wall clock set back: the purge still runs (an earlier cutoff is safe)", async () => {
    const pool = fakePool();
    const rigged = trustedRig();
    hearCloud(rigged.clock, 0);
    rigged.setWall(new Date(BASE.getTime() - 3 * DAY));
    const handle = await startAudit(pool, rigged);

    const result = await handle.runOnce();

    expect(result).toMatchObject({ tenants: 1, deleted: 3, failedTenants: 0 });
    await handle.stop();
  });
});
