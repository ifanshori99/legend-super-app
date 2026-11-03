// OPS-01 supervisor escalation against PostgreSQL (bead legend-5zkp; PRD v1.7
// §3 F45 "Operasional Harian"). Runs the real service with the restricted app
// role so RLS is enforced: the sweep only touches the calling tenant's outlet
// scope, marks each overdue run exactly once and queues one notification event
// per miss. Rows are seeded through the owner connection because the app role
// may not insert checklist data, and every test cleans up what it created so
// the tenant-wide sweep counts stay local.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { opsChecklistRuns } from "../db/schema/operations.ts";
import {
  markChecklistRunMissed,
  sweepMissedChecklistRuns,
} from "../services/operations-escalation.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const assignee = randomUUID();
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = randomUUID();

/** 2026-11-02 11:00 WIB (04:00 UTC). */
const NOW = new Date("2026-11-02T04:00:00.000Z");
const SHIFT_DATE = "2026-11-02";
const before = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const base = (tenant: string) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const outletScope = (outletId: string) =>
  establishScopedTenantContext(base(tenantId), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

/** Owner connection with the tenant settings FORCE RLS requires. */
async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

type RunStatus = "pending" | "in_progress" | "completed" | "failed" | "missed";

type SeededRun = {
  tenant: string;
  runId: string;
  templateId: string;
  outletId: string;
  dueAt: Date;
};

const seededRuns: SeededRun[] = [];

/** One template + one run, written by the owner role in the row's tenant. */
async function seedChecklistRun(options: {
  tenant?: string;
  outletId?: string;
  status?: RunStatus;
  dueAt: Date;
  completedAt?: Date;
}): Promise<SeededRun> {
  const tenant = options.tenant ?? tenantId;
  const outletId = options.outletId ?? outletA;
  const status = options.status ?? "pending";
  const templateId = randomUUID();
  const runId = randomUUID();
  const itemId = randomUUID();
  const items = JSON.stringify([
    {
      id: itemId,
      label: "Kasir dibuka dan dihitung",
      instruction: null,
      requiredEvidence: [],
    },
  ]);
  const schedule = JSON.stringify({
    shiftTemplateId: null,
    stationId: null,
    zoneId: null,
    dueTime: "09:00",
  });
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO ops_checklist_templates
         (id, tenant_id, outlet_id, name, type, items, schedule)
       VALUES ($1, $2, $3, $4, 'opening', $5, $6)`,
      [
        templateId,
        tenant,
        outletId,
        `Checklist ${templateId.slice(0, 8)}`,
        items,
        schedule,
      ],
    );
    await client.query(
      `INSERT INTO ops_checklist_runs
         (id, tenant_id, outlet_id, template_id, template_version, items,
          shift_date, assigned_to, due_at, status, completed_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10)`,
      [
        runId,
        tenant,
        outletId,
        templateId,
        items,
        SHIFT_DATE,
        assignee,
        options.dueAt.toISOString(),
        status,
        options.completedAt?.toISOString() ?? null,
      ],
    );
  });
  const entry = { tenant, runId, templateId, outletId, dueAt: options.dueAt };
  seededRuns.push(entry);
  return entry;
}

async function readRun(run: SeededRun) {
  const { rows } = await asOwner(run.tenant, (client) =>
    client.query(
      `SELECT status, missed_at, alerted_at, completed_at, due_at
         FROM ops_checklist_runs WHERE tenant_id = $1 AND id = $2`,
      [run.tenant, run.runId],
    ),
  );
  return rows[0] as {
    status: string;
    missed_at: Date | null;
    alerted_at: Date | null;
    completed_at: Date | null;
    due_at: Date;
  };
}

/** Every checklist event the outbox holds for this run, oldest first. */
async function readChecklistEvents(run: SeededRun) {
  const { rows } = await asOwner(run.tenant, (client) =>
    client.query(
      `SELECT destination, event
         FROM domain_event_outbox
        WHERE tenant_id = $1 AND aggregate_type = 'checklist' AND aggregate_id = $2
        ORDER BY sequence`,
      [run.tenant, run.runId],
    ),
  );
  return rows as {
    destination: string;
    event: {
      name: string;
      aggregateType: string;
      aggregateId: string;
      actor: unknown;
      payload: Record<string, unknown>;
    };
  }[];
}

async function cleanupSeeded() {
  if (seededRuns.length === 0) return;
  const byTenant = new Map<string, string[]>();
  for (const run of seededRuns) {
    byTenant.set(run.tenant, [...(byTenant.get(run.tenant) ?? []), run.runId]);
  }
  for (const [tenant, runIds] of byTenant) {
    const templateIds = seededRuns
      .filter((run) => run.tenant === tenant && runIds.includes(run.runId))
      .map((run) => run.templateId);
    await asOwner(tenant, async (client) => {
      await client.query(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = ANY($2::uuid[])",
        [tenant, runIds],
      );
      await client.query(
        "DELETE FROM ops_checklist_runs WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant, runIds],
      );
      await client.query(
        "DELETE FROM ops_checklist_templates WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant, templateIds],
      );
    });
  }
  seededRuns.length = 0;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await ownerPool.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Escalation DB', $2)`,
    [assignee, `${assignee}@example.test`],
  );
  // A second tenant with its own outlet, to prove the sweep cannot see or
  // mark another tenant's runs (TEN-01).
  await ownerPool.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Escalation RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `escalation-rls-${otherTenant.slice(0, 8)}`, tenantId],
  );
  await asOwner(otherTenant, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand B')`,
      [otherBrand, otherTenant],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B', false)`,
      [otherEntity, otherTenant],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [otherOutlet, otherTenant, otherBrand, otherEntity],
    );
  });
});

afterEach(cleanupSeeded);

afterAll(async () => {
  await cleanupSeeded();
  await asOwner(otherTenant, async (client) => {
    await client.query("DELETE FROM outlets WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM brands WHERE tenant_id = $1", [
      otherTenant,
    ]);
  });
  await ownerPool.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await ownerPool.query('DELETE FROM "user" WHERE id = $1', [assignee]);
  await ownerPool.end();
});

describe("OPS-01 missed checklist escalation (legend-5zkp)", () => {
  it("[legend-5zkp] OPS-01 an overdue pending run is marked missed and its supervisor alert is queued once", async () => {
    const run = await seedChecklistRun({ dueAt: before(60) });
    const context = outletScope(outletA);

    const marked = await withTenant(db, context, (tx) =>
      sweepMissedChecklistRuns(tx, context, NOW),
    );
    expect(marked).toBeGreaterThanOrEqual(1);

    const row = await readRun(run);
    expect(row.status).toBe("missed");
    expect(row.missed_at?.toISOString()).toBe(NOW.toISOString());
    // Delivery evidence: the notification event committed with the miss.
    expect(row.alerted_at?.toISOString()).toBe(NOW.toISOString());
    expect(row.completed_at).toBeNull();

    const events = await readChecklistEvents(run);
    expect(events).toHaveLength(1);
    expect(events[0].destination).toBe("notification");
    expect(events[0].event.name).toBe("checklist.missed");
    expect(events[0].event.aggregateType).toBe("checklist");
    expect(events[0].event.aggregateId).toBe(run.runId);
    expect(events[0].event.actor).toEqual({ type: "system" });
    expect(events[0].event.payload).toMatchObject({
      runId: run.runId,
      templateId: run.templateId,
      shiftDate: SHIFT_DATE,
      assignedTo: assignee,
      dueAt: run.dueAt.toISOString(),
      detectedAt: NOW.toISOString(),
    });

    // The second tick marks nothing: the status guard is the exactly-once
    // boundary, so no supervisor receives a duplicate alert.
    const again = await withTenant(db, context, (tx) =>
      sweepMissedChecklistRuns(tx, context, NOW),
    );
    expect(again).toBe(0);
    expect(await readChecklistEvents(run)).toHaveLength(1);

    // A direct call is a no-op for an already-missed run.
    const direct = await withTenant(db, context, (tx) =>
      markChecklistRunMissed(
        tx,
        context,
        {
          id: run.runId,
          templateId: run.templateId,
          shiftDate: SHIFT_DATE,
          assignedTo: assignee,
          outletId: run.outletId,
          dueAt: run.dueAt,
        },
        NOW,
      ),
    );
    expect(direct).toBe(false);
    expect(await readChecklistEvents(run)).toHaveLength(1);
  });

  it("[legend-5zkp] OPS-01 a completed run is never marked missed", async () => {
    const run = await seedChecklistRun({
      status: "completed",
      dueAt: before(60),
      completedAt: before(30),
    });
    const context = outletScope(outletA);

    await withTenant(db, context, (tx) =>
      sweepMissedChecklistRuns(tx, context, NOW),
    );

    const row = await readRun(run);
    expect(row.status).toBe("completed");
    expect(row.missed_at).toBeNull();
    expect(row.alerted_at).toBeNull();
    expect(await readChecklistEvents(run)).toHaveLength(0);
  });

  it("[legend-5zkp] OPS-01 the sweep stays inside the caller's tenant: another tenant's run is untouched and invisible", async () => {
    const foreign = await seedChecklistRun({
      tenant: otherTenant,
      outletId: otherOutlet,
      dueAt: before(60),
    });
    const own = await seedChecklistRun({ dueAt: before(60) });
    const context = outletScope(outletA);

    const marked = await withTenant(db, context, (tx) =>
      sweepMissedChecklistRuns(tx, context, NOW),
    );
    expect(marked).toBeGreaterThanOrEqual(1);

    const ownRow = await readRun(own);
    expect(ownRow.status).toBe("missed");

    const foreignRow = await readRun(foreign);
    expect(foreignRow.status).toBe("pending");
    expect(foreignRow.missed_at).toBeNull();
    expect(await readChecklistEvents(foreign)).toHaveLength(0);

    // The app role cannot even read the foreign run through a tenant filter.
    const visible = await withTenant(db, context, (tx) =>
      tx
        .select({ id: opsChecklistRuns.id })
        .from(opsChecklistRuns)
        .where(eq(opsChecklistRuns.id, foreign.runId)),
    );
    expect(visible).toHaveLength(0);
  });
});
