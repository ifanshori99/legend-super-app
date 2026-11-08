// HRIS SOP library against PostgreSQL with the restricted app role (RLS
// enforced): PRD v1.7 §3 F32 "SOP, Pelatihan & Pengumuman"; versions are
// immutable, acknowledgements bind to a version, outlet reach and tenant
// isolation hold (TEN-01/02/03); bead legend-7df1.
//
// Services are called directly with server-minted contexts, plus a few HTTP
// calls through the real Express app. Actors are real users with real role
// assignments, so every decision goes through the RBAC resolver.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  encodeCursor,
  outletIdSchema,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type {
  CreateSopDocumentInput,
  PublishSopVersionInput,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { sopDocuments } from "../db/schema/hris-sop.ts";
import { withTenant } from "../db/tenant.ts";
import {
  acknowledgeSopDocument,
  createSopDocument,
  listSopAcknowledgementStatus,
  listSopDocuments,
  listSopDocumentVersions,
  publishSopVersion,
} from "../services/hris-sop.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const otherTenant = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdStations: string[] = [];
const createdPositions: string[] = [];
const createdStorage: string[] = [];

const base = (tenant: string = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = (tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), { kind: "tenant" });
const outletScope = (outletId: string, tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
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

async function newUser(name: string): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [userId, name, `${userId}@example.test`],
  );
  return userId;
}

async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant,
        `SOP test ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenant,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
}

async function actor(
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
): Promise<string> {
  const userId = await newUser("SOP DB");
  await grantRole(userId, permissions, scope, tenant);
  return userId;
}

async function seedEmployee(input: {
  userId: string | null;
  outletId: string;
  positionId?: string | null;
  name?: string;
}): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, position_id,
                              home_outlet_id, employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenantId,
        input.userId,
        `SOP-${id.slice(0, 8).toUpperCase()}`,
        input.name ?? "Karyawan SOP",
        input.positionId ?? null,
        input.outletId,
      ],
    ),
  );
  return id;
}

async function seedStation(outletId: string): Promise<string> {
  const id = randomUUID();
  createdStations.push(id);
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, $4, 'coffee_bar')`,
      [id, tenantId, outletId, `SOP Stasiun ${id.slice(0, 8)}`],
    ),
  );
  return id;
}

async function seedPosition(): Promise<string> {
  const id = randomUUID();
  createdPositions.push(id);
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO positions (id, tenant_id, name) VALUES ($1, $2, $3)`,
      [id, tenantId, `SOP Uji ${id.slice(0, 8)}`],
    ),
  );
  return id;
}

async function storageObject(outletId: string): Promise<string> {
  const id = randomUUID();
  createdStorage.push(id);
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO core_storage_objects (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes)
       VALUES ($1, $2, $3, 'document', $4, 'image/png', 1024)`,
      [tenantId, outletId, id, `private/${tenantId}/${id}.png`],
    ),
  );
  return id;
}

async function auditRows(objectId: string) {
  const { rows } = await asOwner(tenantId, (client) =>
    client.query<{ event: Record<string, unknown> }>(
      `SELECT event FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = $2`,
      [tenantId, objectId],
    ),
  );
  return rows;
}

const codeOf = (error: unknown) => (error as { code?: string }).code;
const statusOf = (error: unknown) => (error as { status?: number }).status;
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return { code: codeOf(error), status: statusOf(error), error };
  }
  throw new Error("Expected the call to fail");
}

const content = (overrides: Record<string, unknown> = {}) => ({
  title: "Cara membuat espresso",
  body: "1. Giling 18 g.\n2. Ekstraksi 28 detik.",
  mediaIds: [] as string[],
  requiresAcknowledgement: true,
  effectiveFrom: "2026-11-10",
  ...overrides,
});
const createInput = (overrides: Record<string, unknown> = {}) =>
  ({
    ...content(),
    stationId: null,
    positionId: null,
    ...overrides,
  }) as CreateSopDocumentInput;
const versionInput = (overrides: Record<string, unknown> = {}) =>
  content(overrides) as PublishSopVersionInput;

// Actors.
let hr: string; // tenant-wide hr.sop.manage
let managerA: string; // hr.sop.manage at outlet A
let managerB: string; // hr.sop.manage at outlet B
let staffA: string; // self.sop.read at A, employee at A
let staffB: string; // self.sop.read at B, employee at B
let stranger: string; // no SOP code
let hrOther: string; // hr.sop.manage in another tenant

let stationA: string;
let stationB: string;
let positionBarista: string;
let employeeA: string;
let employeeB: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'SOP RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `sop-rls-${otherTenant.slice(0, 8)}`, tenantId],
  );
  hr = await actor(["hr.sop.manage"], { type: "tenant" });
  managerA = await actor(["hr.sop.manage"], { type: "outlet", id: outletA });
  managerB = await actor(["hr.sop.manage"], { type: "outlet", id: outletB });
  staffA = await actor(["self.sop.read"], { type: "outlet", id: outletA });
  staffB = await actor(["self.sop.read"], { type: "outlet", id: outletB });
  stranger = await actor(["menu.item.view"], { type: "tenant" });
  hrOther = await actor(["hr.sop.manage"], { type: "tenant" }, otherTenant);
  stationA = await seedStation(outletA);
  stationB = await seedStation(outletB);
  positionBarista = await seedPosition();
  employeeA = await seedEmployee({
    userId: staffA,
    outletId: outletA,
    positionId: positionBarista,
    name: "Aisyah A",
  });
  employeeB = await seedEmployee({
    userId: staffB,
    outletId: outletB,
    name: "Budi B",
  });
});

afterAll(async () => {
  await asOwner(tenantId, async (client) => {
    await client.query(
      "DELETE FROM sop_acknowledgements WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenantId, createdEmployees],
    );
    await client.query(
      "DELETE FROM sop_documents WHERE tenant_id = $1 AND published_by = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdEmployees],
    );
    await client.query(
      "DELETE FROM stations WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdStations],
    );
    await client.query(
      "DELETE FROM positions WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdPositions],
    );
    await client.query(
      "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdStorage],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdRoles],
    );
  });
  await asOwner(otherTenant, async (client) => {
    await client.query("DELETE FROM sop_documents WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM roles WHERE tenant_id = $1", [otherTenant]);
  });
  // Audit rows are append-only; the fixture tenant may stay (disposable DB).
  await owner
    .query("DELETE FROM tenants WHERE id = $1", [otherTenant])
    .catch(() => undefined);
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

describe("SOP versions", () => {
  it("creates v1 with lineage = id and audits the publish", async () => {
    const doc = await createSopDocument(tenantScope(), hr, createInput());
    expect(doc.version).toBe(1);
    expect(doc.supersedesId).toBeNull();
    const [row] = await withTenant(db, tenantScope(), (tx) =>
      tx
        .select()
        .from(sopDocuments)
        .where(sql`id = ${doc.id}`),
    );
    expect(row?.lineageId).toBe(doc.id);
    const audit = await auditRows(doc.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.event.action).toBe("hris.sop_document.published");
  });

  it("a new version keeps v1 intact and only the head is listed", async () => {
    const station = stationA;
    const v1 = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ title: "Versi uji satu", stationId: station }),
    );
    const v2 = await publishSopVersion(
      tenantScope(),
      hr,
      v1.id,
      versionInput({
        title: "Versi uji dua",
        body: "Isi baru.",
        effectiveFrom: "2026-11-20",
      }),
    );
    expect(v2.version).toBe(2);
    expect(v2.supersedesId).toBe(v1.id);
    expect(v2.stationId).toBe(station);
    const versions = await listSopDocumentVersions(tenantScope(), hr, v2.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]).toEqual(v1);
    const list = await listSopDocuments(tenantScope(), hr, {
      limit: 100,
      stationId: station,
    });
    expect(list.data.map((d) => d.id)).toEqual([v2.id]);
  });

  it("publishing against a stale version answers 409 SOP_VERSION_STALE", async () => {
    const v1 = await createSopDocument(tenantScope(), hr, createInput());
    await publishSopVersion(tenantScope(), hr, v1.id, versionInput());
    const stale = await failure(
      publishSopVersion(tenantScope(), hr, v1.id, versionInput()),
    );
    expect(stale.status).toBe(409);
    expect(stale.code).toBe("SOP_VERSION_STALE");
  });

  it("two concurrent publishes of one version: one wins, one answers 409", async () => {
    const v1 = await createSopDocument(tenantScope(), hr, createInput());
    const results = await Promise.allSettled([
      publishSopVersion(tenantScope(), hr, v1.id, versionInput()),
      publishSopVersion(tenantScope(), hr, v1.id, versionInput()),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(codeOf((rejected[0] as PromiseRejectedResult).reason)).toBe(
      "SOP_VERSION_STALE",
    );
  });

  it("refuses an effective date earlier than the previous version", async () => {
    const v1 = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ effectiveFrom: "2026-12-01" }),
    );
    const early = await failure(
      publishSopVersion(
        tenantScope(),
        hr,
        v1.id,
        versionInput({ effectiveFrom: "2026-11-30" }),
      ),
    );
    expect(early.status).toBe(422);
    expect(early.code).toBe("SOP_EFFECTIVE_DATE_INVALID");
  });

  it("[immutable] neither legend_app nor the owner can UPDATE a version", async () => {
    const doc = await createSopDocument(tenantScope(), hr, createInput());
    await expect(
      withTenant(db, tenantScope(), (tx) =>
        tx.execute(
          sql`UPDATE sop_documents SET title = 'diubah' WHERE id = ${doc.id}`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      asOwner(tenantId, (client) =>
        client.query(
          "UPDATE sop_documents SET title = 'diubah' WHERE id = $1",
          [doc.id],
        ),
      ),
    ).rejects.toThrow(/SOP_VERSION_IMMUTABLE/);
    await expect(
      withTenant(db, tenantScope(), (tx) =>
        tx.execute(sql`DELETE FROM sop_documents WHERE id = ${doc.id}`),
      ),
    ).rejects.toThrow();
  });

  it("media ids must exist in the tenant's storage", async () => {
    const media = await storageObject(outletA);
    const ok = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ mediaIds: [media] }),
    );
    expect(ok.mediaIds).toEqual([media]);
    const missing = await failure(
      createSopDocument(
        tenantScope(),
        hr,
        createInput({ mediaIds: [randomUUID()] }),
      ),
    );
    expect(missing.status).toBe(422);
    expect(missing.code).toBe("SOP_MEDIA_NOT_FOUND");
  });
});

describe("SOP acknowledgement", () => {
  it("binds to the version: v1 ack does not count for v2, old version answers 409", async () => {
    const v1 = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ stationId: stationA, title: "Ack uji" }),
    );
    const ack = await acknowledgeSopDocument(
      outletScope(outletA),
      staffA,
      v1.id,
      {
        idempotencyKey: `sop-${randomUUID()}`,
      },
    );
    expect(ack.documentVersion).toBe(1);
    expect(ack.employeeId).toBe(employeeA);
    const v2 = await publishSopVersion(
      tenantScope(),
      hr,
      v1.id,
      versionInput(),
    );

    const statusV2 = await listSopAcknowledgementStatus(
      tenantScope(),
      hr,
      v2.id,
      { limit: 100 },
    );
    const mine = statusV2.data.find((s) => s.employeeId === employeeA);
    expect(mine).toMatchObject({ acknowledgedVersion: 1, current: false });
    // Outlet-B employee does not belong to the outlet-A station SOP.
    expect(statusV2.data.some((s) => s.employeeId === employeeB)).toBe(false);

    const old = await failure(
      acknowledgeSopDocument(outletScope(outletA), staffA, v1.id, {
        idempotencyKey: `sop-${randomUUID()}`,
      }),
    );
    expect(old.status).toBe(409);
    expect(old.code).toBe("SOP_VERSION_STALE");

    const ackV2 = await acknowledgeSopDocument(
      outletScope(outletA),
      staffA,
      v2.id,
      {
        idempotencyKey: `sop-${randomUUID()}`,
      },
    );
    expect(ackV2.documentVersion).toBe(2);
    const after = await listSopAcknowledgementStatus(tenantScope(), hr, v2.id, {
      limit: 100,
    });
    expect(after.data.find((s) => s.employeeId === employeeA)).toMatchObject({
      acknowledgedVersion: 2,
      current: true,
    });
  });

  it("is idempotent per document and employee", async () => {
    const doc = await createSopDocument(tenantScope(), hr, createInput());
    const key = `sop-${randomUUID()}`;
    const first = await acknowledgeSopDocument(
      outletScope(outletA),
      staffA,
      doc.id,
      {
        idempotencyKey: key,
      },
    );
    const again = await acknowledgeSopDocument(
      outletScope(outletA),
      staffA,
      doc.id,
      {
        idempotencyKey: key,
      },
    );
    const otherKey = await acknowledgeSopDocument(
      outletScope(outletA),
      staffA,
      doc.id,
      { idempotencyKey: `sop-${randomUUID()}` },
    );
    expect(again).toEqual(first);
    expect(otherKey.id).toBe(first.id);
  });

  it("a manager who is also an employee cannot acknowledge a SOP not addressed to them", async () => {
    const both = await newUser("SOP manager employee");
    await grantRole(both, ["hr.sop.manage"], { type: "tenant" });
    await grantRole(both, ["self.sop.read"], { type: "outlet", id: outletA });
    await seedEmployee({ userId: both, outletId: outletA, name: "Manajer A" });
    const inB = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ stationId: stationB, title: "Hanya outlet B (manajer)" }),
    );
    const result = await failure(
      acknowledgeSopDocument(outletScope(outletA), both, inB.id, {
        idempotencyKey: `sop-${randomUUID()}`,
      }),
    );
    expect(result.status).toBe(404);
  });

  it("replays an existing acknowledgement of an older version instead of 409", async () => {
    const v1 = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ stationId: stationA, title: "Replay lama" }),
    );
    const key = `sop-${randomUUID()}`;
    const first = await acknowledgeSopDocument(
      outletScope(outletA),
      staffA,
      v1.id,
      { idempotencyKey: key },
    );
    await publishSopVersion(tenantScope(), hr, v1.id, versionInput());
    const replay = await acknowledgeSopDocument(
      outletScope(outletA),
      staffA,
      v1.id,
      { idempotencyKey: key },
    );
    expect(replay).toEqual(first);
  });

  it("a new key on a superseded version the employee already confirmed answers 409", async () => {
    const v1 = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ stationId: stationA, title: "Kunci baru lama" }),
    );
    await acknowledgeSopDocument(outletScope(outletA), staffA, v1.id, {
      idempotencyKey: `sop-${randomUUID()}`,
    });
    await publishSopVersion(tenantScope(), hr, v1.id, versionInput());
    const result = await failure(
      acknowledgeSopDocument(outletScope(outletA), staffA, v1.id, {
        idempotencyKey: `sop-${randomUUID()}`,
      }),
    );
    expect(result.status).toBe(409);
    expect(result.code).toBe("SOP_VERSION_STALE");
  });

  it("a resigned employee cannot acknowledge and sees no station SOPs", async () => {
    const user = await actor(["self.sop.read"], {
      type: "outlet",
      id: outletA,
    });
    const employeeId = await seedEmployee({
      userId: user,
      outletId: outletA,
      name: "Karyawan Resign",
    });
    const doc = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ stationId: stationA, title: "Dokumen untuk resign" }),
    );
    const setStatus = (status: string) =>
      asOwner(tenantId, (client) =>
        client.query(
          "UPDATE employees SET status = $3 WHERE tenant_id = $1 AND id = $2",
          [tenantId, employeeId, status],
        ),
      );
    // Sanity: while active the employee sees the document.
    const before = await listSopDocuments(outletScope(outletA), user, {
      limit: 200,
    });
    expect(before.data.map((d) => d.id)).toContain(doc.id);
    await setStatus("resigned");
    try {
      const refused = await failure(
        acknowledgeSopDocument(outletScope(outletA), user, doc.id, {
          idempotencyKey: `sop-${randomUUID()}`,
        }),
      );
      expect(refused.status).toBe(403);
      const listed = await listSopDocuments(outletScope(outletA), user, {
        limit: 200,
      }).then(
        (page) => page.data.map((d) => d.id),
        () => [] as string[],
      );
      expect(listed).not.toContain(doc.id);
    } finally {
      await setStatus("active");
    }
  });

  it("status of an older version id is computed against the lineage head", async () => {
    const v1 = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ stationId: stationA, title: "Status kepala" }),
    );
    const v2 = await publishSopVersion(
      tenantScope(),
      hr,
      v1.id,
      versionInput(),
    );
    await acknowledgeSopDocument(outletScope(outletA), staffA, v2.id, {
      idempotencyKey: `sop-${randomUUID()}`,
    });
    const status = await listSopAcknowledgementStatus(
      tenantScope(),
      hr,
      v1.id,
      { limit: 100 },
    );
    expect(status.data.find((s) => s.employeeId === employeeA)).toMatchObject({
      acknowledgedVersion: 2,
      current: true,
    });
  });

  it("a malformed cursor answers 422, not a database error", async () => {
    const cursor = encodeCursor(["Judul", "bukan-uuid"]);
    const list = await failure(
      listSopDocuments(tenantScope(), hr, { limit: 10, cursor }),
    );
    expect(list.status).toBe(422);
    const doc = await createSopDocument(tenantScope(), hr, createInput());
    const status = await failure(
      listSopAcknowledgementStatus(tenantScope(), hr, doc.id, {
        limit: 10,
        cursor,
      }),
    );
    expect(status.status).toBe(422);
  });

  it("a caller without an employee row answers 404", async () => {
    const noEmployee = await actor(["self.sop.read"], {
      type: "outlet",
      id: outletA,
    });
    const doc = await createSopDocument(tenantScope(), hr, createInput());
    const result = await failure(
      acknowledgeSopDocument(outletScope(outletA), noEmployee, doc.id, {
        idempotencyKey: `sop-${randomUUID()}`,
      }),
    );
    expect(result.status).toBe(404);
  });

  it("employees only see SOPs of their outlet and position", async () => {
    const forBarista = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ positionId: positionBarista, title: "Khusus barista" }),
    );
    const inB = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ stationId: stationB, title: "Hanya outlet B" }),
    );
    const mineA = await listSopDocuments(outletScope(outletA), staffA, {
      limit: 200,
    });
    const idsA = mineA.data.map((d) => d.id);
    expect(idsA).toContain(forBarista.id);
    expect(idsA).not.toContain(inB.id);
    const mineB = await listSopDocuments(outletScope(outletB), staffB, {
      limit: 200,
    });
    const idsB = mineB.data.map((d) => d.id);
    expect(idsB).toContain(inB.id);
    expect(idsB).not.toContain(forBarista.id);
    expect(
      (
        await failure(
          acknowledgeSopDocument(outletScope(outletB), staffB, forBarista.id, {
            idempotencyKey: `sop-${randomUUID()}`,
          }),
        )
      ).status,
    ).toBe(404);
  });
});

describe("SOP permissions and outlet scope", () => {
  it("is refused without an SOP permission", async () => {
    expect(
      (await failure(createSopDocument(tenantScope(), stranger, createInput())))
        .status,
    ).toBe(403);
    expect(
      (await failure(listSopDocuments(tenantScope(), stranger, { limit: 20 })))
        .status,
    ).toBe(403);
    // An employee can read but not manage.
    expect(
      (
        await failure(
          createSopDocument(outletScope(outletA), staffA, createInput()),
        )
      ).status,
    ).toBe(403);
  });

  it("[TEN-03] a manager of outlet A cannot publish or see an outlet-B SOP", async () => {
    const inB = await createSopDocument(
      tenantScope(),
      hr,
      createInput({ stationId: stationB }),
    );
    const create = await failure(
      createSopDocument(
        outletScope(outletA),
        managerA,
        createInput({ stationId: stationB }),
      ),
    );
    expect(create.status).toBe(403);
    expect(create.code).toBe("OUTLET_OUT_OF_SCOPE");
    const publish = await failure(
      publishSopVersion(outletScope(outletA), managerA, inB.id, versionInput()),
    );
    expect(publish.status).toBe(403);
    expect(publish.code).toBe("OUTLET_OUT_OF_SCOPE");
    const versions = await failure(
      listSopDocumentVersions(outletScope(outletA), managerA, inB.id),
    );
    expect(versions.status).toBe(404);
    const status = await failure(
      listSopAcknowledgementStatus(outletScope(outletA), managerA, inB.id, {
        limit: 20,
      }),
    );
    expect(status.status).toBe(404);
    const listed = await listSopDocuments(outletScope(outletA), managerA, {
      limit: 200,
    });
    expect(listed.data.some((d) => d.id === inB.id)).toBe(false);
    // Tenant-wide SOPs need tenant reach.
    const wide = await failure(
      createSopDocument(outletScope(outletA), managerA, createInput()),
    );
    expect(wide.code).toBe("OUTLET_OUT_OF_SCOPE");
    // Own outlet works.
    const own = await createSopDocument(
      outletScope(outletA),
      managerA,
      createInput({ stationId: stationA }),
    );
    expect(own.stationId).toBe(stationA);
    const ownB = await createSopDocument(
      outletScope(outletB),
      managerB,
      createInput({ stationId: stationB }),
    );
    expect(ownB.stationId).toBe(stationB);
  });
});

describe("SOP tenant isolation", () => {
  it("[TEN-01] another tenant cannot read, publish or acknowledge a SOP", async () => {
    const doc = await createSopDocument(tenantScope(), hr, createInput());
    const theirs = await createSopDocument(
      tenantScope(otherTenant),
      hrOther,
      createInput({ title: "Milik tenant lain" }),
    );
    const rows = await withTenant(db, tenantScope(otherTenant), (tx) =>
      tx
        .select()
        .from(sopDocuments)
        .where(sql`id = ${doc.id}`),
    );
    expect(rows).toEqual([]);
    expect(
      (
        await failure(
          publishSopVersion(
            tenantScope(otherTenant),
            hrOther,
            doc.id,
            versionInput(),
          ),
        )
      ).status,
    ).toBe(404);
    const mine = await listSopDocuments(tenantScope(), hr, { limit: 500 });
    expect(mine.data.some((d) => d.id === theirs.id)).toBe(false);
  });

  it("[TEN-02] RLS refuses inserting a row into another tenant", async () => {
    const id = randomUUID();
    await expect(
      withTenant(db, tenantScope(otherTenant), (tx) =>
        tx.insert(sopDocuments).values({
          id,
          tenantId,
          lineageId: id,
          version: 1,
          title: "Bocor",
          body: "x",
          requiresAcknowledgement: false,
          effectiveFrom: "2026-11-10",
          publishedBy: userIdSchema.parse(hrOther),
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("SOP HTTP API", () => {
  type Client = ReturnType<typeof agent>;
  let hrClient: Client;
  let staffClient: Client;
  let strangerClient: Client;

  async function signedIn(name: string) {
    const { createApp } = await import("../app.ts");
    const client = agent(createApp());
    await signUp(client, name);
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    createdUsers.push(userId);
    return { client, userId };
  }

  beforeAll(async () => {
    const manager = await signedIn("SOP HR API");
    await grantRole(manager.userId, ["hr.sop.manage"], { type: "tenant" });
    hrClient = manager.client;
    const staff = await signedIn("SOP Staf API");
    await grantRole(staff.userId, ["self.sop.read"], {
      type: "outlet",
      id: outletA,
    });
    await seedEmployee({ userId: staff.userId, outletId: outletA });
    staffClient = staff.client;
    strangerClient = (await signedIn("SOP Asing API")).client;
  });

  it("creates, publishes, lists and acknowledges over HTTP", async () => {
    const created = await hrClient
      .post("/api/hris/sop-documents")
      .set(originHeader)
      .send({ ...content(), stationId: null, positionId: null });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;

    const published = await hrClient
      .post(`/api/hris/sop-documents/${id}/versions`)
      .set(originHeader)
      .send(content({ title: "Cara membuat espresso v2" }));
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(published.body.data.version).toBe(2);
    const v2 = published.body.data.id as string;

    const stale = await hrClient
      .post(`/api/hris/sop-documents/${id}/versions`)
      .set(originHeader)
      .send(content());
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("SOP_VERSION_STALE");

    const versions = await hrClient.get(
      `/api/hris/sop-documents/${v2}/versions`,
    );
    expect(versions.status).toBe(200);
    expect(versions.body.data).toHaveLength(2);

    const list = await staffClient.get("/api/hris/sop-documents?limit=100");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect((list.body.data as { id: string }[]).map((d) => d.id)).toContain(v2);

    const ack = await staffClient
      .post(`/api/hris/sop-documents/${v2}/acknowledgements`)
      .set(originHeader)
      .send({ idempotencyKey: `sop-${randomUUID()}` });
    expect(ack.status, JSON.stringify(ack.body)).toBe(200);
    expect(ack.body.data.documentVersion).toBe(2);

    const status = await hrClient.get(
      `/api/hris/sop-documents/${v2}/acknowledgement-status?limit=100`,
    );
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(
      (status.body.data as { current: boolean }[]).some((s) => s.current),
    ).toBe(true);
  });

  it("answers 403 to a caller without SOP codes and to an employee who manages", async () => {
    expect((await strangerClient.get("/api/hris/sop-documents")).status).toBe(
      403,
    );
    const staffCreate = await staffClient
      .post("/api/hris/sop-documents")
      .set(originHeader)
      .send({ ...content(), stationId: null, positionId: null });
    expect(staffCreate.status).toBe(403);
  });

  it("[TEN-02] rejects a tenantId in the body and a mutation without Origin", async () => {
    const withTenantId = await hrClient
      .post("/api/hris/sop-documents")
      .set(originHeader)
      .send({ ...content(), stationId: null, positionId: null, tenantId });
    expect(withTenantId.status).toBe(422);
    const noOrigin = await hrClient
      .post("/api/hris/sop-documents")
      .send({ ...content(), stationId: null, positionId: null });
    expect(noOrigin.status).toBe(403);
  });
});
