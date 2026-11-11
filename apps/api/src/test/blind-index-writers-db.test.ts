// legend-n039: writers under the versioned blind index (active v2), against
// PostgreSQL with the restricted app role. Rows are forced back to version 1
// to stand for data written before the cutover.
//
// Covers: cross-version uniqueness (a v1 row and a v2 write of the same value
// must still conflict: 409 naming the field, never the value), a same-value
// write on the row itself, new rows written as version 2, idempotency replay of
// a fingerprint stored under v1, and the legal-entity NPWP path.
// Assumption: a create that carries a duplicate NIK is covered by the same
// pre-check as the PII update.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The default active version is 1; these writers run under the v2 cutover.
vi.hoisted(() => {
  process.env.BLIND_INDEX_ACTIVE_VERSION = "2";
});

import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { blindIndexAt } from "../lib/blind-index.ts";
import { hrisBlindIndex } from "../lib/hris-pii.ts";
import { blindIndex, sealSecret } from "../lib/secrets.ts";
import {
  idempotentHrisWrite,
  updateEmployeePii,
} from "../services/hris-employee.service.ts";
import {
  createLegalEntity,
  updateLegalEntity,
} from "../services/org.service.ts";
import {
  asOwner,
  forceEmployeeV1,
  freshNik,
  freshNpwp,
  legacyNikDigest,
  legacyNpwpDigest,
  newFixture,
  scope,
  seedEmployee,
  setupTenants,
  teardown,
} from "./blind-index-fixtures.ts";

const fx = newFixture(2);
const [tenantA, tenantB] = fx.tenants as [string, string];

const employeeRow = (tenant: string, id: string) =>
  asOwner(tenant, async (client) => {
    const { rows } = await client.query(
      `SELECT nik_encrypted, nik_hmac, blind_index_version
         FROM employees WHERE tenant_id = $1 AND id = $2`,
      [tenant, id],
    );
    return rows[0] as {
      nik_encrypted: Buffer | null;
      nik_hmac: string | null;
      blind_index_version: number;
    };
  });

const entityRow = (tenant: string, id: string) =>
  asOwner(tenant, async (client) => {
    const { rows } = await client.query(
      `SELECT npwp_hash, npwp_hash_version FROM legal_entities
        WHERE tenant_id = $1 AND id = $2`,
      [tenant, id],
    );
    return rows[0] as { npwp_hash: string | null; npwp_hash_version: number };
  });

async function seedLegacyEntity(tenant: string, npwp: string): Promise<string> {
  const id = randomUUID();
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO legal_entities
         (id, tenant_id, name, is_pkp, npwp_encrypted, npwp_last4, npwp_hash, npwp_hash_version)
       VALUES ($1, $2, 'PT Legacy', false, $3, $4, $5, 1)`,
      [
        id,
        tenant,
        sealSecret(npwp, `legal_entity:${tenant}`),
        npwp.slice(-4),
        legacyNpwpDigest(tenant, npwp),
      ],
    ),
  );
  return id;
}

beforeAll(async () => {
  await setupTenants(fx, "blind-index-writers");
});

afterAll(async () => {
  // createLegalEntity provisions a chart of accounts and its mappings.
  for (const tenant of fx.tenants)
    await asOwner(tenant, async (client) => {
      const extra = [tenant, fx.entity[tenant]];
      await client.query(
        "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id <> $2",
        extra,
      );
      await client.query(
        "DELETE FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id <> $2",
        extra,
      );
      await client.query(
        "DELETE FROM legal_entities WHERE tenant_id = $1 AND id <> $2",
        extra,
      );
    });
  await teardown(fx);
});

describe("legend-n039 employee PII writers", () => {
  it("[HR-03] a new NIK is written as blind-index version 2", async () => {
    const nik = freshNik();
    const id = await seedEmployee(fx, tenantA, nik);
    const row = await employeeRow(tenantA, id);
    expect(row.blind_index_version).toBe(2);
    expect(row.nik_hmac).toBe(hrisBlindIndex("nik", tenantA, nik, 2));
  });

  it("[HR-03] a v2 write of a NIK held by a legacy v1 employee is a 409 naming the field, not the value", async () => {
    const nik = freshNik();
    const legacy = await seedEmployee(fx, tenantA, nik);
    await forceEmployeeV1(tenantA, legacy, nik);
    const other = await seedEmployee(fx, tenantA, null);

    const attempt = updateEmployeePii(scope(tenantA), fx.hr[tenantA]!, other, {
      nik,
      idempotencyKey: `bi-dup-${randomUUID()}`,
    });
    await expect(attempt).rejects.toMatchObject({ status: 409 });
    await expect(attempt).rejects.toThrow(/nik/);
    await expect(attempt).rejects.not.toThrow(nik);
    // Nothing was written to the second employee.
    expect((await employeeRow(tenantA, other)).nik_encrypted).toBeNull();
    // The legacy row is untouched.
    expect(await employeeRow(tenantA, legacy)).toMatchObject({
      nik_hmac: legacyNikDigest(tenantA, nik),
      blind_index_version: 1,
    });
  });

  it("[HR-03] creating an employee with a NIK held by a legacy v1 employee is a 409", async () => {
    const nik = freshNik();
    const legacy = await seedEmployee(fx, tenantA, nik);
    await forceEmployeeV1(tenantA, legacy, nik);
    await expect(seedEmployee(fx, tenantA, nik)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("[HR-03] writing the same value to the same employee succeeds (own row excluded) and moves it to v2", async () => {
    const nik = freshNik();
    const id = await seedEmployee(fx, tenantA, nik);
    await forceEmployeeV1(tenantA, id, nik);
    await updateEmployeePii(scope(tenantA), fx.hr[tenantA]!, id, {
      nik,
      idempotencyKey: `bi-self-${randomUUID()}`,
    });
    expect(await employeeRow(tenantA, id)).toMatchObject({
      nik_hmac: hrisBlindIndex("nik", tenantA, nik, 2),
      blind_index_version: 2,
    });
  });

  it("[HR-03] the same NIK in another tenant is not a conflict", async () => {
    const nik = freshNik();
    const legacy = await seedEmployee(fx, tenantA, nik);
    await forceEmployeeV1(tenantA, legacy, nik);
    const id = await seedEmployee(fx, tenantB, nik);
    expect((await employeeRow(tenantB, id)).blind_index_version).toBe(2);
  });
});

describe("legend-n039 idempotency fingerprints across versions", () => {
  const operation = "blind_index.test";
  const request = { actor: "a", values: { n: 1 } };

  async function replay(
    key: string,
    op: string,
    req: unknown,
    ran: { count: number },
  ) {
    return withTenant(db, scope(tenantA), (tx) =>
      idempotentHrisWrite(tx, scope(tenantA), key, op, req, async () => {
        ran.count += 1;
        return { ok: true, fresh: true };
      }),
    );
  }

  async function storeV1(key: string): Promise<void> {
    const fingerprint = blindIndex(
      JSON.stringify({ operation, request }),
      `hris:idempotency:${tenantA}`,
    );
    await asOwner(tenantA, (client) =>
      client.query(
        `INSERT INTO hris_idempotency (tenant_id, key, operation, fingerprint, response)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          tenantA,
          key,
          operation,
          fingerprint,
          JSON.stringify({ stored: "v1" }),
        ],
      ),
    );
  }

  it("[HR-03] the same request replays the stored response after the cutover", async () => {
    const key = `bi-replay-${randomUUID()}`;
    await storeV1(key);
    const ran = { count: 0 };
    await expect(replay(key, operation, request, ran)).resolves.toEqual({
      stored: "v1",
    });
    expect(ran.count).toBe(0);
  });

  it("[HR-03] a different request or operation with a v1 fingerprint is IDEMPOTENCY_KEY_REUSED", async () => {
    const key = `bi-reused-${randomUUID()}`;
    await storeV1(key);
    const ran = { count: 0 };
    await expect(
      replay(key, operation, { ...request, values: { n: 2 } }, ran),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      replay(key, "other.operation", request, ran),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(ran.count).toBe(0);
  });

  it("[HR-03] a fresh key stores the active (v2) fingerprint and replays", async () => {
    const key = `bi-fresh-${randomUUID()}`;
    const ran = { count: 0 };
    await replay(key, operation, request, ran);
    expect(ran.count).toBe(1);
    const stored = await asOwner(tenantA, (client) =>
      client.query(
        "SELECT fingerprint FROM hris_idempotency WHERE tenant_id = $1 AND key = $2",
        [tenantA, key],
      ),
    );
    const legacy = blindIndex(
      JSON.stringify({ operation, request }),
      `hris:idempotency:${tenantA}`,
    );
    expect(stored.rows[0].fingerprint).not.toBe(legacy);
    await expect(replay(key, operation, request, ran)).resolves.toEqual({
      ok: true,
      fresh: true,
    });
    expect(ran.count).toBe(1);
  });
});

describe("legend-n039 legal entity NPWP", () => {
  it("[ORG] a new entity writes version 2", async () => {
    const npwp = freshNpwp();
    const created = await createLegalEntity(scope(tenantA), {
      name: "PT Baru",
      npwp,
      isPkp: false,
      address: null,
    } as Parameters<typeof createLegalEntity>[1]);
    expect(await entityRow(tenantA, created.id)).toEqual({
      npwp_hash: blindIndexAt(2, npwp, `legal_entity-npwp:${tenantA}`),
      npwp_hash_version: 2,
    });
  });

  it("[ORG] a second entity with the NPWP of a legacy v1 entity is a 409", async () => {
    const npwp = freshNpwp();
    await seedLegacyEntity(tenantA, npwp);
    await expect(
      createLegalEntity(scope(tenantA), {
        name: "PT Kembar",
        npwp,
        isPkp: false,
        address: null,
      } as Parameters<typeof createLegalEntity>[1]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("[ORG] updating an entity to the NPWP of a legacy v1 entity is a 409", async () => {
    const npwp = freshNpwp();
    await seedLegacyEntity(tenantA, npwp);
    const other = await createLegalEntity(scope(tenantA), {
      name: "PT Lain",
      npwp: freshNpwp(),
      isPkp: false,
      address: null,
    } as Parameters<typeof createLegalEntity>[1]);
    await expect(
      updateLegalEntity(scope(tenantA), other.id, {
        npwp,
      } as Parameters<typeof updateLegalEntity>[2]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("[ORG] re-saving the same NPWP on a legacy entity succeeds and moves it to v2", async () => {
    const npwp = freshNpwp();
    const id = await seedLegacyEntity(tenantA, npwp);
    await updateLegalEntity(scope(tenantA), id, {
      npwp,
    } as Parameters<typeof updateLegalEntity>[2]);
    expect(await entityRow(tenantA, id)).toEqual({
      npwp_hash: blindIndexAt(2, npwp, `legal_entity-npwp:${tenantA}`),
      npwp_hash_version: 2,
    });
  });

  it("[ORG] the same NPWP in another tenant is allowed", async () => {
    const npwp = freshNpwp();
    await seedLegacyEntity(tenantA, npwp);
    const created = await createLegalEntity(scope(tenantB), {
      name: "PT Tenant B",
      npwp,
      isPkp: false,
      address: null,
    } as Parameters<typeof createLegalEntity>[1]);
    expect((await entityRow(tenantB, created.id)).npwp_hash_version).toBe(2);
  });
});
