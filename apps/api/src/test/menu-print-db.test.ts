// DB-backed tests for the printable menu (bead legend-dmi; PRD v1.7 §3 F8
// "Menu Cetak Otomatis", §7 HTML -> PDF) with a fake renderer and storage.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  collectPrintableMenu,
  getLatestMenuPrint,
  markMenuPrintDirty,
  runDueMenuPrints,
  type MenuPdfRenderer,
} from "../services/menu-print.service";
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
  html = "";
  async render(html: string) {
    this.calls += 1;
    this.html = html;
    return new Uint8Array(Buffer.from(`%PDF-1.4 fake ${this.calls}`));
  }
}

const testStartedAt = new Date();
let staff: Staff;
const isolatedTenants: IsolatedTenant[] = [];
const renderer = new CountingRenderer();
const deps = { storage: new FakeObjectStorage(), renderer };

beforeAll(async () => {
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
      "DELETE FROM price_lists pl WHERE pl.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM price_list_items i WHERE i.price_list_id = pl.id) AND pl.created_at >= $2",
      [tenantId, testStartedAt],
    );
    await client.query(
      `DELETE FROM menu_items WHERE tenant_id = $1 AND (${itemFilter})`,
      p,
    );
    await client.query("DELETE FROM menu_import_jobs WHERE tenant_id = $1", [
      tenantId,
    ]);
    await client.query(
      "DELETE FROM printable_menu_renders WHERE tenant_id = $1",
      [tenantId],
    );
    // The PDFs this file stored (purpose `document`, created during the run).
    await client.query(
      "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND purpose = 'document' AND created_at >= $2",
      [tenantId, testStartedAt],
    );
    await client.query(
      "DELETE FROM menu_categories c WHERE c.tenant_id = $1 AND c.created_at >= $2 AND NOT EXISTS (SELECT 1 FROM menu_items m WHERE m.category_id = c.id)",
      [tenantId, testStartedAt],
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
    expect(renderer.html).toContain("belum termasuk pajak");
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
    expect(renderer.html).toContain("Rp 22.000");
  });

  it("fails closed without a PDF renderer: 503 on first read, sweep does not throw", async () => {
    const noRenderer = { storage: deps.storage, renderer: null };
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
