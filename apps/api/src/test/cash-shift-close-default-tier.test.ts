// Default cash shift close approval matrix (bead legend-ccpn; PRD §3.10, Q28,
// TEN-02). Founder decision Q28 (2026-11-09): every shift close is approved by a
// supervisor, a PIN at the cashier is enough, whatever the variance. A tenant
// with no cash_shift_close policy rows gets one tier, one level, from Rp0, for
// the templates that hold shift.cash.approve_close (supervisor, outlet_manager,
// general_manager: an approver must hold the exact role the matrix names, so
// this keeps who could approve a close before), distinct actor. A tenant that
// configured its own matrix keeps it.
//
// Assumptions where the brief is silent:
// - The default row is written out here rather than imported so a wrong
//   constant cannot hide itself.
// - The migration is re-run inside a transaction that is rolled back, so it
//   cannot add rows to tenants owned by other suites. All reads inside it use
//   that same connection (the migration locks roles and approval_policies).
// - Only the isolated tenants created here are asserted on; the shared seeded
//   tenant is read, never changed.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema } from "@starter/shared/core";
import { outletIdSchema, userIdSchema } from "@starter/shared/core";
import type { ScopedTenantContext } from "@starter/shared/core";
import { closePosShiftInputSchema } from "@starter/shared/pos";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { seedTenantRoleTemplates } from "../services/access.service";
import { closePosShift } from "../services/pos-shift.service";
import { createIsolatedTenant } from "./floor-test-helpers";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const ACTION = "cash_shift_close";

const tenantContext = (id: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(id),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

// PRD §3.10 and Q28: every shift close needs one approval, from Rp0. The
// approvers are the templates that hold shift.cash.approve_close. Sorted by
// template key, as closePolicies orders them.
const DEFAULT_ROWS = [
  { threshold: 0, level: 1, template: "general_manager", distinct: true },
  { threshold: 0, level: 1, template: "outlet_manager", distinct: true },
  { threshold: 0, level: 1, template: "supervisor", distinct: true },
];

type PolicyRow = {
  id: string;
  threshold: number | null;
  level: number;
  template_key: string | null;
  approver_role_id: string;
  requires_distinct_actor: boolean;
};

async function closePolicies(
  tenant: string,
  via: Pick<PoolClient, "query"> = owner,
): Promise<PolicyRow[]> {
  const { rows } = await via.query<PolicyRow>(
    `SELECT p.id, p.threshold_idr::int AS threshold, p.levels AS level, r.template_key,
            p.approver_role_id, p.requires_distinct_actor
     FROM approval_policies p JOIN roles r ON r.id = p.approver_role_id
     WHERE p.tenant_id = $1 AND p.action_type = $2
     ORDER BY p.threshold_idr NULLS FIRST, p.levels, r.template_key`,
    [tenant, ACTION],
  );
  return rows;
}

const asDefaults = (rows: PolicyRow[]) =>
  rows.map((r) => ({
    threshold: r.threshold,
    level: r.level,
    template: r.template_key,
    distinct: r.requires_distinct_actor,
  }));

async function roleIdOf(templateKey: string, tenant: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenant, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

const seed = (id: string) =>
  withTenant(db, tenantContext(id), (tx) => seedTenantRoleTemplates(tx, id));

/** A tenant of its own with the role templates, as platform provisioning gives. */
async function provisionedTenant() {
  const suffix = `cs${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const isolated = await createIsolatedTenant(suffix);
  await seed(isolated.tenantId);
  return isolated;
}

const clearRows = (ids: string[]) =>
  owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = ANY($1::uuid[]) AND action_type = $2",
    [ids, ACTION],
  );

/**
 * Run the cash_shift_close_approval_policies_data migration body on a
 * dedicated connection inside a transaction that is always rolled back. The
 * migration locks roles and approval_policies, so every read inside goes
 * through this same connection: a read on another connection would wait for
 * the lock and never return.
 */
async function inRolledBackMigration<T>(
  inspect: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const dir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  const file = readdirSync(dir).find((name) =>
    /^\d{4}_cash_shift_close_approval_policies_data\.sql$/.test(name),
  );
  if (!file)
    throw new Error(
      "Migration cash_shift_close_approval_policies_data is missing",
    );
  const statements = readFileSync(`${dir}${file}`, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    // Fail fast instead of hanging if another session holds a lock.
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const statement of statements) await client.query(statement);
    return await inspect(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

afterAll(async () => {
  await owner.end();
});

describe("PRD §3.10 default cash shift close matrix for a new tenant", () => {
  it("PRD §3.10 a newly provisioned tenant has exactly the 3 default cash_shift_close rows", async () => {
    const tenant = await provisionedTenant();
    const rows = await closePolicies(tenant.tenantId);
    expect(asDefaults(rows)).toEqual(DEFAULT_ROWS);
    // The rows point at this tenant's own roles, in the same order.
    expect(rows.map((r) => r.approver_role_id)).toEqual([
      await roleIdOf("general_manager", tenant.tenantId),
      await roleIdOf("outlet_manager", tenant.tenantId),
      await roleIdOf("supervisor", tenant.tenantId),
    ]);
  });

  it("PRD §3.10 seeding an existing tenant without cash_shift_close rows adds the default once", async () => {
    const tenant = await provisionedTenant();
    await clearRows([tenant.tenantId]);
    expect(await closePolicies(tenant.tenantId)).toHaveLength(0);
    for (let run = 0; run < 3; run += 1) await seed(tenant.tenantId);
    expect(asDefaults(await closePolicies(tenant.tenantId))).toEqual(
      DEFAULT_ROWS,
    );
  });

  it("PRD §3.10 re-running the seed and the migration on a tenant that has the default adds nothing", async () => {
    const tenant = await provisionedTenant();
    const before = await closePolicies(tenant.tenantId);
    expect(before).toHaveLength(3);
    await seed(tenant.tenantId);
    expect(await closePolicies(tenant.tenantId)).toEqual(before);
    await inRolledBackMigration(async (client) => {
      expect(await closePolicies(tenant.tenantId, client)).toEqual(before);
    });
    expect(await closePolicies(tenant.tenantId)).toEqual(before);
  });

  it("PRD §3.10 the seeded dev tenant has the default row", async () => {
    expect(asDefaults(await closePolicies(tenantId))).toEqual(DEFAULT_ROWS);
  });
});

describe("PRD §3.10 a tenant that configured its own cash_shift_close matrix keeps it", () => {
  // A custom matrix. requires_distinct_actor must be true: the table refuses
  // false for these rows (approval_policies_distinct_actor_check).
  const CUSTOM = [
    { threshold: 250_000, template: "outlet_manager" },
    { threshold: 1_000_000, template: "general_manager" },
  ];

  it("PRD §3.10 rows are unchanged after seeding again and after re-running the migration", async () => {
    const custom = await provisionedTenant();
    const legacy = await provisionedTenant(); // an existing tenant with no rows
    const partial = await provisionedTenant(); // a tenant without a supervisor role: only the other two rows land
    const id = custom.tenantId;

    await clearRows([id, legacy.tenantId, partial.tenantId]);
    for (const row of CUSTOM)
      await owner.query(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         VALUES ($1, $2, $3, $4, 1, true)`,
        [id, ACTION, row.threshold, await roleIdOf(row.template, id)],
      );
    const partialSupervisor = await roleIdOf("supervisor", partial.tenantId);
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND approver_role_id = $2",
      [partial.tenantId, partialSupervisor],
    );
    await owner.query("DELETE FROM roles WHERE id = $1", [partialSupervisor]);
    const before = await closePolicies(id);
    expect(before).toHaveLength(2);

    await seed(id);
    expect(await closePolicies(id)).toEqual(before);

    await inRolledBackMigration(async (client) => {
      // The custom tenant is not touched ...
      expect(await closePolicies(id, client)).toEqual(before);
      // ... an existing tenant with no rows gets the default ...
      expect(asDefaults(await closePolicies(legacy.tenantId, client))).toEqual(
        DEFAULT_ROWS,
      );
      // ... and a tenant without a supervisor role gets no supervisor row.
      expect(asDefaults(await closePolicies(partial.tenantId, client))).toEqual(
        DEFAULT_ROWS.filter((row) => row.template !== "supervisor"),
      );
    });
    // Rolled back: the migration left no trace for the suites that follow.
    expect(await closePolicies(legacy.tenantId)).toHaveLength(0);
    expect(await closePolicies(id)).toEqual(before);
  });

  it("PRD §3.10 the seeded tenant's default survives the migration being re-run", async () => {
    const before = await closePolicies(tenantId);
    expect(asDefaults(before)).toEqual(DEFAULT_ROWS);
    await inRolledBackMigration(async (client) => {
      expect(await closePolicies(tenantId, client)).toEqual(before);
    });
    expect(await closePolicies(tenantId)).toEqual(before);
  });
});

describe("TEN-02 the cash_shift_close default never crosses tenants", () => {
  it("TEN-02 seeding the defaults for tenant B does not touch tenant A", async () => {
    const aBefore = await closePolicies(tenantId);
    const aRoles = (
      await owner.query<{ id: string }>(
        "SELECT id FROM roles WHERE tenant_id = $1",
        [tenantId],
      )
    ).rows.map((r) => r.id);

    const tenantB = await provisionedTenant();
    await clearRows([tenantB.tenantId]);
    await seed(tenantB.tenantId);

    expect(asDefaults(await closePolicies(tenantB.tenantId))).toEqual(
      DEFAULT_ROWS,
    );
    expect(await closePolicies(tenantId)).toEqual(aBefore);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approval_policies
       WHERE tenant_id = $1 AND approver_role_id = ANY($2::uuid[])`,
      [tenantB.tenantId, aRoles],
    );
    expect(rows[0]!.n).toBe("0");
  });
});

describe("legend-ccpn the default matrix keeps who could approve a shift close", () => {
  // The matrix is judged when the approval is used, so these tests close a
  // real shift through closePosShift. Both writers are the real services; only
  // the approved PIN override row is written as the owner (a PIN approved at
  // the cashier a few seconds ago, what createPosOverride stores).
  const tenantCtx = (id: string) => tenantContext(id);
  type Provisioned = Awaited<ReturnType<typeof provisionedTenant>>;

  async function userWithRole(tenant: Provisioned, templateKey: string) {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
      [id, `Staf ${templateKey}`, `${id}@example.test`],
    );
    // Backdated: the container clock may drift from the Node clock.
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [
        tenant.tenantId,
        id,
        await roleIdOf(templateKey, tenant.tenantId),
        tenant.outletId,
      ],
    );
    return id;
  }

  /** An open shift with a count of Rp70.000 against Rp100.000 (variance -30.000). */
  async function shiftWithCount(tenant: Provisioned) {
    const cashier = await userWithRole(tenant, "cashier");
    const shiftId = randomUUID();
    await owner.query(
      `INSERT INTO pos_shifts
         (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
          opened_at, opening_float_idr, open_key, open_fingerprint)
       VALUES ($1, $2, $3, $4, $5, current_date, 'open', now(), 100000, $6, $7)`,
      [
        shiftId,
        tenant.tenantId,
        tenant.outletId,
        randomUUID(),
        cashier,
        randomUUID(),
        "a".repeat(64),
      ],
    );
    const countId = randomUUID();
    await owner.query(
      `INSERT INTO pos_shift_counts
         (id, tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
          counted_idr, expected_idr, variance_idr, submitted_by, submitted_at,
          idempotency_key, request_fingerprint, cash_watermark)
       VALUES ($1, $2, $3, $4, 1, $8::jsonb, $5, 70000, 100000, -30000, $6, now(), $7, $5, 0)`,
      [
        countId,
        tenant.tenantId,
        tenant.outletId,
        shiftId,
        "b".repeat(64),
        cashier,
        randomUUID(),
        JSON.stringify([
          { denominationIdr: 50000, quantity: 1 },
          { denominationIdr: 20000, quantity: 1 },
        ]),
      ],
    );
    return { cashier, shiftId, countId };
  }

  /** Close the shift with a PIN approval by `approver`, as the cashier. */
  async function closeWithPin(
    tenant: Provisioned,
    shift: Awaited<ReturnType<typeof shiftWithCount>>,
    approver: string,
  ) {
    const overrideId = randomUUID();
    await owner.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, 'cash_shift_close', 'supervisor_pin', 'approved', $4, $5,
               'Hitung kas akhir shift', 30000, 'pos_shift_count', $6, $7,
               now() - interval '5 seconds', now() - interval '5 seconds')`,
      [
        overrideId,
        tenant.tenantId,
        tenant.outletId,
        shift.cashier,
        approver,
        shift.countId,
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      ],
    );
    return closePosShift(
      tenantCtx(tenant.tenantId),
      { userId: userIdSchema.parse(shift.cashier), deviceId: null },
      outletIdSchema.parse(tenant.outletId),
      shift.shiftId,
      closePosShiftInputSchema.parse({
        countId: shift.countId,
        varianceNote: "Selisih hitung kas akhir shift",
        approvedBy: approver,
        approvalRequestId: overrideId,
        idempotencyKey: randomUUID(),
      }),
    );
  }

  it("legend-ccpn an outlet_manager (not supervisor) PIN approves a close with a variance under the default matrix", async () => {
    const tenant = await provisionedTenant();
    expect(await closePolicies(tenant.tenantId)).toHaveLength(3);
    const shift = await shiftWithCount(tenant);
    const manager = await userWithRole(tenant, "outlet_manager");
    const closed = await closeWithPin(tenant, shift, manager);
    expect(closed.status).toBe("closed");
    expect(closed.varianceIdr).toBe(-30_000);
  });

  it("legend-ccpn a supervisor and a general_manager PIN approve a close under the default matrix", async () => {
    for (const template of ["supervisor", "general_manager"]) {
      const tenant = await provisionedTenant();
      const shift = await shiftWithCount(tenant);
      const approver = await userWithRole(tenant, template);
      const closed = await closeWithPin(tenant, shift, approver);
      expect(closed.status, template).toBe("closed");
    }
  });

  it("legend-ccpn a cashier with no approve role is still refused as approver", async () => {
    const tenant = await provisionedTenant();
    const shift = await shiftWithCount(tenant);
    const otherCashier = await userWithRole(tenant, "cashier");
    await expect(
      closeWithPin(tenant, shift, otherCashier),
    ).rejects.toMatchObject({ status: 403 });
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM pos_shifts WHERE id = $1",
      [shift.shiftId],
    );
    expect(rows[0]!.status).toBe("open");
  });

  it("legend-ccpn a tenant with a custom supervisor-only matrix is untouched by the seed and still refuses an outlet_manager", async () => {
    const tenant = await provisionedTenant();
    await clearRows([tenant.tenantId]);
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, NULL, $3, 1, true)`,
      [tenant.tenantId, ACTION, await roleIdOf("supervisor", tenant.tenantId)],
    );
    const before = await closePolicies(tenant.tenantId);
    expect(before).toHaveLength(1);
    await seed(tenant.tenantId);
    expect(await closePolicies(tenant.tenantId)).toEqual(before);
    const shift = await shiftWithCount(tenant);
    const manager = await userWithRole(tenant, "outlet_manager");
    await expect(closeWithPin(tenant, shift, manager)).rejects.toMatchObject({
      status: 403,
    });
    const supervisor = await userWithRole(tenant, "supervisor");
    expect((await closeWithPin(tenant, shift, supervisor)).status).toBe(
      "closed",
    );
  });
});
