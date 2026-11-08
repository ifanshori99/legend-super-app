// Tenant PPh 21 policy HTTP API (bead legend-y4wp; contract
// `@starter/shared/hris/payroll` endpoints.ts). Runs the real Express app
// (router mounted at /api/hris/payroll/pph21-policies by routes/index.ts),
// Better Auth, the RBAC resolver and PostgreSQL against the seeded Cafe Legend
// tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  type BusinessDate,
} from "@starter/shared/core";
import { DEFAULT_PPH21_POLICY } from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const BASE = "/api/hris/payroll/pph21-policies";
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdVersions: string[] = [];

const today = businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);
const plusDays = (date: BusinessDate, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10) as BusinessDate;
const key = () => `pph21-api-${randomUUID()}`;

const PARAMETERS = {
  ...DEFAULT_PPH21_POLICY,
  roundingMode: "down",
};
const body = (effectiveFrom: BusinessDate, idempotencyKey = key()) => ({
  effectiveFrom,
  parameters: PARAMETERS,
  reason: "Saran konsultan pajak (uji API)",
  idempotencyKey,
});

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
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
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `PPh21 api ${roleId.slice(0, 8)}`,
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
let viewerClient: Client;
let strangerClient: Client;

beforeAll(async () => {
  const admin = await signedInClient("PPh21 admin API");
  await grantRole(admin.userId, ["payroll.view", "payroll.run"]);
  adminClient = admin.client;
  const viewer = await signedInClient("PPh21 viewer API");
  await grantRole(viewer.userId, ["payroll.view"]);
  viewerClient = viewer.client;
  const stranger = await signedInClient("PPh21 stranger API");
  await grantRole(stranger.userId, ["hr.employee.view"]);
  strangerClient = stranger.client;
  // Versions of earlier runs would change what "in force" answers.
  await asTenant((db) =>
    db.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );
});

afterAll(async () => {
  await asTenant(async (db) => {
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'pph21-api-%'",
      [tenant.id],
    );
    await db.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]);
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenant.id, createdUsers],
    );
    await db.query("DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)", [
      tenant.id,
      createdRoles,
    ]);
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("PPh 21 policy API: create, list, in-force", () => {
  it("[PAYR-02] answers the default while empty, then creates, lists and resolves by date", async () => {
    const empty = await viewerClient.get(`${BASE}/in-force`);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toMatchObject({
      source: "default",
      version: null,
      versionId: null,
    });

    const effectiveFrom = plusDays(today, 30);
    const created = await adminClient
      .post(BASE)
      .set(originHeader)
      .send(body(effectiveFrom));
    expect(created.status).toBe(201);
    createdVersions.push(created.body.data.id);
    expect(created.body.data).toMatchObject({
      tenantId: tenant.id,
      version: 1,
      effectiveFrom,
      parameters: PARAMETERS,
    });

    const list = await viewerClient.get(BASE);
    expect(list.status).toBe(200);
    expect(list.body.data.map((row: { id: string }) => row.id)).toEqual([
      created.body.data.id,
    ]);

    const before = await viewerClient.get(
      `${BASE}/in-force?date=${plusDays(effectiveFrom, -1)}`,
    );
    expect(before.body.data.source).toBe("default");
    const from = await viewerClient.get(
      `${BASE}/in-force?date=${effectiveFrom}`,
    );
    expect(from.status).toBe(200);
    expect(from.body.data).toMatchObject({
      source: "version",
      version: 1,
      effectiveFrom,
      versionId: created.body.data.id,
      parameters: PARAMETERS,
    });
  });
});

describe("PPh 21 policy API: permission and input", () => {
  it("[AUTH] answers 401 anonymous, 403 without payroll.run (write) or payroll.view (read)", async () => {
    expect((await agent(app).get(BASE)).status).toBe(401);
    const noRun = await viewerClient
      .post(BASE)
      .set(originHeader)
      .send(body(plusDays(today, 50)));
    expect(noRun.status).toBe(403);
    expect((await strangerClient.get(BASE)).status).toBe(403);
    expect((await strangerClient.get(`${BASE}/in-force`)).status).toBe(403);
  });

  it("[TEN-02] rejects a tenantId in the body with 422", async () => {
    const response = await adminClient
      .post(BASE)
      .set(originHeader)
      .send({ ...body(plusDays(today, 51)), tenantId: tenant.id });
    expect(response.status).toBe(422);
  });

  it("rejects an unknown query key and a bad date with 422", async () => {
    expect(
      (await viewerClient.get(`${BASE}/in-force?tenantId=${tenant.id}`)).status,
    ).toBe(422);
    expect((await viewerClient.get(`${BASE}/in-force?date=nope`)).status).toBe(
      422,
    );
  });

  it("rejects a mutation without Origin with 403", async () => {
    const response = await adminClient
      .post(BASE)
      .send(body(plusDays(today, 52)));
    expect(response.status).toBe(403);
  });
});

describe("PPh 21 policy API: conflicts and idempotency", () => {
  it("answers PAYROLL_PPH21_POLICY_CONFLICT (409) for a past date and a taken date", async () => {
    const past = await adminClient
      .post(BASE)
      .set(originHeader)
      .send(body(plusDays(today, -1)));
    expect(past.status).toBe(409);
    expect(past.body.error.code).toBe("PAYROLL_PPH21_POLICY_CONFLICT");

    const date = plusDays(today, 60);
    const first = await adminClient
      .post(BASE)
      .set(originHeader)
      .send(body(date));
    expect(first.status).toBe(201);
    createdVersions.push(first.body.data.id);
    const taken = await adminClient
      .post(BASE)
      .set(originHeader)
      .send(body(date));
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("PAYROLL_PPH21_POLICY_CONFLICT");
  });

  it("replays the first 201 for the same key and body, and refuses the key with another body", async () => {
    const idempotencyKey = key();
    const date = plusDays(today, 70);
    const first = await adminClient
      .post(BASE)
      .set(originHeader)
      .send(body(date, idempotencyKey));
    expect(first.status).toBe(201);
    createdVersions.push(first.body.data.id);

    const replay = await adminClient
      .post(BASE)
      .set(originHeader)
      .send(body(date, idempotencyKey));
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    const rows = await asTenant((db) =>
      db.query("SELECT id FROM payroll_pph21_policies WHERE id = $1", [
        first.body.data.id,
      ]),
    );
    expect(rows.rowCount).toBe(1);
    const all = await viewerClient.get(BASE);
    expect(
      all.body.data.filter(
        (row: { effectiveFrom: string }) => row.effectiveFrom === date,
      ),
    ).toHaveLength(1);

    const other = await adminClient
      .post(BASE)
      .set(originHeader)
      .send(body(plusDays(today, 71), idempotencyKey));
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("[append-only] has no PUT, PATCH or DELETE route", async () => {
    const id = createdVersions[0]!;
    for (const method of ["put", "patch", "delete"] as const) {
      const response = await adminClient[method](`${BASE}/${id}`).set(
        originHeader,
      );
      expect(response.status, method).toBe(404);
    }
    expect((await adminClient.put(BASE).set(originHeader)).status).toBe(404);
    expect((await adminClient.delete(BASE).set(originHeader)).status).toBe(404);
  });
});
