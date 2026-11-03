// DB-backed tests for menu bulk import commit (bead legend-dmi; PRD v1.7 §3 F8
// "Impor Massal"). Real PostgreSQL with RLS (disposable server from
// `pnpm test`). Parsing rules live in menu-import-parse.test.ts.

import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures, outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  menuCategories,
  menuItems,
  priceListItems,
  stations,
} from "../db/schema/menu";
import { menuImportJobs } from "../db/schema/menu-import";
import {
  commitMenuImport,
  MenuImportInvalidError,
  previewMenuImport,
  validateMenuImport,
} from "../services/menu-import.service";
import {
  createIsolatedTenant,
  owner,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";

const app = createApp();
const { tenant, brand, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const stationId = randomUUID();
const categoryName = `Impor ${randomUUID().slice(0, 8)}`;

const ctx = (id = tenantId) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId: id, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

const HEADER =
  "kategori,nama,deskripsi,tipe,harga,stasiun,course,label,alergen";
const file = (...lines: string[]) => ({
  fileName: "menu.csv",
  dataBase64: Buffer.from([HEADER, ...lines].join("\n")).toString("base64"),
  outletId: outletA,
});

let staff: Staff;

beforeAll(async () => {
  staff = await staffWithRole(app, { template: "owner" });
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Bar Impor', 'beverage_bar')`,
      [stationId, tenantId, outletA],
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
});

afterAll(async () => {
  // Rows are tenant-scoped test data; the disposable database is dropped by pnpm test.
});

describe("menu import commit", () => {
  it("validate reports row errors and writes nothing", async () => {
    const report = await validateMenuImport(
      ctx(),
      staff.userId,
      file(
        `${categoryName},Ok,,,10000,Bar Impor,,,`,
        `${categoryName},Stasiun Hilang,,,10000,Tidak Ada,,,`,
      ),
    );
    expect(report.errorRows).toBe(1);
    expect(report.rows[1]).toMatchObject({ rowNumber: 3, action: "error" });
    const cats = await withTenant(db, ctx(), (tx) =>
      tx
        .select()
        .from(menuCategories)
        .where(eq(menuCategories.name, categoryName)),
    );
    expect(cats).toHaveLength(0);
  });

  it("commit is atomic: one bad row rejects the file and imports nothing", async () => {
    await expect(
      commitMenuImport(
        ctx(),
        staff.userId,
        `atomic-${randomUUID()}`,
        file(
          `${categoryName},Baik,,,10000,Bar Impor,,,`,
          `${categoryName},Buruk,,,abc,Bar Impor,,,`,
        ),
      ),
    ).rejects.toBeInstanceOf(MenuImportInvalidError);
    const items = await withTenant(db, ctx(), (tx) =>
      tx.select().from(menuItems).where(eq(menuItems.name, "Baik")),
    );
    expect(items).toHaveLength(0);
  });

  it("rows without a photo land as DRAFT with a price and a new category", async () => {
    const result = await commitMenuImport(
      ctx(),
      staff.userId,
      `draft-${randomUUID()}`,
      file(`${categoryName},Kopi Draft,Enak,,25000,Bar Impor,,manis,`),
    );
    expect(result).toMatchObject({
      createdItems: 1,
      createdCategories: 1,
      draftItems: 1,
    });
    const [item] = await withTenant(db, ctx(), (tx) =>
      tx.select().from(menuItems).where(eq(menuItems.name, "Kopi Draft")),
    );
    expect(item.isActive).toBe(false);
    expect(item.mediaId).toBeNull();
    expect(item.stationId).toBe(stationId);
    const prices = await withTenant(db, ctx(), (tx) =>
      tx
        .select()
        .from(priceListItems)
        .where(and(eq(priceListItems.itemId, item.id))),
    );
    expect(Number(prices[0].priceIdr)).toBe(25000);
  });

  it("idempotency replay returns the stored result; same key + other file is 409", async () => {
    const key = `idem-${randomUUID()}`;
    const input = file(`${categoryName},Idem,,,12000,Bar Impor,,,`);
    const first = await commitMenuImport(ctx(), staff.userId, key, input);
    const again = await commitMenuImport(ctx(), staff.userId, key, input);
    expect(again.replayed).toBe(true);
    expect(again.jobId).toBe(first.jobId);
    const items = await withTenant(db, ctx(), (tx) =>
      tx.select().from(menuItems).where(eq(menuItems.name, "Idem")),
    );
    expect(items).toHaveLength(1);
    await expect(
      commitMenuImport(
        ctx(),
        staff.userId,
        key,
        file(`${categoryName},Lain,,,12000,Bar Impor,,,`),
      ),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("duplicate name: rejected by default, updated in place with onDuplicate=update", async () => {
    const line = (price: number) =>
      file(`${categoryName},Duplikat,,,${price},Bar Impor,,,`);
    await commitMenuImport(
      ctx(),
      staff.userId,
      `dup1-${randomUUID()}`,
      line(10000),
    );
    const report = await previewMenuImport(ctx(), staff.userId, line(11000));
    expect(report.rows[0].errors[0].code).toBe("DUPLICATE_EXISTING");
    const updated = await commitMenuImport(
      ctx(),
      staff.userId,
      `dup2-${randomUUID()}`,
      { ...line(11000), onDuplicate: "update" },
    );
    expect(updated).toMatchObject({ createdItems: 0, updatedItems: 1 });
    const [item] = await withTenant(db, ctx(), (tx) =>
      tx.select().from(menuItems).where(eq(menuItems.name, "Duplikat")),
    );
    const prices = await withTenant(db, ctx(), (tx) =>
      tx
        .select()
        .from(priceListItems)
        .where(eq(priceListItems.itemId, item.id)),
    );
    expect(prices).toHaveLength(1);
    expect(Number(prices[0].priceIdr)).toBe(11000);
  });

  it("TEN-01 cross-tenant: another tenant cannot import into or read this brand/jobs", async () => {
    const other = await createIsolatedTenant(`imp-${randomUUID().slice(0, 6)}`);
    const otherCtx = establishScopedTenantContext(
      establishTenantContext({
        tenantId: other.tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    await expect(
      validateMenuImport(otherCtx, staff.userId, {
        ...file(`${categoryName},X,,,1000,Bar Impor,,,`),
        brandId: brand.id,
        outletId: other.outletId,
      }),
    ).rejects.toBeDefined();
    const jobs = await withTenant(db, otherCtx, (tx) =>
      tx.select().from(menuImportJobs),
    );
    expect(jobs).toHaveLength(0);
    // outlet-scoped context for a different outlet cannot name this outlet
    const outsider = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(outlets[1].id)] },
    );
    await expect(
      validateMenuImport(
        outsider,
        staff.userId,
        file(`${categoryName},Y,,,1000,Bar Impor,,,`),
      ),
    ).rejects.toBeDefined();
    void stations;
  });
});
