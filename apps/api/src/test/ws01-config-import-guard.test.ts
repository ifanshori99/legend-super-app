// legend-datb2 (WS-01 CT): tenant config import guard. POST /api/org/config/import
// needs `org.config.import`, never writes a sensitive section
// (TENANT_IMPORT_BLOCKED_SECTIONS: platform admin only) and only ever writes into
// the caller's own tenant. Written from the shared contract
// (packages/shared/src/platform) and the permission catalogue, not the route code.
//
// Assumptions where the contract is silent (same as org-tenant-config-contracts.test.ts):
// - HTTP actors are members of the seeded tenant; the throwaway tenant B only
//   owns foreign rows and is only "the other tenant".
// - a bundle that carries (or a `sections` filter that names) a sensitive section
//   is refused with 403, even for a role holding org.config.import, and NOTHING
//   is written, not even the allowed sections of the same bundle (one unit).
// - a non-empty sensitive section (here: a custom role granting permissions)
//   is refused the same way as an empty one; no role row is created.
// - a user whose import role lives only in tenant B gets 403 in the seeded
//   tenant, and a `tenantId` in the body is refused with 422.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  CONFIG_BUNDLE_FORMAT_VERSION,
  TENANT_IMPORT_BLOCKED_SECTIONS,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { originHeader } from "./helpers.ts";
import {
  createTestTenant,
  removeTestTenant,
  type TestTenant,
} from "./platform-theme-helpers.ts";
import {
  cleanupMembers,
  memberOf,
  memberWith,
  owner,
  seededTenantId,
} from "./ws01-brand-config-helpers.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const app: Express = createApp();
const IMPORT = "/api/org/config/import";
// A catalogued text key (an unknown key is CONFIG_BUNDLE_INVALID). Other suites
// clean it up too, so do not run them in parallel with this file.
const KEY = "terms.stationBarKopi";
const ROLE_NAME = "Peran Impor ws01";
let tenantB: TestTenant;
let importsBefore: string[] = [];

const bundle = (sections: Record<string, unknown>, extra: object = {}) => ({
  formatVersion: CONFIG_BUNDLE_FORMAT_VERSION,
  exportedAt: new Date().toISOString(),
  sections,
  ...extra,
});
const textSection = (value: string) => ({
  text_overrides: {
    version: 1,
    sets: [{ locale: "en", overrides: [{ key: KEY, value }] }],
  },
});
const roleSection = () => ({
  roles: {
    version: 1,
    items: [
      {
        key: "custom.ws01-import",
        kind: "custom",
        templateKey: null,
        name: ROLE_NAME,
        permissions: ["org.config.import", "org.theme.manage"],
        allowedScopeTypes: ["tenant"],
        mfaRequired: false,
      },
    ],
  },
});

const importIds = async () =>
  (
    await owner.query<{ id: string }>(
      "SELECT id FROM config_imports WHERE tenant_id = $1",
      [seededTenantId],
    )
  ).rows.map((row) => row.id);
const overrides = async (tenantId: string) =>
  (
    await owner.query<{ value: string }>(
      "SELECT value FROM text_overrides WHERE tenant_id = $1 AND key = $2",
      [tenantId, KEY],
    )
  ).rows.map((row) => row.value);
const roleCount = async (tenantId: string) =>
  (
    await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM roles WHERE tenant_id = $1 AND name = $2",
      [tenantId, ROLE_NAME],
    )
  ).rows[0]!.n;

beforeAll(async () => {
  tenantB = await createTestTenant("ws01-imp-b");
  importsBefore = await importIds();
});

beforeEach(async () => {
  await owner.query("DELETE FROM text_overrides WHERE key = $1", [KEY]);
});

afterAll(async () => {
  await owner
    .query("DELETE FROM text_overrides WHERE key = $1", [KEY])
    .catch(() => undefined);
  await owner
    .query("DELETE FROM roles WHERE name = $1", [ROLE_NAME])
    .catch(() => undefined);
  await owner
    .query(
      "DELETE FROM config_imports WHERE tenant_id = $1 AND id <> ALL($2::uuid[])",
      [seededTenantId, importsBefore],
    )
    .catch(() => undefined);
  await cleanupMembers();
  await removeTestTenant(tenantB);
  await owner.end();
});

describe("legend-datb2 import needs org.config.import", () => {
  it("a role without it gets 403 and nothing is written", async () => {
    const cashier = await memberOf(app, "cashier");
    const exportOnly = await memberWith(app, seededTenantId, [
      "org.config.export",
    ]);
    const before = (await importIds()).length;
    for (const member of [cashier, exportOnly]) {
      const response = await member.client
        .post(IMPORT)
        .set(originHeader)
        .send({ bundle: bundle(textSection("Tidak Boleh")) });
      expect(response.status, JSON.stringify(response.body)).toBe(403);
    }
    expect(await importIds()).toHaveLength(before);
    expect(await overrides(seededTenantId)).toEqual([]);
  });

  it("a role with it imports an allowed section into its own tenant only", async () => {
    const importer = await memberWith(app, seededTenantId, [
      "org.config.import",
    ]);
    const response = await importer.client
      .post(IMPORT)
      .set(originHeader)
      .send({ bundle: bundle(textSection("Boleh")) });
    expect([200, 201], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(response.body.data).toMatchObject({
      tenantId: seededTenantId,
      status: "applied",
    });
    expect(await overrides(seededTenantId)).toEqual(["Boleh"]);
    expect(await overrides(tenantB.tenantId)).toEqual([]);
  });
});

describe("legend-datb2 sensitive sections stay blocked", () => {
  it("every blocked section named in `sections` is 403 for a role holding the permission; the allowed section of the bundle is not written either", async () => {
    const importer = await memberWith(app, seededTenantId, [
      "org.config.import",
    ]);
    const before = (await importIds()).length;
    for (const section of TENANT_IMPORT_BLOCKED_SECTIONS) {
      const response = await importer.client
        .post(IMPORT)
        .set(originHeader)
        .send({
          bundle: bundle(textSection("Campuran")),
          sections: ["text_overrides", section],
        });
      expect(
        response.status,
        `${section}: ${JSON.stringify(response.body)}`,
      ).toBe(403);
    }
    expect(await importIds()).toHaveLength(before);
    expect(await overrides(seededTenantId)).toEqual([]);
  });

  it("a non-empty roles section is 403: no role is created, the text section is not written", async () => {
    const importer = await memberWith(app, seededTenantId, [
      "org.config.import",
    ]);
    const admin = await memberOf(app, "tenant_admin");
    const before = (await importIds()).length;
    for (const member of [importer, admin]) {
      const response = await member.client
        .post(IMPORT)
        .set(originHeader)
        .send({
          bundle: bundle({ ...textSection("Eskalasi"), ...roleSection() }),
        });
      expect(response.status, JSON.stringify(response.body)).toBe(403);
    }
    expect(await roleCount(seededTenantId)).toBe("0");
    expect(await overrides(seededTenantId)).toEqual([]);
    expect(await importIds()).toHaveLength(before);
  });
});

describe("legend-datb2 another tenant is refused", () => {
  it("a user whose import role lives in tenant B is 403 in the seeded tenant and writes nothing", async () => {
    const foreign = await memberWith(app, tenantB.tenantId, [
      "org.config.import",
    ]);
    const before = (await importIds()).length;
    const response = await foreign.client
      .post(IMPORT)
      .set(originHeader)
      .send({ bundle: bundle(textSection("Tenant Lain")) });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await importIds()).toHaveLength(before);
    for (const tenantId of [seededTenantId, tenantB.tenantId])
      expect(await overrides(tenantId)).toEqual([]);
  });

  it("an own-tenant importer cannot aim at tenant B: tenantId in the body is 422, in the query it is ignored", async () => {
    const importer = await memberWith(app, seededTenantId, [
      "org.config.import",
    ]);
    const refused = await importer.client
      .post(IMPORT)
      .set(originHeader)
      .send({
        tenantId: tenantB.tenantId,
        bundle: bundle(textSection("Ke Tenant B")),
      });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(await overrides(tenantB.tenantId)).toEqual([]);

    const viaQuery = await importer.client
      .post(`${IMPORT}?tenantId=${tenantB.tenantId}`)
      .set(originHeader)
      .send({ bundle: bundle(textSection("Dari Query")) });
    expect([200, 201], JSON.stringify(viaQuery.body)).toContain(
      viaQuery.status,
    );
    expect(viaQuery.body.data.tenantId).toBe(seededTenantId);
    expect(await overrides(tenantB.tenantId)).toEqual([]);
    expect(await overrides(seededTenantId)).toEqual(["Dari Query"]);
  });

  it("a bundle carrying another tenant's id is 422 and writes nothing", async () => {
    const importer = await memberWith(app, seededTenantId, [
      "org.config.import",
    ]);
    const response = await importer.client
      .post(IMPORT)
      .set(originHeader)
      .send({
        bundle: bundle(textSection("Bocor"), {
          tenantId: tenantB.tenantId,
          importId: randomUUID(),
        }),
      });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await overrides(seededTenantId)).toEqual([]);
  });
});
