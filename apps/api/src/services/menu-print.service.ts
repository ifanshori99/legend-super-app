// Printable menu (bead legend-dmi; PRD v1.7 §3 F8 "Menu Cetak Otomatis", §7
// HTML -> PDF).
//
// One PDF per outlet. Content rules:
// - only items a guest could order: active, with a photo (Q23, same rule as
//   `menuItemVisibleToGuests`), not deleted, availability `available` for the
//   outlet, and with a price in the dine_in list in force today;
// - prices EXCLUDE tax and service (owner decision) and the PDF says so;
// - HTML is escaped (item names are tenant input).
// Rendering goes through the `MenuPdfRenderer` port (the repo has no HTML->PDF
// engine yet; the real adapter, e.g. headless Chromium, is wired by the lead).
// The PDF is stored through core-storage (`document`, private) and served via
// the existing short-lived signed URL.
//
// Auto refresh: the outbox consumer (`createMenuPrintDirtyConsumer`) marks
// outlets that already have a render as dirty on price / availability / item
// changes, with a trailing debounce (each event pushes `refresh_after` out, up
// to a hard cap), and `runDueMenuPrints` (worker job) renders each due outlet
// once. A burst of events therefore yields one regeneration per outlet. An
// unchanged payload hash is not re-stored.

import type { OutletId } from "@starter/shared/core";
import { outlets } from "../db/schema/platform-org.ts";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  businessDateOf,
  CoreError,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { ObjectStorage } from "@starter/shared/adapters";
import type { EventEnvelope } from "@starter/shared/events";
import { menuItemVisibleToGuests } from "@starter/shared/menu";
import {
  itemAvailability,
  menuCategories,
  menuItems,
} from "../db/schema/menu.ts";
import { printableMenuRenders } from "../db/schema/menu-import.ts";
import { brands } from "../db/schema/platform-org.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import type { consumeOutbox } from "./core-outbox.ts";
import {
  assertScannerAcceptsDocuments,
  NoopMalwareScanner,
  type MalwareScanner,
} from "./core-image.ts";
import { signedStorageUrl, uploadStorage } from "./core-storage.ts";
import {
  MENU_VIEW_PERMISSION,
  MENU_ITEM_PERMISSION,
  assertOutletPermission,
  resolveOutlet,
  type Tx,
} from "./menu-internals.ts";
import { readChannelPriceGrid } from "./menu-pricing.service.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";

/** HTML -> PDF port. The real adapter must not fetch remote resources. */
export interface MenuPdfRenderer {
  render(html: string): Promise<Uint8Array>;
}

export type MenuPrintDeps = {
  storage: ObjectStorage;
  renderer: MenuPdfRenderer | null;
  scanner?: MalwareScanner;
};

export const PRINT_DEBOUNCE_SECONDS = 30;
/** Hard cap so a constant trickle of changes still produces a PDF. */
export const PRINT_MAX_WAIT_SECONDS = 300;
const PRINT_CHANNEL = "dine_in" as const;
export const PRINT_TAX_NOTE = "Harga belum termasuk pajak dan biaya layanan.";

// ----------------------------------------------------------------- content

export type PrintableMenu = {
  brandName: string;
  outletName: string;
  /** Outlet business date, YYYY-MM-DD. */
  date: string;
  categories: {
    name: string;
    items: { name: string; description: string; priceIdr: number }[];
  }[];
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function formatRupiah(value: number): string {
  return `Rp ${Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

/** Self-contained HTML (inline CSS, no remote resources). */
export function renderMenuPrintHtml(menu: PrintableMenu): string {
  const sections = menu.categories
    .map(
      (category) =>
        `<section><h2>${escapeHtml(category.name)}</h2>${category.items
          .map(
            (item) =>
              `<div class="row"><div class="n"><strong>${escapeHtml(item.name)}</strong>${
                item.description ? `<p>${escapeHtml(item.description)}</p>` : ""
              }</div><div class="p">${formatRupiah(item.priceIdr)}</div></div>`,
          )
          .join("")}</section>`,
    )
    .join("");
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Menu ${escapeHtml(
    menu.outletName,
  )}</title><style>
body{font-family:Helvetica,Arial,sans-serif;color:#111;margin:32px}
h1{font-size:24px;margin:0}header p,footer{color:#555;font-size:12px}
h2{font-size:16px;border-bottom:1px solid #999;padding-bottom:4px;margin-top:24px}
.row{display:flex;justify-content:space-between;gap:16px;margin:8px 0;break-inside:avoid}
.row p{margin:2px 0 0;font-size:12px;color:#444}.p{white-space:nowrap}
footer{margin-top:32px;border-top:1px solid #ccc;padding-top:8px}
</style></head><body><header><h1>${escapeHtml(menu.brandName)}</h1><p>${escapeHtml(
    menu.outletName,
  )} - ${escapeHtml(menu.date)}</p></header>${sections}<footer>${escapeHtml(
    PRINT_TAX_NOTE,
  )}</footer></body></html>`;
}

/** Stable hash of what is printed (the date is part of it: the footer shows it). */
export function printableMenuHash(menu: PrintableMenu): string {
  return createHash("sha256").update(JSON.stringify(menu)).digest("hex");
}

/**
 * Collect the printable payload of one outlet. Pure read on the caller's
 * transaction; exported for tests and for the worker.
 */
export async function collectPrintableMenu(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
): Promise<PrintableMenu> {
  const tenantId = context.tenant.tenantId;
  const [outlet] = await tx
    .select({
      name: outlets.name,
      brandId: outlets.brandId,
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
  const [brand] = await tx
    .select({ name: brands.name })
    .from(brands)
    .where(and(eq(brands.tenantId, tenantId), eq(brands.id, outlet.brandId)));
  const date = businessDateOf(now, outletBusinessDayClock(outlet));
  const grid = await readChannelPriceGrid(tx, context, {
    outletId,
    channel: PRINT_CHANNEL,
    businessDate: date,
  });
  const price = new Map<string, number>();
  for (const entry of grid.entries)
    if (entry.variantId === null)
      price.set(entry.itemId, Number(entry.priceIdr));

  const items = await tx
    .select({
      id: menuItems.id,
      name: menuItems.name,
      description: menuItems.description,
      categoryId: menuItems.categoryId,
      isActive: menuItems.isActive,
      mediaId: menuItems.mediaId,
      sortOrder: menuItems.sortOrder,
    })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, tenantId),
        eq(menuItems.brandId, outlet.brandId),
        isNull(menuItems.deletedAt),
      ),
    )
    .orderBy(asc(menuItems.sortOrder), asc(menuItems.name), asc(menuItems.id));
  const available = new Set(
    (
      await tx
        .select({ id: itemAvailability.menuItemId })
        .from(itemAvailability)
        .where(
          and(
            eq(itemAvailability.tenantId, tenantId),
            eq(itemAvailability.outletId, outletId),
            eq(itemAvailability.status, "available"),
            isNull(itemAvailability.deletedAt),
          ),
        )
    ).map((r) => r.id),
  );
  const categories = await tx
    .select({
      id: menuCategories.id,
      name: menuCategories.name,
    })
    .from(menuCategories)
    .where(
      and(
        eq(menuCategories.tenantId, tenantId),
        eq(menuCategories.brandId, outlet.brandId),
        isNull(menuCategories.deletedAt),
      ),
    )
    .orderBy(asc(menuCategories.sortOrder), asc(menuCategories.id));
  const printable = items.filter(
    (item) =>
      menuItemVisibleToGuests(item) &&
      available.has(item.id) &&
      price.has(item.id),
  );
  return {
    brandName: brand?.name ?? "",
    outletName: outlet.name,
    date,
    categories: categories
      .map((category) => ({
        name: category.name,
        items: printable
          .filter((item) => item.categoryId === category.id)
          .map((item) => ({
            name: item.name,
            description: item.description,
            priceIdr: price.get(item.id) as number,
          })),
      }))
      .filter((category) => category.items.length > 0),
  };
}

// ------------------------------------------------------------------ dirty

/**
 * Mark outlets dirty (trailing debounce). Only outlets that already have a
 * render row are touched: nobody asked for a printable menu there yet.
 */
export async function markMenuPrintDirty(
  tx: Tx,
  tenantId: string,
  outletIds: readonly string[],
  now: Date,
  debounceSeconds = PRINT_DEBOUNCE_SECONDS,
  maxWaitSeconds = PRINT_MAX_WAIT_SECONDS,
): Promise<number> {
  if (outletIds.length === 0) return 0;
  const rows = await tx
    .update(printableMenuRenders)
    .set({
      dirtySince: sql`coalesce(${printableMenuRenders.dirtySince}, ${now.toISOString()}::timestamptz)`,
      refreshAfter: sql`least(${now.toISOString()}::timestamptz + make_interval(secs => ${debounceSeconds}), coalesce(${printableMenuRenders.dirtySince}, ${now.toISOString()}::timestamptz) + make_interval(secs => ${maxWaitSeconds}))`,
      updatedAt: now,
    })
    .where(
      and(
        eq(printableMenuRenders.tenantId, tenantId),
        inArray(printableMenuRenders.outletId, [...outletIds]),
      ),
    )
    .returning({ id: printableMenuRenders.id });
  return rows.length;
}

/** Outlets a menu event affects (price / availability / item / category). */
export async function outletsAffectedByEvent(
  tx: Tx,
  event: Pick<EventEnvelope, "name" | "tenantId" | "payload">,
): Promise<string[]> {
  const payload = event.payload as Record<string, unknown>;
  const str = (key: string) =>
    typeof payload[key] === "string" ? (payload[key] as string) : null;
  const brandOutlets = async (brandId: string | null | undefined) => {
    if (!brandId) return [];
    const rows = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        and(eq(outlets.tenantId, event.tenantId), eq(outlets.brandId, brandId)),
      );
    return rows.map((r) => r.id);
  };
  switch (event.name) {
    case "price_list.updated":
    case "item.sold_out":
    case "item.restored": {
      const outletId = str("outletId");
      return outletId ? [outletId] : [];
    }
    case "menu_item.updated": {
      const itemId = str("itemId");
      if (!itemId) return [];
      const [row] = await tx
        .select({ brandId: menuItems.brandId })
        .from(menuItems)
        .where(
          and(eq(menuItems.tenantId, event.tenantId), eq(menuItems.id, itemId)),
        );
      return brandOutlets(row?.brandId);
    }
    case "menu.updated": {
      const entity = str("entity");
      const entityId = str("entityId");
      if (!entityId) return [];
      if (entity === "category") {
        const [row] = await tx
          .select({ brandId: menuCategories.brandId })
          .from(menuCategories)
          .where(
            and(
              eq(menuCategories.tenantId, event.tenantId),
              eq(menuCategories.id, entityId),
            ),
          );
        return brandOutlets(row?.brandId);
      }
      if (entity === "availability") {
        const [row] = await tx
          .select({ outletId: itemAvailability.outletId })
          .from(itemAvailability)
          .where(
            and(
              eq(itemAvailability.tenantId, event.tenantId),
              eq(itemAvailability.id, entityId),
            ),
          );
        return row ? [row.outletId] : [];
      }
      return [];
    }
    default:
      return [];
  }
}

type Deliver = Parameters<typeof consumeOutbox>[2]["deliver"];

/**
 * `consumeOutbox` deliver callback: marks the affected outlets dirty inside
 * the consumption transaction (so a crash cannot lose the signal).
 */
export function createMenuPrintDirtyConsumer(
  options: { debounceSeconds?: number; now?: () => Date } = {},
): Deliver {
  return async (event, _key, tx) => {
    const outletIds = await outletsAffectedByEvent(tx as unknown as Tx, event);
    await markMenuPrintDirty(
      tx as unknown as Tx,
      event.tenantId,
      outletIds,
      options.now?.() ?? new Date(),
      options.debounceSeconds,
    );
  };
}

// ----------------------------------------------------------------- render

/** Render + store one outlet now. Returns the render row id. */
export async function regenerateMenuPrint(
  context: ScopedTenantContext,
  outletId: string,
  deps: MenuPrintDeps,
  now = new Date(),
): Promise<{ objectId: string; itemCount: number; reused: boolean }> {
  assertTrustedScopedContext(context);
  assertOutletInScope(context.outletScope, outletId);
  if (!deps.renderer)
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "Pembuat PDF menu belum tersedia.",
    );
  // Before the claim and the render: a scanner that cannot vet PDFs would make
  // the upload below refuse anyway (legend-0w2wy).
  assertScannerAcceptsDocuments(deps.scanner ?? new NoopMalwareScanner());
  const tenantId = context.tenant.tenantId;
  // Claim: clear the dirty flag first. An event arriving while we render sets
  // it again and triggers one more run; nothing is lost.
  const { menu, previous } = await withTenant(db, context, async (tx) => {
    await tx
      .insert(printableMenuRenders)
      .values({ tenantId, outletId, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(printableMenuRenders)
      .where(
        and(
          eq(printableMenuRenders.tenantId, tenantId),
          eq(printableMenuRenders.outletId, outletId),
        ),
      )
      .for("update");
    await tx
      .update(printableMenuRenders)
      .set({ dirtySince: null, refreshAfter: null, updatedAt: now })
      .where(
        and(
          eq(printableMenuRenders.tenantId, tenantId),
          eq(printableMenuRenders.id, row.id),
        ),
      );
    return {
      menu: await collectPrintableMenu(tx, context, outletId, now),
      previous: row,
    };
  });
  const hash = printableMenuHash(menu);
  const itemCount = menu.categories.reduce((n, c) => n + c.items.length, 0);
  try {
    if (previous.objectId && previous.contentHash === hash) {
      await withTenant(db, context, (tx) =>
        tx
          .update(printableMenuRenders)
          .set({ lastError: null, attempts: 0, updatedAt: now })
          .where(
            and(
              eq(printableMenuRenders.tenantId, tenantId),
              eq(printableMenuRenders.id, previous.id),
            ),
          ),
      );
      return { objectId: previous.objectId, itemCount, reused: true };
    }
    const pdf = await deps.renderer.render(renderMenuPrintHtml(menu));
    const object = await uploadStorage(
      db,
      context,
      { purpose: "document", outletId: outletId as OutletId },
      pdf,
      {
        storage: deps.storage,
        scanner: deps.scanner ?? new NoopMalwareScanner(),
        authorize: async () => true, // callers authorised the outlet already
        // System render (also run by the scheduled sweep): no user owns it.
        actorUserId: null,
      },
    );
    await withTenant(db, context, (tx) =>
      tx
        .update(printableMenuRenders)
        .set({
          objectId: object.id,
          contentHash: hash,
          itemCount,
          generatedAt: now,
          attempts: 0,
          lastError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(printableMenuRenders.tenantId, tenantId),
            eq(printableMenuRenders.id, previous.id),
          ),
        ),
    );
    return { objectId: object.id, itemCount, reused: false };
  } catch (error) {
    // Re-arm with a backoff; keep only a generic marker.
    const attempts = previous.attempts + 1;
    await withTenant(db, context, (tx) =>
      tx
        .update(printableMenuRenders)
        .set({
          dirtySince: previous.dirtySince ?? now,
          refreshAfter: sql`${now.toISOString()}::timestamptz + make_interval(secs => ${Math.min(
            60 * 2 ** Math.min(attempts, 5),
            3600,
          )})`,
          attempts,
          lastError: "render_failed",
          updatedAt: now,
        })
        .where(
          and(
            eq(printableMenuRenders.tenantId, tenantId),
            eq(printableMenuRenders.id, previous.id),
          ),
        ),
    );
    throw error;
  }
}

/** Worker sweep: render every due outlet once (tenant-scoped context). */
export async function runDueMenuPrints(
  context: ScopedTenantContext,
  deps: MenuPrintDeps,
  now = new Date(),
  limit = 20,
): Promise<{ regenerated: string[]; failed: string[] }> {
  assertTrustedScopedContext(context);
  const due = await withTenant(db, context, (tx) =>
    tx
      .select({ outletId: printableMenuRenders.outletId })
      .from(printableMenuRenders)
      .where(
        and(
          eq(printableMenuRenders.tenantId, context.tenant.tenantId),
          sql`${printableMenuRenders.dirtySince} IS NOT NULL`,
          sql`${printableMenuRenders.refreshAfter} <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(printableMenuRenders.refreshAfter))
      .limit(limit),
  );
  const regenerated: string[] = [];
  const failed: string[] = [];
  for (const { outletId } of due) {
    try {
      await regenerateMenuPrint(context, outletId, deps, now);
      regenerated.push(outletId);
    } catch {
      failed.push(outletId);
    }
  }
  return { regenerated, failed };
}

// ------------------------------------------------------------------- read

export type LatestMenuPrint = {
  outletId: string;
  url: string;
  expiresAt: string;
  generatedAt: string;
  itemCount: number;
  /** A change is waiting for the debounced regeneration. */
  stale: boolean;
  taxNote: string;
};

/** Latest PDF of the outlet; the first request renders it on the spot. */
export async function getLatestMenuPrint(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { outletId?: string },
  deps: MenuPrintDeps,
  now = new Date(),
): Promise<LatestMenuPrint> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const outletId = await withTenant(db, context, async (tx) => {
    const id = await resolveOutlet(tx, context, input.outletId);
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      MENU_VIEW_PERMISSION,
      id,
      now,
    );
    return id;
  });
  const load = () =>
    withTenant(db, context, async (tx) => {
      const [row] = await tx
        .select()
        .from(printableMenuRenders)
        .where(
          and(
            eq(printableMenuRenders.tenantId, tenantId),
            eq(printableMenuRenders.outletId, outletId),
          ),
        );
      return row;
    });
  let row = await load();
  if (!row?.objectId) {
    await regenerateMenuPrint(context, outletId, deps, now);
    row = await load();
  }
  if (!row?.objectId || !row.generatedAt)
    throw new CoreError("NOT_FOUND", "Menu cetak belum tersedia.");
  const signed = await signedStorageUrl(db, context, row.objectId, "original", {
    storage: deps.storage,
    authorize: async () => true, // viewed permission asserted above
  });
  return {
    outletId,
    url: signed.url,
    expiresAt: signed.expiresAt,
    generatedAt: row.generatedAt.toISOString(),
    itemCount: row.itemCount,
    stale: row.dirtySince !== null,
    taxNote: PRINT_TAX_NOTE,
  };
}

/** Manual "regenerate now" (needs the item-manage permission on the outlet). */
export async function refreshMenuPrintNow(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { outletId?: string },
  deps: MenuPrintDeps,
  now = new Date(),
): Promise<LatestMenuPrint> {
  assertTrustedScopedContext(context);
  const outletId = await withTenant(db, context, async (tx) => {
    const id = await resolveOutlet(tx, context, input.outletId);
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      MENU_ITEM_PERMISSION,
      id,
      now,
    );
    return id;
  });
  await regenerateMenuPrint(context, outletId, deps, now);
  return getLatestMenuPrint(context, actorUserId, { outletId }, deps, now);
}
