// The `recipes` catalog stream is tenant-wide only for an edge that asks for
// catalog protocol 3 (bead legend-2uqcd; compat of a cloud release that runs
// before its edges). An edge without `protocolVersion`, or with 2, has no
// brand check for a recipe of another brand (FK failure, permanent
// CATALOG_PULL_FAILED), so it keeps getting the recipes of its outlet's brand.
//
// The cloud is a private database (helpers/catalog-database.ts) with a private
// tenant of two brands; the page comes from the real service.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { catalogSyncQuerySchema } from "@starter/shared/edge";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db, pool } from "../db/index.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import { endTestPool } from "./helpers/database-cleanup.ts";

const cloud = await vi.hoisted(async () => {
  const { createCatalogCloud } = await import("./helpers/catalog-database.ts");
  return createCatalogCloud();
});

type Rec = Record<string, unknown>;

const tenantId = randomUUID();
const legalEntityId = randomUUID();
const brandA = randomUUID();
const brandB = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
const actor = randomUUID();
const recA = randomUUID();
const recB = randomUUID();

const mainOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  const q = (text: string, params: unknown[]) => mainOwner.query(text, params);
  const fixtureTenant = cafeLegendPlatformFixtures.tenant;
  await q(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1,$2,'Tenant uji versi resep',$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [
      tenantId,
      `resep-versi-${tenantId}`,
      fixtureTenant.plan,
      fixtureTenant.status,
      fixtureTenant.deploymentMode,
      JSON.stringify(fixtureTenant.featureFlags),
      JSON.stringify(fixtureTenant.limits),
      actor,
    ],
  );
  for (const [brand, slug] of [
    [brandA, "merek-a"],
    [brandB, "merek-b"],
  ] as const)
    await q(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1,$2,$3,$4)`,
      [brand, tenantId, slug, `Merek ${slug}`],
    );
  await q(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1,$2,'PT Uji Versi',false)`,
    [legalEntityId, tenantId],
  );
  for (const [outlet, brand, code] of [
    [outletA, brandA, "VER-A"],
    [outletB, brandB, "VER-B"],
  ] as const)
    await q(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1,$2,$3,$4,$5,$5,'Jl. Uji','{}','active')`,
      [outlet, tenantId, brand, legalEntityId, code],
    );
  const uomId = (
    await q(
      `INSERT INTO uoms (tenant_id, code, name) VALUES ($1,$2,$2) RETURNING id`,
      [tenantId, `u${randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id;
  const userId = (await q(`SELECT id FROM "user" ORDER BY id LIMIT 1`, []))
    .rows[0].id;
  for (const [recipeId, brand, name, minute] of [
    [recA, brandA, "Resep A", 10],
    [recB, brandB, "Resep B", 11],
  ] as const)
    await q(
      `INSERT INTO recipes (id, tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,NULL,'1.0000',$5,true,$6,$7)`,
      [
        recipeId,
        tenantId,
        brand,
        `${name} ${recipeId.slice(0, 6)}`,
        uomId,
        userId,
        new Date(Date.UTC(2025, 5, 1, 0, minute)),
      ],
    );
}, 240_000);

afterAll(async () => {
  setAuditWriter(null);
  await endTestPool(mainOwner);
  await endTestPool(pool);
  await cloud.cleanup();
});

/** Every recipe id the stream serves to the credential of `outlet`. */
async function recipeIds(outlet: string, protocolVersion?: number) {
  await settleCloud(mainOwner);
  const ids: string[] = [];
  let since: string | null = null;
  let stamped: unknown;
  for (let n = 0; n < 20; n += 1) {
    const page = (await listCatalogRecordsSince(db, {
      tenantId: tenantId as never,
      outletId: outlet as never,
      query: catalogSyncQuerySchema.parse({
        stream: "recipes",
        limit: 100,
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        ...(since === null ? {} : { since }),
      }),
    })) as unknown as {
      records: Rec[];
      nextCursor: string | null;
      hasMore: boolean;
      protocolVersion?: number;
    };
    stamped = page.protocolVersion;
    ids.push(...page.records.map((r) => String(r.id)));
    if (!page.hasMore) break;
    since = page.nextCursor;
  }
  return { ids, stamped };
}

describe("recipes stream by negotiated catalog protocol", () => {
  it("no protocolVersion (an edge before versioning): only the recipes of the outlet's brand, page without the field", async () => {
    const { ids, stamped } = await recipeIds(outletB);
    expect(ids).toEqual([recB]);
    expect(stamped).toBeUndefined();
  });

  it("protocolVersion 2: only the recipes of the outlet's brand", async () => {
    const { ids, stamped } = await recipeIds(outletB, 2);
    expect(ids).toEqual([recB]);
    expect(stamped).toBe(2);
    expect((await recipeIds(outletA, 2)).ids).toEqual([recA]);
  });

  it("protocolVersion 3: every recipe of the tenant", async () => {
    const { ids, stamped } = await recipeIds(outletB, 3);
    expect([...ids].sort()).toEqual([recA, recB].sort());
    expect(stamped).toBe(3);
  });

  it("protocolVersion above ours is negotiated down to 4 and stays tenant-wide", async () => {
    const { ids, stamped } = await recipeIds(outletB, 9);
    expect([...ids].sort()).toEqual([recA, recB].sort());
    expect(stamped).toBe(4);
  });
});
