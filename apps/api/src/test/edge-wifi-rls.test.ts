// TEN-01/TEN-02 FAC-13 (legend-hsk): wifi_device_grants is tenant + outlet
// owned and forced through RLS; the request of a grant (its provider
// reference) is immutable, a terminal status is final, and the raw controller
// id (MAC) only lives on live rows. Raw checks run as the restricted
// legend_app role with explicit settings; fixtures as the migration owner.
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const otherTenant = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

async function asAppRole<T>(
  settings: { tenant: string; outlets: string },
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [settings.tenant, settings.outlets],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Fixtures as the migration owner with the tenant settings (FORCE RLS). */
async function asOwner(
  text: string,
  params: unknown[] = [],
  tenant = tenantId,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Owner-seeded second tenant with one outlet (outlet FK across tenants). */
async function seedOtherTenantOutlet() {
  const [brandId, legalEntityId, outletId] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const tag = otherTenant.slice(0, 8);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Wifi', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      otherTenant,
      `uji-wifi-${tag}`,
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
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, otherTenant],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)",
    [legalEntityId, otherTenant],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, 'W-01', 'Outlet Uji Wifi', 'Jl. Uji', '{}')`,
    [outletId, otherTenant, brandId, legalEntityId],
  );
  return outletId;
}

const deviceHash = (tenant: string, mac: string) =>
  createHash("sha256").update(`${tenant}:${mac}`).digest("hex");
const newMac = () =>
  Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0"),
  ).join(":");

const insertPendingSql = `INSERT INTO wifi_device_grants
  (id, tenant_id, outlet_id, wifi_session_id, device_hash, controller_device_id,
   speed_tier, bandwidth_kbps, base_bandwidth_kbps, duration_seconds, status,
   renew_until, requested_at)
  VALUES ($1, $2, $3, $4, $5, $6, 'full', 20000, 2000, 3900, 'pending',
          now() + interval '8 hours', now())`;

const insertActiveSql = `INSERT INTO wifi_device_grants
  (id, tenant_id, outlet_id, wifi_session_id, device_hash, controller_device_id,
   speed_tier, bandwidth_kbps, base_bandwidth_kbps, duration_seconds, status,
   renew_until, requested_at, authorized_at, expires_at)
  VALUES ($1, $2, $3, $4, $5, $6, 'full', 20000, 2000, 3900, 'active',
          now() + interval '8 hours', now(), now(), now() + interval '65 minutes')`;

/** One live grant on (tenant, outlet) for a fresh device. */
async function seedGrant(
  sql: string,
  options: { tenant?: string; outlet?: string; session?: string } = {},
) {
  const id = randomUUID();
  const tenant = options.tenant ?? tenantId;
  const mac = newMac();
  const hash = deviceHash(tenant, mac);
  const session = options.session ?? randomUUID();
  await asOwner(
    sql,
    [id, tenant, options.outlet ?? outletA, session, hash, mac],
    tenant,
  );
  return { id, hash, mac, session };
}

let otherOutlet: string;
let grantA: Awaited<ReturnType<typeof seedGrant>>;
let grantOther: Awaited<ReturnType<typeof seedGrant>>;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  otherOutlet = await seedOtherTenantOutlet();
  grantA = await seedGrant(insertActiveSql);
  grantOther = await seedGrant(insertActiveSql, {
    tenant: otherTenant,
    outlet: otherOutlet,
  });
});

afterAll(async () => {
  await owner.end();
});

describe("legend-hsk wifi_device_grants RLS", () => {
  it("TEN-02 wifi_device_grants has forced restrictive tenant and outlet policies", async () => {
    const result = await owner.query(
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'tenant_isolation' AND NOT p.polpermissive) AS tenant,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'outlet_isolation' AND NOT p.polpermissive) AS outlet
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'wifi_device_grants'`,
    );
    expect(result.rows).toEqual([
      { enabled: true, forced: true, tenant: true, outlet: true },
    ]);
  });

  it("TEN-01 the owning tenant and outlet see the row", async () => {
    const own = await asAppRole({ tenant: tenantId, outlets: "*" }, (c) =>
      c.query("SELECT id FROM wifi_device_grants WHERE id = $1", [grantA.id]),
    );
    expect(own.rows).toEqual([{ id: grantA.id }]);
    const scoped = await asAppRole(
      { tenant: tenantId, outlets: JSON.stringify([outletA]) },
      (c) =>
        c.query("SELECT id FROM wifi_device_grants WHERE id = $1", [grantA.id]),
    );
    expect(scoped.rows).toEqual([{ id: grantA.id }]);
  });

  it("TEN-01 tenant B cannot see tenant A rows, and the reverse", async () => {
    const asB = await asAppRole({ tenant: otherTenant, outlets: "*" }, (c) =>
      c.query("SELECT id FROM wifi_device_grants"),
    );
    expect(asB.rows).toEqual([{ id: grantOther.id }]);
    const asA = await asAppRole({ tenant: tenantId, outlets: "*" }, (c) =>
      c.query("SELECT id FROM wifi_device_grants WHERE id = $1", [
        grantOther.id,
      ]),
    );
    expect(asA.rows).toEqual([]);
  });

  it("TEN-01 outlet A rows are invisible under an outlet B scope", async () => {
    const outletOnlyB = await asAppRole(
      { tenant: tenantId, outlets: JSON.stringify([outletB]) },
      (c) =>
        c.query("SELECT id FROM wifi_device_grants WHERE id = $1", [grantA.id]),
    );
    expect(outletOnlyB.rows).toEqual([]);
  });

  it("TEN-01 tenant B cannot update or delete tenant A rows", async () => {
    const result = await asAppRole({ tenant: otherTenant, outlets: "*" }, (c) =>
      c.query(
        `UPDATE wifi_device_grants SET attempt_count = attempt_count + 1,
           last_error_code = 'X' WHERE id = $1`,
        [grantA.id],
      ),
    );
    expect(result.rowCount).toBe(0);
    const deleted = await asAppRole(
      { tenant: otherTenant, outlets: "*" },
      (c) =>
        c.query("DELETE FROM wifi_device_grants WHERE id = $1", [grantA.id]),
    );
    expect(deleted.rowCount).toBe(0);
    const outletScoped = await asAppRole(
      { tenant: tenantId, outlets: JSON.stringify([outletB]) },
      (c) =>
        c.query(
          "UPDATE wifi_device_grants SET attempt_count = 9 WHERE id = $1",
          [grantA.id],
        ),
    );
    expect(outletScoped.rowCount).toBe(0);
    const row = await asOwner(
      "SELECT attempt_count FROM wifi_device_grants WHERE id = $1",
      [grantA.id],
    );
    expect(row.rows).toEqual([{ attempt_count: 0 }]);
  });

  it("TEN-01 WITH CHECK refuses a foreign tenant_id and an out-of-scope outlet", async () => {
    const mac = newMac();
    await expect(
      asAppRole({ tenant: otherTenant, outlets: "*" }, (c) =>
        c.query(insertPendingSql, [
          randomUUID(),
          tenantId,
          outletA,
          randomUUID(),
          deviceHash(tenantId, mac),
          mac,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asAppRole({ tenant: tenantId, outlets: JSON.stringify([outletB]) }, (c) =>
        c.query(insertPendingSql, [
          randomUUID(),
          tenantId,
          outletA,
          randomUUID(),
          deviceHash(tenantId, mac),
          mac,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("TEN-01 the app role inserts a grant for its own tenant and outlet", async () => {
    const mac = newMac();
    const inserted = await asAppRole(
      { tenant: tenantId, outlets: JSON.stringify([outletA]) },
      (c) =>
        c.query(insertPendingSql, [
          randomUUID(),
          tenantId,
          outletA,
          randomUUID(),
          deviceHash(tenantId, mac),
          mac,
        ]),
    );
    expect(inserted.rowCount).toBe(1);
  });

  it("TEN-03 an outlet of another tenant is refused by the composite FK", async () => {
    const mac = newMac();
    await expect(
      asOwner(insertPendingSql, [
        randomUUID(),
        tenantId,
        otherOutlet,
        randomUUID(),
        deviceHash(tenantId, mac),
        mac,
      ]),
    ).rejects.toThrow(/wifi_device_grants_outlet_fk/);
  });

  it("legend-hsk the request columns of a grant are immutable", async () => {
    const grant = await seedGrant(insertActiveSql);
    const changes: Array<[string, string]> = [
      ["id", `'${randomUUID()}'`],
      ["tenant_id", `'${otherTenant}'`],
      ["outlet_id", `'${outletB}'`],
      ["wifi_session_id", `'${randomUUID()}'`],
      ["device_hash", `'${deviceHash(tenantId, newMac())}'`],
      ["speed_tier", "'base'"],
      ["bandwidth_kbps", "bandwidth_kbps + 1"],
      ["base_bandwidth_kbps", "base_bandwidth_kbps - 1"],
      ["duration_seconds", "duration_seconds + 1"],
      ["renew_until", "renew_until + interval '1 hour'"],
      ["requested_at", "requested_at - interval '1 minute'"],
    ];
    for (const [column, value] of changes) {
      await expect(
        asOwner(
          `UPDATE wifi_device_grants SET ${column} = ${value} WHERE id = $1`,
          [grant.id],
        ),
        column,
      ).rejects.toThrow(/wifi grant request is immutable/);
    }
    // Lifecycle columns stay writable.
    const ok = await asOwner(
      `UPDATE wifi_device_grants SET attempt_count = 1, last_error_code = 'WIFI_PROVIDER_TIMEOUT',
         expires_at = expires_at + interval '1 minute', updated_at = now() WHERE id = $1`,
      [grant.id],
    );
    expect(ok.rowCount).toBe(1);
  });

  it("legend-hsk a terminal status is final", async () => {
    const failed = await seedGrant(insertPendingSql);
    await asOwner(
      `UPDATE wifi_device_grants SET status = 'failed', controller_device_id = NULL,
         ended_at = now(), last_error_code = 'WIFI_AUTHORIZE_REFUSED' WHERE id = $1`,
      [failed.id],
    );
    await expect(
      asOwner(
        `UPDATE wifi_device_grants SET status = 'pending', controller_device_id = $2,
           ended_at = NULL WHERE id = $1`,
        [failed.id, failed.mac],
      ),
    ).rejects.toThrow(/terminal wifi grant status is final/);

    const revoked = await seedGrant(insertActiveSql);
    await asOwner(
      `UPDATE wifi_device_grants SET status = 'revoked', controller_device_id = NULL,
         ended_at = now(), revoke_requested_at = now(), end_reason = 'staff_revoked'
       WHERE id = $1`,
      [revoked.id],
    );
    await expect(
      asOwner(
        `UPDATE wifi_device_grants SET status = 'superseded', superseded_by = $2,
           revoke_requested_at = NULL, end_reason = NULL WHERE id = $1`,
        [revoked.id, grantA.id],
      ),
    ).rejects.toThrow(/terminal wifi grant status is final/);
  });

  it("legend-hsk the raw controller id lives only on live rows (scrub)", async () => {
    const mac = newMac();
    await expect(
      asOwner(insertPendingSql, [
        randomUUID(),
        tenantId,
        outletA,
        randomUUID(),
        deviceHash(tenantId, mac),
        null,
      ]),
    ).rejects.toThrow(/wifi_device_grants_scrub_check/);
    const grant = await seedGrant(insertActiveSql);
    await expect(
      asOwner(
        `UPDATE wifi_device_grants SET status = 'revoked', ended_at = now(),
           revoke_requested_at = now(), end_reason = 'session_ended' WHERE id = $1`,
        [grant.id],
      ),
    ).rejects.toThrow(/wifi_device_grants_scrub_check/);
  });

  it("legend-hsk lifecycle checks: active needs expiry, terminal needs ended_at, revoke is write-ahead", async () => {
    const grant = await seedGrant(insertPendingSql);
    await expect(
      asOwner(`UPDATE wifi_device_grants SET status = 'active' WHERE id = $1`, [
        grant.id,
      ]),
    ).rejects.toThrow(/wifi_device_grants_active_check/);
    await expect(
      asOwner(
        `UPDATE wifi_device_grants SET status = 'failed', controller_device_id = NULL WHERE id = $1`,
        [grant.id],
      ),
    ).rejects.toThrow(/wifi_device_grants_ended_check/);
    // FAC-13: running out of quota is not an end reason.
    await expect(
      asOwner(
        `UPDATE wifi_device_grants SET revoke_requested_at = now(), end_reason = 'quota_exhausted' WHERE id = $1`,
        [grant.id],
      ),
    ).rejects.toThrow(/wifi_device_grants_end_reason_check/);
    await expect(
      asOwner(
        `UPDATE wifi_device_grants SET end_reason = 'staff_revoked' WHERE id = $1`,
        [grant.id],
      ),
    ).rejects.toThrow(/wifi_device_grants_revoke_request_check/);
    // Write-ahead on the live row, then the confirmed revoke scrubs it.
    await asOwner(
      `UPDATE wifi_device_grants SET revoke_requested_at = now(), end_reason = 'staff_revoked' WHERE id = $1`,
      [grant.id],
    );
    const done = await asOwner(
      `UPDATE wifi_device_grants SET status = 'revoked', controller_device_id = NULL,
         ended_at = now() WHERE id = $1 RETURNING status, controller_device_id`,
      [grant.id],
    );
    expect(done.rows).toEqual([
      { status: "revoked", controller_device_id: null },
    ]);
  });

  it("FAC-13 one active and one in-flight grant per device; make-before-break supersedes", async () => {
    const old = await seedGrant(insertActiveSql);
    const session = old.session;
    await expect(
      asOwner(insertActiveSql, [
        randomUUID(),
        tenantId,
        outletA,
        session,
        old.hash,
        old.mac,
      ]),
    ).rejects.toThrow(/wifi_device_grants_one_active/);

    const next = randomUUID();
    await asOwner(insertPendingSql, [
      next,
      tenantId,
      outletA,
      session,
      old.hash,
      old.mac,
    ]);
    await expect(
      asOwner(insertPendingSql, [
        randomUUID(),
        tenantId,
        outletA,
        session,
        old.hash,
        old.mac,
      ]),
    ).rejects.toThrow(/wifi_device_grants_one_inflight/);

    // Old grant superseded first (successor named), then the new one active.
    await asOwner(
      `UPDATE wifi_device_grants SET status = 'superseded', superseded_by = $2,
         controller_device_id = NULL, ended_at = now() WHERE id = $1`,
      [old.id, next],
    );
    await asOwner(
      `UPDATE wifi_device_grants SET status = 'active', authorized_at = now(),
         expires_at = now() + interval '65 minutes' WHERE id = $1`,
      [next],
    );
    const rows = await asOwner(
      `SELECT id, status FROM wifi_device_grants WHERE device_hash = $1 ORDER BY status`,
      [old.hash],
    );
    expect(rows.rows).toEqual([
      { id: next, status: "active" },
      { id: old.id, status: "superseded" },
    ]);

    // The same device on another outlet is a separate grant.
    const otherOutletGrant = await asOwner(insertActiveSql, [
      randomUUID(),
      tenantId,
      outletB,
      session,
      old.hash,
      old.mac,
    ]);
    expect(otherOutletGrant.rowCount).toBe(1);
  });

  it("legend-hsk the successor of a superseded grant is in the same tenant and outlet", async () => {
    const old = await seedGrant(insertActiveSql);
    const onB = await seedGrant(insertActiveSql, { outlet: outletB });
    await expect(
      asOwner(
        `UPDATE wifi_device_grants SET status = 'superseded', superseded_by = $2,
           controller_device_id = NULL, ended_at = now() WHERE id = $1`,
        [old.id, onB.id],
      ),
    ).rejects.toThrow(/wifi_device_grants_superseded_by_fk/);
    await expect(
      asOwner(
        `UPDATE wifi_device_grants SET status = 'superseded', superseded_by = NULL,
           controller_device_id = NULL, ended_at = now() WHERE id = $1`,
        [old.id],
      ),
    ).rejects.toThrow(/wifi_device_grants_superseded_check/);
  });
});
