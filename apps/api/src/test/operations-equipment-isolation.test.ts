// Isolation and permission checks for equipment, maintenance schedules,
// maintenance tickets and shift handovers (PRD v1.7 §3 F41 / F45, OPS-04,
// OPS-05, TEN-01..03; bead legend-o032 WS-14 piece C). Black-box: the real
// Express app, Better Auth, the RBAC resolver and PostgreSQL. Database reads
// only verify what the API did (state unchanged / column filled).
//
// Assumptions (spec silent on the exact status):
// - A row addressed by id that the caller cannot see (other tenant, other
//   outlet) answers 404, the same as "does not exist" (precedent in
//   operations-equipment.test.ts).
// - A list or create that NAMES an outlet outside the caller's scope answers
//   403 OUTLET_OUT_OF_SCOPE for an outlet-scoped caller. For a caller of
//   another tenant the outlet is unknown, so any of 403/404/422 (or an empty
//   list) is accepted; what matters is that nothing leaks or is written.
// - A caller without `ops.equipment.maintain` / `ops.handover.record` gets 403
//   on every mutation of that area.
// - A handover has no separate "close" call: it stays `submitted` until the
//   receiving shift acknowledges it, and `acknowledged` is its closed state.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

type Client = ReturnType<typeof agent>;

const ROLE_PREFIX = "Operations isolation test ";
const KEY_PREFIX = "legend-o032-";
const nextKey = () => `${KEY_PREFIX}${randomUUID()}`;

const equipmentPath = (id = "") =>
  `/api/operations/equipment${id ? `/${id}` : ""}`;
const schedulePath = () => "/api/operations/maintenance-schedules";
const ticketPath = (id = "") =>
  `/api/operations/maintenance-tickets${id ? `/${id}` : ""}`;
const handoverPath = (id = "") =>
  `/api/operations/shift-handovers${id ? `/${id}` : ""}`;

const createdUsers: string[] = [];
const createdEquipmentIds: string[] = [];
const createdTicketIds: string[] = [];
const createdScheduleIds: string[] = [];
const createdHandoverIds: string[] = [];
const createdMediaIds: string[] = [];
const menuItemIds: string[] = [];
const menuCategoryId = randomUUID();

// A private second tenant (TEN-01). Its equipment is seeded directly so that
// no audit or outbox row is ever written for it.
const tenantB = {
  id: randomUUID(),
  brandId: randomUUID(),
  entityId: randomUUID(),
  outletId: randomUUID(),
  equipmentId: randomUUID(),
  domainId: randomUUID(),
  // The API resolves the tenant from the request host (TEN-02), never from the
  // client, so tenant B's caller reaches it through its own verified domain.
  hostname: `iso-b-${randomUUID().slice(0, 8)}.contoh.example`,
};

async function asTenantId<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
) {
  const client = await owner.connect();
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
const asTenant = <T>(run: (client: PoolClient) => Promise<T>) =>
  asTenantId(tenant.id, run);

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function createRole(
  tenantId: string,
  permissions: string[],
  scopeTypes: string[],
) {
  const roleId = randomUUID();
  await asTenantId(tenantId, (client) =>
    client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `${ROLE_PREFIX}${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(scopeTypes),
      ],
    ),
  );
  return roleId;
}

async function assign(
  tenantId: string,
  userId: string,
  roleId: string,
  outletId?: string,
) {
  await asTenantId(tenantId, (client) =>
    client.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenantId,
        userId,
        roleId,
        outletId ? "outlet" : "tenant",
        outletId ?? null,
      ],
    ),
  );
}

/** Tenant-wide owner of the seeded tenant (holds every permission). */
async function ownerClient() {
  const result = await signedIn("Isolation Owner");
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenant.id, result.userId],
  );
  return result;
}

/** Tenant-wide caller of the seeded tenant holding only the given codes. */
async function limitedClient(permissions: string[]) {
  const result = await signedIn("Isolation Limited");
  await assign(
    tenant.id,
    result.userId,
    await createRole(tenant.id, permissions, ["tenant", "outlet"]),
  );
  return result;
}

/** Caller of the seeded tenant whose role only covers one outlet (TEN-03). */
async function outletClient(outletId: string) {
  const result = await signedIn("Isolation Outlet");
  await assign(
    tenant.id,
    result.userId,
    await createRole(
      tenant.id,
      ["ops.equipment.maintain", "ops.handover.record"],
      ["outlet"],
    ),
    outletId,
  );
  return result;
}

/** Caller of the private second tenant, with full operations permissions. */
async function tenantBClient() {
  const signed = await signedIn("Isolation Tenant B");
  const result = {
    userId: signed.userId,
    client: new Proxy(signed.client, {
      get(target, property, receiver) {
        if (
          property === "get" ||
          property === "post" ||
          property === "patch" ||
          property === "put" ||
          property === "delete"
        )
          return (...args: [string]) =>
            target[property](...args).set("Host", tenantB.hostname);
        return Reflect.get(target, property, receiver);
      },
    }) as Client,
  };
  await assign(
    tenantB.id,
    result.userId,
    await createRole(
      tenantB.id,
      ["ops.equipment.maintain", "ops.handover.record"],
      ["tenant", "outlet"],
    ),
  );
  return result;
}

/**
 * A stored breakdown photo as the upload flow leaves it: uploaded by the acting
 * user, source kind `maintenance_ticket`, not yet attached (legend-mg2bz). A
 * ticket consumes its photos, so each ticket needs its own.
 */
async function storedMedia(
  actorUserId: string,
  outletId: string = outletA.id,
  sourceKind: string = "maintenance_ticket",
): Promise<string> {
  const id = randomUUID();
  await asTenant((client) =>
    client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          owner_user_id, uploaded_by, source_kind)
       VALUES ($1, $2, $3, 'receipt', $4, 'image/webp', 1024, $5, $5, $6)`,
      [
        tenant.id,
        outletId,
        id,
        `legend-o032/${id}.webp`,
        actorUserId,
        sourceKind,
      ],
    ),
  );
  createdMediaIds.push(id);
  return id;
}

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

async function availabilityStatus(menuItemId: string) {
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

async function equipmentRow(id: string) {
  const { rows } = await asTenant((client) =>
    client.query(
      `SELECT name, status, disabled_item_ids, linked_menu_item_ids
         FROM equipment WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, id],
    ),
  );
  return rows[0] as
    | {
        name: string;
        status: string;
        disabled_item_ids: string[];
        linked_menu_item_ids: string[];
      }
    | undefined;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await asTenant((client) => client.query(sql, params));
  return Number(rows[0].n);
}

async function postEquipment(
  client: Client,
  body: Record<string, unknown>,
  track = true,
) {
  const response = await client
    .post(equipmentPath())
    .set(originHeader)
    .send({
      category: "other",
      linkedMenuItemIds: [],
      idempotencyKey: nextKey(),
      ...body,
    });
  if (track && response.status === 201)
    createdEquipmentIds.push(response.body.data.id as string);
  return response;
}

async function machine(
  client: Client,
  name: string,
  linkedMenuItemIds: string[],
  outletId: string = outletA.id,
) {
  const created = await postEquipment(client, {
    outletId,
    name,
    linkedMenuItemIds,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data as { id: string; updatedAt: string };
}

async function transition(client: Client, id: string, action: string) {
  const response = await client
    .post(`${equipmentPath(id)}/transition`)
    .set(originHeader)
    .send({ action, idempotencyKey: nextKey() });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response;
}

const handoverBody = (marker: string, outletId: string = outletA.id) => ({
  outletId,
  fromShiftTemplateId: randomUUID(),
  toShiftTemplateId: randomUUID(),
  notes: {
    cash: null,
    criticalStock: null,
    openComplaints: null,
    equipmentIssues: null,
    specialNotes: marker,
  },
  idempotencyKey: nextKey(),
});

const ticketBody = (
  equipmentId: string,
  mediaId: string,
  extra: Record<string, unknown> = {},
) => ({
  outletId: outletA.id,
  equipmentId,
  urgency: "high",
  description: `Rusak ${randomUUID()}`,
  mediaIds: [mediaId],
  idempotencyKey: nextKey(),
  ...extra,
});

/** Rows of tenant A that every isolation test attacks. */
const fx = {
  itemId: "",
  machineId: "",
  machineName: "",
  machineUpdatedAt: "",
  ticketId: "",
  scheduleId: "",
  handoverId: "",
  handoverSubmitter: "",
  mediaId: "",
  outletBMachineId: "",
};

/** The response of a request aimed at another tenant's data: either refused or
 * empty, never a row of that tenant and never a server error. */
function expectNoLeak(
  response: { status: number; body: unknown },
  forbiddenIds: string[],
) {
  expect([200, 403, 404, 422], JSON.stringify(response.body)).toContain(
    response.status,
  );
  const text = JSON.stringify(response.body);
  for (const id of forbiddenIds) expect(text).not.toContain(id);
}

beforeAll(async () => {
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Isolation Tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantB.id, `iso-b-${tenantB.id.slice(0, 8)}`, tenant.id],
  );
  await asTenantId(tenantB.id, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand B')`,
      [tenantB.brandId, tenantB.id],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Isolation B', false)`,
      [tenantB.entityId, tenantB.id],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'ISO-B1', 'Outlet Isolation B', 'Jl. Uji B', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [tenantB.outletId, tenantB.id, tenantB.brandId, tenantB.entityId],
    );
    await client.query(
      `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
       VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
      [tenantB.domainId, tenantB.id, tenantB.brandId, tenantB.hostname],
    );
    await client.query(
      `INSERT INTO equipment (id, tenant_id, outlet_id, name, category)
       VALUES ($1, $2, $3, 'Mesin Tenant B', 'other')`,
      [tenantB.equipmentId, tenantB.id, tenantB.outletId],
    );
  });

  await asTenant((client) =>
    client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'OPS Uji legend-o032', 0)`,
      [menuCategoryId, tenant.id, brand.id],
    ),
  );

  // Tenant A rows that the attackers aim at.
  const { client, userId: ticketReporter } = await ownerClient();
  fx.itemId = await createMenuItem("Es Kopi Isolasi Uji");
  fx.machineName = `Mesin Isolasi ${randomUUID().slice(0, 8)}`;
  const created = await machine(client, fx.machineName, [fx.itemId]);
  fx.machineId = created.id;
  fx.machineUpdatedAt = created.updatedAt;
  fx.outletBMachineId = (
    await machine(client, "Mesin Outlet B Uji", [], outletB.id)
  ).id;
  fx.mediaId = await storedMedia(ticketReporter);

  const ticket = await client
    .post(ticketPath())
    .set(originHeader)
    .send(ticketBody(fx.machineId, fx.mediaId));
  expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
  fx.ticketId = ticket.body.data.id as string;
  createdTicketIds.push(fx.ticketId);

  const schedule = await client.post(schedulePath()).set(originHeader).send({
    outletId: outletA.id,
    equipmentId: fx.machineId,
    intervalDays: 30,
    nextDueAt: "2031-01-01T00:00:00.000Z",
    idempotencyKey: nextKey(),
  });
  expect(schedule.status, JSON.stringify(schedule.body)).toBe(201);
  fx.scheduleId = schedule.body.data.id as string;
  createdScheduleIds.push(fx.scheduleId);

  const submitter = await ownerClient();
  fx.handoverSubmitter = submitter.userId;
  const handover = await submitter.client
    .post(handoverPath())
    .set(originHeader)
    .send(handoverBody("isolation-fixture"));
  expect(handover.status, JSON.stringify(handover.body)).toBe(201);
  fx.handoverId = handover.body.data.id as string;
  createdHandoverIds.push(fx.handoverId);
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
      "DELETE FROM operations_idempotency WHERE tenant_id = $1 AND key LIKE $2",
      [tenant.id, `${KEY_PREFIX}%`],
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

  await asTenantId(tenantB.id, async (client) => {
    await client.query("DELETE FROM tenant_domains WHERE tenant_id = $1", [
      tenantB.id,
    ]);
    await client.query("DELETE FROM equipment WHERE tenant_id = $1", [
      tenantB.id,
    ]);
    await client.query(
      "DELETE FROM operations_idempotency WHERE tenant_id = $1",
      [tenantB.id],
    );
    await client.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      tenantB.id,
    ]);
    await client.query("DELETE FROM roles WHERE tenant_id = $1", [tenantB.id]);
    await client.query("DELETE FROM outlets WHERE tenant_id = $1", [
      tenantB.id,
    ]);
    await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
      tenantB.id,
    ]);
    await client.query("DELETE FROM brands WHERE tenant_id = $1", [tenantB.id]);
  });
  if (createdUsers.length > 0) {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      createdUsers,
    ]);
    await owner.query(
      "DELETE FROM roles WHERE name LIKE $1 AND tenant_id = $2",
      [`${ROLE_PREFIX}%`, tenant.id],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB.id]);
  await owner.end();
});

describe("Cross-tenant isolation (legend-o032, TEN-01)", () => {
  it("[legend-o032][TEN-01] another tenant's caller cannot read tenant A's equipment, tickets, schedules or handovers", async () => {
    const { client } = await tenantBClient();

    // Control: the caller does see its own tenant's equipment.
    const own = await client.get(equipmentPath(tenantB.equipmentId));
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data.name).toBe("Mesin Tenant B");

    // By id: indistinguishable from "does not exist".
    for (const path of [
      equipmentPath(fx.machineId),
      ticketPath(fx.ticketId),
      handoverPath(fx.handoverId),
    ]) {
      const response = await client.get(path);
      expect(response.status, path).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    }

    // By list: naming tenant A's outlet leaks nothing.
    const ids = [fx.machineId, fx.ticketId, fx.scheduleId, fx.handoverId];
    for (const path of [
      equipmentPath(),
      schedulePath(),
      ticketPath(),
      handoverPath(),
    ])
      expectNoLeak(await client.get(`${path}?outletId=${outletA.id}`), ids);

    // Its own outlet's list holds only its own equipment.
    const ownList = await client.get(
      `${equipmentPath()}?outletId=${tenantB.outletId}&limit=100`,
    );
    expect(ownList.status, JSON.stringify(ownList.body)).toBe(200);
    expect(ownList.body.data.map((row: { id: string }) => row.id)).toEqual([
      tenantB.equipmentId,
    ]);
  });

  it("[legend-o032][TEN-01] another tenant's caller cannot change tenant A's rows, and nothing is written to tenant A", async () => {
    const { client } = await tenantBClient();
    const before = await equipmentRow(fx.machineId);
    const marker = `lintas-tenant-${randomUUID()}`;

    const patched = await client
      .patch(equipmentPath(fx.machineId))
      .set(originHeader)
      .send({
        name: marker,
        expectedUpdatedAt: fx.machineUpdatedAt,
        idempotencyKey: nextKey(),
      });
    expect(patched.status).toBe(404);

    const transitions = [
      await client
        .post(`${equipmentPath(fx.machineId)}/transition`)
        .set(originHeader)
        .send({ action: "report_breakdown", idempotencyKey: nextKey() }),
      await client
        .post(`${ticketPath(fx.ticketId)}/transition`)
        .set(originHeader)
        .send({ action: "start", idempotencyKey: nextKey() }),
      await client
        .post(`${handoverPath(fx.handoverId)}/acknowledge`)
        .set(originHeader)
        .send({ idempotencyKey: nextKey() }),
    ];
    for (const response of transitions) expect(response.status).toBe(404);

    // Creating rows that point into tenant A's outlet is refused.
    const created = [
      await postEquipment(
        client,
        { outletId: outletA.id, name: marker },
        false,
      ),
      await client.post(schedulePath()).set(originHeader).send({
        outletId: outletA.id,
        equipmentId: fx.machineId,
        intervalDays: 7,
        nextDueAt: "2031-06-01T00:00:00.000Z",
        idempotencyKey: nextKey(),
      }),
      await client
        .post(ticketPath())
        .set(originHeader)
        .send(ticketBody(fx.machineId, fx.mediaId, { description: marker })),
      await client
        .post(handoverPath())
        .set(originHeader)
        .send(handoverBody(marker)),
    ];
    for (const response of created) {
      expect([403, 404, 422], JSON.stringify(response.body)).toContain(
        response.status,
      );
    }

    // Tenant A's rows are exactly as they were.
    expect(await equipmentRow(fx.machineId)).toEqual(before);
    expect(
      await count(
        "SELECT count(*) AS n FROM equipment WHERE tenant_id = $1 AND name = $2",
        [tenant.id, marker],
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM maintenance_schedules WHERE tenant_id = $1 AND equipment_id = $2",
        [tenant.id, fx.machineId],
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM maintenance_tickets WHERE tenant_id = $1 AND (description = $2 OR (id = $3 AND status <> 'reported'))",
        [tenant.id, marker, fx.ticketId],
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM shift_handovers WHERE tenant_id = $1 AND (notes->>'specialNotes' = $2 OR (id = $3 AND status <> 'submitted'))",
        [tenant.id, marker, fx.handoverId],
      ),
    ).toBe(0);
  });
});

describe("Outlet scope (legend-o032, TEN-03)", () => {
  it("[legend-o032][TEN-03] a caller scoped to outlet B does not see outlet A's rows and can still use outlet B", async () => {
    const { client } = await outletClient(outletB.id);

    for (const path of [
      equipmentPath(fx.machineId),
      ticketPath(fx.ticketId),
      handoverPath(fx.handoverId),
    ]) {
      const response = await client.get(path);
      expect(response.status, path).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    }
    for (const path of [
      equipmentPath(),
      schedulePath(),
      ticketPath(),
      handoverPath(),
    ]) {
      const response = await client.get(`${path}?outletId=${outletA.id}`);
      expect(response.status, path).toBe(403);
      expect(response.body.error.code).toBe("OUTLET_OUT_OF_SCOPE");
    }

    // Control: its own outlet works and lists only outlet B rows.
    const own = await client.get(equipmentPath(fx.outletBMachineId));
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const list = await client.get(
      `${equipmentPath()}?outletId=${outletB.id}&limit=100`,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const listed = list.body.data as { id: string; outletId: string }[];
    expect(listed.some((row) => row.id === fx.outletBMachineId)).toBe(true);
    expect(listed.every((row) => row.outletId === outletB.id)).toBe(true);
    expect(listed.some((row) => row.id === fx.machineId)).toBe(false);

    const handover = await client
      .post(handoverPath())
      .set(originHeader)
      .send(handoverBody(`outlet-b-${randomUUID()}`, outletB.id));
    expect(handover.status, JSON.stringify(handover.body)).toBe(201);
    createdHandoverIds.push(handover.body.data.id as string);
  });

  it("[legend-o032][TEN-03] a caller scoped to outlet B cannot change or create anything in outlet A", async () => {
    const { client } = await outletClient(outletB.id);
    const before = await equipmentRow(fx.machineId);
    const marker = `lintas-outlet-${randomUUID()}`;

    const patched = await client
      .patch(equipmentPath(fx.machineId))
      .set(originHeader)
      .send({
        name: marker,
        expectedUpdatedAt: fx.machineUpdatedAt,
        idempotencyKey: nextKey(),
      });
    expect(patched.status).toBe(404);

    for (const path of [
      `${equipmentPath(fx.machineId)}/transition`,
      `${ticketPath(fx.ticketId)}/transition`,
    ]) {
      const response = await client
        .post(path)
        .set(originHeader)
        .send({
          action: path.includes("maintenance-tickets")
            ? "start"
            : "report_breakdown",
          idempotencyKey: nextKey(),
        });
      expect(response.status, path).toBe(404);
    }
    const acknowledged = await client
      .post(`${handoverPath(fx.handoverId)}/acknowledge`)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(acknowledged.status).toBe(404);

    const created = [
      await postEquipment(
        client,
        { outletId: outletA.id, name: marker },
        false,
      ),
      await client.post(schedulePath()).set(originHeader).send({
        outletId: outletA.id,
        equipmentId: fx.machineId,
        intervalDays: 7,
        nextDueAt: "2031-06-01T00:00:00.000Z",
        idempotencyKey: nextKey(),
      }),
      await client
        .post(ticketPath())
        .set(originHeader)
        .send(ticketBody(fx.machineId, fx.mediaId, { description: marker })),
      await client
        .post(handoverPath())
        .set(originHeader)
        .send(handoverBody(marker)),
    ];
    for (const response of created) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body.error.code).toBe("OUTLET_OUT_OF_SCOPE");
    }

    expect(await equipmentRow(fx.machineId)).toEqual(before);
    expect(
      await count(
        "SELECT count(*) AS n FROM equipment WHERE tenant_id = $1 AND name = $2",
        [tenant.id, marker],
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM maintenance_tickets WHERE tenant_id = $1 AND description = $2",
        [tenant.id, marker],
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM shift_handovers WHERE tenant_id = $1 AND notes->>'specialNotes' = $2",
        [tenant.id, marker],
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM maintenance_schedules WHERE tenant_id = $1 AND equipment_id = $2",
        [tenant.id, fx.machineId],
      ),
    ).toBe(1);
  });
});

describe("Permissions (legend-o032, F41, F45, OPS-05)", () => {
  it("[legend-o032][F41] without ops.equipment.maintain every equipment, schedule and ticket mutation is 403", async () => {
    // Holds the handover permission only.
    const { client } = await limitedClient(["ops.handover.record"]);
    const before = await equipmentRow(fx.machineId);
    const marker = `tanpa-izin-${randomUUID()}`;

    const responses = [
      await postEquipment(
        client,
        { outletId: outletA.id, name: marker },
        false,
      ),
      await client.patch(equipmentPath(fx.machineId)).set(originHeader).send({
        name: marker,
        expectedUpdatedAt: fx.machineUpdatedAt,
        idempotencyKey: nextKey(),
      }),
      await client
        .post(`${equipmentPath(fx.machineId)}/transition`)
        .set(originHeader)
        .send({ action: "report_breakdown", idempotencyKey: nextKey() }),
      await client.post(schedulePath()).set(originHeader).send({
        outletId: outletA.id,
        equipmentId: fx.machineId,
        intervalDays: 7,
        nextDueAt: "2031-06-01T00:00:00.000Z",
        idempotencyKey: nextKey(),
      }),
      await client
        .post(ticketPath())
        .set(originHeader)
        .send(
          ticketBody(fx.machineId, fx.mediaId, {
            description: marker,
            marksEquipmentBroken: true,
          }),
        ),
      await client
        .post(`${ticketPath(fx.ticketId)}/transition`)
        .set(originHeader)
        .send({ action: "start", idempotencyKey: nextKey() }),
    ];
    for (const response of responses)
      expect(response.status, JSON.stringify(response.body)).toBe(403);

    expect(await equipmentRow(fx.machineId)).toEqual(before);
    expect(
      await count(
        "SELECT count(*) AS n FROM equipment WHERE tenant_id = $1 AND name = $2",
        [tenant.id, marker],
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM maintenance_tickets WHERE tenant_id = $1 AND (description = $2 OR (id = $3 AND status <> 'reported'))",
        [tenant.id, marker, fx.ticketId],
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM maintenance_schedules WHERE tenant_id = $1 AND equipment_id = $2",
        [tenant.id, fx.machineId],
      ),
    ).toBe(1);

    // Control: the same caller is not blocked by a blanket 403 on the handover
    // area it is allowed to use.
    const handover = await client
      .post(handoverPath())
      .set(originHeader)
      .send(handoverBody(`izin-ok-${randomUUID()}`));
    expect(handover.status, JSON.stringify(handover.body)).toBe(201);
    createdHandoverIds.push(handover.body.data.id as string);

    // And the maintain permission opens the equipment area.
    const maintainer = await limitedClient(["ops.equipment.maintain"]);
    const created = await postEquipment(maintainer.client, {
      outletId: outletA.id,
      name: `izin-ok-${randomUUID().slice(0, 8)}`,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });

  it("[legend-o032][OPS-05] without ops.handover.record creating or acknowledging a handover is 403", async () => {
    // Holds the equipment permission only.
    const { client } = await limitedClient(["ops.equipment.maintain"]);
    const marker = `tanpa-izin-${randomUUID()}`;

    const created = await client
      .post(handoverPath())
      .set(originHeader)
      .send(handoverBody(marker));
    expect(created.status, JSON.stringify(created.body)).toBe(403);

    const acknowledged = await client
      .post(`${handoverPath(fx.handoverId)}/acknowledge`)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(403);

    expect(
      await count(
        "SELECT count(*) AS n FROM shift_handovers WHERE tenant_id = $1 AND notes->>'specialNotes' = $2",
        [tenant.id, marker],
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM shift_handovers WHERE tenant_id = $1 AND id = $2 AND status = 'submitted' AND acknowledged_by IS NULL",
        [tenant.id, fx.handoverId],
      ),
    ).toBe(1);
  });

  it("[legend-o032][F41] an anonymous caller is refused on every mutation (401)", async () => {
    const anonymous = agent(app);
    for (const [path, body] of [
      [equipmentPath(), { name: "x" }],
      [`${equipmentPath(fx.machineId)}/transition`, { action: "retire" }],
      [schedulePath(), { intervalDays: 7 }],
      [ticketPath(), { description: "x" }],
      [`${handoverPath(fx.handoverId)}/acknowledge`, {}],
    ] as const) {
      const response = await anonymous
        .post(path)
        .set(originHeader)
        .send({ ...body, idempotencyKey: nextKey() });
      expect(response.status, path).toBe(401);
    }
  });
});

describe("Breakdown ticket and menu availability (legend-o032, OPS-04)", () => {
  it("[legend-o032][OPS-04] a breakdown ticket fills disabled_item_ids and sells out linked items; repair restores them but never a manual 86", async () => {
    const { client, userId } = await ownerClient();
    const automatic = await createMenuItem("Latte Isolasi Uji");
    const manual = await createMenuItem("Croissant 86 Isolasi Uji");
    await asTenant((db) =>
      db.query(
        `INSERT INTO item_availability (tenant_id, outlet_id, menu_item_id, status)
         VALUES ($1, $2, $3, 'sold_out')`,
        [tenant.id, outletA.id, manual],
      ),
    );
    const grinder = await machine(client, "Grinder Isolasi Uji", [
      automatic,
      manual,
    ]);

    // A ticket that does not mark the machine broken changes nothing.
    const note = await client
      .post(ticketPath())
      .set(originHeader)
      .send(
        ticketBody(grinder.id, await storedMedia(userId), {
          marksEquipmentBroken: false,
        }),
      );
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    createdTicketIds.push(note.body.data.id as string);
    expect((await equipmentRow(grinder.id))?.status).toBe("operational");
    expect((await equipmentRow(grinder.id))?.disabled_item_ids).toEqual([]);
    expect(await availabilityStatus(automatic)).toBeUndefined();

    // A ticket that marks it broken disables the linked items.
    const broken = await client
      .post(ticketPath())
      .set(originHeader)
      .send(
        ticketBody(grinder.id, await storedMedia(userId), {
          marksEquipmentBroken: true,
        }),
      );
    expect(broken.status, JSON.stringify(broken.body)).toBe(201);
    createdTicketIds.push(broken.body.data.id as string);

    const afterBreak = await equipmentRow(grinder.id);
    expect(afterBreak?.status).toBe("broken");
    // The manually 86'd item was not disabled by the machine, so it is not in
    // the column; the item the machine took offline is.
    expect(afterBreak?.disabled_item_ids).toEqual([automatic]);
    expect(await availabilityStatus(automatic)).toBe("sold_out");
    expect(await availabilityStatus(manual)).toBe("sold_out");

    // Resolving the ticket is not a repair.
    for (const action of ["start", "resolve"])
      expect(
        (
          await client
            .post(`${ticketPath(broken.body.data.id)}/transition`)
            .set(originHeader)
            .send({ action, idempotencyKey: nextKey() })
        ).status,
      ).toBe(200);
    expect((await equipmentRow(grinder.id))?.status).toBe("broken");
    expect(await availabilityStatus(automatic)).toBe("sold_out");

    // complete_maintenance restores what the machine disabled, only that.
    await transition(client, grinder.id, "start_maintenance");
    await transition(client, grinder.id, "complete_maintenance");
    const repaired = await equipmentRow(grinder.id);
    expect(repaired?.status).toBe("operational");
    expect(repaired?.disabled_item_ids).toEqual([]);
    expect(await availabilityStatus(automatic)).toBe("available");
    expect(await availabilityStatus(manual)).toBe("sold_out");
  });

  it("[legend-o032][OPS-04] an item linked to two broken machines returns only after the last repair", async () => {
    const { client, userId } = await ownerClient();
    const shared = await createMenuItem("Cappuccino Bersama Isolasi");
    const left = await machine(client, "Espresso Kiri Isolasi", [shared]);
    const right = await machine(client, "Espresso Kanan Isolasi", [shared]);

    for (const id of [left.id, right.id]) {
      const ticket = await client
        .post(ticketPath())
        .set(originHeader)
        .send(
          ticketBody(id, await storedMedia(userId), {
            marksEquipmentBroken: true,
          }),
        );
      expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
      createdTicketIds.push(ticket.body.data.id as string);
    }
    expect(await availabilityStatus(shared)).toBe("sold_out");

    await transition(client, left.id, "start_maintenance");
    await transition(client, left.id, "complete_maintenance");
    expect((await equipmentRow(left.id))?.disabled_item_ids).toEqual([]);
    // The right machine is still broken, so the item stays off the menu.
    expect(await availabilityStatus(shared)).toBe("sold_out");

    await transition(client, right.id, "start_maintenance");
    await transition(client, right.id, "complete_maintenance");
    expect(await availabilityStatus(shared)).toBe("available");
  });
});

describe("Shift handover acknowledgement (legend-o032, OPS-05)", () => {
  it("[legend-o032][OPS-05] the submitter cannot acknowledge, so the handover stays open until the receiving shift confirms", async () => {
    const submitter = await ownerClient();
    const receiver = await ownerClient();
    const created = await submitter.client
      .post(handoverPath())
      .set(originHeader)
      .send(handoverBody(`ack-${randomUUID()}`));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    createdHandoverIds.push(id);
    expect(created.body.data.status).toBe("submitted");

    // The sender is refused, and the handover is not closed by the attempt.
    const self = await submitter.client
      .post(`${handoverPath(id)}/acknowledge`)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(self.status, JSON.stringify(self.body)).toBe(403);
    expect(self.body.error.code).toBe("HANDOVER_SELF_ACKNOWLEDGEMENT");
    const stillOpen = await submitter.client.get(handoverPath(id));
    expect(stillOpen.body.data.status).toBe("submitted");
    expect(stillOpen.body.data.acknowledgedBy).toBeNull();
    expect(stillOpen.body.data.acknowledgedAt).toBeNull();

    // It is listed as open, not as acknowledged.
    const openList = await receiver.client.get(
      `${handoverPath()}?outletId=${outletA.id}&status=submitted&limit=100`,
    );
    expect(openList.status, JSON.stringify(openList.body)).toBe(200);
    expect(
      openList.body.data.some((row: { id: string }) => row.id === id),
    ).toBe(true);
    const closedList = await receiver.client.get(
      `${handoverPath()}?outletId=${outletA.id}&status=acknowledged&limit=100`,
    );
    expect(
      closedList.body.data.some((row: { id: string }) => row.id === id),
    ).toBe(false);

    // Another user closes it, recorded with their identity.
    const closed = await receiver.client
      .post(`${handoverPath(id)}/acknowledge`)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.status).toBe("acknowledged");
    expect(closed.body.data.acknowledgedBy).toBe(receiver.userId);
    expect(closed.body.data.acknowledgedBy).not.toBe(submitter.userId);

    // The submitter still cannot re-open or re-acknowledge a closed handover.
    const late = await submitter.client
      .post(`${handoverPath(id)}/acknowledge`)
      .set(originHeader)
      .send({ idempotencyKey: nextKey() });
    expect([403, 409]).toContain(late.status);
    const final = await submitter.client.get(handoverPath(id));
    expect(final.body.data.status).toBe("acknowledged");
    expect(final.body.data.acknowledgedBy).toBe(receiver.userId);
  });
});
