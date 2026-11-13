// Kirimdev sender mapping, platform-written only (legend-nqxtb). Written from
// docs/briefs/legend-nqxtb.md ("Contract" and "Tests required"), not from the
// implementation. Real Express app, Better Auth and PostgreSQL; `fetch` is
// always a mock (never the real Kirimdev).
//
// Assumptions (the brief is silent):
// - Responses use the repo envelope: `{ data: KirimdevSenderMappingDto }` for
//   PUT, `{ data: KirimdevSenderMappingDto[] }` for GET, errors as
//   `{ error: { code } }`. The DTO carries id, tenantId, outletId,
//   phoneNumberId.
// - DELETE answers 200 or 204.
// - An unknown tenant, or an outlet of another tenant, answers 404 or 422.
// - The audit event for a mutation has `event->>'objectId'` = the mapping id
//   and `event->>'actorId'` = the signed-in Super Admin, in `audit_logs`
//   (same table the other platform services write to); upsert and delete use
//   different `action` values.
// - Fixtures use two dedicated active tenants (attacker "A", victim "B"), so
//   the seeded tenant's integrations are never touched. A tenant admin is
//   only needed in the seeded tenant, to prove the platform routes refuse it.
// - Mapping rows are inserted as the migration owner with the columns named in
//   the brief; the platform API is used for the behaviour under test.
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, TenantId } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  KirimdevSendError,
  createKirimdevMessagingProvider,
  kirimdevSenderFromPlatformMapping,
} from "../services/messaging-kirimdev.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});

const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const ROUTE = "/api/platform/messaging/kirimdev-senders";
const API_KEY = "kdv_live_" + "abcDEF123_-abcDEF123_-xy".slice(0, 24);

type Fixture = { tenantId: string; outletId: string; outletId2: string };
const tenantA = {} as Fixture;
const tenantB = {} as Fixture;
const tenantIds: string[] = [];
const adminUserIds: string[] = [];

const newNumber = () => `pn_${randomBytes(6).toString("hex")}`;

async function makeTenant(label: string): Promise<Fixture> {
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const legalEntityId = randomUUID();
  const outlets = [randomUUID(), randomUUID()];
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $4, $5)`,
    [
      tenantId,
      `uji-kdv-${label}-${randomBytes(4).toString("hex")}`,
      `Tenant ${label} Kirimdev`,
      JSON.stringify({
        maxOutlets: 5,
        maxActiveEmployees: 30,
        maxDevices: 10,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)`,
    [brandId, tenantId, `uji-kdv-${randomBytes(3).toString("hex")}`, label],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
    [legalEntityId, tenantId, `PT ${label}`],
  );
  for (const [index, outletId] of outlets.entries())
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji', '{}')`,
      [
        outletId,
        tenantId,
        brandId,
        legalEntityId,
        `${label}-0${index + 1}`,
        `Outlet ${label} ${index + 1}`,
      ],
    );
  tenantIds.push(tenantId);
  return { tenantId, outletId: outlets[0]!, outletId2: outlets[1]! };
}

async function platformAdmin(mfa = true) {
  const client = agent(app);
  const email = await signUp(client, "Platform Admin");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
  adminUserIds.push(userId);
  if (mfa) await verifySessionMfa(email);
  return { client, userId };
}

/** A tenant admin of the seeded tenant, MFA verified. Not a platform admin. */
async function tenantAdmin() {
  const client = agent(app);
  const email = await signUp(client, "Tenant Admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const assigned = await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'tenant_admin'`,
    [seededTenantId, userId],
  );
  if (assigned.rowCount !== 1) throw new Error("No tenant_admin role template");
  await verifySessionMfa(email);
  return client;
}

let fixtureActor = "";

/**
 * Runs owner-pool statements in one transaction with the platform write flag
 * on. A DB trigger refuses direct writes to kirimdev_sender_mappings unless
 * `app.kirimdev_sender_write` is 'on' (transaction-local).
 */
async function withWriteFlag<T>(
  run: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.kirimdev_sender_write','on',true)",
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

async function deleteMappingsOf(tenantIds: string[]) {
  await withWriteFlag((client) =>
    client.query(
      "DELETE FROM kirimdev_sender_mappings WHERE tenant_id = ANY($1)",
      [tenantIds],
    ),
  );
}

async function insertMapping(
  tenantId: string,
  outletId: string | null,
  phoneNumberId = newNumber(),
) {
  const id = randomUUID();
  await withWriteFlag((client) =>
    client.query(
      `INSERT INTO kirimdev_sender_mappings
         (id, tenant_id, outlet_id, phone_number_id, created_by_user_id,
          updated_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, now(), now())`,
      [id, tenantId, outletId, phoneNumberId, fixtureActor],
    ),
  );
  return { id, phoneNumberId };
}

async function mappingsOf(tenantId: string) {
  const { rows } = await owner.query<{
    id: string;
    outlet_id: string | null;
    phone_number_id: string;
  }>(
    "SELECT id, outlet_id, phone_number_id FROM kirimdev_sender_mappings WHERE tenant_id = $1 ORDER BY id",
    [tenantId],
  );
  return rows;
}

async function auditFor(objectId: string) {
  const { rows } = await owner.query<{
    action: string;
    actor_id: string;
    event: unknown;
  }>(
    `SELECT event->>'action' AS action, event->>'actorId' AS actor_id, event
       FROM audit_logs WHERE event->>'objectId' = $1 ORDER BY id`,
    [objectId],
  );
  return rows;
}

const contextFor = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
const resolve = (tenantId: string, outletId: string | null) =>
  kirimdevSenderFromPlatformMapping(db)(contextFor(tenantId), { outletId });

/** Runs `run` in a rolled-back legend_app transaction with tenant context. */
async function asTenant<T>(
  tenantId: string | null,
  run: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    if (tenantId !== null)
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  Object.assign(tenantA, await makeTenant("A"));
  Object.assign(tenantB, await makeTenant("B"));
  const fixture = await platformAdmin();
  fixtureActor = fixture.userId;
});

afterAll(async () => {
  const quiet = async (sql: string, params: unknown[]) => {
    try {
      await owner.query(sql, params);
    } catch {
      // Best effort: audit rows may keep a tenant alive.
    }
  };
  try {
    await deleteMappingsOf(tenantIds);
  } catch {
    // Best effort, same as the other cleanup.
  }
  await quiet("DELETE FROM tenant_integrations WHERE tenant_id = ANY($1)", [
    tenantIds,
  ]);
  await quiet("DELETE FROM outlets WHERE tenant_id = ANY($1)", [tenantIds]);
  await quiet("DELETE FROM legal_entities WHERE tenant_id = ANY($1)", [
    tenantIds,
  ]);
  await quiet("DELETE FROM brands WHERE tenant_id = ANY($1)", [tenantIds]);
  await quiet("DELETE FROM tenants WHERE id = ANY($1)", [tenantIds]);
  await quiet("DELETE FROM platform_admins WHERE user_id = ANY($1)", [
    adminUserIds,
  ]);
  await owner.end();
  await appPool.end();
});

async function reset() {
  await deleteMappingsOf(tenantIds);
  await owner.query(
    "DELETE FROM tenant_integrations WHERE tenant_id = ANY($1)",
    [tenantIds],
  );
  await owner.query("UPDATE tenants SET status = 'active' WHERE id = ANY($1)", [
    tenantIds,
  ]);
}

describe("legend-nqxtb 1: a tenant cannot claim another tenant's number", () => {
  it("refuses A's platform PUT with B's number (409, B unchanged, number not echoed)", async () => {
    await reset();
    const { client } = await platformAdmin();
    const number = newNumber();
    const victim = await client.put(ROUTE).set(originHeader).send({
      tenantId: tenantB.tenantId,
      outletId: null,
      phoneNumberId: number,
    });
    expect(victim.status).toBe(200);
    const before = await mappingsOf(tenantB.tenantId);
    expect(before).toHaveLength(1);

    for (const outletId of [null, tenantA.outletId]) {
      const claim = await client.put(ROUTE).set(originHeader).send({
        tenantId: tenantA.tenantId,
        outletId,
        phoneNumberId: number,
      });
      expect(claim.status).toBe(409);
      expect(claim.body.error.code).toBe("SENDER_ALREADY_MAPPED");
      expect(JSON.stringify(claim.body)).not.toContain(number);
    }

    expect(await mappingsOf(tenantB.tenantId)).toEqual(before);
    expect(await mappingsOf(tenantA.tenantId)).toEqual([]);
    expect(await resolve(tenantA.tenantId, null)).toBeNull();
    expect(await resolve(tenantB.tenantId, null)).toBe(number);
  });

  it("ignores tenant_integrations.config.phoneNumberId written by the tenant", async () => {
    await reset();
    const number = newNumber();
    await insertMapping(tenantB.tenantId, null, number);
    // B holds the number only in the platform mapping; A claims it in its own
    // (tenant-editable) WhatsApp integration config.
    await owner.query(
      `INSERT INTO tenant_integrations (tenant_id, provider, config, credentials_encrypted, status)
       VALUES ($1, 'whatsapp', $2, 'c2VhbGVkLXRlc3Q=', 'active')`,
      [tenantA.tenantId, JSON.stringify({ phoneNumberId: number })],
    );
    expect(await resolve(tenantA.tenantId, null)).toBeNull();
    expect(await resolve(tenantA.tenantId, tenantA.outletId)).toBeNull();
    expect(await resolve(tenantB.tenantId, null)).toBe(number);
  });
});

describe("legend-nqxtb 2: no mapping fails closed", () => {
  it("resolver returns null and send throws no_sender without calling fetch", async () => {
    await reset();
    expect(await resolve(tenantA.tenantId, null)).toBeNull();
    expect(await resolve(tenantA.tenantId, tenantA.outletId)).toBeNull();

    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    const provider = createKirimdevMessagingProvider({
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
      resolveSender: kirimdevSenderFromPlatformMapping(db),
      webhookSecrets: ["kirim-secret-current"],
      sleep: async () => {},
    });
    const context = contextFor(tenantA.tenantId);
    const error = await provider
      .send(context, {
        tenantId: tenantA.tenantId as TenantId,
        outletId: tenantA.outletId as OutletId,
        reference: "order-nqxtb-1",
        recipient: "628123456789",
        text: "Pesanan sudah siap diambil",
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(KirimdevSendError);
    expect((error as KirimdevSendError).code).toBe("no_sender");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends from the tenant's own mapped number only", async () => {
    await reset();
    const own = newNumber();
    await insertMapping(tenantA.tenantId, null, own);
    await insertMapping(tenantB.tenantId, null, newNumber());
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { id: "msg_1", status: "queued" } }),
          {
            status: 202,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    const provider = createKirimdevMessagingProvider({
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
      resolveSender: kirimdevSenderFromPlatformMapping(db),
      webhookSecrets: ["kirim-secret-current"],
      sleep: async () => {},
    });
    await provider.send(contextFor(tenantA.tenantId), {
      tenantId: tenantA.tenantId as TenantId,
      outletId: tenantA.outletId as OutletId,
      reference: "order-nqxtb-2",
      recipient: "628123456789",
      text: "Pesanan sudah siap diambil",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      `https://api.kirimdev.com/v1/${own}/messages`,
    );
  });
});

describe("legend-nqxtb resolver lookup order", () => {
  it("prefers the outlet mapping, falls back to the tenant-wide one", async () => {
    await reset();
    const wide = newNumber();
    const outlet = newNumber();
    await insertMapping(tenantA.tenantId, null, wide);
    await insertMapping(tenantA.tenantId, tenantA.outletId, outlet);
    expect(await resolve(tenantA.tenantId, tenantA.outletId)).toBe(outlet);
    expect(await resolve(tenantA.tenantId, tenantA.outletId2)).toBe(wide);
    expect(await resolve(tenantA.tenantId, null)).toBe(wide);
  });

  it("an outlet-only mapping does not serve other outlets or the tenant-wide lookup", async () => {
    await reset();
    const outlet = newNumber();
    await insertMapping(tenantA.tenantId, tenantA.outletId, outlet);
    expect(await resolve(tenantA.tenantId, tenantA.outletId)).toBe(outlet);
    expect(await resolve(tenantA.tenantId, tenantA.outletId2)).toBeNull();
    expect(await resolve(tenantA.tenantId, null)).toBeNull();
  });

  it.each(["suspended", "archived"])(
    "returns null for a %s tenant even with a mapping",
    async (status) => {
      await reset();
      await insertMapping(tenantA.tenantId, null);
      await owner.query("UPDATE tenants SET status = $2 WHERE id = $1", [
        tenantA.tenantId,
        status,
      ]);
      expect(await resolve(tenantA.tenantId, null)).toBeNull();
    },
  );
});

describe("legend-nqxtb 3: only a platform admin may use the routes", () => {
  it("answers 401 anonymous and 403 for a tenant admin on GET, PUT and DELETE", async () => {
    await reset();
    const existing = await insertMapping(tenantB.tenantId, null);
    expect(
      (await agent(app).get(`${ROUTE}?tenantId=${tenantB.tenantId}`)).status,
    ).toBe(401);

    // Other test files may map the seeded tenant in the shared DB, so
    // snapshot its rows and assert they are unchanged instead of expecting 0.
    const snapshotSeeded = async () =>
      (
        await owner.query(
          "SELECT id, phone_number_id FROM kirimdev_sender_mappings WHERE tenant_id = $1 ORDER BY id",
          [seededTenantId],
        )
      ).rows;
    const seededBefore = await snapshotSeeded();

    const member = await tenantAdmin();
    expect(
      (await member.get(`${ROUTE}?tenantId=${tenantB.tenantId}`)).status,
    ).toBe(403);
    expect(
      (
        await member.put(ROUTE).set(originHeader).send({
          tenantId: seededTenantId,
          outletId: null,
          phoneNumberId: newNumber(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await member
          .delete(`${ROUTE}/${existing.id}?tenantId=${tenantB.tenantId}`)
          .set(originHeader)
      ).status,
    ).toBe(403);

    expect(await mappingsOf(tenantB.tenantId)).toHaveLength(1);
    expect(await snapshotSeeded()).toEqual(seededBefore);
  });

  it("a legacy user.role admin who is not in platform_admins gets 403", async () => {
    const legacy = agent(app);
    await setRole(await signUp(legacy, "Legacy Admin"), "admin");
    expect(
      (await legacy.get(`${ROUTE}?tenantId=${tenantB.tenantId}`)).status,
    ).toBe(403);
  });
});

describe("legend-nqxtb 4: platform admin without session MFA is rejected", () => {
  it("answers 403 MFA_REQUIRED on GET, PUT and DELETE and changes nothing", async () => {
    await reset();
    const existing = await insertMapping(tenantB.tenantId, null);
    const { client } = await platformAdmin(false);

    const list = await client.get(`${ROUTE}?tenantId=${tenantB.tenantId}`);
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe("MFA_REQUIRED");
    const put = await client.put(ROUTE).set(originHeader).send({
      tenantId: tenantA.tenantId,
      outletId: null,
      phoneNumberId: newNumber(),
    });
    expect(put.status).toBe(403);
    expect(put.body.error.code).toBe("MFA_REQUIRED");
    const del = await client
      .delete(`${ROUTE}/${existing.id}?tenantId=${tenantB.tenantId}`)
      .set(originHeader);
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe("MFA_REQUIRED");

    expect(await mappingsOf(tenantA.tenantId)).toEqual([]);
    expect(await mappingsOf(tenantB.tenantId)).toHaveLength(1);
  });
});

describe("legend-nqxtb 5: tenant context cannot read another tenant's mapping (RLS)", () => {
  it("shows a tenant only its own rows and refuses tenant-context writes", async () => {
    await reset();
    const a = await insertMapping(tenantA.tenantId, null);
    const b = await insertMapping(tenantB.tenantId, null);

    const seenByA = await asTenant(tenantA.tenantId, (client) =>
      client.query<{ id: string; tenant_id: string }>(
        "SELECT id, tenant_id FROM kirimdev_sender_mappings",
      ),
    );
    expect(seenByA.rows.map((row) => row.id)).toEqual([a.id]);

    const aReadsB = await asTenant(tenantA.tenantId, (client) =>
      client.query("SELECT 1 FROM kirimdev_sender_mappings WHERE id = $1", [
        b.id,
      ]),
    );
    expect(aReadsB.rowCount).toBe(0);

    const seenByB = await asTenant(tenantB.tenantId, (client) =>
      client.query<{ id: string }>("SELECT id FROM kirimdev_sender_mappings"),
    );
    expect(seenByB.rows.map((row) => row.id)).toEqual([b.id]);

    // Fail closed without any tenant context: the repo's RLS raises 42501
    // (app.require_tenant_id) instead of returning zero rows.
    await expect(
      asTenant(null, (client) =>
        client.query("SELECT 1 FROM kirimdev_sender_mappings"),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    // The same through the app's withTenant helper.
    const viaHelper = await withTenant(db, contextFor(tenantA.tenantId), (tx) =>
      tx.execute(sql`SELECT id FROM kirimdev_sender_mappings`),
    );
    expect((viaHelper.rows as { id: string }[]).map((row) => row.id)).toEqual([
      a.id,
    ]);

    // Assumption: the brief says writes come from the platform context only;
    // the schema notes say generic tenant RLS. Only cross-tenant writes are
    // asserted here: tenant A cannot insert for, rewrite or delete B's rows.
    await expect(
      asTenant(tenantA.tenantId, (client) =>
        client.query(
          `INSERT INTO kirimdev_sender_mappings
             (id, tenant_id, outlet_id, phone_number_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, now(), now())`,
          [randomUUID(), tenantB.tenantId, tenantB.outletId, newNumber()],
        ),
      ),
    ).rejects.toThrow();
    for (const statement of [
      "UPDATE kirimdev_sender_mappings SET phone_number_id = 'pn_hijacked' WHERE id = $1",
      "DELETE FROM kirimdev_sender_mappings WHERE id = $1",
    ]) {
      const touched = await asTenant(tenantA.tenantId, (client) =>
        client.query(statement, [b.id]).then(
          (result) => result.rowCount ?? 0,
          () => 0,
        ),
      );
      expect(touched).toBe(0);
    }
    expect((await mappingsOf(tenantB.tenantId))[0]?.phone_number_id).toBe(
      b.phoneNumberId,
    );
  });

  it("rejects direct INSERT, UPDATE and DELETE on the tenant's own rows with 42501 unless the platform write flag is set", async () => {
    // Assumption: a DB trigger refuses writes unless
    // set_config('app.kirimdev_sender_write','on',true) is set in the same
    // transaction, even for the tenant's own rows (the brief: platform-written
    // only). Each statement gets its own transaction (an error aborts it).
    await reset();
    const own = await insertMapping(tenantA.tenantId, null);
    const insertSql = `INSERT INTO kirimdev_sender_mappings
         (id, tenant_id, outlet_id, phone_number_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())`;
    const insertParams = () => [
      randomUUID(),
      tenantA.tenantId,
      tenantA.outletId,
      newNumber(),
    ];
    const updateSql =
      "UPDATE kirimdev_sender_mappings SET phone_number_id = $2 WHERE id = $1";
    const deleteSql = "DELETE FROM kirimdev_sender_mappings WHERE id = $1";
    const flag = "SELECT set_config('app.kirimdev_sender_write','on',true)";

    await expect(
      asTenant(tenantA.tenantId, (client) =>
        client.query(insertSql, insertParams()),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asTenant(tenantA.tenantId, (client) =>
        client.query(updateSql, [own.id, newNumber()]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asTenant(tenantA.tenantId, (client) => client.query(deleteSql, [own.id])),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await mappingsOf(tenantA.tenantId)).toEqual([
      expect.objectContaining({
        id: own.id,
        phone_number_id: own.phoneNumberId,
      }),
    ]);

    // With the flag, the same statements are not refused by the trigger.
    const allowed = await asTenant(tenantA.tenantId, async (client) => {
      await client.query(flag);
      const inserted = await client.query(insertSql, insertParams());
      const updated = await client.query(updateSql, [own.id, newNumber()]);
      const deleted = await client.query(deleteSql, [own.id]);
      return [inserted.rowCount, updated.rowCount, deleted.rowCount];
    });
    expect(allowed).toEqual([1, 1, 1]);
  });

  it("the resolver under another tenant's context never returns this tenant's number", async () => {
    await reset();
    await insertMapping(tenantB.tenantId, null);
    expect(await resolve(tenantA.tenantId, null)).toBeNull();
    expect(await resolve(tenantA.tenantId, tenantB.outletId)).toBeNull();
  });
});

describe("legend-nqxtb 6: mutations are audited", () => {
  it("writes an audit event on upsert and on delete, by the signed-in admin", async () => {
    await reset();
    const { client, userId } = await platformAdmin();
    const number = newNumber();

    const created = await client.put(ROUTE).set(originHeader).send({
      tenantId: tenantA.tenantId,
      outletId: null,
      phoneNumberId: number,
    });
    expect(created.status).toBe(200);
    const id = created.body.data.id as string;
    expect(created.body.data).toMatchObject({
      tenantId: tenantA.tenantId,
      outletId: null,
      phoneNumberId: number,
    });
    const afterUpsert = await auditFor(id);
    expect(afterUpsert).toHaveLength(1);
    expect(afterUpsert[0]?.actor_id).toBe(userId);
    expect(afterUpsert[0]?.action).toBe("platform.kirimdev_sender.upserted");

    // Upsert is by tenant + outlet: the same key keeps its id.
    const replacement = newNumber();
    const updated = await client.put(ROUTE).set(originHeader).send({
      tenantId: tenantA.tenantId,
      outletId: null,
      phoneNumberId: replacement,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.id).toBe(id);
    expect(await mappingsOf(tenantA.tenantId)).toHaveLength(1);
    expect(await auditFor(id)).toHaveLength(2);

    const listed = await client.get(`${ROUTE}?tenantId=${tenantA.tenantId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((row: { id: string }) => row.id)).toEqual([id]);

    const removed = await client
      .delete(`${ROUTE}/${id}?tenantId=${tenantA.tenantId}`)
      .set(originHeader);
    expect([200, 204]).toContain(removed.status);
    expect(await mappingsOf(tenantA.tenantId)).toEqual([]);
    const afterDelete = await auditFor(id);
    expect(afterDelete).toHaveLength(3);
    expect(afterDelete[2]?.actor_id).toBe(userId);
    expect(afterDelete[2]?.action).toBe("platform.kirimdev_sender.deleted");
    expect(await resolve(tenantA.tenantId, null)).toBeNull();
  });

  it("a refused duplicate writes no mapping and no audit event", async () => {
    await reset();
    const { client, userId } = await platformAdmin();
    const number = newNumber();
    const victim = await insertMapping(tenantB.tenantId, null, number);
    const before = await auditFor(victim.id);
    const refused = await client.put(ROUTE).set(originHeader).send({
      tenantId: tenantA.tenantId,
      outletId: null,
      phoneNumberId: number,
    });
    expect(refused.status).toBe(409);
    expect(await auditFor(victim.id)).toEqual(before);
    const stray = await owner.query(
      `SELECT 1 FROM audit_logs
        WHERE event->>'actorId' = $1 AND event::text LIKE $2`,
      [userId, `%${number}%`],
    );
    expect(stray.rowCount).toBe(0);
  });
});

describe("legend-nqxtb platform API validation", () => {
  it("DELETE of an id that belongs to another tenant answers 404 and keeps the row", async () => {
    await reset();
    const b = await insertMapping(tenantB.tenantId, null);
    const { client } = await platformAdmin();
    const wrongTenant = await client
      .delete(`${ROUTE}/${b.id}?tenantId=${tenantA.tenantId}`)
      .set(originHeader);
    expect(wrongTenant.status).toBe(404);
    expect(await mappingsOf(tenantB.tenantId)).toHaveLength(1);
    const noTenant = await client.delete(`${ROUTE}/${b.id}`).set(originHeader);
    expect(noTenant.status).toBeGreaterThanOrEqual(400);
    expect(noTenant.status).toBeLessThan(500);
    expect(await mappingsOf(tenantB.tenantId)).toHaveLength(1);
  });

  it("lists only the requested tenant's mappings", async () => {
    await reset();
    const a = await insertMapping(tenantA.tenantId, null);
    const b = await insertMapping(tenantB.tenantId, null);
    const { client } = await platformAdmin();
    const forA = await client.get(`${ROUTE}?tenantId=${tenantA.tenantId}`);
    expect(forA.body.data.map((row: { id: string }) => row.id)).toEqual([a.id]);
    const forB = await client.get(`${ROUTE}?tenantId=${tenantB.tenantId}`);
    expect(forB.body.data.map((row: { id: string }) => row.id)).toEqual([b.id]);
    // The tenant filter is required: a bare list is a validation error.
    const bare = await client.get(ROUTE);
    expect(bare.status).toBeGreaterThanOrEqual(400);
    expect(bare.status).toBeLessThan(500);
  });

  it("refuses an unknown tenant, an outlet of another tenant, a malformed number and an untrusted origin", async () => {
    await reset();
    const { client } = await platformAdmin();
    const put = (body: Record<string, unknown>, headers = originHeader) =>
      client.put(ROUTE).set(headers).send(body);

    const unknownTenant = await put({
      tenantId: randomUUID(),
      outletId: null,
      phoneNumberId: newNumber(),
    });
    expect([404, 422]).toContain(unknownTenant.status);

    const foreignOutlet = await put({
      tenantId: tenantA.tenantId,
      outletId: tenantB.outletId,
      phoneNumberId: newNumber(),
    });
    expect([404, 422]).toContain(foreignOutlet.status);

    for (const phoneNumberId of ["pn/other", "pn id", "", "p".repeat(65)]) {
      const bad = await put({
        tenantId: tenantA.tenantId,
        outletId: null,
        phoneNumberId,
      });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(bad.status).toBeLessThan(500);
    }

    const extra = await put({
      tenantId: tenantA.tenantId,
      outletId: null,
      phoneNumberId: newNumber(),
      extra: true,
    });
    expect(extra.status).toBeGreaterThanOrEqual(400);
    expect(extra.status).toBeLessThan(500);

    const untrusted = await put(
      {
        tenantId: tenantA.tenantId,
        outletId: null,
        phoneNumberId: newNumber(),
      },
      { Origin: "https://untrusted.example" } as typeof originHeader,
    );
    expect(untrusted.status).toBe(403);

    expect(await mappingsOf(tenantA.tenantId)).toEqual([]);
  });
});
