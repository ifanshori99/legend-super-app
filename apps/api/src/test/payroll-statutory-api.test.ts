// Statutory table HTTP API (bead legend-gfcr; contract `@starter/shared/hris/
// payroll` endpoints.ts). Runs the real Express app (router mounted at
// /api/hris/payroll/statutory-tables by routes/index.ts), Better Auth, the
// RBAC resolver and PostgreSQL against the seeded Cafe Legend tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  type BusinessDate,
} from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const otherTenant = randomUUID();
const BASE = "/api/hris/payroll/statutory-tables";
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];

const today = businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);
const plusDays = (date: BusinessDate, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10) as BusinessDate;
const key = () => `statutory-api-${randomUUID()}`;

const THR = { minTenureMonths: 3, fullTenureMonths: 12, roundingMode: "down" };
const BPJS = {
  employerRateBp: 370,
  employeeRateBp: 200,
  wageCapIdr: 12_000_000,
  wageFloorIdr: null,
  roundingMode: "half_up",
};
const body = (
  effectiveFrom: BusinessDate,
  draft: unknown = { type: "thr", parameters: THR },
  idempotencyKey = key(),
) => ({
  draft,
  effectiveFrom,
  legalBasis: "PP 36/2021 (uji API)",
  idempotencyKey,
});

async function asTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
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

/** Published rows are immutable (trigger), so cleanup skips the trigger. */
async function clearRates() {
  for (const id of [tenant.id, otherTenant])
    await asTenant(id, async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("DELETE FROM statutory_rates WHERE tenant_id = $1", [
        id,
      ]);
    });
}

async function signedInClient(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function grantRole(userId: string, permissions: string[]) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(tenant.id, async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Statutory api ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.id, userId, roleId],
    );
  });
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let adminClient: Client;
let adminUserId: string;
let viewerClient: Client;
let strangerClient: Client;
let foreignId: string;

const create = async (
  effectiveFrom: BusinessDate,
  draft?: unknown,
  idempotencyKey?: string,
) =>
  adminClient
    .post(BASE)
    .set(originHeader)
    .send(body(effectiveFrom, draft, idempotencyKey));
const act = (id: string, action: "publish" | "archive") =>
  adminClient
    .post(`${BASE}/${id}/${action}`)
    .set(originHeader)
    .send({ idempotencyKey: key() });

beforeAll(async () => {
  const admin = await signedInClient("Statutory admin API");
  await grantRole(admin.userId, ["payroll.view", "payroll.run"]);
  adminClient = admin.client;
  adminUserId = admin.userId;
  const viewer = await signedInClient("Statutory viewer API");
  await grantRole(viewer.userId, ["payroll.view"]);
  viewerClient = viewer.client;
  const stranger = await signedInClient("Statutory stranger API");
  await grantRole(stranger.userId, ["hr.employee.view"]);
  strangerClient = stranger.client;

  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Statutory API tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `statutory-api-${otherTenant.slice(0, 8)}`, tenant.id],
  );
  await clearRates();
  foreignId = randomUUID();
  await asTenant(otherTenant, (db) =>
    db.query(
      `INSERT INTO statutory_rates
         (id, tenant_id, type, version, effective_from, status, legal_basis, parameters, created_by)
       VALUES ($1, $2, 'thr', 1, $3, 'draft', 'Tenant B', $4, $5)`,
      [
        foreignId,
        otherTenant,
        plusDays(today, 400),
        JSON.stringify(THR),
        adminUserId,
      ],
    ),
  );
});

afterAll(async () => {
  await clearRates();
  await asTenant(tenant.id, async (db) => {
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'statutory-api-%'",
      [tenant.id],
    );
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenant.id, createdUsers],
    );
    await db.query("DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)", [
      tenant.id,
      createdRoles,
    ]);
  });
  // Audit rows are append-only: a tenant that was audited stays in place.
  const audited = await owner.query(
    "SELECT 1 FROM audit_logs WHERE tenant_id = $1 LIMIT 1",
    [otherTenant],
  );
  if ((audited.rowCount ?? 0) === 0)
    await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("statutory API: permission and input", () => {
  it("[AUTH] answers 401 anonymous, 403 without payroll.run (write) or payroll.view (read)", async () => {
    expect((await agent(app).get(BASE)).status).toBe(401);
    const noRun = await viewerClient
      .post(BASE)
      .set(originHeader)
      .send(body(plusDays(today, 10)));
    expect(noRun.status).toBe(403);
    const id = randomUUID();
    for (const request of [
      () =>
        viewerClient.put(`${BASE}/${id}`).set(originHeader).send(body(today)),
      () =>
        viewerClient
          .post(`${BASE}/${id}/publish`)
          .set(originHeader)
          .send({ idempotencyKey: key() }),
      () =>
        viewerClient
          .post(`${BASE}/${id}/archive`)
          .set(originHeader)
          .send({ idempotencyKey: key() }),
    ])
      expect((await request()).status).toBe(403);
    expect((await strangerClient.get(BASE)).status).toBe(403);
    expect((await strangerClient.get(`${BASE}/${id}`)).status).toBe(403);
  });

  it("[TEN-02] rejects tenantId, unknown keys and a wrong parameter shape with 422", async () => {
    const withTenant = await adminClient
      .post(BASE)
      .set(originHeader)
      .send({ ...body(plusDays(today, 11)), tenantId: tenant.id });
    expect(withTenant.status).toBe(422);
    const unknownKey = await adminClient
      .post(BASE)
      .set(originHeader)
      .send({ ...body(plusDays(today, 11)), extra: 1 });
    expect(unknownKey.status).toBe(422);
    const unknownParam = await create(plusDays(today, 11), {
      type: "thr",
      parameters: { ...THR, surprise: true },
    });
    expect(unknownParam.status).toBe(422);
    const wrongShape = await create(plusDays(today, 11), {
      type: "thr",
      parameters: BPJS,
    });
    expect(wrongShape.status).toBe(422);
    const badDate = await adminClient
      .post(BASE)
      .set(originHeader)
      .send({ ...body(plusDays(today, 11)), effectiveFrom: "nope" });
    expect(badDate.status).toBe(422);
  });

  it("rejects an unknown query key, a bad type, a bad id and a bad cursor with 422", async () => {
    for (const path of [
      `${BASE}?tenantId=${tenant.id}`,
      `${BASE}?type=nope`,
      `${BASE}?cursor=not-a-cursor`,
      `${BASE}/not-a-uuid`,
    ])
      expect((await viewerClient.get(path)).status, path).toBe(422);
  });

  it("rejects a mutation without Origin with 403", async () => {
    const response = await adminClient
      .post(BASE)
      .send(body(plusDays(today, 12)));
    expect(response.status).toBe(403);
  });
});

describe("statutory API: create, read, update, list", () => {
  it("creates a draft with the next version per type, then reads it back", async () => {
    const date = plusDays(today, 20);
    const first = await create(date);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      tenantId: tenant.id,
      type: "thr",
      status: "draft",
      effectiveFrom: date,
      legalBasis: "PP 36/2021 (uji API)",
      parameters: THR,
      publishedAt: null,
      publishedBy: null,
    });
    const second = await create(plusDays(today, 21));
    expect(second.status).toBe(201);
    expect(second.body.data.version).toBe(first.body.data.version + 1);
    const other = await create(plusDays(today, 20), {
      type: "jht",
      parameters: BPJS,
    });
    expect(other.status).toBe(201);
    expect(other.body.data.version).toBe(1);

    const got = await viewerClient.get(`${BASE}/${first.body.data.id}`);
    expect(got.status).toBe(200);
    expect(got.body.data).toEqual(first.body.data);
  });

  it("lists by type with cursor pages, newest effective date first", async () => {
    await create(plusDays(today, 30));
    await create(plusDays(today, 31));
    const filtered = await viewerClient.get(`${BASE}?type=thr&limit=100`);
    expect(filtered.status).toBe(200);
    const rows = filtered.body.data as {
      id: string;
      type: string;
      effectiveFrom: string;
    }[];
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((row) => row.type === "thr")).toBe(true);
    const dates = rows.map((row) => row.effectiveFrom);
    expect(dates).toEqual([...dates].sort().reverse());

    const pageOne = await viewerClient.get(`${BASE}?type=thr&limit=2`);
    expect(pageOne.body.data).toHaveLength(2);
    expect(pageOne.body.meta.nextCursor).toEqual(expect.any(String));
    const pageTwo = await viewerClient.get(
      `${BASE}?type=thr&limit=2&cursor=${pageOne.body.meta.nextCursor}`,
    );
    expect(pageTwo.status).toBe(200);
    const seen = [...pageOne.body.data, ...pageTwo.body.data].map(
      (row: { id: string }) => row.id,
    );
    expect(new Set(seen).size).toBe(4);
    expect(seen).toEqual(rows.slice(0, 4).map((row) => row.id));
  });

  it("updates a draft (parameters, date, legal basis) but never its type", async () => {
    const created = await create(plusDays(today, 40));
    const id = created.body.data.id as string;
    const date = plusDays(today, 41);
    const updated = await adminClient
      .put(`${BASE}/${id}`)
      .set(originHeader)
      .send({
        ...body(date, {
          type: "thr",
          parameters: { ...THR, minTenureMonths: 1 },
        }),
        legalBasis: "Perubahan",
      });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({
      id,
      version: created.body.data.version,
      status: "draft",
      effectiveFrom: date,
      legalBasis: "Perubahan",
      parameters: { ...THR, minTenureMonths: 1 },
    });
    const retype = await adminClient
      .put(`${BASE}/${id}`)
      .set(originHeader)
      .send(body(date, { type: "jht", parameters: BPJS }));
    expect(retype.status).toBe(422);
    const unknown = await adminClient
      .put(`${BASE}/${randomUUID()}`)
      .set(originHeader)
      .send(body(date));
    expect(unknown.status).toBe(404);
  });

  it("replays the first response for the same key and body, refuses the key with another body", async () => {
    const idempotencyKey = key();
    const date = plusDays(today, 50);
    const first = await create(date, undefined, idempotencyKey);
    expect(first.status).toBe(201);
    const replay = await create(date, undefined, idempotencyKey);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    const rows = await asTenant(tenant.id, (db) =>
      db.query("SELECT id FROM statutory_rates WHERE effective_from = $1", [
        date,
      ]),
    );
    expect(rows.rowCount).toBe(1);
    const other = await create(plusDays(today, 51), undefined, idempotencyKey);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("re-parses stored parameters on read and fails loudly on drift", async () => {
    const created = await create(plusDays(today, 60));
    const id = created.body.data.id as string;
    // A draft may be edited by SQL (trigger allows it); the shape is wrong.
    await asTenant(tenant.id, (db) =>
      db.query(
        `UPDATE statutory_rates SET parameters = '{"minTenureMonths": 99999}' WHERE id = $1`,
        [id],
      ),
    );
    const response = await viewerClient.get(`${BASE}/${id}`);
    expect(response.status).toBe(422);
    // The drifted draft would fail every later list of the tenant.
    await asTenant(tenant.id, (db) =>
      db.query("DELETE FROM statutory_rates WHERE id = $1", [id]),
    );
  });
});

describe("statutory API: publish, archive and immutability", () => {
  it("publishes a draft with the server clock, then refuses every later change with 409", async () => {
    const created = await create(plusDays(today, 70));
    const id = created.body.data.id as string;
    const published = await act(id, "publish");
    expect(published.status).toBe(200);
    expect(published.body.data).toMatchObject({
      id,
      status: "published",
      publishedBy: adminUserId,
    });
    expect(Date.parse(published.body.data.publishedAt)).not.toBeNaN();

    const update = await adminClient
      .put(`${BASE}/${id}`)
      .set(originHeader)
      .send(body(plusDays(today, 71)));
    expect(update.status).toBe(409);
    expect(update.body.error.code).toBe("PAYROLL_STATUTORY_TABLE_IMMUTABLE");
    const again = await act(id, "publish");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("PAYROLL_STATUTORY_TABLE_IMMUTABLE");
    const archive = await act(id, "archive");
    expect(archive.status).toBe(409);
    expect(archive.body.error.code).toBe("PAYROLL_STATUTORY_TABLE_IMMUTABLE");
    const stored = await viewerClient.get(`${BASE}/${id}`);
    expect(stored.body.data).toEqual(published.body.data);
  });

  it("refuses to publish a backdated version with PAYROLL_STATUTORY_TABLE_BACKDATED", async () => {
    const created = await create(plusDays(today, -1));
    expect(created.status).toBe(201);
    const response = await act(created.body.data.id, "publish");
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("PAYROLL_STATUTORY_TABLE_BACKDATED");
    const stored = await viewerClient.get(`${BASE}/${created.body.data.id}`);
    expect(stored.body.data.status).toBe("draft");
  });

  it("refuses a second published version for the same type and effective date with 409", async () => {
    const date = plusDays(today, 80);
    const first = await create(date);
    const second = await create(date);
    expect((await act(first.body.data.id, "publish")).status).toBe(200);
    const clash = await act(second.body.data.id, "publish");
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("PAYROLL_STATUTORY_TABLE_AMBIGUOUS");
    // Another type on the same date is not a clash.
    const jht = await create(date, { type: "jht", parameters: BPJS });
    expect((await act(jht.body.data.id, "publish")).status).toBe(200);
  });

  it("archives a draft once; an archived version cannot be edited or published", async () => {
    const created = await create(plusDays(today, 90));
    const id = created.body.data.id as string;
    const archived = await act(id, "archive");
    expect(archived.status).toBe(200);
    expect(archived.body.data).toMatchObject({
      status: "archived",
      publishedAt: null,
      publishedBy: null,
    });
    const update = await adminClient
      .put(`${BASE}/${id}`)
      .set(originHeader)
      .send(body(plusDays(today, 91)));
    expect(update.status).toBe(409);
    expect(update.body.error.code).toBe("PAYROLL_STATUTORY_TABLE_IMMUTABLE");
    const publish = await act(id, "publish");
    expect(publish.status).toBe(409);
    expect(publish.body.error.code).toBe("PAYROLL_INVALID_TRANSITION");
    const again = await act(id, "archive");
    expect(again.status).toBe(409);
  });

  it("[PAYR-02] refuses a direct SQL change (23514) or delete (42501) of a published row as the app role", async () => {
    const created = await create(plusDays(today, 100));
    const id = created.body.data.id as string;
    expect((await act(id, "publish")).status).toBe(200);
    // DELETE is revoked from the app role (42501) before the trigger runs.
    for (const [statement, code] of [
      [
        "UPDATE statutory_rates SET legal_basis = 'diubah' WHERE id = $1",
        "23514",
      ],
      ["UPDATE statutory_rates SET status = 'archived' WHERE id = $1", "23514"],
      ["UPDATE statutory_rates SET parameters = '{}' WHERE id = $1", "23514"],
      ["DELETE FROM statutory_rates WHERE id = $1", "42501"],
    ] as const) {
      const result = await asTenant(tenant.id, async (client) => {
        await client.query("SET LOCAL ROLE legend_app");
        try {
          await client.query(statement, [id]);
          return null;
        } catch (error) {
          return error as { code?: string };
        }
      });
      expect(result?.code, statement).toBe(code);
    }
  });
});

describe("statutory API: tenant isolation", () => {
  it("answers 404 for another tenant's row on every endpoint and keeps it out of the list", async () => {
    expect((await viewerClient.get(`${BASE}/${foreignId}`)).status).toBe(404);
    const update = await adminClient
      .put(`${BASE}/${foreignId}`)
      .set(originHeader)
      .send(body(plusDays(today, 410)));
    expect(update.status).toBe(404);
    expect((await act(foreignId, "publish")).status).toBe(404);
    expect((await act(foreignId, "archive")).status).toBe(404);
    const list = await viewerClient.get(`${BASE}?limit=100`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(
      list.body.data.some((row: { id: string }) => row.id === foreignId),
    ).toBe(false);
    const stored = await asTenant(otherTenant, (db) =>
      db.query(
        "SELECT status, legal_basis FROM statutory_rates WHERE id = $1",
        [foreignId],
      ),
    );
    expect(stored.rows[0]).toEqual({
      status: "draft",
      legal_basis: "Tenant B",
    });
  });
});
