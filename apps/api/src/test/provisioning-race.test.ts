// Provisioning vs owner writers (beads legend-dq0n tax, legend-hd1m CoA).
// The provisioning backfills guard "only fill what the tenant lacks" with a
// per-tenant advisory lock, but the owner writers (`createTaxRule`,
// `createAccount`) used to skip that lock, so both could read an empty table
// at once and then both insert: two tax rules, or a chart mixing an owner
// account with the whole standard template. The owner writers must share the
// provisioning lock.
//
// Deterministic interleave, no sleeps. A helper client holds
// `LOCK TABLE <guarded table> IN SHARE MODE`, which blocks every INSERT into
// that table (reads still pass). The owner writer is started first and parked
// on its INSERT; the backfill is started second and parked either on the
// advisory lock (fixed code) or, having read an empty table, on its own
// INSERT (racy code). Releasing the helper then lets both run to the end.
//
// Assumptions where the brief is silent:
// - The tax owner rule is a draft (that is what `createTaxRule` always makes);
//   the backfill must still treat any existing rule as "tenant has config".
// - The backfill is "blocked" when a second non-granted relation lock on the
//   guarded table exists (racy code) or its advisory lock is ungranted (fixed
//   code). Which one was seen is recorded and asserted to be the advisory one.
// - `expect.soft` is used so a failing run reports the data outcome and the
//   missing advisory wait together.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { EdgeMasterSnapshot } from "@starter/shared/edge/master-sync";
import { applyEdgeMasterSnapshot } from "../edge/master-sync.ts";
import { parseEdgeCredential } from "../edge/credential.ts";
import { backfillTenantCharts } from "../services/accounting-provisioning.service.ts";
import { createAccount } from "../services/accounting-accounts.service.ts";
import { backfillTenantTaxDefaults } from "../services/tax-provisioning.service.ts";
import { createTaxRule } from "../services/tax.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const userId = randomUUID();
const tenants: string[] = [];

const scopeOf = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantId as TenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

/** A bare tenant (no tax config, no chart) whose owner may manage tax config. */
async function seedTenant(): Promise<{ tenantId: string; entityId: string }> {
  const tenantId = randomUUID();
  const entityId = randomUUID();
  tenants.push(tenantId);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Balapan Provisioning', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `pbal-${randomBytes(4).toString("hex")}`,
      userId,
      seededTenantId,
    ],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji Balapan', false)`,
    [entityId, tenantId],
  );
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types)
     VALUES ($1, $2, 'Pemilik balapan', $3, '["tenant"]')`,
    [roleId, tenantId, JSON.stringify(["org.tax_config.manage"])],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
  return { tenantId, entityId };
}

/** Granted flags of the advisory lock `hashtextextended(key, 0)`, from pg_locks. */
async function advisoryLockStates(key: string): Promise<boolean[]> {
  const { rows } = await owner.query<{ granted: boolean }>(
    `SELECT granted FROM pg_locks
      WHERE locktype = 'advisory'
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return rows.map((row) => row.granted);
}

/** Number of backends waiting for a relation lock on `table`. */
async function relationWaiters(table: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'relation' AND NOT granted
        AND relation = to_regclass($1)`,
    [`public.${table}`],
  );
  return rows[0]!.n;
}

/** Polls (no fixed sleep) until `check` holds or 5 s pass. */
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((done) => setTimeout(done, 20));
  }
}

/**
 * Runs one race. `table` is locked in SHARE mode by a helper client; `start`
 * launches the owner writer, then the backfill. Returns what was observed
 * while both were parked, plus both settled outcomes.
 */
async function race<A, B>(
  table: string,
  advisoryKey: string,
  startOwnerWriter: () => Promise<A>,
  startBackfill: () => Promise<B>,
) {
  const helper: PoolClient = await owner.connect();
  let released = false;
  const release = async (action: "COMMIT" | "ROLLBACK") => {
    if (released) return;
    released = true;
    try {
      await helper.query(action);
    } finally {
      helper.release();
    }
  };
  try {
    await helper.query("BEGIN");
    await helper.query(`LOCK TABLE ${table} IN SHARE MODE`);

    const ownerWrite = startOwnerWriter();
    // The owner writer is parked on its INSERT into the guarded table.
    await waitFor(async () => (await relationWaiters(table)) >= 1);

    const backfill = startBackfill();
    // The backfill is parked: on the advisory lock (fixed code) or, after
    // reading the still-empty table, on its own INSERT (racy code).
    let parkedOn: "advisory" | "relation" | undefined;
    await waitFor(async () => {
      if ((await advisoryLockStates(advisoryKey)).includes(false)) {
        parkedOn = "advisory";
        return true;
      }
      if ((await relationWaiters(table)) >= 2) {
        parkedOn = "relation";
        return true;
      }
      return false;
    });
    const advisoryStates = await advisoryLockStates(advisoryKey);

    await release("COMMIT");
    const [ownerResult, backfillResult] = await Promise.allSettled([
      ownerWrite,
      backfill,
    ]);
    return { parkedOn, advisoryStates, ownerResult, backfillResult };
  } finally {
    await release("ROLLBACK");
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userId, "Race Provisioning", `${userId}@example.test`],
  );
});

afterAll(async () => {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "account_mappings",
      "chart_of_accounts",
      "tax_rules",
      "tax_settings",
      "service_charge_rules",
      "domain_event_outbox",
      "audit_logs",
      "role_assignments",
      "roles",
      "outlets",
      "brands",
      "legal_entities",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [
        tenants,
      ]);
    await client.query("DELETE FROM tenants WHERE id = ANY($1)", [tenants]);
    await client.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

/** Tenant + entity + brand + outlet, and an edge snapshot of one cloud account `9999`. */
async function seedEdgeWorld() {
  const { tenantId, entityId } = await seedTenant();
  const brandId = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'balapan', 'Brand Balapan')",
    [brandId, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Balapan', 'Jl. Balapan', 'Asia/Jakarta', '{}', 'active')`,
    [
      outletId,
      tenantId,
      brandId,
      entityId,
      `PB-${randomBytes(3).toString("hex")}`.toUpperCase(),
    ],
  );
  // The cloud's chart is one custom root account and no mapping. The edge
  // copies it by id; the template must never be added next to it.
  const now = new Date().toISOString();
  const snapshot = {
    version: 1,
    issuedAt: now,
    tenantId,
    outletId,
    legalEntityId: entityId,
    uoms: [],
    stockLocations: [],
    chartOfAccounts: [
      {
        id: randomUUID(),
        tenantId,
        legalEntityId: entityId,
        code: "9999",
        name: "Akun Cloud",
        type: "asset",
        reportGroup: "current_asset",
        parentId: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    accountMappings: [],
  } as unknown as EdgeMasterSnapshot;
  const claims = {
    tenantId,
    outletId,
    edgeNodeId: randomUUID(),
    hash: "unused",
  } as NonNullable<ReturnType<typeof parseEdgeCredential>>;
  return { tenantId, entityId, snapshot, claims };
}

async function chartState(tenantId: string, entityId: string) {
  const accounts = await owner.query<{ id: string; code: string }>(
    "SELECT id, code FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 ORDER BY code",
    [tenantId, entityId],
  );
  const mappings = await owner.query<{ role: string; account_id: string }>(
    "SELECT role, account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 ORDER BY role",
    [tenantId, entityId],
  );
  return { accounts: accounts.rows, mappings: mappings.rows };
}

describe("provisioning vs owner writers share one lock", () => {
  it("legend-dq0n: owner tax rule and default tax backfill leave exactly one rule", async () => {
    const { tenantId } = await seedTenant();
    const context = scopeOf(tenantId);

    const outcome = await race(
      "tax_rules",
      `tax:provisioning:${tenantId}`,
      () =>
        createTaxRule(context, userId, {
          outletId: null,
          code: "CUSTOM-PBJT",
          name: "Pajak Kustom Pemilik",
          taxType: "pbjt",
          rateBp: 1100,
          regionCode: null,
          channels: ["dine_in"],
          appliesTo: {
            itemClasses: ["food_beverage"],
            categoryIds: [],
            itemIds: [],
          },
          includeServiceInBase: true,
          isActive: true,
          effectiveFrom: businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK),
        }),
      () => backfillTenantTaxDefaults(tenantId),
    );

    expect.soft(outcome.ownerResult.status).toBe("fulfilled");
    expect.soft(outcome.backfillResult.status).toBe("fulfilled");
    const { rows } = await owner.query<{ code: string }>(
      "SELECT code FROM tax_rules WHERE tenant_id = $1 ORDER BY code",
      [tenantId],
    );
    expect.soft(rows.map((row) => row.code)).toEqual(["CUSTOM-PBJT"]);
    if (outcome.backfillResult.status === "fulfilled")
      expect.soft(outcome.backfillResult.value.rulesInserted).toBe(0);
    // The backfill must wait on the provisioning lock, not race past it.
    expect.soft(outcome.parkedOn).toBe("advisory");
    expect.soft(outcome.advisoryStates).toContain(false);
  });

  it("legend-hd1m: owner account and standard chart backfill never mix in one chart", async () => {
    const { tenantId, entityId } = await seedTenant();
    const context = scopeOf(tenantId);

    const outcome = await race(
      "chart_of_accounts",
      `chart_of_accounts:${tenantId}:${entityId}`,
      () =>
        createAccount(
          context,
          entityId,
          {
            code: "9999",
            name: "Akun Pemilik",
            type: "asset",
            reportGroup: "current_asset",
            parentId: null,
          },
          userId as UserId,
        ),
      () => backfillTenantCharts(tenantId),
    );

    expect.soft(outcome.ownerResult.status).toBe("fulfilled");
    expect.soft(outcome.backfillResult.status).toBe("fulfilled");
    const accounts = await owner.query<{ code: string }>(
      "SELECT code FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 ORDER BY code",
      [tenantId, entityId],
    );
    expect.soft(accounts.rows.map((row) => row.code)).toEqual(["9999"]);
    const mappings = await owner.query(
      "SELECT 1 FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, entityId],
    );
    expect.soft(mappings.rowCount).toBe(0);
    if (outcome.backfillResult.status === "fulfilled")
      expect
        .soft(outcome.backfillResult.value.map((result) => result.status))
        .toEqual(["already_present"]);
    expect.soft(outcome.parkedOn).toBe("advisory");
    expect.soft(outcome.advisoryStates).toContain(false);
  });

  it("legend-usa4b: edge master import and standard chart backfill never mix in one chart", async () => {
    const { tenantId, entityId, snapshot, claims } = await seedEdgeWorld();

    const outcome = await race(
      "chart_of_accounts",
      `chart_of_accounts:${tenantId}:${entityId}`,
      () => applyEdgeMasterSnapshot(claims, snapshot),
      () => backfillTenantCharts(tenantId),
    );

    expect.soft(outcome.ownerResult.status).toBe("fulfilled");
    expect.soft(outcome.backfillResult.status).toBe("fulfilled");
    const accounts = await owner.query<{ code: string }>(
      "SELECT code FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 ORDER BY code",
      [tenantId, entityId],
    );
    expect.soft(accounts.rows.map((row) => row.code)).toEqual(["9999"]);
    const mappings = await owner.query(
      "SELECT 1 FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, entityId],
    );
    expect.soft(mappings.rowCount).toBe(0);
    if (outcome.backfillResult.status === "fulfilled")
      expect
        .soft(outcome.backfillResult.value.map((result) => result.status))
        .toEqual(["already_present"]);
    expect.soft(outcome.parkedOn).toBe("advisory");
    expect.soft(outcome.advisoryStates).toContain(false);
  });

  it("legend-usa4b: edge import after the backfill committed the template is refused, chart and mappings untouched", async () => {
    const { tenantId, entityId, snapshot, claims } = await seedEdgeWorld();
    const results = await backfillTenantCharts(tenantId);
    expect(results.map((result) => result.status)).toEqual(["provisioned"]);
    const before = await chartState(tenantId, entityId);
    expect(before.accounts.length).toBe(71);
    expect(before.mappings.length).toBeGreaterThan(0);

    // The cloud chart is account 9999 only: no template code is in the
    // snapshot, so the template accounts are not replaceable forks.
    await expect(
      applyEdgeMasterSnapshot(claims, snapshot),
    ).rejects.toMatchObject({ code: "LOCAL_CONFLICT" });
    expect(await chartState(tenantId, entityId)).toEqual(before);
  });
});
