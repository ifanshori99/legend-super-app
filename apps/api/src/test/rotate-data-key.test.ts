// Brief 466 item 4: operational data-key rotation. runDataKeyRotation (module
// db/rotate-data-key.ts, CLI db:rotate-data-key) walks every tenant and re-seals
// stale integration credentials and AI provider keys to the ACTIVE key version.
//
// Contract (from the brief):
//   runDataKeyRotation({ tenantId?, force?, dryRun? }) -> {
//     activeVersion, dryRun,
//     tenants: [{ tenantId, integrationsRotated, aiKeysRotated, error? }],
//     totals: { integrationsRotated, aiKeysRotated, failedTenants: string[] },
//     remaining: { integrations, aiKeys }   // rows of ALL tenants whose key
//   }                                       // version NULL or != active, with ciphertext
//
// Shape (same pattern as platform-integration-key-rotation.test.ts): phase 1
// seals integrations under the default ring (version 1) with the static
// imports; phase 2 re-imports the modules with the ring env stubbed to version 2.
//
// Assumptions:
//   - A corrupt ciphertext (version byte 1 + garbage) makes the tenant's
//     rotation throw; that tenant lands in failedTenants with a string `error`,
//     the other tenants are still rotated.
//   - dryRun reports, per tenant, the number of rows that WOULD be rotated in
//     integrationsRotated (the brief says dry-run "reports stale rows per
//     tenant") and writes nothing.
//   - The test database is shared with other test files, so assertions look up
//     OUR tenants by id in report.tenants, and `remaining` is compared with a
//     direct count of stale rows instead of a hard-coded 0 (a leftover corrupt
//     row of another file would otherwise make this test flaky).
//   - These tests only seal integrations; AI keys stay at 0 for our tenants.
//   - Hardening cases (bottom describe): the report gets `remainingComplete`
//     (true when every tenant's stale count was read, false when at least one
//     count failed; that tenant is then also in failedTenants and the run does
//     not throw). Faults are injected black-box by spying on pg's
//     Client.prototype.query (shared by pool.query and transaction clients; pg
//     is externalized by vitest so vi.resetModules keeps the same class):
//       * remaining count fault = a `count(` query on tenant_integrations or
//         ai_provider_configs whose text/params carry the tenant id;
//       * "domain error" fault = the UPDATE tenant_integrations of that row.
//     Each fault test asserts the spy fired, so a trigger that no longer
//     matches the query shape is reported as such, not as a silent pass.
//   - Integration credentials are AAD-bound as
//     `tenant_integration:<tenantId>:<integrationId>` (same AAD the gateway
//     test uses to open them); the JSON.parse test re-seals a non-JSON value
//     under it and proves it opens before running the rotation.
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cafeLegendPlatformFixtures,
  PlatformError,
} from "@starter/shared/platform";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { HttpError } from "../lib/http-error.ts";
import { openSecret, sealSecret, sealedVersion } from "../lib/secrets.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service.ts";
import type { DataKeyRotationReport } from "../db/rotate-data-key.ts";

const actor = randomUUID();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const KEY2 = randomBytes(32).toString("base64");
const createdTenants: string[] = [];

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

async function createTenant(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant rotasi semua kunci', plan, status, deployment_mode,
            '{"modules":[],"integrationProviders":["doit","email"]}', limits, created_by
       FROM tenants WHERE id = $3`,
    [id, `uji-rotkey-${randomBytes(4).toString("hex")}`, seededTenantId],
  );
  createdTenants.push(id);
  return id;
}

// Seals one active integration under the default ring (key version 1).
async function sealIntegrationV1(tenantId: string): Promise<string> {
  const ctx = contextFor(tenantId);
  const created = await upsertIntegration(
    ctx,
    {
      outletId: null,
      provider: "doit",
      config: { merchantCode: `ROT-${randomBytes(3).toString("hex")}` },
      credentials: { apiKey: `doit-${randomBytes(12).toString("hex")}` },
    },
    actor,
  );
  await setIntegrationStatus(ctx, created.id, { status: "active" }, actor);
  const row = await sealedRow(created.id);
  expect(row.credentials_key_version).toBe(1);
  expect(sealedVersion(row.credentials_encrypted)).toBe(1);
  return created.id;
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

async function staleIntegrationCount(activeVersion: number): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM tenant_integrations
     WHERE credentials_encrypted IS NOT NULL
       AND (credentials_key_version IS NULL OR credentials_key_version <> $1)`,
    [activeVersion],
  );
  return Number(rows[0]!.n);
}

// Phase 2: fresh module graph whose ring knows version 2 and has it active.
async function loadRotation() {
  vi.resetModules();
  vi.stubEnv("DATA_ENCRYPTION_KEYS", `2:${KEY2}`);
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_VERSION", "2");
  const audit = await import("../services/audit-writer.ts");
  const core = await import("../services/core-audit-writer.ts");
  audit.setAuditWriter(core.coreAuditWriter);
  const mod = await import("../db/rotate-data-key.ts");
  return { audit, run: mod.runDataKeyRotation };
}

function entry(report: DataKeyRotationReport, tenantId: string) {
  return report.tenants.find((t) => t.tenantId === tenantId);
}

// Makes matching pg queries fail. Handles both the promise form and the
// callback form (pool.query hands client.query a callback).
function injectQueryFault(
  match: (text: string, values: unknown[]) => boolean,
  makeError: () => Error,
) {
  const real = Client.prototype.query as unknown as (
    ...a: unknown[]
  ) => unknown;
  const state = { fired: 0 };
  vi.spyOn(Client.prototype, "query").mockImplementation(function (
    this: unknown,
    ...args: unknown[]
  ) {
    const first = args[0];
    const text =
      typeof first === "string"
        ? first
        : ((first as { text?: string } | null)?.text ?? "");
    // drizzle calls client.query(config, params): the values are the second
    // argument even when the first one is a config object.
    const rawValues = Array.isArray(args[1])
      ? args[1]
      : (first as { values?: unknown } | null)?.values;
    const values = Array.isArray(rawValues) ? rawValues : [];
    if (!match(text, values)) return real.apply(this, args);
    state.fired += 1;
    const error = makeError();
    const callback = args.find((a) => typeof a === "function") as
      ((e: Error) => void) | undefined;
    if (callback) {
      process.nextTick(callback, error);
      return undefined;
    }
    return Promise.reject(error);
  } as never);
  return state;
}

function mentions(text: string, values: unknown[], id: string) {
  return (
    text.includes(id) ||
    values.some((v) => typeof v === "string" && v.includes(id))
  );
}

async function cleanup() {
  if (createdTenants.length === 0) return;
  await owner.query(
    "DELETE FROM tenant_integrations WHERE tenant_id = ANY($1::uuid[])",
    [createdTenants],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  // The default ring cannot open version 2 rows; start every test empty.
  await cleanup();
});

afterAll(async () => {
  setAuditWriter(null);
  await cleanup();
  if (createdTenants.length > 0) {
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      createdTenants,
    ]);
  }
  await owner.end();
});

describe("PAY-06 runDataKeyRotation rotates every tenant to the active data key", () => {
  it("PAY-06 two tenants sealed at version 1 are both rotated to version 2, the report counts them, and a second run rotates nothing", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const rowA = await sealIntegrationV1(tenantA);
    const rowB = await sealIntegrationV1(tenantB);
    const beforeA = await sealedRow(rowA);
    const beforeB = await sealedRow(rowB);

    const { audit, run } = await loadRotation();
    const first = await run({});

    expect(first.activeVersion).toBe(2);
    expect(first.dryRun).toBe(false);
    expect(entry(first, tenantA)).toMatchObject({
      integrationsRotated: 1,
      aiKeysRotated: 0,
    });
    expect(entry(first, tenantB)).toMatchObject({
      integrationsRotated: 1,
      aiKeysRotated: 0,
    });
    expect(entry(first, tenantA)?.error).toBeUndefined();
    expect(entry(first, tenantB)?.error).toBeUndefined();
    expect(first.totals.integrationsRotated).toBeGreaterThanOrEqual(2);
    expect(first.totals.failedTenants).not.toContain(tenantA);
    expect(first.totals.failedTenants).not.toContain(tenantB);

    for (const [id, before] of [
      [rowA, beforeA],
      [rowB, beforeB],
    ] as const) {
      const after = await sealedRow(id);
      expect(after.credentials_key_version).toBe(2);
      expect(sealedVersion(after.credentials_encrypted)).toBe(2);
      expect(after.credentials_encrypted).not.toBe(
        before.credentials_encrypted,
      );
    }
    // Nothing of ours is left at another version; the report's `remaining`
    // matches the real number of stale rows in the database.
    expect(first.remaining.integrations).toBe(await staleIntegrationCount(2));
    expect(first.remaining.aiKeys).toBeGreaterThanOrEqual(0);
    // Every tenant's stale count was read, so `remaining` is complete.
    expect(first).toMatchObject({ remainingComplete: true });

    // Idempotent: a second run only touches stale rows, so our tenants get 0.
    const sealedAfterFirst = [
      (await sealedRow(rowA)).credentials_encrypted,
      (await sealedRow(rowB)).credentials_encrypted,
    ];
    const second = await run({});
    expect(entry(second, tenantA)?.integrationsRotated).toBe(0);
    expect(entry(second, tenantB)?.integrationsRotated).toBe(0);
    expect(entry(second, tenantA)?.aiKeysRotated).toBe(0);
    expect([
      (await sealedRow(rowA)).credentials_encrypted,
      (await sealedRow(rowB)).credentials_encrypted,
    ]).toEqual(sealedAfterFirst);
    audit.setAuditWriter(null);
  });

  it("PAY-06 a dry run writes nothing and reports the stale rows", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const rowA = await sealIntegrationV1(tenantA);
    const rowB = await sealIntegrationV1(tenantB);
    const beforeA = await sealedRow(rowA);
    const beforeB = await sealedRow(rowB);

    const { audit, run } = await loadRotation();
    const report = await run({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.activeVersion).toBe(2);
    // Assumption: dry run reports the would-be count per tenant.
    expect(entry(report, tenantA)?.integrationsRotated).toBe(1);
    expect(entry(report, tenantB)?.integrationsRotated).toBe(1);
    // Nothing was written, so our two rows are still stale.
    expect(report.remaining.integrations).toBeGreaterThanOrEqual(2);
    expect(report.remaining.integrations).toBe(await staleIntegrationCount(2));
    expect(await sealedRow(rowA)).toEqual(beforeA);
    expect(await sealedRow(rowB)).toEqual(beforeB);
    audit.setAuditWriter(null);
  });

  it("PAY-06 NULL version metadata counts encrypted credentials but excludes rows without ciphertext", async () => {
    const legacyTenant = await createTenant();
    const emptyTenant = await createTenant();
    const legacyId = await sealIntegrationV1(legacyTenant);
    const emptyId = await sealIntegrationV1(emptyTenant);
    await owner.query(
      "UPDATE tenant_integrations SET credentials_key_version = NULL WHERE id = $1",
      [legacyId],
    );
    await owner.query(
      `UPDATE tenant_integrations
          SET status = 'draft', credentials_encrypted = NULL, credentials_key_version = NULL
        WHERE id = $1`,
      [emptyId],
    );
    const legacyBefore = await sealedRow(legacyId);
    const emptyBefore = await sealedRow(emptyId);
    expect(legacyBefore.credentials_key_version).toBeNull();
    expect(sealedVersion(legacyBefore.credentials_encrypted)).toBe(1);
    expect(emptyBefore).toEqual({
      credentials_encrypted: null,
      credentials_key_version: null,
    });

    const { audit, run } = await loadRotation();
    const preview = await run({ dryRun: true });
    expect(entry(preview, legacyTenant)?.integrationsRotated).toBe(1);
    expect(entry(preview, emptyTenant)?.integrationsRotated).toBe(0);
    expect(preview.remaining.integrations).toBe(await staleIntegrationCount(2));
    expect(await sealedRow(legacyId)).toEqual(legacyBefore);
    expect(await sealedRow(emptyId)).toEqual(emptyBefore);

    const report = await run({});
    expect(entry(report, legacyTenant)).toMatchObject({
      integrationsRotated: 1,
    });
    expect(entry(report, legacyTenant)?.error).toBeUndefined();
    expect(entry(report, emptyTenant)).toMatchObject({
      integrationsRotated: 0,
    });
    expect(entry(report, emptyTenant)?.error).toBeUndefined();
    expect((await sealedRow(legacyId)).credentials_key_version).toBe(2);
    expect(await sealedRow(emptyId)).toEqual(emptyBefore);
    expect(report.remaining.integrations).toBe(await staleIntegrationCount(2));
    audit.setAuditWriter(null);
  });

  it("PAY-06 one tenant with a corrupt ciphertext is recorded as failed while the other tenants are still rotated", async () => {
    const good1 = await createTenant();
    const bad = await createTenant();
    const good2 = await createTenant();
    const rowGood1 = await sealIntegrationV1(good1);
    const rowBad = await sealIntegrationV1(bad);
    const rowGood2 = await sealIntegrationV1(good2);
    // Version byte 1 followed by garbage: cannot be authenticated or opened.
    const garbage = Buffer.concat([Buffer.from([1]), randomBytes(48)]).toString(
      "base64",
    );
    await owner.query(
      "UPDATE tenant_integrations SET credentials_encrypted = $2 WHERE id = $1",
      [rowBad, garbage],
    );

    const { audit, run } = await loadRotation();
    const report = await run({});

    expect(report.totals.failedTenants).toContain(bad);
    expect(report.totals.failedTenants).not.toContain(good1);
    expect(report.totals.failedTenants).not.toContain(good2);
    const badEntry = entry(report, bad);
    expect(typeof badEntry?.error).toBe("string");
    expect(badEntry?.error).not.toContain(KEY2);
    expect(badEntry?.error).not.toContain(garbage);
    expect(entry(report, good1)).toMatchObject({ integrationsRotated: 1 });
    expect(entry(report, good2)).toMatchObject({ integrationsRotated: 1 });

    expect((await sealedRow(rowGood1)).credentials_key_version).toBe(2);
    expect((await sealedRow(rowGood2)).credentials_key_version).toBe(2);
    // The corrupt row is untouched and still counted as remaining.
    const badAfter = await sealedRow(rowBad);
    expect(badAfter.credentials_key_version).toBe(1);
    expect(badAfter.credentials_encrypted).toBe(garbage);
    expect(report.remaining.integrations).toBeGreaterThanOrEqual(1);
    expect(report.remaining.integrations).toBe(await staleIntegrationCount(2));
    // A corrupt row does not stop the count: `remaining` is still complete.
    expect(report).toMatchObject({ remainingComplete: true });
    audit.setAuditWriter(null);
  });

  it("PAY-06 a tenant id limits the run to that tenant and leaves the others at version 1", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const rowA = await sealIntegrationV1(tenantA);
    const rowB = await sealIntegrationV1(tenantB);
    const beforeB = await sealedRow(rowB);

    const { audit, run } = await loadRotation();
    const report = await run({ tenantId: tenantA });

    expect(report.tenants.map((t) => t.tenantId)).toEqual([tenantA]);
    expect(entry(report, tenantA)?.integrationsRotated).toBe(1);
    expect((await sealedRow(rowA)).credentials_key_version).toBe(2);
    expect(await sealedRow(rowB)).toEqual(beforeB);
    // `remaining` still counts every tenant, so tenant B shows up as stale.
    expect(report.remaining.integrations).toBeGreaterThanOrEqual(1);
    expect(report.remaining.integrations).toBe(await staleIntegrationCount(2));
    audit.setAuditWriter(null);
  });

  it("PAY-06 a failing remaining count for one tenant does not throw: that tenant is failed, the others are still rotated, and remaining is marked incomplete", async () => {
    const tenantX = await createTenant();
    const tenantY = await createTenant();
    const rowX = await sealIntegrationV1(tenantX);
    const rowY = await sealIntegrationV1(tenantY);

    const { audit, run } = await loadRotation();
    const fault = injectQueryFault(
      (text, values) =>
        /count\s*\(/i.test(text) &&
        /tenant_integrations|ai_provider_configs/i.test(text) &&
        mentions(text, values, tenantX),
      () => new Error("simulated stale-count failure"),
    );
    let report: DataKeyRotationReport;
    try {
      // Must resolve: a count failure is reported, never thrown.
      report = await run({});
    } finally {
      vi.restoreAllMocks();
    }

    // Guard: the injected fault actually hit a remaining-count query.
    expect(fault.fired).toBeGreaterThan(0);
    expect(report.totals.failedTenants).toContain(tenantX);
    expect(report.totals.failedTenants).not.toContain(tenantY);
    expect(typeof entry(report, tenantX)?.error).toBe("string");
    expect(entry(report, tenantX)?.error).not.toBe("");
    expect(entry(report, tenantY)).toMatchObject({
      integrationsRotated: 1,
      aiKeysRotated: 0,
    });
    expect(entry(report, tenantY)?.error).toBeUndefined();
    expect((await sealedRow(rowY)).credentials_key_version).toBe(2);
    expect(report).toMatchObject({ remainingComplete: false });
    // The totals stay numbers so the operator still sees partial figures.
    expect(typeof report.remaining.integrations).toBe("number");
    expect(typeof report.remaining.aiKeys).toBe("number");
    void rowX;
    audit.setAuditWriter(null);
  });

  it("PAY-06 a credential that opens to non-JSON text fails its tenant without leaking any of the plaintext or a raw JSON.parse message", async () => {
    const good = await createTenant();
    const bad = await createTenant();
    await sealIntegrationV1(good);
    const rowBad = await sealIntegrationV1(bad);
    const secretMarker = `LEAK-${randomBytes(9).toString("hex")}-not-json`;
    const aad = `tenant_integration:${bad}:${rowBad}`;
    const sealed = sealSecret(secretMarker, aad);
    // Proof the fixture is a valid v1 envelope under the integration AAD.
    expect(openSecret(sealed, aad)).toBe(secretMarker);
    expect(() => JSON.parse(secretMarker)).toThrow(SyntaxError);
    await owner.query(
      "UPDATE tenant_integrations SET credentials_encrypted = $2 WHERE id = $1",
      [rowBad, sealed],
    );

    const { audit, run } = await loadRotation();
    const report = await run({});

    expect(report.totals.failedTenants).toContain(bad);
    expect(report.totals.failedTenants).not.toContain(good);
    const error = entry(report, bad)?.error;
    expect(typeof error).toBe("string");
    expect(error).not.toBe("");
    expect(error).not.toContain(secretMarker);
    expect(error).not.toContain("LEAK-");
    // Raw V8 JSON.parse messages ("Unexpected token ... is not valid JSON",
    // "... in JSON at position N") must not reach the report.
    expect(error).not.toMatch(
      /unexpected token|not valid JSON|in JSON at position/i,
    );
    expect(error).not.toContain(KEY2);
    expect(JSON.stringify(report)).not.toContain(secretMarker);
    expect(entry(report, good)).toMatchObject({ integrationsRotated: 1 });
    // The unreadable row is untouched.
    expect((await sealedRow(rowBad)).credentials_encrypted).toBe(sealed);
    audit.setAuditWriter(null);
  });

  it.each([
    [
      "HttpError",
      () => new HttpError(409, "ROTATION_TEST_CONFLICT", "Konflik uji rotasi."),
    ],
    ["PlatformError", () => new PlatformError("RESTORE_NOT_AVAILABLE")],
  ])(
    "PAY-06 a %s with a code during one tenant's rotation fails that tenant without being labelled a PostgreSQL failure",
    async (_name, makeError) => {
      const good = await createTenant();
      const bad = await createTenant();
      const rowGood = await sealIntegrationV1(good);
      const rowBad = await sealIntegrationV1(bad);

      const { audit, run } = await loadRotation();
      const fault = injectQueryFault(
        (text, values) =>
          /update\s+"?tenant_integrations"?/i.test(text) &&
          (mentions(text, values, rowBad) || mentions(text, values, bad)),
        makeError,
      );
      let report: DataKeyRotationReport;
      try {
        report = await run({});
      } finally {
        vi.restoreAllMocks();
      }

      // Guard: the injected domain error actually hit the reseal write.
      expect(fault.fired).toBeGreaterThan(0);
      expect(report.totals.failedTenants).toContain(bad);
      expect(report.totals.failedTenants).not.toContain(good);
      const error = entry(report, bad)?.error;
      expect(typeof error).toBe("string");
      expect(error).not.toBe("");
      // Only real driver errors are named that way; a coded domain error is not.
      expect(error).not.toMatch(/postgresql operation failed/i);
      expect(entry(report, good)).toMatchObject({ integrationsRotated: 1 });
      expect((await sealedRow(rowGood)).credentials_key_version).toBe(2);
      audit.setAuditWriter(null);
    },
  );
});
