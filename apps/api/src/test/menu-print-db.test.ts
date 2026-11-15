// DB-backed tests for the printable menu (bead legend-dmi; PRD v1.7 §3 F8
// "Menu Cetak Otomatis", §7 HTML -> PDF) with a fake renderer and storage.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendFixtures, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../app";
import { createMenuPdfRenderer } from "../services/menu-pdf-renderer";
import { allText } from "./pdf-text";
import { validPdfBytes } from "./helpers/pdf-fixtures";
import { NoopMalwareScanner } from "../services/core-image";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { and, eq } from "drizzle-orm";
import { coreStorageObjects } from "../db/schema/core-storage";
import { printableMenuRenders } from "../db/schema/menu-import";
import {
  collectPrintableMenu,
  getLatestMenuPrint,
  markMenuPrintDirty,
  PRINT_TAX_NOTE,
  regenerateMenuPrint,
  runDueMenuPrints,
  type MenuPdfRenderer,
  type PrintableMenu,
} from "../services/menu-print.service";
import { buildMenuPdfSpec } from "../services/menu-pdf-renderer";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  type IsolatedTenant,
  owner,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";

const app = createApp();
const { tenant, brand, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const now = new Date("2026-03-10T02:00:00.000Z");
const ids = {
  category: randomUUID(),
  ok: randomUUID(),
  soldOut: randomUUID(),
  draft: randomUUID(),
  noPrice: randomUUID(),
  list: randomUUID(),
};

const ctx = () =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

class CountingRenderer implements MenuPdfRenderer {
  calls = 0;
  /** What the real renderer would draw for the last menu (pure spec as JSON). */
  drawn = "";
  async render(menu: PrintableMenu) {
    this.calls += 1;
    this.drawn = JSON.stringify(buildMenuPdfSpec(menu));
    // A real PDF: storage parses document uploads (legend-851ef).
    return validPdfBytes({ marker: `fake ${this.calls}` });
  }
}

let staff: Staff;
const isolatedTenants: IsolatedTenant[] = [];
const renderer = new CountingRenderer();
const deps = {
  storage: new FakeObjectStorage(),
  renderer,
  scanner: new NoopMalwareScanner(),
};

beforeAll(async () => {
  // Earlier files (menu-import-storage-wire) render a PDF for outlet A and
  // leave the render row and its stored object behind; start from none.
  await clearPrintArtifacts();
  staff = await staffWithRole(app, { template: "owner", tenantId });
  // Service calls below use a fixed past clock; the grant must already be valid.
  await owner.query(
    "UPDATE role_assignments SET valid_from = $2 WHERE user_id = $1",
    [staff.userId, "2026-01-01T00:00:00Z"],
  );
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'Cetak Uji',0)`,
      [ids.category, tenantId, brand.id],
    );
    for (const [id, name, active, media] of [
      [ids.ok, "Kopi Cetak", true, randomUUID()],
      [ids.soldOut, "Kopi Habis", true, randomUUID()],
      [ids.draft, "Kopi Draft Cetak", false, null],
      [ids.noPrice, "Kopi Tanpa Harga", true, randomUUID()],
    ] as const)
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, tenantId, brand.id, ids.category, name, active, media],
      );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from) VALUES ($1,$2,$3,'dine_in','2026-01-01')`,
      [ids.list, tenantId, outletA],
    );
    for (const id of [ids.ok, ids.soldOut, ids.draft])
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr) VALUES ($1,$2,$3,$4,20000)`,
        [randomUUID(), tenantId, ids.list, id],
      );
    for (const [id, status] of [
      [ids.ok, "available"],
      [ids.soldOut, "sold_out"],
      [ids.draft, "available"],
      [ids.noPrice, "available"],
    ] as const)
      await client.query(
        `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, schedule, status) VALUES ($1,$2,$3,$4,'[]',$5)`,
        [randomUUID(), tenantId, outletA, id, status],
      );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
});

afterAll(async () => {
  for (const t of isolatedTenants) await dropIsolatedTenant(t);
  await cleanupSeededTenant("category_id = $2", [ids.category]);
});
/** Delete the printable-menu render rows of the tenant and the PDF objects they
 *  point at. The object ids are read BEFORE the rows go and the objects are
 *  deleted AFTER them (the render row references the object). Never by time or
 *  by "all documents": the DB clock steps back and other files own documents. */
async function deleteRenderRowsAndObjects(client: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}) {
  const { rows } = (await client.query(
    "SELECT object_id FROM printable_menu_renders WHERE tenant_id = $1 AND object_id IS NOT NULL",
    [tenantId],
  )) as { rows: { object_id: string }[] };
  await client.query(
    "DELETE FROM printable_menu_renders WHERE tenant_id = $1",
    [tenantId],
  );
  await client.query(
    "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2)",
    [tenantId, rows.map((row) => row.object_id)],
  );
}

/** Drop the render rows and stored PDFs left by earlier files. Files run
 *  serially on one DB, so a leftover row would make the "first read" skip
 *  rendering and a leftover object would break the one-PDF count. */
async function clearPrintArtifacts() {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await deleteRenderRowsAndObjects(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Remove what this file wrote into the shared seeded tenant so the other
 *  menu suites (latest price list wins, guest menu lists) are not disturbed. */
async function cleanupSeededTenant(itemFilter: string, params: unknown[]) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const items = `SELECT id FROM menu_items WHERE tenant_id = $1 AND (${itemFilter})`;
    const p = [tenantId, ...params];
    await client.query(
      `DELETE FROM item_availability WHERE tenant_id = $1 AND menu_item_id IN (${items})`,
      p,
    );
    await client.query(
      `DELETE FROM price_list_items WHERE tenant_id = $1 AND item_id IN (${items})`,
      p,
    );
    await client.query(
      "DELETE FROM price_lists WHERE tenant_id = $1 AND id = $2",
      [tenantId, ids.list],
    );
    await client.query(
      `DELETE FROM menu_items WHERE tenant_id = $1 AND (${itemFilter})`,
      p,
    );
    await client.query("DELETE FROM menu_import_jobs WHERE tenant_id = $1", [
      tenantId,
    ]);
    // The render rows and the PDFs they point at.
    await deleteRenderRowsAndObjects(client);
    await client.query(
      "DELETE FROM menu_categories WHERE tenant_id = $1 AND id = $2",
      [tenantId, ids.category],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("printable menu", () => {
  it("prints only AVAILABLE published items that have a price", async () => {
    const menu = await withTenant(db, ctx(), (tx) =>
      collectPrintableMenu(tx, ctx(), outletA, now),
    );
    const names = menu.categories.flatMap((c) => c.items.map((i) => i.name));
    expect(names).toContain("Kopi Cetak");
    expect(names).not.toContain("Kopi Habis");
    expect(names).not.toContain("Kopi Draft Cetak");
    expect(names).not.toContain("Kopi Tanpa Harga");
  });

  it("first read renders and stores the PDF and returns a short-lived URL", async () => {
    const latest = await getLatestMenuPrint(
      ctx(),
      staff.userId,
      { outletId: outletA },
      deps,
      now,
    );
    expect(renderer.calls).toBe(1);
    expect(latest.url).toBeTruthy();
    expect(latest.stale).toBe(false);
    expect(renderer.drawn).toContain("belum termasuk pajak");
  });

  it("debounce: a burst of changes yields ONE regeneration per outlet", async () => {
    const before = renderer.calls;
    // change a price so the payload hash differs
    // One pooled client for the whole transaction: Pool.query may hand each
    // statement to a different connection (set_config would not apply).
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await client.query(
        "UPDATE price_list_items SET price_idr = 22000 WHERE tenant_id = $1 AND item_id = $2",
        [tenantId, ids.ok],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await withTenant(db, ctx(), async (tx) => {
      for (let i = 0; i < 5; i += 1)
        await markMenuPrintDirty(
          tx,
          tenantId,
          [outletA],
          new Date(now.getTime() + i * 1000),
          30,
        );
    });
    const early = await runDueMenuPrints(
      ctx(),
      deps,
      new Date(now.getTime() + 10_000),
    );
    expect(early.regenerated).toEqual([]);
    expect(renderer.calls).toBe(before);
    const due = new Date(now.getTime() + 60_000);
    const first = await runDueMenuPrints(ctx(), deps, due);
    expect(first.regenerated).toEqual([outletA]);
    const second = await runDueMenuPrints(ctx(), deps, due);
    expect(second.regenerated).toEqual([]);
    expect(renderer.calls).toBe(before + 1);
    expect(renderer.drawn).toContain("Rp 22.000");
  });

  it("fails closed without a PDF renderer: 503 on first read, sweep does not throw", async () => {
    const noRenderer = {
      storage: deps.storage,
      renderer: null,
      scanner: deps.scanner,
    };
    await expect(
      getLatestMenuPrint(
        ctx(),
        staff.userId,
        { outletId: outlets[1].id },
        noRenderer,
        now,
      ),
    ).rejects.toMatchObject({ status: 503 });
    await withTenant(db, ctx(), (tx) =>
      markMenuPrintDirty(tx, tenantId, [outletA], now, 0),
    );
    const sweep = await runDueMenuPrints(
      ctx(),
      noRenderer,
      new Date(now.getTime() + 1_000),
    );
    expect(sweep).toEqual({ regenerated: [], failed: [outletA] });
  });

  it("TEN-01 cross-tenant: another tenant cannot read this outlet's printable menu", async () => {
    const other = await createIsolatedTenant(`prt-${randomUUID().slice(0, 6)}`);
    isolatedTenants.push(other);
    const otherCtx = establishScopedTenantContext(
      establishTenantContext({
        tenantId: other.tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    await expect(
      getLatestMenuPrint(
        otherCtx,
        staff.userId,
        { outletId: outletA },
        deps,
        now,
      ),
    ).rejects.toBeDefined();
  });
});

// legend-eirhm: a re-render must not leave the previous PDF behind.
describe("printable menu: old PDF cleanup", () => {
  const pdfLookup = (objectId: string) => ({
    tenantId,
    outletId: outletA,
    reference: objectId,
    visibility: "private" as const,
    key: `${objectId}/original.pdf`,
  });
  const exists = (storage: FakeObjectStorage, objectId: string) =>
    storage.get(ctx(), pdfLookup(objectId)).then(
      () => true,
      () => false,
    );
  const currentObjectId = async () =>
    withTenant(db, ctx(), async (tx) => {
      const [row] = await tx
        .select()
        .from(printableMenuRenders)
        .where(
          and(
            eq(printableMenuRenders.tenantId, tenantId),
            eq(printableMenuRenders.outletId, outletA),
          ),
        );
      return row.objectId as string;
    });
  const objectRowExists = (objectId: string) =>
    withTenant(db, ctx(), async (tx) => {
      const rows = await tx
        .select({ id: coreStorageObjects.id })
        .from(coreStorageObjects)
        .where(
          and(
            eq(coreStorageObjects.tenantId, tenantId),
            eq(coreStorageObjects.id, objectId),
          ),
        );
      return rows.length > 0;
    });
  const setPrice = async (price: number) => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await client.query(
        "UPDATE price_list_items SET price_idr = $3 WHERE tenant_id = $1 AND item_id = $2",
        [tenantId, ids.ok, price],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  const cleanupAudits = (objectId: string) =>
    owner.query(
      "SELECT event FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = 'menu.print.old_pdf_delete_failed' AND event->>'objectId' = $2",
      [tenantId, objectId],
    );

  it("a successful re-render deletes the old PDF object and its row", async () => {
    const storage = new FakeObjectStorage();
    const d = { storage, renderer, scanner: deps.scanner };
    await setPrice(31000);
    const first = await regenerateMenuPrint(ctx(), outletA, d, now);
    await setPrice(32000);
    const second = await regenerateMenuPrint(ctx(), outletA, d, now);
    expect(second.objectId).not.toBe(first.objectId);
    expect(await exists(storage, first.objectId)).toBe(false);
    expect(await objectRowExists(first.objectId)).toBe(false);
    expect(await exists(storage, second.objectId)).toBe(true);
    expect(await objectRowExists(second.objectId)).toBe(true);
    expect(await currentObjectId()).toBe(second.objectId);
  });

  it("a failed render keeps the old PDF", async () => {
    const storage = new FakeObjectStorage();
    const d = { storage, renderer, scanner: deps.scanner };
    await setPrice(33000);
    const first = await regenerateMenuPrint(ctx(), outletA, d, now);
    await setPrice(34000);
    const failing = {
      storage,
      scanner: deps.scanner,
      renderer: {
        render: async () => {
          throw new Error("renderer down");
        },
      },
    };
    await expect(
      regenerateMenuPrint(ctx(), outletA, failing, now),
    ).rejects.toThrow("renderer down");
    expect(await exists(storage, first.objectId)).toBe(true);
    expect(await objectRowExists(first.objectId)).toBe(true);
    expect(await currentObjectId()).toBe(first.objectId);
  });

  it("an unchanged payload is reused and nothing is deleted", async () => {
    const storage = new FakeObjectStorage();
    const d = { storage, renderer, scanner: deps.scanner };
    await setPrice(35000);
    const first = await regenerateMenuPrint(ctx(), outletA, d, now);
    const again = await regenerateMenuPrint(ctx(), outletA, d, now);
    expect(again).toMatchObject({ reused: true, objectId: first.objectId });
    expect(await exists(storage, first.objectId)).toBe(true);
  });

  it("concurrent renders leave exactly one PDF object (no orphan)", async () => {
    const storage = new FakeObjectStorage();
    const d = { storage, renderer, scanner: deps.scanner };
    // Document objects of this outlet. Other files leave their own behind, so
    // only the rows created or removed by THIS test's renders are compared.
    const documentIds = async () =>
      (
        await withTenant(db, ctx(), (tx) =>
          tx
            .select({ id: coreStorageObjects.id })
            .from(coreStorageObjects)
            .where(
              and(
                eq(coreStorageObjects.tenantId, tenantId),
                eq(coreStorageObjects.outletId, outletA),
                eq(coreStorageObjects.purpose, "document"),
              ),
            ),
        )
      ).map((r) => r.id);
    await setPrice(38000);
    const first = await regenerateMenuPrint(ctx(), outletA, d, now);
    await setPrice(39000);
    const before = new Set(await documentIds());
    await Promise.all([
      regenerateMenuPrint(ctx(), outletA, d, now),
      regenerateMenuPrint(ctx(), outletA, d, now),
    ]);
    const after = await documentIds();
    // Exactly one new PDF object, the current one; the one it replaced is gone.
    expect(after.filter((id) => !before.has(id))).toEqual([
      await currentObjectId(),
    ]);
    expect(after).not.toContain(first.objectId);
  });

  it("a failed delete does not fail the render and is written to the audit log", async () => {
    const storage = new FakeObjectStorage();
    const d = { storage, renderer, scanner: deps.scanner };
    await setPrice(36000);
    const first = await regenerateMenuPrint(ctx(), outletA, d, now);
    await setPrice(37000);
    storage.delete = async () => {
      throw new Error("storage delete down");
    };
    const second = await regenerateMenuPrint(ctx(), outletA, d, now);
    expect(second.reused).toBe(false);
    expect(await currentObjectId()).toBe(second.objectId);
    // Old object stays (row kept so it can be found) and the failure is logged.
    expect(await objectRowExists(first.objectId)).toBe(true);
    const audits = await cleanupAudits(first.objectId);
    expect(audits.rows).toHaveLength(1);
  });
});

// legend-hspr8: the real PDF engine, stored per tenant (brief
// docs/briefs/menu-pdf-engine.md). The fake renderer above only counts calls.
describe("printable menu: real PDF renderer", () => {
  const realDeps = () => ({
    storage: new FakeObjectStorage(),
    renderer: createMenuPdfRenderer(),
    scanner: deps.scanner,
  });
  const pdfLookup = (objectId: string) => ({
    tenantId,
    outletId: outletA,
    reference: objectId,
    visibility: "private" as const,
    key: `${objectId}/original.pdf`,
  });
  // A price no other test in this file uses, so the payload hash differs from
  // any render row left behind and the real renderer really runs.
  const setPrice = async (price: number) => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await client.query(
        "UPDATE price_list_items SET price_idr = $3 WHERE tenant_id = $1 AND item_id = $2",
        [tenantId, ids.ok, price],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  it("regenerateMenuPrint stores a valid PDF with the menu in the tenant's storage", async () => {
    const d = realDeps();
    await setPrice(41000);
    const result = await regenerateMenuPrint(ctx(), outletA, d, now);
    const stored = await d.storage.get(ctx(), pdfLookup(result.objectId));
    const bytes = Buffer.from(stored.content as Uint8Array);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
    const text = allText(bytes);
    expect(text).toContain("Kopi Cetak");
    expect(text).toContain("Rp 41.000");
    expect(text).toContain(PRINT_TAX_NOTE);
    // only what the guest may see is printed
    expect(text).not.toContain("Kopi Habis");
    expect(text).not.toContain("Kopi Draft Cetak");
    expect(text).not.toContain("Kopi Tanpa Harga");
    // the stored object is a tenant-owned row
    const rows = await withTenant(db, ctx(), (tx) =>
      tx
        .select({ id: coreStorageObjects.id })
        .from(coreStorageObjects)
        .where(
          and(
            eq(coreStorageObjects.tenantId, tenantId),
            eq(coreStorageObjects.id, result.objectId),
          ),
        ),
    );
    expect(rows).toHaveLength(1);
  });

  it("getLatestMenuPrint with the real renderer returns a URL for the owner tenant", async () => {
    const d = realDeps();
    await setPrice(42000);
    await withTenant(db, ctx(), (tx) =>
      markMenuPrintDirty(tx, tenantId, [outletA], now, 0),
    );
    await runDueMenuPrints(ctx(), d, new Date(now.getTime() + 1_000));
    const latest = await getLatestMenuPrint(
      ctx(),
      staff.userId,
      { outletId: outletA },
      d,
      new Date(now.getTime() + 2_000),
    );
    expect(latest.url).toBeTruthy();
    expect(latest.taxNote).toBe(PRINT_TAX_NOTE);
    expect(latest.stale).toBe(false);
  });

  it("TEN-01 another tenant cannot read the stored PDF, its row, or the menu", async () => {
    const d = realDeps();
    await setPrice(43000);
    const result = await regenerateMenuPrint(ctx(), outletA, d, now);
    const other = await createIsolatedTenant(`prp-${randomUUID().slice(0, 6)}`);
    isolatedTenants.push(other);
    const otherCtx = establishScopedTenantContext(
      establishTenantContext({
        tenantId: other.tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    // The same object key, asked for by the other tenant: refused.
    await expect(
      d.storage.get(otherCtx, pdfLookup(result.objectId)),
    ).rejects.toBeDefined();
    await expect(
      d.storage.get(otherCtx, {
        ...pdfLookup(result.objectId),
        tenantId: tenantIdSchema.parse(other.tenantId),
      }),
    ).rejects.toBeDefined();
    // The storage row is invisible to the other tenant (RLS).
    const visible = await withTenant(db, otherCtx, (tx) =>
      tx
        .select({ id: coreStorageObjects.id })
        .from(coreStorageObjects)
        .where(eq(coreStorageObjects.id, result.objectId)),
    );
    expect(visible).toEqual([]);
    // And the menu itself is not readable through the service.
    await expect(
      getLatestMenuPrint(otherCtx, staff.userId, { outletId: outletA }, d, now),
    ).rejects.toBeDefined();
  });
});
