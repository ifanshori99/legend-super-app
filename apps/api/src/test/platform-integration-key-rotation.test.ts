// PAY-06 "kredensial integrasi tersegel, kunci dapat dirotasi" (bead
// legend-dheu). rotateIntegrationCredentials must really re-seal stale rows to
// the ACTIVE data-encryption key version (DATA_ENCRYPTION_KEYS +
// DATA_ENCRYPTION_ACTIVE_KEY_VERSION), skip rows already at that version, and
// leave the credentials readable.
//
// Shape: phase 1 seals an integration under the default ring (version 1, no
// extra keys). Phase 2 re-imports the service with the ring env stubbed (same
// pattern as src/lib/hris-pii.test.ts) and rotates.
//
// Assumptions (the brief, not the implementation):
//   - tenant_integrations.credentials_key_version records the key version used
//     to seal credentials_encrypted, and the first byte of the decoded
//     envelope is that version (sealedVersion()).
//   - A re-imported service reads the env again; the audit writer must be
//     installed on the fresh module instance, as the API bootstrap does.
//   - The test database setup does not set DATA_ENCRYPTION_KEYS itself, so
//     phase 1 is version 1.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { sealedVersion } from "../lib/secrets.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  currentCredentialKeyVersion,
  loadActiveIntegrationCredentials,
  rotateIntegrationCredentials,
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service.ts";

const tenantId = randomUUID();
const actor = randomUUID();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const KEY2 = randomBytes(32).toString("base64");

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

function contextFor(id: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId: id, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function sealedRow(integrationId: string) {
  return (
    await owner.query<{
      credentials_encrypted: string;
      credentials_key_version: number;
    }>(
      "SELECT credentials_encrypted, credentials_key_version FROM tenant_integrations WHERE id = $1",
      [integrationId],
    )
  ).rows[0]!;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant rotasi kunci', plan, status, deployment_mode,
            '{"modules":[],"integrationProviders":["doit","email"]}', limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `uji-rotasi-${randomBytes(4).toString("hex")}`, seededTenantId],
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query("DELETE FROM tenant_integrations WHERE tenant_id = $1", [
    tenantId,
  ]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await owner.end();
});

describe("PAY-06 rotateIntegrationCredentials moves rows to the active data key", () => {
  it("PAY-06 a row sealed at key version 1 is re-sealed to version 2 once, stays readable, and the next run skips it", async () => {
    // Phase 1: default ring, version 1.
    const ctx = contextFor(tenantId);
    const apiKey = `doit-${randomBytes(12).toString("hex")}`;
    const created = await upsertIntegration(
      ctx,
      {
        outletId: null,
        provider: "doit",
        config: { merchantCode: "ROT-1" },
        credentials: { apiKey },
      },
      actor,
    );
    await setIntegrationStatus(ctx, created.id, { status: "active" }, actor);
    const before = await sealedRow(created.id);
    expect(before.credentials_key_version).toBe(1);
    expect(sealedVersion(before.credentials_encrypted)).toBe(1);

    // Phase 2: the ring has version 2 and it is active.
    vi.resetModules();
    vi.stubEnv("DATA_ENCRYPTION_KEYS", `2:${KEY2}`);
    vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_VERSION", "2");
    const audit = await import("../services/audit-writer.ts");
    const core = await import("../services/core-audit-writer.ts");
    audit.setAuditWriter(core.coreAuditWriter);
    const shared = await import("@starter/shared/core/server");
    const service = await import("../services/platform-integration.service.ts");
    const ctx2 = shared.establishScopedTenantContext(
      shared.establishTenantContext({
        tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    expect(service.currentCredentialKeyVersion()).toBe(2);

    // The old (version 1) blob still opens before rotation (previous-key fallback).
    expect(
      (await service.loadActiveIntegrationCredentials(ctx2, "doit", null))
        ?.credentials,
    ).toEqual({ apiKey });

    expect(await service.rotateIntegrationCredentials(ctx2)).toEqual({
      rotated: 1,
    });
    const after = await sealedRow(created.id);
    expect(after.credentials_key_version).toBe(2);
    expect(sealedVersion(after.credentials_encrypted)).toBe(2);
    expect(after.credentials_encrypted).not.toBe(before.credentials_encrypted);
    expect(
      (await service.loadActiveIntegrationCredentials(ctx2, "doit", null))
        ?.credentials,
    ).toEqual({ apiKey });

    // Already at the active version: nothing to do.
    expect(await service.rotateIntegrationCredentials(ctx2)).toEqual({
      rotated: 0,
    });
    expect((await sealedRow(created.id)).credentials_encrypted).toBe(
      after.credentials_encrypted,
    );
    audit.setAuditWriter(null);
    // The default ring (no version 2) cannot open this row any more; the next
    // test starts from an empty tenant.
    await owner.query("DELETE FROM tenant_integrations WHERE tenant_id = $1", [
      tenantId,
    ]);
  });

  it("PAY-06 without a ring change the version stays 1 and rotation touches nothing", async () => {
    const ctx = contextFor(tenantId);
    // Phase-1 modules (static imports): default ring.
    expect(currentCredentialKeyVersion()).toBe(1);
    const apiKey = `doit-${randomBytes(12).toString("hex")}`;
    const created = await upsertIntegration(
      ctx,
      {
        outletId: null,
        provider: "doit",
        config: { merchantCode: "ROT-2" },
        credentials: { apiKey },
      },
      actor,
    );
    await setIntegrationStatus(ctx, created.id, { status: "active" }, actor);
    const before = await sealedRow(created.id);
    expect(await rotateIntegrationCredentials(ctx)).toEqual({ rotated: 0 });
    expect((await sealedRow(created.id)).credentials_encrypted).toBe(
      before.credentials_encrypted,
    );
    expect(
      (await loadActiveIntegrationCredentials(ctx, "doit", null))?.credentials,
    ).toEqual({ apiKey });
  });
});
