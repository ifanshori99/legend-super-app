// OPS-04 service reminder sweep against PostgreSQL (WS-14 legend-o032). Runs
// the real service with the restricted app role so RLS is enforced: a schedule
// due within the horizon is reminded exactly once per due date, advancing the
// due date re-arms it, retired equipment is skipped and another tenant is never
// touched. Rows are seeded through the owner connection and removed afterwards
// so the tenant-wide sweep counts stay local.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { sweepEquipmentServiceReminders } from "../services/operations-equipment-reminder.service.ts";
import { createNotificationRecipientResolver } from "../worker/notification-adapters.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = randomUUID();
const supervisorUser = randomUUID();

/** 2026-11-10 10:00 WIB (03:00 UTC). */
const NOW = new Date("2026-11-10T03:00:00.000Z");
const inDays = (days: number) =>
  new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);

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

type SeededSchedule = {
  tenant: string;
  outletId: string;
  equipmentId: string;
  scheduleId: string;
};
const seeded: SeededSchedule[] = [];

async function seedSchedule(options: {
  tenant?: string;
  outletId?: string;
  dueAt: Date;
  remindedForDueAt?: Date | null;
  equipmentStatus?: string;
}): Promise<SeededSchedule> {
  const tenant = options.tenant ?? tenantId;
  const outletId = options.outletId ?? outletA;
  const equipmentId = randomUUID();
  const scheduleId = randomUUID();
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO equipment (id, tenant_id, outlet_id, name, category, status)
       VALUES ($1, $2, $3, $4, 'espresso_machine', $5)`,
      [
        equipmentId,
        tenant,
        outletId,
        `Mesin ${equipmentId.slice(0, 8)}`,
        options.equipmentStatus ?? "operational",
      ],
    );
    await client.query(
      `INSERT INTO maintenance_schedules
         (id, tenant_id, outlet_id, equipment_id, interval_days, next_due_at, reminded_for_due_at)
       VALUES ($1, $2, $3, $4, 90, $5, $6)`,
      [
        scheduleId,
        tenant,
        outletId,
        equipmentId,
        options.dueAt.toISOString(),
        options.remindedForDueAt?.toISOString() ?? null,
      ],
    );
  });
  const entry = { tenant, outletId, equipmentId, scheduleId };
  seeded.push(entry);
  return entry;
}

async function readSchedule(entry: SeededSchedule) {
  const { rows } = await asOwner(entry.tenant, (client) =>
    client.query(
      `SELECT next_due_at, reminded_for_due_at
         FROM maintenance_schedules WHERE tenant_id = $1 AND id = $2`,
      [entry.tenant, entry.scheduleId],
    ),
  );
  return rows[0] as { next_due_at: Date; reminded_for_due_at: Date | null };
}

async function readEvents(entry: SeededSchedule) {
  const { rows } = await asOwner(entry.tenant, (client) =>
    client.query(
      `SELECT destination, event
         FROM domain_event_outbox
        WHERE tenant_id = $1 AND aggregate_id = $2
        ORDER BY sequence`,
      [entry.tenant, entry.scheduleId],
    ),
  );
  return rows as {
    destination: string;
    event: {
      name: string;
      outletId: string | null;
      aggregateId: string;
      actor: { type: string };
      payload: Record<string, unknown>;
    };
  }[];
}

async function cleanupSeeded() {
  const byTenant = new Map<string, SeededSchedule[]>();
  for (const entry of seeded) {
    byTenant.set(entry.tenant, [...(byTenant.get(entry.tenant) ?? []), entry]);
  }
  for (const [tenant, entries] of byTenant) {
    await asOwner(tenant, async (client) => {
      await client.query(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = ANY($2::uuid[])",
        [tenant, entries.map((entry) => entry.scheduleId)],
      );
      await client.query(
        "DELETE FROM maintenance_schedules WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant, entries.map((entry) => entry.scheduleId)],
      );
      await client.query(
        "DELETE FROM equipment WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant, entries.map((entry) => entry.equipmentId)],
      );
    });
  }
  seeded.length = 0;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await ownerPool.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Reminder supervisor', $2)`,
    [supervisorUser, `${supervisorUser}@example.test`],
  );
  await ownerPool.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     SELECT $1, $2, id, 'outlet', $3, now() - interval '1 hour', $2
       FROM roles WHERE tenant_id = $1 AND template_key = 'supervisor'`,
    [tenantId, supervisorUser, outletA],
  );
  // A second tenant with its own outlet, to prove the sweep cannot see or
  // mark another tenant's schedules (TEN-01).
  await ownerPool.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Reminder RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `reminder-rls-${otherTenant.slice(0, 8)}`, tenantId],
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
  await ownerPool.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, supervisorUser],
  );
  await ownerPool.query('DELETE FROM "user" WHERE id = $1', [supervisorUser]);
  await ownerPool.end();
});

const sweep = (now: Date = NOW) => {
  const context = outletScope(outletA);
  return withTenant(db, context, (tx) =>
    sweepEquipmentServiceReminders(tx, context, now),
  );
};

describe("OPS-04 equipment service reminder (legend-o032)", () => {
  it("reminds a schedule inside the horizon exactly once, even when the sweep runs twice", async () => {
    const entry = await seedSchedule({ dueAt: inDays(3) });

    expect(await sweep()).toBeGreaterThanOrEqual(1);
    expect(await sweep()).toBe(0);

    const events = await readEvents(entry);
    expect(events).toHaveLength(1);
    expect(events[0].destination).toBe("notification");
    expect(events[0].event.name).toBe("equipment_service.reminded");
    expect(events[0].event.aggregateId).toBe(entry.scheduleId);
    expect(events[0].event.outletId).toBe(outletA);
    expect(events[0].event.actor).toEqual({ type: "system" });
    expect(events[0].event.payload).toEqual({
      scheduleId: entry.scheduleId,
      equipmentId: entry.equipmentId,
      nextDueAt: inDays(3).toISOString(),
      vendorId: null,
      remindedAt: NOW.toISOString(),
    });

    const row = await readSchedule(entry);
    expect(row.reminded_for_due_at?.toISOString()).toBe(
      row.next_due_at.toISOString(),
    );
  });

  it("also reminds a schedule that is already overdue", async () => {
    const entry = await seedSchedule({ dueAt: inDays(-2) });
    await sweep();
    expect(await readEvents(entry)).toHaveLength(1);
  });

  it("does not remind a schedule due beyond the 7-day horizon", async () => {
    const entry = await seedSchedule({ dueAt: inDays(8) });
    await sweep();
    expect(await readEvents(entry)).toHaveLength(0);
    expect((await readSchedule(entry)).reminded_for_due_at).toBeNull();
  });

  it("reminds again after the due date advances", async () => {
    const entry = await seedSchedule({ dueAt: inDays(2) });
    await sweep();
    expect(await readEvents(entry)).toHaveLength(1);

    // Service completed: the next due date moves, `reminded_for_due_at` stays.
    await asOwner(entry.tenant, (client) =>
      client.query(
        "UPDATE maintenance_schedules SET next_due_at = $3 WHERE tenant_id = $1 AND id = $2",
        [entry.tenant, entry.scheduleId, inDays(5).toISOString()],
      ),
    );
    await sweep();

    const events = await readEvents(entry);
    expect(events).toHaveLength(2);
    expect(events[1].event.payload.nextDueAt).toBe(inDays(5).toISOString());
    expect(await sweep()).toBe(0);
  });

  it("skips retired equipment", async () => {
    const entry = await seedSchedule({
      dueAt: inDays(1),
      equipmentStatus: "retired",
    });
    await sweep();
    expect(await readEvents(entry)).toHaveLength(0);
    expect((await readSchedule(entry)).reminded_for_due_at).toBeNull();
  });

  it("never touches another tenant's schedule", async () => {
    const foreign = await seedSchedule({
      tenant: otherTenant,
      outletId: otherOutlet,
      dueAt: inDays(1),
    });
    await sweep();
    expect(await readEvents(foreign)).toHaveLength(0);
    expect((await readSchedule(foreign)).reminded_for_due_at).toBeNull();
  });

  it("does not remind outlets outside the caller's scope", async () => {
    // A second outlet of the same tenant is outside the outlet-scoped context.
    const [secondOutlet] = cafeLegendPlatformFixtures.outlets.slice(1);
    expect(secondOutlet).toBeDefined();
    const entry = await seedSchedule({
      outletId: secondOutlet!.id,
      dueAt: inDays(1),
    });
    await sweep();
    expect(await readEvents(entry)).toHaveLength(0);
  });

  it("the notification rule resolves outlet supervisors for the reminder", async () => {
    const entry = await seedSchedule({ dueAt: inDays(4) });
    await sweep();
    const [stored] = await readEvents(entry);
    const event = eventEnvelopeSchema.parse(stored.event);

    const context = outletScope(outletA);
    const recipients = await withTenant(db, context, (tx) =>
      createNotificationRecipientResolver({ email: true, push: true })(
        context,
        event,
        tx,
      ),
    );
    expect(recipients.map((recipient) => recipient.userId)).toContain(
      supervisorUser,
    );
  });
});
