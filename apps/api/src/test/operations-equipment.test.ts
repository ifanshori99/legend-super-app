// Equipment registry, maintenance and shift-handover HTTP API (PRD v1.7 §3
// F41 "Peralatan & Perawatan", F45 "Operasional Harian"; bead legend-i57s;
// OPS-04, OPS-05; TEN-01..03). Runs the real Express app, Better Auth, the RBAC
// resolver and PostgreSQL against the seeded Cafe Legend tenant. Needs
// `operationsEquipmentRouter` mounted at /api/operations.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEquipment,
  createMaintenanceSchedule,
  createMaintenanceTicket,
  createShiftHandover,
  getEquipment,
  getMaintenanceTicket,
  getShiftHandover,
  listEquipment,
  listMaintenanceSchedules,
  listMaintenanceTickets,
  listShiftHandovers,
  postEquipmentTransition,
  postMaintenanceTicketTransition,
  postShiftHandoverAcknowledgement,
  updateEquipment,
} from "@starter/shared/operations";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const brand = cafeLegendPlatformFixtures.brand;
const [outletA, outletB] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const createdUsers: string[] = [];
const createdEquipmentIds: string[] = [];
const createdTicketIds: string[] = [];
const createdScheduleIds: string[] = [];
const createdHandoverIds: string[] = [];
const menuItemIds: string[] = [];
const createdMediaIds: string[] = [];
const menuCategoryId = randomUUID();
/** The ticket test's machine, read again by the isolation test. */
let ticketEquipmentId = "";

/** Idempotency keys are tenant-scoped; the prefix keeps cleanup targeted. */
const nextKey = () => `legend-i57s-${randomUUID()}`;

const equipmentPath = (id = "") =>
  `/api/operations/equipment${id ? `/${id}` : ""}`;
const ticketPath = (id = "") =>
  `/api/operations/maintenance-tickets${id ? `/${id}` : ""}`;
const handoverPath = (id = "") =>
  `/api/operations/shift-handovers${id ? `/${id}` : ""}`;

async function asTenant<T>(run: (client: PoolClient) => Promise<T>) {
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

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function ownerClient() {
  const result = await signedIn("Operations Owner");
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenant.id, result.userId],
  );
  return result;
}

/** A caller whose role only covers one outlet (TEN-03 cross-outlet checks). */
async function outletClient(outletId: string) {
  const result = await signedIn("Operations Outlet B");
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["outlet"]')`,
    [
      roleId,
      tenant.id,
      `Operations API test ${roleId.slice(0, 8)}`,
      JSON.stringify(["ops.equipment.maintain", "ops.handover.record"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenant.id, result.userId, roleId, outletId],
  );
  return result;
}

/**
 * A stored breakdown photo in one outlet of the tenant (core storage), as the
 * upload flow leaves it: uploaded by `actorUserId`, bound to a source kind and
 * not yet attached to a document (legend-mg2bz).
 */
async function storedMedia(
  actorUserId: string,
  options: {
    outletId?: string;
    sourceKind?: string;
    sourceId?: string | null;
    uploadedBy?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const sourceKind = options.sourceKind ?? "maintenance_ticket";
  await asTenant((client) =>
    client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          owner_user_id, uploaded_by, source_kind, source_id)
       VALUES ($1, $2, $3, 'receipt', $4, 'image/webp', 1024, $5, $6, $7, $8)`,
      [
        tenant.id,
        options.outletId ?? outletA.id,
        id,
        `legend-i57s/${id}.webp`,
        actorUserId,
        options.uploadedBy ?? actorUserId,
        sourceKind,
        options.sourceId ?? null,
      ],
    ),
  );
  createdMediaIds.push(id);
  return id;
}

async function mediaSourceId(mediaId: string) {
  const { rows } = await asTenant((client) =>
    client.query(
      "SELECT source_id::text AS source_id FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
      [tenant.id, mediaId],
    ),
  );
  return rows[0]?.source_id as string | null | undefined;
}

async function itemAvailabilityStatus(menuItemId: string) {
  const result = await asTenant((client) =>
    client.query(
      `SELECT status FROM item_availability
        WHERE tenant_id = $1 AND outlet_id = $2 AND menu_item_id = $3
          AND deleted_at IS NULL`,
      [tenant.id, outletA.id, menuItemId],
    ),
  );
  return result.rows[0]?.status as string | undefined;
}

beforeAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'OPS Uji legend-i57s', 0)`,
      [menuCategoryId, tenant.id, brand.id],
    );
    const itemId = randomUUID();
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active)
       VALUES ($1, $2, $3, $4, 'Es Kopi Susu Uji', true)`,
      [itemId, tenant.id, brand.id, menuCategoryId],
    );
    menuItemIds.push(itemId);
  });
});

afterAll(async () => {
  await asTenant(async (client) => {
    if (createdTicketIds.length > 0)
      await client.query(
        "DELETE FROM maintenance_tickets WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdTicketIds],
      );
    if (createdScheduleIds.length > 0)
      await client.query(
        "DELETE FROM maintenance_schedules WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdScheduleIds],
      );
    if (createdEquipmentIds.length > 0) {
      await client.query(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_type = 'equipment' AND aggregate_id = ANY($2::uuid[])",
        [tenant.id, createdEquipmentIds],
      );
      await client.query(
        "DELETE FROM equipment WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdEquipmentIds],
      );
    }
    if (createdHandoverIds.length > 0)
      await client.query(
        "DELETE FROM shift_handovers WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdHandoverIds],
      );
    if (createdMediaIds.length > 0)
      await client.query(
        "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdMediaIds],
      );
    await client.query(
      "DELETE FROM operations_idempotency WHERE tenant_id = $1 AND key LIKE 'legend-i57s-%'",
      [tenant.id],
    );
    if (menuItemIds.length > 0) {
      await client.query(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_type = 'item' AND event->'payload'->>'itemId' = ANY($2::text[])",
        [tenant.id, menuItemIds],
      );
      await client.query(
        "DELETE FROM item_availability WHERE tenant_id = $1 AND menu_item_id = ANY($2::uuid[])",
        [tenant.id, menuItemIds],
      );
      await client.query(
        "DELETE FROM menu_items WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, menuItemIds],
      );
    }
    await client.query(
      "DELETE FROM menu_categories WHERE tenant_id = $1 AND id = $2",
      [tenant.id, menuCategoryId],
    );
  });
  if (createdUsers.length > 0) {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      createdUsers,
    ]);
    await owner.query(
      "DELETE FROM roles WHERE name LIKE 'Operations API test %' AND tenant_id = $1",
      [tenant.id],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.end();
});

describe("Operations equipment API (legend-i57s)", () => {
  let equipmentId = "";
  let equipmentUpdatedAt = "";
  const menuItemId = () => menuItemIds[0];

  it("[legend-i57s][F41] creates equipment with linked menu items, replays the key and rejects unknown links", async () => {
    const { client } = await ownerClient();
    const body = {
      outletId: outletA.id,
      name: "Mesin Espresso Uji",
      category: "espresso_machine",
      linkedMenuItemIds: [menuItemId()],
      idempotencyKey: nextKey(),
    };
    const created = await client
      .post(equipmentPath())
      .set(originHeader)
      .send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    createEquipment.response.parse(created.body);
    equipmentId = created.body.data.id as string;
    equipmentUpdatedAt = created.body.data.updatedAt as string;
    createdEquipmentIds.push(equipmentId);
    expect(created.body.data.status).toBe("operational");
    expect(created.body.data.linkedMenuItemIds).toEqual([menuItemId()]);

    // The same key and body return the same document, not a second machine.
    const replay = await client
      .post(equipmentPath())
      .set(originHeader)
      .send(body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data.id).toBe(equipmentId);

    // A key cannot be reused for another payload.
    const reused = await client
      .post(equipmentPath())
      .set(originHeader)
      .send({ ...body, name: "Mesin Lain" });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    // OPS-04 mapping: an unknown/deleted menu item is refused, not stored.
    const invalidLink = await client
      .post(equipmentPath())
      .set(originHeader)
      .send({
        outletId: outletA.id,
        name: "Grinder Uji",
        category: "grinder",
        linkedMenuItemIds: [randomUUID()],
        idempotencyKey: nextKey(),
      });
    expect(invalidLink.status).toBe(422);
    expect(invalidLink.body.error.code).toBe("VALIDATION_ERROR");

    // TEN-02: the tenant never comes from the client.
    const tenantAttempt = await client
      .post(equipmentPath())
      .set(originHeader)
      .send({ ...body, idempotencyKey: nextKey(), tenantId: tenant.id });
    expect(tenantAttempt.status).toBe(422);

    // The read endpoint returns the contract shape.
    const read = await client.get(equipmentPath(equipmentId));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    getEquipment.response.parse(read.body);
    expect(read.body.data.id).toBe(equipmentId);
    expect(read.body.data.tenantId).toBe(tenant.id);
    expect(read.body.data.outletId).toBe(outletA.id);
    expect(read.body.data.name).toBe("Mesin Espresso Uji");
    expect(read.body.data.assetId).toBeNull();
    expect(read.body.data.temperatureThreshold).toBeNull();
  });

  it("[legend-i57s][F41] updates equipment and refuses a stale expectedUpdatedAt", async () => {
    const { client } = await ownerClient();
    const patched = await client
      .patch(equipmentPath(equipmentId))
      .set(originHeader)
      .send({
        name: "Mesin Espresso Utama",
        expectedUpdatedAt: equipmentUpdatedAt,
        idempotencyKey: nextKey(),
      });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    updateEquipment.response.parse(patched.body);
    expect(patched.body.data.name).toBe("Mesin Espresso Utama");
    equipmentUpdatedAt = patched.body.data.updatedAt as string;

    const stale = await client
      .patch(equipmentPath(equipmentId))
      .set(originHeader)
      .send({
        name: "Mesin Basi",
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
        idempotencyKey: nextKey(),
      });
    expect(stale.status).toBe(412);
    expect(stale.body.error.code).toBe("PRECONDITION_FAILED");
  });

  it("[legend-i57s][OPS-04] report_breakdown sells out the linked item and complete_maintenance restores it", async () => {
    const { client } = await ownerClient();
    const broken = await client
      .post(`${equipmentPath(equipmentId)}/transition`)
      .set(originHeader)
      .send({ action: "report_breakdown", idempotencyKey: nextKey() });
    expect(broken.status, JSON.stringify(broken.body)).toBe(200);
    postEquipmentTransition.response.parse(broken.body);
    expect(broken.body.data.status).toBe("broken");
    expect(await itemAvailabilityStatus(menuItemId())).toBe("sold_out");

    const maintenance = await client
      .post(`${equipmentPath(equipmentId)}/transition`)
      .set(originHeader)
      .send({ action: "start_maintenance", idempotencyKey: nextKey() });
    expect(maintenance.status, JSON.stringify(maintenance.body)).toBe(200);
    expect(maintenance.body.data.status).toBe("under_maintenance");
    // The machine is still out of service: starting the repair must not put
    // the item back on sale; only complete_maintenance does.
    expect(await itemAvailabilityStatus(menuItemId())).toBe("sold_out");

    const repaired = await client
      .post(`${equipmentPath(equipmentId)}/transition`)
      .set(originHeader)
      .send({ action: "complete_maintenance", idempotencyKey: nextKey() });
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
    expect(repaired.body.data.status).toBe("operational");
    expect(await itemAvailabilityStatus(menuItemId())).toBe("available");

    // A retired asset is terminal; the machine refuses the transition (409).
    const retired = await client
      .post(`${equipmentPath(equipmentId)}/transition`)
      .set(originHeader)
      .send({ action: "retire", idempotencyKey: nextKey() });
    expect(retired.status).toBe(200);
    const fromRetired = await client
      .post(`${equipmentPath(equipmentId)}/transition`)
      .set(originHeader)
      .send({ action: "report_breakdown", idempotencyKey: nextKey() });
    expect(fromRetired.status).toBe(409);
    expect(fromRetired.body.error.code).toBe("EQUIPMENT_TRANSITION_INVALID");
  });
});

/** A fresh menu item of the test brand, cleaned up in afterAll. */
async function createMenuItem(name: string) {
  const itemId = randomUUID();
  await asTenant((client) =>
    client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [itemId, tenant.id, brand.id, menuCategoryId, name],
    ),
  );
  menuItemIds.push(itemId);
  return itemId;
}

async function createMachine(
  client: ReturnType<typeof agent>,
  name: string,
  linkedMenuItemIds: string[],
) {
  const created = await client.post(equipmentPath()).set(originHeader).send({
    outletId: outletA.id,
    name,
    category: "other",
    linkedMenuItemIds,
    idempotencyKey: nextKey(),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  createdEquipmentIds.push(id);
  return id;
}

async function transition(
  client: ReturnType<typeof agent>,
  id: string,
  action: string,
) {
  const response = await client
    .post(`${equipmentPath(id)}/transition`)
    .set(originHeader)
    .send({ action, idempotencyKey: nextKey() });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response;
}

describe("Operations equipment OPS-04 restore rules (legend-i57s)", () => {
  it("[legend-i57s][OPS-04] a shared item stays sold out until the last broken machine is repaired", async () => {
    const { client } = await ownerClient();
    const shared = await createMenuItem("Latte Bersama Uji");
    const first = await createMachine(client, "Espresso Kiri Uji", [shared]);
    const second = await createMachine(client, "Espresso Kanan Uji", [shared]);

    await transition(client, first, "report_breakdown");
    expect(await itemAvailabilityStatus(shared)).toBe("sold_out");
    await transition(client, second, "report_breakdown");
    expect(await itemAvailabilityStatus(shared)).toBe("sold_out");

    // Repairing the first machine must not sell an item the second one,
    // still broken, cannot make.
    await transition(client, first, "start_maintenance");
    await transition(client, first, "complete_maintenance");
    expect(await itemAvailabilityStatus(shared)).toBe("sold_out");

    await transition(client, second, "start_maintenance");
    expect(await itemAvailabilityStatus(shared)).toBe("sold_out");
    await transition(client, second, "complete_maintenance");
    expect(await itemAvailabilityStatus(shared)).toBe("available");
  });

  it("[legend-i57s][OPS-04] a repair never lifts a manual 86", async () => {
    const { client } = await ownerClient();
    const manual = await createMenuItem("Croissant 86 Manual Uji");
    await asTenant((db) =>
      db.query(
        `INSERT INTO item_availability (tenant_id, outlet_id, menu_item_id, status)
         VALUES ($1, $2, $3, 'sold_out')`,
        [tenant.id, outletA.id, manual],
      ),
    );
    const oven = await createMachine(client, "Oven Uji", [manual]);
    await transition(client, oven, "report_breakdown");
    await transition(client, oven, "start_maintenance");
    await transition(client, oven, "complete_maintenance");
    expect(await itemAvailabilityStatus(manual)).toBe("sold_out");
  });

  it("[legend-i57s][OPS-04] a breakdown ticket follows the equipment machine (retired / planned maintenance -> 409)", async () => {
    const { client, userId } = await ownerClient();
    const item = await createMenuItem("Roti Bakar Uji");
    const toaster = await createMachine(client, "Pemanggang Uji", [item]);
    const photo = await storedMedia(userId);
    const ticketBody = () => ({
      outletId: outletA.id,
      equipmentId: toaster,
      urgency: "high",
      description: "Pemanggang tidak menyala.",
      mediaIds: [photo],
      marksEquipmentBroken: true,
      idempotencyKey: nextKey(),
    });

    await transition(client, toaster, "start_maintenance");
    const planned = await client
      .post(ticketPath())
      .set(originHeader)
      .send(ticketBody());
    expect(planned.status).toBe(409);
    expect(planned.body.error.code).toBe("EQUIPMENT_TRANSITION_INVALID");
    // Nothing was stored or sold out by the refused ticket.
    expect(await itemAvailabilityStatus(item)).toBeUndefined();

    await transition(client, toaster, "retire");
    const retired = await client
      .post(ticketPath())
      .set(originHeader)
      .send(ticketBody());
    expect(retired.status).toBe(409);
    expect(retired.body.error.code).toBe("EQUIPMENT_TRANSITION_INVALID");
  });

  it("[legend-i57s][OPS-04] an equipment transition writes an audit row", async () => {
    const { client } = await ownerClient();
    const machine = await createMachine(client, "Blender Audit Uji", []);
    await transition(client, machine, "report_breakdown");
    const audit = await asTenant((db) =>
      db.query(
        `SELECT event FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2
            AND event->>'action' = 'equipment.transitioned'`,
        [tenant.id, machine],
      ),
    );
    expect(audit.rowCount).toBe(1);
  });
});

describe("Operations maintenance API (legend-i57s)", () => {
  let ticketId = "";
  let equipmentId = "";
  let scheduleId = "";

  it("[legend-i57s][OPS-04] a breakdown ticket with marksEquipmentBroken breaks the asset and emits equipment.broken", async () => {
    const { client, userId } = await ownerClient();
    const machine = await client
      .post(equipmentPath())
      .set(originHeader)
      .send({
        outletId: outletA.id,
        name: "Mesin Espresso Tiket",
        category: "espresso_machine",
        linkedMenuItemIds: [menuItemIds[0]],
        idempotencyKey: nextKey(),
      });
    expect(machine.status, JSON.stringify(machine.body)).toBe(201);
    createEquipment.response.parse(machine.body);
    equipmentId = machine.body.data.id as string;
    ticketEquipmentId = equipmentId;
    createdEquipmentIds.push(equipmentId);

    const firstPhoto = await storedMedia(userId);
    const created = await client
      .post(ticketPath())
      .set(originHeader)
      .send({
        outletId: outletA.id,
        equipmentId,
        urgency: "critical",
        description: "Mesin mengeluarkan suara keras dan tidak memanas.",
        mediaIds: [firstPhoto],
        marksEquipmentBroken: true,
        idempotencyKey: nextKey(),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    createMaintenanceTicket.response.parse(created.body);
    ticketId = created.body.data.id as string;
    createdTicketIds.push(ticketId);
    // The photo is now attached to the ticket it documents (legend-mg2bz).
    expect(await mediaSourceId(firstPhoto)).toBe(ticketId);
    expect(created.body.data.status).toBe("reported");
    expect(created.body.data.marksEquipmentBroken).toBe(true);
    expect(created.body.data.reportedBy).toBe(userId);
    expect(created.body.data.resolvedAt).toBeNull();

    // OPS-04: the asset is broken and its mapped item is sold out.
    const asset = await client.get(equipmentPath(equipmentId));
    expect(asset.status, JSON.stringify(asset.body)).toBe(200);
    getEquipment.response.parse(asset.body);
    expect(asset.body.data.status).toBe("broken");
    expect(await itemAvailabilityStatus(menuItemIds[0])).toBe("sold_out");

    // The event tells consumers which item to disable without another read.
    const outbox = await asTenant((db) =>
      db.query(
        `SELECT event FROM domain_event_outbox
          WHERE tenant_id = $1 AND aggregate_type = 'equipment'
            AND aggregate_id = $2 AND event->>'name' = 'equipment.broken'
          ORDER BY sequence`,
        [tenant.id, equipmentId],
      ),
    );
    expect(outbox.rowCount).toBe(1);
    const event = outbox.rows[0].event as {
      payload: {
        equipmentId: string;
        ticketId: string;
        urgency: string;
        linkedMenuItemIds: string[];
        reportedAt: string;
      };
    };
    expect(event.payload.equipmentId).toBe(equipmentId);
    expect(event.payload.ticketId).toBe(ticketId);
    expect(event.payload.urgency).toBe("critical");
    expect(event.payload.linkedMenuItemIds).toEqual([menuItemIds[0]]);
    expect(Number.isNaN(Date.parse(event.payload.reportedAt))).toBe(false);

    const read = await client.get(ticketPath(ticketId));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    getMaintenanceTicket.response.parse(read.body);
    expect(read.body.data.id).toBe(ticketId);

    // start -> resolve records the cost; it does not repair the equipment.
    const started = await client
      .post(`${ticketPath(ticketId)}/transition`)
      .set(originHeader)
      .send({ action: "start", idempotencyKey: nextKey() });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    postMaintenanceTicketTransition.response.parse(started.body);
    expect(started.body.data.status).toBe("in_progress");

    const resolved = await client
      .post(`${ticketPath(ticketId)}/transition`)
      .set(originHeader)
      .send({
        action: "resolve",
        costIdr: 250_000,
        idempotencyKey: nextKey(),
      });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    postMaintenanceTicketTransition.response.parse(resolved.body);
    expect(resolved.body.data.status).toBe("resolved");
    expect(resolved.body.data.costIdr).toBe(250_000);
    expect(resolved.body.data.resolvedAt).not.toBeNull();

    // Resolving the ticket is not a repair: only the equipment transition is.
    const stillBroken = await client.get(equipmentPath(equipmentId));
    expect(stillBroken.body.data.status).toBe("broken");

    const reopened = await client
      .post(`${ticketPath(ticketId)}/transition`)
      .set(originHeader)
      .send({ action: "start", idempotencyKey: nextKey() });
    expect(reopened.status).toBe(409);
    expect(reopened.body.error.code).toBe("MAINTENANCE_TRANSITION_INVALID");
  });

  it("[legend-i57s][F41] a breakdown ticket requires at least one photo", async () => {
    const { client, userId } = await ownerClient();
    const noPhoto = await client.post(ticketPath()).set(originHeader).send({
      outletId: outletA.id,
      equipmentId,
      urgency: "high",
      description: "Layar panel mati total.",
      mediaIds: [],
      idempotencyKey: nextKey(),
    });
    expect(noPhoto.status).toBe(422);
    expect(noPhoto.body.error.code).toBe("VALIDATION_ERROR");

    const missingMedia = await client
      .post(ticketPath())
      .set(originHeader)
      .send({
        outletId: outletA.id,
        equipmentId,
        urgency: "high",
        description: "Layar panel mati total.",
        idempotencyKey: nextKey(),
      });
    expect(missingMedia.status).toBe(422);

    // A photo id must be an object stored for THIS tenant and outlet.
    for (const mediaId of [
      randomUUID(),
      await storedMedia(userId, { outletId: outletB.id }),
    ]) {
      const foreign = await client
        .post(ticketPath())
        .set(originHeader)
        .send({
          outletId: outletA.id,
          equipmentId,
          urgency: "high",
          description: "Layar panel mati total.",
          mediaIds: [mediaId],
          idempotencyKey: nextKey(),
        });
      expect(foreign.status, JSON.stringify(foreign.body)).toBe(422);
      expect(foreign.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  // Brief 796 (legend-mg2bz): ticket evidence must be the reporter's own
  // upload of source kind `maintenance_ticket`, stored in the ticket's outlet
  // and not attached to another document. Any failure is a generic 422
  // VALIDATION_ERROR and no ticket is stored.
  it("[legend-mg2bz][F41] a ticket rejects photos that are not the reporter's own, wrong-kind or already attached", async () => {
    const { client, userId } = await ownerClient();
    const colleague = await ownerClient();
    const otherDocument = randomUUID();
    const attachedElsewhere = await storedMedia(userId, {
      sourceId: otherDocument,
    });
    const rejected: Record<string, string> = {
      "a colleague's photo from the same outlet": await storedMedia(
        colleague.userId,
      ),
      "a photo of the wrong source kind": await storedMedia(userId, {
        sourceKind: "checklist_evidence",
      }),
      "a photo already attached to another document": attachedElsewhere,
    };
    const marker = `Bukti ditolak ${randomUUID()}`;
    for (const [label, mediaId] of Object.entries(rejected)) {
      const response = await client
        .post(ticketPath())
        .set(originHeader)
        .send({
          outletId: outletA.id,
          equipmentId,
          urgency: "high",
          description: marker,
          mediaIds: [mediaId],
          idempotencyKey: nextKey(),
        });
      expect(
        response.status,
        `${label}: ${JSON.stringify(response.body)}`,
      ).toBe(422);
      expect(response.body.error.code, label).toBe("VALIDATION_ERROR");
      // The refused file stays as it was: never attached to a ticket of ours.
      expect(await mediaSourceId(mediaId), label).toBe(
        mediaId === attachedElsewhere ? otherDocument : null,
      );
    }
    // One good photo next to a colleague's photo still refuses the whole ticket.
    const mixed = await client
      .post(ticketPath())
      .set(originHeader)
      .send({
        outletId: outletA.id,
        equipmentId,
        urgency: "high",
        description: marker,
        mediaIds: [
          await storedMedia(userId),
          rejected["a colleague's photo from the same outlet"],
        ],
        idempotencyKey: nextKey(),
      });
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(422);
    expect(mixed.body.error.code).toBe("VALIDATION_ERROR");

    const stored = await asTenant((db) =>
      db.query(
        "SELECT count(*)::int AS n FROM maintenance_tickets WHERE tenant_id = $1 AND description = $2",
        [tenant.id, marker],
      ),
    );
    expect(stored.rows[0].n).toBe(0);
  });

  it("[legend-mg2bz][F41] the reporter's own maintenance_ticket photo is accepted, attached to the ticket and not reusable", async () => {
    const { client, userId } = await ownerClient();
    const photo = await storedMedia(userId);
    expect(await mediaSourceId(photo)).toBeNull();
    const created = await client
      .post(ticketPath())
      .set(originHeader)
      .send({
        outletId: outletA.id,
        equipmentId,
        urgency: "medium",
        description: `Foto sendiri ${randomUUID()}`,
        mediaIds: [photo],
        idempotencyKey: nextKey(),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const newTicketId = created.body.data.id as string;
    createdTicketIds.push(newTicketId);
    expect(await mediaSourceId(photo)).toBe(newTicketId);

    // The same file cannot document a second ticket.
    const reused = await client
      .post(ticketPath())
      .set(originHeader)
      .send({
        outletId: outletA.id,
        equipmentId,
        urgency: "medium",
        description: `Foto dipakai ulang ${randomUUID()}`,
        mediaIds: [photo],
        idempotencyKey: nextKey(),
      });
    expect(reused.status, JSON.stringify(reused.body)).toBe(422);
    expect(reused.body.error.code).toBe("VALIDATION_ERROR");
    expect(await mediaSourceId(photo)).toBe(newTicketId);
  });

  it("[legend-i57s][F41] creates a maintenance schedule and lists it by equipment and due date", async () => {
    const { client } = await ownerClient();
    const created = await client
      .post("/api/operations/maintenance-schedules")
      .set(originHeader)
      .send({
        outletId: outletA.id,
        equipmentId,
        intervalDays: 30,
        nextDueAt: "2030-01-01T00:00:00.000Z",
        idempotencyKey: nextKey(),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    createMaintenanceSchedule.response.parse(created.body);
    scheduleId = created.body.data.id as string;
    createdScheduleIds.push(scheduleId);
    expect(created.body.data.intervalDays).toBe(30);
    expect(created.body.data.vendorId).toBeNull();

    const listed = await client.get(
      `/api/operations/maintenance-schedules?outletId=${outletA.id}&equipmentId=${equipmentId}&limit=100`,
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    listMaintenanceSchedules.response.parse(listed.body);
    expect(
      listed.body.data.some((row: { id: string }) => row.id === scheduleId),
    ).toBe(true);

    const early = await client.get(
      `/api/operations/maintenance-schedules?outletId=${outletA.id}&dueBefore=2029-12-31T23:59:59.000Z`,
    );
    expect(early.status, JSON.stringify(early.body)).toBe(200);
    listMaintenanceSchedules.response.parse(early.body);
    expect(
      early.body.data.some((row: { id: string }) => row.id === scheduleId),
    ).toBe(false);

    const equipment = await client.get(
      `${equipmentPath()}?outletId=${outletA.id}&category=espresso_machine&limit=100`,
    );
    expect(equipment.status, JSON.stringify(equipment.body)).toBe(200);
    listEquipment.response.parse(equipment.body);
    expect(
      equipment.body.data.some((row: { id: string }) => row.id === equipmentId),
    ).toBe(true);

    const tickets = await client.get(
      `${ticketPath()}?outletId=${outletA.id}&status=resolved&limit=100`,
    );
    expect(tickets.status, JSON.stringify(tickets.body)).toBe(200);
    listMaintenanceTickets.response.parse(tickets.body);
    expect(
      tickets.body.data.some((row: { id: string }) => row.id === ticketId),
    ).toBe(true);
  });
});

describe("Operations shift handover API (legend-i57s)", () => {
  const handoverBody = () => ({
    outletId: outletA.id,
    fromShiftTemplateId: randomUUID(),
    toShiftTemplateId: randomUUID(),
    notes: {
      cash: "Kas akhir shift Rp 1.250.000.",
      criticalStock: null,
      openComplaints: null,
      equipmentIssues: "Mesin espresso rusak; tiket perawatan sudah dibuat.",
      specialNotes: null,
    },
    idempotencyKey: nextKey(),
  });

  it("[legend-i57s][OPS-05] a handover cannot close before the receiving shift confirms it", async () => {
    const submitter = await ownerClient();
    const receiver = await ownerClient();
    const created = await submitter.client
      .post(handoverPath())
      .set(originHeader)
      .send(handoverBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    createShiftHandover.response.parse(created.body);
    const handoverId = created.body.data.id as string;
    createdHandoverIds.push(handoverId);
    expect(created.body.data.status).toBe("submitted");
    expect(created.body.data.submittedBy).toBe(submitter.userId);
    expect(created.body.data.acknowledgedBy).toBeNull();

    // OPS-05: the submitting shift cannot acknowledge its own handover.
    const self = await submitter.client
      .post(`${handoverPath(handoverId)}/acknowledge`)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("HANDOVER_SELF_ACKNOWLEDGEMENT");

    const acknowledged = await receiver.client
      .post(`${handoverPath(handoverId)}/acknowledge`)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
    postShiftHandoverAcknowledgement.response.parse(acknowledged.body);
    expect(acknowledged.body.data.status).toBe("acknowledged");
    expect(acknowledged.body.data.acknowledgedBy).toBe(receiver.userId);
    expect(acknowledged.body.data.acknowledgedAt).not.toBeNull();

    const again = await receiver.client
      .post(`${handoverPath(handoverId)}/acknowledge`)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("HANDOVER_ALREADY_ACKNOWLEDGED");

    const read = await receiver.client.get(handoverPath(handoverId));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    getShiftHandover.response.parse(read.body);
    expect(read.body.data.id).toBe(handoverId);

    const listed = await receiver.client.get(
      `${handoverPath()}?outletId=${outletA.id}&status=acknowledged&limit=100`,
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    listShiftHandovers.response.parse(listed.body);
    expect(
      listed.body.data.some((row: { id: string }) => row.id === handoverId),
    ).toBe(true);
  });

  it("[legend-7j4e][OPS-05] close refuses an unconfirmed handover without changing its state", async () => {
    const submitter = await ownerClient();
    const created = await submitter.client
      .post(handoverPath())
      .set(originHeader)
      .send(handoverBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const handoverId = created.body.data.id as string;
    createdHandoverIds.push(handoverId);

    const closed = await submitter.client
      .post(`${handoverPath(handoverId)}/close`)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(closed.status, JSON.stringify(closed.body)).toBe(422);
    expect(closed.body.error.code).toBe("HANDOVER_ACKNOWLEDGEMENT_REQUIRED");

    const read = await submitter.client.get(handoverPath(handoverId));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.status).toBe("submitted");
    expect(read.body.data.acknowledgedAt).toBeNull();
    expect(read.body.data.closedAt).toBeNull();
    expect(read.body.data.closedBy).toBeNull();
  });

  it("[legend-7j4e][OPS-05] close persists its actor and time and replays the same key once", async () => {
    const submitter = await ownerClient();
    const receiver = await ownerClient();
    const created = await submitter.client
      .post(handoverPath())
      .set(originHeader)
      .send(handoverBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const handoverId = created.body.data.id as string;
    createdHandoverIds.push(handoverId);

    const acknowledgeKey = nextKey();
    const acknowledged = await receiver.client
      .post(`${handoverPath(handoverId)}/acknowledge`)
      .set(originHeader)
      .send({ idempotencyKey: acknowledgeKey });
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);

    const reused = await receiver.client
      .post(`${handoverPath(handoverId)}/close`)
      .set(originHeader)
      .send({ idempotencyKey: acknowledgeKey });
    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const beforeClose = await receiver.client.get(handoverPath(handoverId));
    expect(beforeClose.status, JSON.stringify(beforeClose.body)).toBe(200);
    expect(beforeClose.body.data.status).toBe("acknowledged");
    expect(beforeClose.body.data.closedAt).toBeNull();
    expect(beforeClose.body.data.closedBy).toBeNull();

    const closeKey = nextKey();
    const close = () =>
      receiver.client
        .post(`${handoverPath(handoverId)}/close`)
        .set(originHeader)
        .send({ idempotencyKey: closeKey });
    const closed = await close();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    getShiftHandover.response.parse(closed.body);
    expect(closed.body.data.status).toBe("closed");
    expect(closed.body.data.closedBy).toBe(receiver.userId);
    expect(Number.isFinite(Date.parse(closed.body.data.closedAt))).toBe(true);
    expect(closed.body.data.acknowledgedBy).toBe(receiver.userId);
    expect(closed.body.data.acknowledgedAt).toBe(
      acknowledged.body.data.acknowledgedAt,
    );

    const replay = await close();
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data).toEqual(closed.body.data);
    const audit = await asTenant((client) =>
      client.query(
        `SELECT event FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2
            AND event->>'action' = 'shift_handover.closed'`,
        [tenant.id, handoverId],
      ),
    );
    expect(audit.rowCount).toBe(1);

    const repeat = await receiver.client
      .post(`${handoverPath(handoverId)}/close`)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(repeat.status, JSON.stringify(repeat.body)).toBe(409);
    expect(repeat.body.error.code).toBe("HANDOVER_ALREADY_CLOSED");
    const acknowledgeClosed = await receiver.client
      .post(`${handoverPath(handoverId)}/acknowledge`)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(
      acknowledgeClosed.status,
      JSON.stringify(acknowledgeClosed.body),
    ).toBe(409);
    expect(acknowledgeClosed.body.error.code).toBe(
      "HANDOVER_ALREADY_ACKNOWLEDGED",
    );
    for (const injected of [
      { status: "submitted" },
      { closedBy: submitter.userId },
      { closedAt: "2030-01-15T03:00:00.000Z" },
    ]) {
      const invalid = await receiver.client
        .post(`${handoverPath(handoverId)}/close`)
        .set(originHeader)
        .send({ idempotencyKey: nextKey(), ...injected });
      expect(invalid.status, JSON.stringify(invalid.body)).toBe(422);
    }
    for (const missing of [
      { closedBy: null },
      { closedAt: null },
      { acknowledgedBy: null },
      { acknowledgedAt: null },
    ])
      expect(
        getShiftHandover.response.safeParse({
          data: { ...closed.body.data, ...missing },
        }).success,
      ).toBe(false);

    const read = await receiver.client.get(handoverPath(handoverId));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data).toEqual(closed.body.data);
    const listed = await receiver.client.get(
      `${handoverPath()}?outletId=${outletA.id}&status=closed&limit=100`,
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    listShiftHandovers.response.parse(listed.body);
    expect(
      listed.body.data.some((row: { id: string }) => row.id === handoverId),
    ).toBe(true);
  });

  it("[legend-7j4e][TEN-03] close hides another outlet and requires a trusted signed-in caller", async () => {
    const submitter = await ownerClient();
    const receiver = await ownerClient();
    const created = await submitter.client
      .post(handoverPath())
      .set(originHeader)
      .send(handoverBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const handoverId = created.body.data.id as string;
    createdHandoverIds.push(handoverId);
    const closePath = `${handoverPath(handoverId)}/close`;

    const acknowledged = await receiver.client
      .post(`${handoverPath(handoverId)}/acknowledge`)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);

    const outsider = await outletClient(outletB.id);
    const outOfScope = await outsider.client
      .post(closePath)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(outOfScope.status, JSON.stringify(outOfScope.body)).toBe(404);
    expect(outOfScope.body.error.code).toBe("NOT_FOUND");
    const anonymous = await agent(app)
      .post(closePath)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(anonymous.status, JSON.stringify(anonymous.body)).toBe(401);
    const untrusted = await receiver.client
      .post(closePath)
      .set("Origin", "https://evil.example")
      .send({ idempotencyKey: nextKey() });
    expect(untrusted.status, JSON.stringify(untrusted.body)).toBe(403);

    const read = await receiver.client.get(handoverPath(handoverId));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.status).toBe("acknowledged");
    expect(read.body.data.closedAt).toBeNull();
  });
});

describe("Operations equipment API isolation (legend-i57s)", () => {
  it("[legend-i57s][TEN-01][TEN-03] hides another outlet's rows and refuses an untrusted origin", async () => {
    const anonymous = agent(app);
    expect(
      (await anonymous.get(`${equipmentPath()}?outletId=${outletA.id}`)).status,
    ).toBe(401);

    const outsider = await outletClient(outletB.id);
    // RLS hides the outlet A row from an outlet B caller: identical 404.
    const read = await outsider.client.get(equipmentPath(ticketEquipmentId));
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe("NOT_FOUND");

    const list = await outsider.client.get(
      `${equipmentPath()}?outletId=${outletA.id}`,
    );
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe("OUTLET_OUT_OF_SCOPE");

    const ownerCaller = await ownerClient();
    const untrusted = await ownerCaller.client
      .post(equipmentPath())
      .set("Origin", "https://evil.example")
      .send({
        outletId: outletA.id,
        name: "Mesin Ilegal",
        category: "other",
        idempotencyKey: nextKey(),
      });
    expect(untrusted.status).toBe(403);
  });
});
