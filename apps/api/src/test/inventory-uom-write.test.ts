// Tenant UOM write tests (bead ie6m): add and edit a unit of measure. Needs the
// disposable PostgreSQL database; the migration owner seeds fixtures, the
// restricted legend_app login checks RLS, and the services run as owner-role
// users. The HTTP block needs the inventory setup router mounted at
// /api/inventory (already the case for locations).
//
// Acceptance ids used in test names:
// - UOM-01 create (isSystem=false, code normalized, validation, duplicate, replay)
// - UOM-02 update (name only, system units locked, unknown id)
// - UOM-03 permission (inventory.item.manage) and audit trail
// - UOM-04 provisioning marks the standard catalog as system units
// - TEN-01 isolation across tenants
//
// Assumptions (the brief leaves these open):
// - Service signatures follow the brief: createUom(ctx, actorId, input)
//   and updateUom(ctx, actorId, uomId, input).
// - Editing a system unit is refused with HTTP status 403; the row must stay
//   unchanged.
// - Audit rows carry event.action, event.objectType = "uom", event.objectId,
//   and the before/after names somewhere in the event payload.
import { createUomInputSchema } from "@starter/shared/inventory";
import { randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { provisionStandardUoms } from "../services/inventory-provisioning.service.ts";
import { createUom, updateUom } from "../services/inventory-uom.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();
const STANDARD_CODES = [
  "kg",
  "g",
  "l",
  "ml",
  "pcs",
  "pack",
  "ctn",
  "btl",
  "can",
  "sachet",
  "box",
  "porsi",
];

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});
const app = createApp();

const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const createdUomIds: string[] = [];

function tenantContext(tenantId: string = tenantA): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );
}

/** A short unique lowercase code that satisfies ^[a-z0-9]{1,10}$. */
function freshCode(): string {
  return `u${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function createInput(code: string, name = `Satuan ${code}`) {
  return createUomInputSchema.parse({
    code,
    name,
    idempotencyKey: `uom-${randomUUID()}`,
  });
}

async function asTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    return await run(client as unknown as Client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function rejectsWithCode(
  run: Promise<unknown>,
  code: string,
): Promise<void> {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ code });
}

async function rejectsWithStatus(
  run: Promise<unknown>,
  status: number | number[],
): Promise<void> {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  const actual = (error as { status?: number } | null)?.status;
  expect(Array.isArray(status) ? status : [status]).toContain(actual);
}

async function insertUserWithManage(
  tenantId: string,
  permissions: string[],
): Promise<string> {
  const userId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userId, "Uom Write User", `${userId}@example.com`],
  );
  createdUserIds.push(userId);
  await grantCustomRole(tenantId, userId, permissions);
  return userId;
}

/** A tenant custom role holding exactly these codes, assigned tenant-wide. */
async function grantCustomRole(
  tenantId: string,
  userId: string,
  permissions: string[],
): Promise<void> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, false, NULL, $3::jsonb, false, '["tenant"]'::jsonb) RETURNING id`,
    [tenantId, `Custom ${randomUUID()}`, JSON.stringify(permissions)],
  );
  createdRoleIds.push(rows[0]!.id);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, userId, rows[0]!.id],
  );
}

async function signedIn(name: string, permissions?: string[]) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  if (permissions) await grantCustomRole(tenantA, userId, permissions);
  return { client, userId };
}

async function uomRow(id: string) {
  const { rows } = await owner.query<{
    code: string;
    name: string;
    is_system: boolean;
    tenant_id: string;
  }>("SELECT code, name, is_system, tenant_id FROM uoms WHERE id = $1", [id]);
  return rows[0];
}

async function auditEvents(action: string, objectId: string) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    "SELECT event FROM audit_logs WHERE tenant_id = ANY($1::uuid[]) AND event->>'action' = $2 AND event->>'objectId' = $3",
    [[tenantA, tenantB], action, objectId],
  );
  return rows.map((row) => row.event);
}

const MANAGE = ["inventory.stock.view", "inventory.item.manage"];

let managerA: string;
let managerB: string;
let viewerA: string;
let systemKgB: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Inventory Uom Tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `inv-uom-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 1,
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
  // Tenant B gets the standard catalog through the real provisioning path.
  const scopeB = tenantContext(tenantB);
  await withTenant(db, scopeB, (tx) => provisionStandardUoms(tx, scopeB, null));
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM uoms WHERE tenant_id = $1 AND code = 'kg'",
    [tenantB],
  );
  systemKgB = rows[0]!.id;

  managerA = await insertUserWithManage(tenantA, MANAGE);
  viewerA = await insertUserWithManage(tenantA, ["inventory.stock.view"]);
  managerB = await insertUserWithManage(tenantB, MANAGE);
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM inventory_setup_idempotency WHERE tenant_id = ANY($1::uuid[])",
    [[tenantA, tenantB]],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
    [createdUserIds],
  );
  await owner.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
    createdRoleIds,
  ]);
  await owner.query("DELETE FROM uoms WHERE id = ANY($1::uuid[])", [
    createdUomIds,
  ]);
  await owner.query("DELETE FROM uoms WHERE tenant_id = $1", [tenantB]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.end();
  await appPool.end();
});

describe("UOM-01 create a unit", () => {
  it("UOM-01 creates a custom unit that is not a system unit", async () => {
    const code = freshCode();
    const created = await createUom(
      tenantContext(),
      managerA,
      createInput(code, "Gelas Besar"),
    );
    createdUomIds.push(created.id);
    expect(created).toMatchObject({
      tenantId: tenantA,
      code,
      name: "Gelas Besar",
      isSystem: false,
    });
    expect((await uomRow(created.id))?.is_system).toBe(false);
  });

  it("UOM-01 normalizes the code to lowercase and trims the name", () => {
    const parsed = createUomInputSchema.parse({
      code: "  KG9X ",
      name: "  Kilo Khusus  ",
      idempotencyKey: `uom-${randomUUID()}`,
    });
    expect(parsed.code).toBe("kg9x");
    expect(parsed.name).toBe("Kilo Khusus");
  });

  it("UOM-01 rejects an invalid code or an empty name", () => {
    const base = { name: "Valid", idempotencyKey: `uom-${randomUUID()}` };
    for (const code of ["", "has space", "a-b", "under_score", "abcdefghijk"])
      expect(
        createUomInputSchema.safeParse({ ...base, code }).success,
        `code "${code}"`,
      ).toBe(false);
    expect(
      createUomInputSchema.safeParse({ ...base, code: "ok", name: "   " })
        .success,
    ).toBe(false);
    expect(
      createUomInputSchema.safeParse({
        ...base,
        code: "ok",
        name: "x".repeat(151),
      }).success,
    ).toBe(false);
  });

  it("UOM-01 refuses a duplicate code in the tenant with 409", async () => {
    const code = freshCode();
    const first = await createUom(tenantContext(), managerA, createInput(code));
    createdUomIds.push(first.id);
    await rejectsWithStatus(
      createUom(tenantContext(), managerA, createInput(code, "Lain")),
      409,
    );
    // A standard unit's code is taken as well (tenant B has the catalog).
    await rejectsWithStatus(
      createUom(tenantContext(tenantB), managerB, createInput("kg")),
      409,
    );
    const { rows } = await owner.query(
      "SELECT 1 FROM uoms WHERE tenant_id = $1 AND code = $2",
      [tenantA, code],
    );
    expect(rows).toHaveLength(1);
  });

  it("UOM-01 replays the same key and refuses a reused key with another payload", async () => {
    const input = createInput(freshCode());
    const first = await createUom(tenantContext(), managerA, input);
    createdUomIds.push(first.id);
    const replay = await createUom(tenantContext(), managerA, input);
    expect(replay.id).toBe(first.id);
    const { rows } = await owner.query(
      "SELECT 1 FROM uoms WHERE tenant_id = $1 AND code = $2",
      [tenantA, input.code],
    );
    expect(rows).toHaveLength(1);

    await rejectsWithCode(
      createUom(tenantContext(), managerA, { ...input, name: "Beda" }),
      "IDEMPOTENCY_KEY_REUSED",
    );
    await rejectsWithCode(
      createUom(tenantContext(), managerA, {
        ...input,
        code: freshCode(),
      }),
      "IDEMPOTENCY_KEY_REUSED",
    );
  });
});

describe("UOM-02 edit a unit", () => {
  it("UOM-02 renames a custom unit and keeps the code", async () => {
    const created = await createUom(
      tenantContext(),
      managerA,
      createInput(freshCode(), "Nama Lama"),
    );
    createdUomIds.push(created.id);
    const updated = await updateUom(tenantContext(), managerA, created.id, {
      name: "Nama Baru",
    });
    expect(updated).toMatchObject({
      id: created.id,
      code: created.code,
      name: "Nama Baru",
      isSystem: false,
    });
    expect((await uomRow(created.id))?.name).toBe("Nama Baru");
  });

  it("UOM-02 refuses to edit a system unit and leaves the row unchanged", async () => {
    const before = await uomRow(systemKgB);
    expect(before?.is_system).toBe(true);
    await rejectsWithStatus(
      updateUom(tenantContext(tenantB), managerB, systemKgB as never, {
        name: "Kilogram Diubah",
      }),
      [403],
    );
    expect(await uomRow(systemKgB)).toEqual(before);
  });

  it("UOM-02 an unknown unit id is a 404", async () => {
    await rejectsWithStatus(
      updateUom(tenantContext(), managerA, randomUUID() as never, {
        name: "Tidak ada",
      }),
      404,
    );
  });
});

describe("UOM-03 permission and audit", () => {
  it("UOM-03 denies create and edit without inventory.item.manage", async () => {
    const created = await createUom(
      tenantContext(),
      managerA,
      createInput(freshCode(), "Dilindungi"),
    );
    createdUomIds.push(created.id);
    const denied = createInput(freshCode());
    await rejectsWithCode(
      createUom(tenantContext(), viewerA, denied),
      "PERMISSION_DENIED",
    );
    await rejectsWithCode(
      updateUom(tenantContext(), viewerA, created.id, { name: "Dicuri" }),
      "PERMISSION_DENIED",
    );
    expect((await uomRow(created.id))?.name).toBe("Dilindungi");
    const { rows } = await owner.query(
      "SELECT 1 FROM uoms WHERE tenant_id = $1 AND code = $2",
      [tenantA, denied.code],
    );
    expect(rows).toHaveLength(0);
  });

  it("UOM-03 writes audit rows for create and update with before and after", async () => {
    const created = await createUom(
      tenantContext(),
      managerA,
      createInput(freshCode(), "Audit Awal"),
    );
    createdUomIds.push(created.id);
    const createdEvents = await auditEvents(
      "inventory.uom.created",
      created.id,
    );
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({ objectType: "uom" });
    expect(JSON.stringify(createdEvents[0])).toContain(created.code);

    await updateUom(tenantContext(), managerA, created.id, {
      name: "Audit Akhir",
    });
    const updatedEvents = await auditEvents(
      "inventory.uom.updated",
      created.id,
    );
    expect(updatedEvents).toHaveLength(1);
    expect(updatedEvents[0]).toMatchObject({ objectType: "uom" });
    const payload = JSON.stringify(updatedEvents[0]);
    // Names are masked in audit payloads (same policy as other setup audits);
    // the row id, code and the before/after envelope must still be present.
    expect(payload).toContain(created.code);
    expect(payload).toContain('"before"');
    expect(payload).toContain('"after"');
    expect(updatedEvents[0]).toMatchObject({ objectId: created.id });
  });

  it("UOM-03 a replayed create does not write a second audit row", async () => {
    const input = createInput(freshCode());
    const first = await createUom(tenantContext(), managerA, input);
    createdUomIds.push(first.id);
    await createUom(tenantContext(), managerA, input);
    expect(await auditEvents("inventory.uom.created", first.id)).toHaveLength(
      1,
    );
  });
});

describe("UOM-04 provisioning", () => {
  it("UOM-04 marks every standard unit as a system unit", async () => {
    const { rows } = await owner.query<{ code: string; is_system: boolean }>(
      "SELECT code, is_system FROM uoms WHERE tenant_id = $1 ORDER BY code",
      [tenantB],
    );
    for (const code of STANDARD_CODES) {
      const row = rows.find((candidate) => candidate.code === code);
      expect(row, `standard unit ${code}`).toBeDefined();
      expect(row?.is_system, `isSystem of ${code}`).toBe(true);
    }
  });
});

describe("TEN-01 UOM isolation", () => {
  it("TEN-01 another tenant cannot see, edit or insert into a tenant's custom unit", async () => {
    const created = await createUom(
      tenantContext(),
      managerA,
      createInput(freshCode(), "Milik Tenant A"),
    );
    createdUomIds.push(created.id);

    // Service layer: tenant B's manager gets a 404, never a write.
    await rejectsWithStatus(
      updateUom(tenantContext(tenantB), managerB, created.id, {
        name: "Dibajak",
      }),
      404,
    );
    expect((await uomRow(created.id))?.name).toBe("Milik Tenant A");

    // RLS layer, through the restricted legend_app login.
    const seen = await asTenant(tenantB, (client) =>
      client.query("SELECT 1 FROM uoms WHERE id = $1", [created.id]),
    );
    expect(seen.rows).toHaveLength(0);
    const touched = await asTenant(tenantB, (client) =>
      client.query("UPDATE uoms SET name = 'Dibajak' WHERE id = $1", [
        created.id,
      ]),
    );
    expect(touched.rowCount).toBe(0);
    await expect(
      asTenant(tenantB, (client) =>
        client.query(
          "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, 'zrls', 'x')",
          [tenantA],
        ),
      ),
    ).rejects.toBeTruthy();
    expect((await uomRow(created.id))?.name).toBe("Milik Tenant A");
  });

  it("TEN-01 the same code may exist in two tenants", async () => {
    const code = freshCode();
    const inA = await createUom(tenantContext(), managerA, createInput(code));
    const inB = await createUom(
      tenantContext(tenantB),
      managerB,
      createInput(code),
    );
    createdUomIds.push(inA.id, inB.id);
    expect(inA.id).not.toBe(inB.id);
    expect(inB.tenantId).toBe(tenantB);
  });
});

describe("inventory UOM API", () => {
  it("POST creates a unit with a Location header and PATCH renames it", async () => {
    const { client } = await signedIn("Uom API Manager", MANAGE);
    const code = freshCode();
    const created = await client
      .post("/api/inventory/uoms")
      .set(originHeader)
      .send({
        code: code.toUpperCase(),
        name: "  Gelas API  ",
        idempotencyKey: `api-uom-${randomUUID()}`,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      code,
      name: "Gelas API",
      isSystem: false,
    });
    expect(created.headers.location).toContain(created.body.data.id);
    createdUomIds.push(created.body.data.id);

    const patched = await client
      .patch(`/api/inventory/uoms/${created.body.data.id}`)
      .set(originHeader)
      .send({ name: "Gelas API Baru" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.data).toMatchObject({
      code,
      name: "Gelas API Baru",
    });
  });

  it("rejects an invalid code, a code change, tenant fields and an unknown id", async () => {
    const { client } = await signedIn("Uom API Validation", MANAGE);
    const valid = {
      code: freshCode(),
      name: "Valid",
      idempotencyKey: `api-uom-${randomUUID()}`,
    };
    expect(
      (
        await client
          .post("/api/inventory/uoms")
          .set(originHeader)
          .send({ ...valid, code: "not valid!" })
      ).status,
    ).toBe(422);
    expect(
      (
        await client
          .post("/api/inventory/uoms")
          .set(originHeader)
          .send({ ...valid, tenantId: tenantB })
      ).status,
    ).toBe(422);

    const created = await client
      .post("/api/inventory/uoms")
      .set(originHeader)
      .send(valid);
    expect(created.status).toBe(201);
    createdUomIds.push(created.body.data.id);
    // The code is immutable: a PATCH carrying it is a validation error.
    expect(
      (
        await client
          .patch(`/api/inventory/uoms/${created.body.data.id}`)
          .set(originHeader)
          .send({ name: "Ok", code: freshCode() })
      ).status,
    ).toBe(422);
    expect(
      (
        await client
          .patch(`/api/inventory/uoms/${created.body.data.id}`)
          .set(originHeader)
          .send({ name: "" })
      ).status,
    ).toBe(422);
    expect(
      (
        await client
          .patch(`/api/inventory/uoms/${randomUUID()}`)
          .set(originHeader)
          .send({ name: "Tidak ada" })
      ).status,
    ).toBe(404);
  });

  it("requires a session and the item.manage permission", async () => {
    const body = {
      code: freshCode(),
      name: "Tanpa Izin",
      idempotencyKey: `api-uom-${randomUUID()}`,
    };
    expect(
      (
        await agent(app)
          .post("/api/inventory/uoms")
          .set(originHeader)
          .send(body)
      ).status,
    ).toBe(401);
    const viewer = await signedIn("Uom API Viewer", [
      "inventory.stock.view",
      "inventory.stock.receive",
    ]);
    expect(
      (
        await viewer.client
          .post("/api/inventory/uoms")
          .set(originHeader)
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await viewer.client
          .patch(`/api/inventory/uoms/${randomUUID()}`)
          .set(originHeader)
          .send({ name: "Tidak boleh" })
      ).status,
    ).toBe(403);
    // A cookie-authenticated write without the trusted origin is refused.
    const { client } = await signedIn("Uom API Origin", MANAGE);
    expect((await client.post("/api/inventory/uoms").send(body)).status).toBe(
      403,
    );
  });
});
