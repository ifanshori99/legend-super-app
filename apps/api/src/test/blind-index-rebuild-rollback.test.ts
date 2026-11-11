// legend-n039 rollback lever: BLIND_INDEX_ACTIVE_VERSION=1 makes version 1 the
// active version; the same rebuild job then moves v2 rows back to v1 digests
// (both directions, `version <> active`). Separate file: the active version is
// read from the environment when the config loads.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.BLIND_INDEX_ACTIVE_VERSION = "1";
});

import {
  BLIND_INDEX_ACTIVE_VERSION,
  blindIndexAt,
} from "../lib/blind-index.ts";
import { hrisBlindIndex } from "../lib/hris-pii.ts";
import { sealSecret } from "../lib/secrets.ts";
import { runBlindIndexRebuild } from "../worker/blind-index-rebuild.job.ts";
import {
  asOwner,
  freshNik,
  freshNpwp,
  legacyNikDigest,
  legacyNpwpDigest,
  newFixture,
  seedEmployee,
  setupTenants,
  teardown,
} from "./blind-index-fixtures.ts";

const fx = newFixture(1);
const tenant = fx.tenants[0]!;

beforeAll(async () => {
  await setupTenants(fx, "blind-index-rollback");
});

afterAll(async () => {
  await asOwner(tenant, (client) =>
    client.query(
      "DELETE FROM legal_entities WHERE tenant_id = $1 AND id <> $2",
      [tenant, fx.entity[tenant]],
    ),
  );
  await teardown(fx);
});

describe("legend-n039 rollback to blind-index version 1", () => {
  it("[HR-03] with active=1 the job moves v2 rows back to v1 digests and writers use v1", async () => {
    expect(BLIND_INDEX_ACTIVE_VERSION).toBe(1);
    const nik = freshNik();
    // Written under active=1: already v1.
    const id = await seedEmployee(fx, tenant, nik);
    const written = await asOwner(tenant, (client) =>
      client.query(
        "SELECT nik_hmac, blind_index_version FROM employees WHERE tenant_id = $1 AND id = $2",
        [tenant, id],
      ),
    );
    expect(written.rows[0]).toMatchObject({
      nik_hmac: legacyNikDigest(tenant, nik),
      blind_index_version: 1,
    });

    // Stand for rows moved to v2 earlier.
    const npwp = freshNpwp();
    const entityId = randomUUID();
    await asOwner(tenant, async (client) => {
      await client.query(
        `UPDATE employees SET nik_hmac = $3, blind_index_version = 2
          WHERE tenant_id = $1 AND id = $2`,
        [tenant, id, hrisBlindIndex("nik", tenant, nik, 2)],
      );
      await client.query(
        `INSERT INTO legal_entities
           (id, tenant_id, name, is_pkp, npwp_encrypted, npwp_last4, npwp_hash, npwp_hash_version)
         VALUES ($1, $2, 'PT Back', false, $3, $4, $5, 2)`,
        [
          entityId,
          tenant,
          sealSecret(npwp, `legal_entity:${tenant}`),
          npwp.slice(-4),
          blindIndexAt(2, npwp, `legal_entity-npwp:${tenant}`),
        ],
      );
    });

    const result = await runBlindIndexRebuild({
      batchSize: 2,
      log: { error: () => {}, warn: () => {}, info: () => {} },
      listTenantIds: async () => [tenant],
    } as Parameters<typeof runBlindIndexRebuild>[0]);
    expect(result).toMatchObject({
      employees: 1,
      legalEntities: 1,
      conflicts: 0,
      incompleteTenants: 0,
    });

    const employee = await asOwner(tenant, (client) =>
      client.query(
        "SELECT nik_hmac, blind_index_version FROM employees WHERE tenant_id = $1 AND id = $2",
        [tenant, id],
      ),
    );
    expect(employee.rows[0]).toMatchObject({
      nik_hmac: legacyNikDigest(tenant, nik),
      blind_index_version: 1,
    });
    const entity = await asOwner(tenant, (client) =>
      client.query(
        "SELECT npwp_hash, npwp_hash_version FROM legal_entities WHERE tenant_id = $1 AND id = $2",
        [tenant, entityId],
      ),
    );
    expect(entity.rows[0]).toMatchObject({
      npwp_hash: legacyNpwpDigest(tenant, npwp),
      npwp_hash_version: 1,
    });
  });
});
