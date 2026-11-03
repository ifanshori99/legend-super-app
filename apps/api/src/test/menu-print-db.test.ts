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

let staff: Staff;
const renderer = new CountingRenderer();
const deps = { storage: new FakeObjectStorage(), renderer };

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

afterAll(async () => {});

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
    await owner.query("BEGIN");
    await owner.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await owner.query(
      "UPDATE price_list_items SET price_idr = 22000 WHERE tenant_id = $1 AND item_id = $2",
      [tenantId, ids.ok],
    );
    await owner.query("COMMIT");
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

  it("TEN-01 cross-tenant: another tenant cannot read this outlet's printable menu", async () => {
    const other = await createIsolatedTenant(`prt-${randomUUID().slice(0, 6)}`);
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
