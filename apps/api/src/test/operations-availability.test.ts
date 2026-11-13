// OPS-04 sold-out write-through against PostgreSQL (bead legend-5zkp; PRD v1.7
// §3 F45 "Operasional Harian"). The service writes item_availability and the
// menu outbox inside the caller's transaction, so the tests run it through
// withTenant with the restricted app role (RLS enforced) and inspect both the
// availability rows and the cloud-sync outbox. Everything is seeded with the
// owner connection because the app role may not create menu or equipment rows,
// and cleaned up afterwards so the tenant's other tests see no leftovers.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { EquipmentStatus } from "@starter/shared/operations";
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  setAvailabilityStatus,
  updateAvailability,
} from "../services/menu-pricing.service.ts";
import {
  syncEquipmentAvailability,
  type EquipmentAvailabilityRow,
} from "../services/operations-availability.service.ts";
import { agent, signUp } from "./helpers";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const brandId = cafeLegendPlatformFixtures.brand.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
/** Any user id is a valid event actor; the outbox has no actor FK. */
const actorUserId = randomUUID();

/** 2026-11-02 11:00 WIB. */
const NOW = new Date("2026-11-02T04:00:00.000Z");

const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "outlets", outletIds: [outletA] },
);

/** Owner connection with the tenant settings FORCE RLS requires. */
async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

const createdItemIds: string[] = [];
const createdEquipmentIds: string[] = [];
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
let categoryId: string;

async function seedMenuItem(options: { deleted?: boolean } = {}) {
  const id = randomUUID();
  await asOwner((client) =>
    client.query(
      `INSERT INTO menu_items
         (id, tenant_id, brand_id, category_id, name, is_active, media_id, deleted_at)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
      [
        id,
        tenantId,
        brandId,
        categoryId,
        `Item OPS-04 ${id.slice(0, 8)}`,
        randomUUID(),
        options.deleted ? NOW.toISOString() : null,
      ],
    ),
  );
  createdItemIds.push(id);
  return id;
}

async function seedAvailability(
  menuItemId: string,
  status: "available" | "sold_out",
  soldOutUntil: Date | null = null,
  // legend-svmj: who placed the 86. Null is a pre-svmj row (read as staff).
  source: "staff" | "auto" | null = null,
): Promise<string> {
  const id = randomUUID();
  await asOwner((client) =>
    client.query(
      `INSERT INTO item_availability
         (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, sold_out_until, status, source)
       VALUES ($1, $2, $3, $4, '[]', NULL, $5, $6, $7)`,
      [
        id,
        tenantId,
        outletA,
        menuItemId,
        soldOutUntil?.toISOString() ?? null,
        status,
        source,
      ],
    ),
  );
  return id;
}

async function seedEquipment(options: {
  linked: string[];
  disabled?: string[];
  status: EquipmentStatus;
}): Promise<string> {
  const id = randomUUID();
  await asOwner((client) =>
    client.query(
      `INSERT INTO equipment
         (id, tenant_id, outlet_id, name, category, status, linked_menu_item_ids, disabled_item_ids)
       VALUES ($1, $2, $3, $4, 'espresso_machine', $5, $6, $7)`,
      [
        id,
        tenantId,
        outletA,
        `Mesin ${id.slice(0, 8)}`,
        options.status,
        options.linked,
        options.disabled ?? [],
      ],
    ),
  );
  createdEquipmentIds.push(id);
  return id;
}

function equipmentRow(
  id: string,
  status: EquipmentStatus,
  linked: string[],
  disabled: string[] = [],
): EquipmentAvailabilityRow {
  return {
    id,
    outletId: outletA,
    name: "Espresso machine",
    status,
    linkedMenuItemIds: linked,
    disabledItemIds: disabled,
  };
}

async function readEquipment(id: string) {
  const { rows } = await asOwner((client) =>
    client.query(
      `SELECT status, linked_menu_item_ids, disabled_item_ids
         FROM equipment WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    ),
  );
  return rows[0] as {
    status: string;
    linked_menu_item_ids: string[];
    disabled_item_ids: string[];
  };
}

async function readAvailability(itemIds: string[]) {
  const { rows } = await asOwner((client) =>
    client.query(
      `SELECT id, menu_item_id, status, sold_out_until, daily_limit, schedule, source
         FROM item_availability
        WHERE tenant_id = $1 AND outlet_id = $2
          AND menu_item_id = ANY($3::uuid[]) AND deleted_at IS NULL`,
      [tenantId, outletA, itemIds],
    ),
  );
  return new Map(
    (
      rows as {
        id: string;
        menu_item_id: string;
        status: string;
        sold_out_until: Date | null;
        daily_limit: number | null;
        schedule: unknown[];
        source: string | null;
      }[]
    ).map((row) => [row.menu_item_id, row]),
  );
}

/**
 * A real signed-up user holding the availability toggle on outlet A, so the
 * service-level 86 path (setAvailabilityStatus) passes its permission check.
 */
async function seedAvailabilityToggler(): Promise<string> {
  const client = agent(createApp());
  await signUp(client, "OPS-04 Availability Staff");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  const roleId = randomUUID();
  createdRoleIds.push(roleId);
  await asOwner(async (connection) => {
    await connection.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, '["menu.availability.toggle"]', '["outlet"]')`,
      [roleId, tenantId, `OPS-04 86 ${roleId.slice(0, 8)}`],
    );
    await connection.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, $5, $2)`,
      // The tests pass the fixed clock NOW to the service, so the assignment
      // must already be active then: a wall-clock valid_from lies after NOW.
      [
        tenantId,
        userId,
        roleId,
        outletA,
        new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      ],
    );
  });
  return userId;
}

/** Menu events the outbox holds for these items, oldest first. */
async function readItemEvents(itemIds: string[]) {
  const { rows } = await asOwner((client) =>
    client.query(
      `SELECT destination, event
         FROM domain_event_outbox
        WHERE tenant_id = $1 AND aggregate_type = 'item'
        ORDER BY sequence`,
      [tenantId],
    ),
  );
  return (
    rows as {
      destination: string;
      event: {
        name: string;
        aggregateId: string;
        actor: unknown;
        payload: Record<string, unknown>;
      };
    }[]
  ).filter((row) => itemIds.includes(String(row.event.payload.itemId)));
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  categoryId = randomUUID();
  await asOwner((client) =>
    client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'OPS-04 Uji', 0)`,
      [categoryId, tenantId, brandId],
    ),
  );
});

afterAll(async () => {
  await asOwner(async (client) => {
    if (createdItemIds.length > 0) {
      await client.query(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_type = 'item' AND event->'payload'->>'itemId' = ANY($2::text[])",
        [tenantId, createdItemIds],
      );
      await client.query(
        "DELETE FROM item_availability WHERE tenant_id = $1 AND menu_item_id = ANY($2::uuid[])",
        [tenantId, createdItemIds],
      );
      await client.query(
        "DELETE FROM menu_items WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, createdItemIds],
      );
    }
    if (createdEquipmentIds.length > 0)
      await client.query(
        "DELETE FROM equipment WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, createdEquipmentIds],
      );
    await client.query(
      "DELETE FROM menu_categories WHERE tenant_id = $1 AND id = $2",
      [tenantId, categoryId],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, createdRoleIds],
    );
  });
  await ownerPool.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUserIds,
  ]);
  await ownerPool.end();
});

describe("OPS-04 sold-out write-through (legend-5zkp)", () => {
  it("[legend-5zkp] OPS-04 a broken machine sells out its linked items and records them for repair", async () => {
    const itemWithoutRow = await seedMenuItem();
    const itemWithRow = await seedMenuItem();
    const existingAvailabilityId = await seedAvailability(
      itemWithRow,
      "available",
    );
    // A deleted item and an unknown id must be skipped without failing the
    // transition; the duplicate link collapses to one write.
    const deletedItem = await seedMenuItem({ deleted: true });
    const missingItem = randomUUID();
    const linked = [
      itemWithRow,
      missingItem,
      itemWithoutRow,
      itemWithRow,
      deletedItem,
    ];
    const equipmentId = await seedEquipment({ status: "broken", linked });

    const changed = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        // The column is uuid[], but the service still validates its input: a
        // non-UUID link a caller assembled from untrusted data is dropped.
        equipmentRow(equipmentId, "broken", [...linked, "not-a-uuid"]),
        "operational",
        NOW,
      ),
    );
    expect(changed).toEqual([itemWithRow, itemWithoutRow]);

    const availability = await readAvailability([itemWithoutRow, itemWithRow]);
    expect(availability.get(itemWithRow)?.status).toBe("sold_out");
    expect(availability.get(itemWithRow)?.sold_out_until).toBeNull();
    expect(availability.get(itemWithRow)?.id).toBe(existingAvailabilityId);
    expect(availability.get(itemWithoutRow)?.status).toBe("sold_out");
    expect(availability.get(itemWithoutRow)?.sold_out_until).toBeNull();
    // The row created here is the default availability row.
    expect(availability.get(itemWithoutRow)?.daily_limit).toBeNull();
    expect(availability.get(itemWithoutRow)?.schedule).toEqual([]);
    // Neither the deleted item nor the unknown id gained a row.
    expect(availability.size).toBe(2);

    const equipment = await readEquipment(equipmentId);
    expect(equipment.disabled_item_ids.sort()).toEqual(
      [itemWithRow, itemWithoutRow].sort(),
    );

    const events = await readItemEvents([itemWithRow, itemWithoutRow]);
    expect(events).toHaveLength(2);
    for (const entry of events) {
      expect(entry.event.name).toBe("item.sold_out");
      expect(entry.destination).toBe("cloud-sync");
      expect(entry.event.actor).toEqual({ type: "user", id: actorUserId });
      expect(entry.event.payload).toMatchObject({
        outletId: outletA,
        soldOutUntil: null,
      });
      // The aggregate is the availability row, keeping one aggregate on one
      // outlet in the outbox.
      const itemId = String(entry.event.payload.itemId);
      expect(entry.event.aggregateId).toBe(availability.get(itemId)?.id);
    }

    // A broken machine staying broken must not re-broadcast anything.
    const second = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(
          equipmentId,
          "broken",
          [itemWithRow, itemWithoutRow],
          [itemWithRow, itemWithoutRow],
        ),
        "broken",
        NOW,
      ),
    );
    expect(second).toEqual([]);
    expect(await readItemEvents([itemWithRow, itemWithoutRow])).toHaveLength(2);
  });

  it("[legend-5zkp] OPS-04 a repair restores only the items the equipment disabled", async () => {
    const itemA = await seedMenuItem();
    const itemB = await seedMenuItem();
    const manual86 = await seedMenuItem();
    const alreadyRestored = await seedMenuItem();
    const manualAvailabilityId = await seedAvailability(manual86, "sold_out");
    // legend-svmj: only an 86 the equipment placed itself (source 'auto') is
    // lifted by the repair.
    await seedAvailability(itemA, "sold_out", null, "auto");
    await seedAvailability(itemB, "sold_out", null, "auto");
    await seedAvailability(alreadyRestored, "available");
    // `manual86` is a linked item sold out by an operator, not by this
    // equipment: it is absent from `disabled_item_ids` and must stay sold out.
    // `alreadyRestored` is in the bookkeeping but its row is no longer sold
    // out, so the repair has nothing to restore there either.
    const equipmentId = await seedEquipment({
      status: "operational",
      linked: [itemA, itemB, manual86, alreadyRestored],
      disabled: [itemA, itemB, alreadyRestored],
    });

    const changed = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(
          equipmentId,
          "operational",
          [itemA, itemB, manual86, alreadyRestored],
          [itemA, itemB, alreadyRestored],
        ),
        "broken",
        NOW,
      ),
    );
    expect(changed).toEqual([itemA, itemB]);

    const availability = await readAvailability([
      itemA,
      itemB,
      manual86,
      alreadyRestored,
    ]);
    expect(availability.get(itemA)?.status).toBe("available");
    expect(availability.get(itemA)?.sold_out_until).toBeNull();
    expect(availability.get(itemB)?.status).toBe("available");
    expect(availability.get(manual86)?.status).toBe("sold_out");
    expect(availability.get(manual86)?.id).toBe(manualAvailabilityId);
    expect(availability.get(alreadyRestored)?.status).toBe("available");

    const equipment = await readEquipment(equipmentId);
    expect(equipment.disabled_item_ids).toEqual([]);

    const events = await readItemEvents([itemA, itemB, manual86]);
    expect(events.map((entry) => entry.event.name)).toEqual([
      "item.restored",
      "item.restored",
    ]);
    expect(
      events.map((entry) => String(entry.event.payload.itemId)).sort(),
    ).toEqual([itemA, itemB].sort());
    for (const entry of events) {
      expect(entry.destination).toBe("cloud-sync");
      expect(entry.event.actor).toEqual({ type: "user", id: actorUserId });
      expect(entry.event.payload.availabilityId).toBe(entry.event.aggregateId);
    }
  });

  it("[legend-5zkp] OPS-04 two broken machines sharing an item: the item returns only after the last repair", async () => {
    const shared = await seedMenuItem();
    const onlyA = await seedMenuItem();
    await seedAvailability(shared, "available");
    await seedAvailability(onlyA, "available");
    const machineA = await seedEquipment({
      status: "broken",
      linked: [shared, onlyA],
    });
    const machineB = await seedEquipment({
      status: "broken",
      linked: [shared],
    });

    // A breaks first and sells out both of its items.
    const brokeA = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(machineA, "broken", [shared, onlyA]),
        "operational",
        NOW,
      ),
    );
    expect(brokeA.sort()).toEqual([shared, onlyA].sort());

    // B breaks while `shared` is already sold out by A: B co-holds it with no
    // second broadcast.
    const brokeB = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(machineB, "broken", [shared]),
        "operational",
        NOW,
      ),
    );
    expect(brokeB).toEqual([]);
    expect((await readEquipment(machineB)).disabled_item_ids).toEqual([shared]);
    expect(await readItemEvents([shared])).toHaveLength(1);

    // A is repaired: its own item returns, the shared one stays sold out
    // because B is still broken.
    await asOwner((client) =>
      client.query(
        "UPDATE equipment SET status = 'operational' WHERE tenant_id = $1 AND id = $2",
        [tenantId, machineA],
      ),
    );
    const repairedA = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(machineA, "operational", [shared, onlyA], [shared, onlyA]),
        "broken",
        NOW,
      ),
    );
    expect(repairedA).toEqual([onlyA]);
    let availability = await readAvailability([shared, onlyA]);
    expect(availability.get(shared)?.status).toBe("sold_out");
    expect(availability.get(onlyA)?.status).toBe("available");
    expect((await readEquipment(machineA)).disabled_item_ids).toEqual([]);

    // B is repaired last: now the shared item returns, once.
    await asOwner((client) =>
      client.query(
        "UPDATE equipment SET status = 'operational' WHERE tenant_id = $1 AND id = $2",
        [tenantId, machineB],
      ),
    );
    const repairedB = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(machineB, "operational", [shared], [shared]),
        "broken",
        NOW,
      ),
    );
    expect(repairedB).toEqual([shared]);
    availability = await readAvailability([shared]);
    expect(availability.get(shared)?.status).toBe("available");
    expect(
      (await readItemEvents([shared])).map((entry) => entry.event.name),
    ).toEqual(["item.sold_out", "item.restored"]);
  });

  it("[legend-5zkp] OPS-04 a manual 86 before the breakdown is never taken over or lifted by the repair", async () => {
    const manual = await seedMenuItem();
    await seedAvailability(manual, "sold_out");
    const machine = await seedEquipment({ status: "broken", linked: [manual] });

    const broke = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(machine, "broken", [manual]),
        "operational",
        NOW,
      ),
    );
    expect(broke).toEqual([]);
    expect((await readEquipment(machine)).disabled_item_ids).toEqual([]);

    const repaired = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(machine, "operational", [manual], []),
        "broken",
        NOW,
      ),
    );
    expect(repaired).toEqual([]);
    expect((await readAvailability([manual])).get(manual)?.status).toBe(
      "sold_out",
    );
    expect(await readItemEvents([manual])).toHaveLength(0);
  });

  it("[legend-5zkp] OPS-04 a timed manual 86 cannot lapse while the machine is broken and is not lifted by the repair", async () => {
    const timed = await seedMenuItem();
    const later = new Date(NOW.getTime() + 2 * 60 * 60_000);
    await seedAvailability(timed, "sold_out", later);
    const machine = await seedEquipment({ status: "broken", linked: [timed] });

    const broke = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(machine, "broken", [timed]),
        "operational",
        NOW,
      ),
    );
    expect(broke).toEqual([timed]);
    const row = (await readAvailability([timed])).get(timed);
    expect(row?.status).toBe("sold_out");
    expect(row?.sold_out_until).toBeNull();
    // Still a manual 86: not in the equipment bookkeeping.
    expect((await readEquipment(machine)).disabled_item_ids).toEqual([]);
    const events = await readItemEvents([timed]);
    expect(events).toHaveLength(1);
    expect(events[0].event.name).toBe("item.sold_out");
    expect(events[0].event.payload.soldOutUntil).toBeNull();
  });

  it("[legend-5zkp] OPS-04 an item re-86'd by staff with a deadline while broken is left alone by the repair", async () => {
    const item = await seedMenuItem();
    const later = new Date(NOW.getTime() + 2 * 60 * 60_000);
    // The equipment sold it out (no deadline); staff then re-86'd it until
    // later, which the equipment never writes.
    await seedAvailability(item, "sold_out", later);
    const machine = await seedEquipment({
      status: "operational",
      linked: [item],
      disabled: [item],
    });

    const repaired = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(machine, "operational", [item], [item]),
        "broken",
        NOW,
      ),
    );
    expect(repaired).toEqual([]);
    const row = (await readAvailability([item])).get(item);
    expect(row?.status).toBe("sold_out");
    expect(row?.sold_out_until?.toISOString()).toBe(later.toISOString());
    expect((await readEquipment(machine)).disabled_item_ids).toEqual([]);
    expect(await readItemEvents([item])).toHaveLength(0);
  });

  it("[legend-svmj] OPS-04 a breakdown marks its 86 as auto; staff restore + re-86 without a deadline survives the repair", async () => {
    const staffUserId = await seedAvailabilityToggler();
    const item = await seedMenuItem();
    await seedAvailability(item, "available");
    const machine = await seedEquipment({ status: "broken", linked: [item] });

    const broke = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(machine, "broken", [item]),
        "operational",
        NOW,
      ),
    );
    expect(broke).toEqual([item]);
    let row = (await readAvailability([item])).get(item);
    expect(row?.status).toBe("sold_out");
    expect(row?.source).toBe("auto");
    const availabilityId = row!.id;

    // Staff lift the 86 and put it back with no deadline while the machine is
    // still broken: the item now belongs to staff, not to the equipment.
    await setAvailabilityStatus(
      context,
      staffUserId,
      availabilityId,
      { action: "restore", idempotencyKey: `legend-svmj-${randomUUID()}` },
      NOW,
    );
    await setAvailabilityStatus(
      context,
      staffUserId,
      availabilityId,
      {
        action: "sell_out",
        soldOutUntil: null,
        idempotencyKey: `legend-svmj-${randomUUID()}`,
      },
      NOW,
    );
    row = (await readAvailability([item])).get(item);
    expect(row?.status).toBe("sold_out");
    expect(row?.sold_out_until).toBeNull();
    expect(row?.source).toBe("staff");
    const eventsBeforeRepair = await readItemEvents([item]);

    const repaired = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(machine, "operational", [item], [item]),
        "broken",
        NOW,
      ),
    );
    // The repair does not lift a staff 86, even one without a deadline.
    expect(repaired).toEqual([]);
    row = (await readAvailability([item])).get(item);
    expect(row?.status).toBe("sold_out");
    expect(row?.source).toBe("staff");
    expect(await readItemEvents([item])).toHaveLength(
      eventsBeforeRepair.length,
    );
  });

  it("[legend-svmj] OPS-04 an auto 86 from a breakdown is lifted by the repair and its source is cleared", async () => {
    const item = await seedMenuItem();
    await seedAvailability(item, "available");
    const machine = await seedEquipment({ status: "broken", linked: [item] });

    await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(machine, "broken", [item]),
        "operational",
        NOW,
      ),
    );
    expect((await readAvailability([item])).get(item)?.source).toBe("auto");

    const repaired = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(machine, "operational", [item], [item]),
        "broken",
        NOW,
      ),
    );
    expect(repaired).toEqual([item]);
    const row = (await readAvailability([item])).get(item);
    expect(row?.status).toBe("available");
    expect(row?.source).toBeNull();
    expect(
      (await readItemEvents([item])).map((entry) => entry.event.name),
    ).toEqual(["item.sold_out", "item.restored"]);
  });

  it("[legend-svmj] OPS-04 a legacy sold-out row with a null source is treated as staff and not lifted by the repair", async () => {
    const item = await seedMenuItem();
    // A row written before the source column existed: sold out, no deadline,
    // source null, and (worst case) listed in the equipment's bookkeeping.
    await seedAvailability(item, "sold_out", null, null);
    const machine = await seedEquipment({
      status: "operational",
      linked: [item],
      disabled: [item],
    });

    const repaired = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(machine, "operational", [item], [item]),
        "broken",
        NOW,
      ),
    );
    expect(repaired).toEqual([]);
    const row = (await readAvailability([item])).get(item);
    expect(row?.status).toBe("sold_out");
    expect(row?.source).toBeNull();
    expect(await readItemEvents([item])).toHaveLength(0);
  });

  it("[legend-svmj] OPS-04 setAvailabilityStatus records staff as the source of a sell-out and clears it on restore", async () => {
    const staffUserId = await seedAvailabilityToggler();
    const item = await seedMenuItem();
    const later = new Date(NOW.getTime() + 2 * 60 * 60_000);
    // Starts as an equipment-placed 86: a staff action takes it over.
    const availabilityId = await seedAvailability(
      item,
      "sold_out",
      null,
      "auto",
    );
    const key = () => `legend-svmj-${randomUUID()}`;

    // The row is already sold_out, so sell_out is not a valid transition: staff
    // take it over by setting a deadline through updateAvailability.
    await updateAvailability(
      context,
      staffUserId,
      availabilityId,
      { soldOutUntil: later.toISOString() },
      NOW,
    );
    let row = (await readAvailability([item])).get(item);
    expect(row?.status).toBe("sold_out");
    expect(row?.sold_out_until?.toISOString()).toBe(later.toISOString());
    expect(row?.source).toBe("staff");

    await setAvailabilityStatus(
      context,
      staffUserId,
      availabilityId,
      { action: "restore", idempotencyKey: key() },
      NOW,
    );
    row = (await readAvailability([item])).get(item);
    expect(row?.status).toBe("available");
    expect(row?.sold_out_until).toBeNull();
    expect(row?.source).toBeNull();

    await setAvailabilityStatus(
      context,
      staffUserId,
      availabilityId,
      { action: "sell_out", soldOutUntil: null, idempotencyKey: key() },
      NOW,
    );
    row = (await readAvailability([item])).get(item);
    expect(row?.status).toBe("sold_out");
    expect(row?.source).toBe("staff");
  });

  it("[legend-5zkp] OPS-04 equipment without linked items writes nothing", async () => {
    const unrelatedItem = await seedMenuItem();
    const equipmentId = await seedEquipment({
      status: "broken",
      linked: [],
    });

    const changed = await withTenant(db, context, (tx) =>
      syncEquipmentAvailability(
        tx,
        context,
        actorUserId,
        equipmentRow(equipmentId, "broken", []),
        "operational",
        NOW,
      ),
    );
    expect(changed).toEqual([]);
    expect(await readItemEvents([unrelatedItem])).toHaveLength(0);
    const equipment = await readEquipment(equipmentId);
    expect(equipment.disabled_item_ids).toEqual([]);
    const availability = await readAvailability([unrelatedItem]);
    expect(availability.size).toBe(0);
  });
});
