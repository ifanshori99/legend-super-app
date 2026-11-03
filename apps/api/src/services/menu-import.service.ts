// Menu bulk import service (bead legend-dmi; PRD v1.7 §3 F8 "Impor Massal").
//
// validate / preview / commit share one pipeline: parse the file (pure,
// menu-import-parse.ts), then resolve each row against the brand's categories,
// the outlet's stations and the existing items. Commit re-parses the bytes
// (never trusts a prior preview) and is ATOMIC: one transaction, and any
// invalid row refuses the whole file with per-row errors (all-or-nothing, so a
// half-imported menu can never exist).
//
// Rules: imported items are DRAFTS (is_active false, no media; owner Q23, the
// template has no photo column). A missing category is created; a missing
// station is a row error (a station needs an outlet and a type, so it is never
// invented). An item with the same category + name already in the brand is a
// duplicate: rejected by default, or updated in place with `onDuplicate:
// "update"` (template fields + price only; is_active, media and every other
// field stay untouched). The template price goes to the outlet's price list
// for `channel` (default dine_in) effective today (outlet business date): the
// list in force is copied forward first, so unrelated prices are not lost.
// Idempotency: the `Idempotency-Key` is unique per tenant and bound to a
// fingerprint of file hash + brand + outlet + options; a retry replays the
// stored counts, the same key with different input is a 409.

import { outlets } from "../db/schema/platform-org.ts";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  businessDateOf,
  createUlid,
  CoreError,
  idempotencyKeySchema,
  idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  menuItemUpdatedEvent,
  menuUpdatedEvent,
  priceListUpdatedEvent,
  type MenuChannel,
  type MenuImportRow,
} from "@starter/shared/menu";
import {
  itemAvailability,
  menuCategories,
  menuItems,
  priceListItems,
  priceLists,
  stations,
} from "../db/schema/menu.ts";
import { menuImportJobs } from "../db/schema/menu-import.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  MENU_ITEM_PERMISSION,
  MENU_PRICE_MANAGE_PERMISSION,
  appendMenuEvent,
  assertBrandPermission,
  assertOutletPermission,
  resolveBrand,
  resolveOutlet,
  type Tx,
} from "./menu-internals.ts";
import {
  IMPORT_MAX_FILE_BYTES,
  ImportFileError,
  importKey,
  parseMenuImportFile,
  type ImportRowError,
  type ParsedImport,
} from "./menu-import-parse.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";

export type MenuImportInput = {
  fileName: string;
  /** Base64 file bytes (no data: prefix). */
  dataBase64: string;
  brandId?: string;
  outletId?: string;
  channel?: MenuChannel;
  onDuplicate?: "reject" | "update";
};

export type ImportRowReport = {
  rowNumber: number;
  action: "create" | "update" | "error";
  errors: ImportRowError[];
  /** Normalised row, only on preview. */
  data?: MenuImportRow;
};

export type ImportReport = {
  fileHash: string;
  format: "csv" | "xlsx";
  outletId: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  summary: {
    itemsToCreate: number;
    itemsToUpdate: number;
    categoriesToCreate: number;
  };
  rows: ImportRowReport[];
};

export type ImportCommitResult = {
  jobId: string;
  replayed: boolean;
  fileHash: string;
  createdItems: number;
  updatedItems: number;
  createdCategories: number;
  priceListId: string;
  /** Every imported item is a draft until its photo is uploaded (Q23). */
  draftItems: number;
};

/** Commit refused: at least one row is invalid (nothing was written). */
export class MenuImportInvalidError extends HttpError {
  constructor(public report: ImportReport) {
    super(
      422,
      "MENU_IMPORT_INVALID",
      `${report.errorRows} baris tidak valid. Perbaiki berkas lalu unggah ulang; tidak ada data yang disimpan.`,
    );
  }
}

function decodeFile(input: MenuImportInput): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64))
    throw new HttpError(422, "VALIDATION_ERROR", "Data berkas harus base64.");
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (bytes.length > IMPORT_MAX_FILE_BYTES)
    throw new HttpError(
      413,
      "PAYLOAD_TOO_LARGE",
      "Berkas melebihi batas ukuran impor.",
    );
  return bytes;
}

function parseOrThrow(input: MenuImportInput): ParsedImport {
  try {
    return parseMenuImportFile({
      fileName: input.fileName,
      bytes: decodeFile(input),
    });
  } catch (error) {
    if (error instanceof ImportFileError)
      throw new HttpError(
        error.code === "FILE_TOO_LARGE" ? 413 : 422,
        `MENU_IMPORT_${error.code}`,
        error.message,
      );
    throw error;
  }
}

type Resolved = {
  brandId: string;
  outletId: string;
  parsed: ParsedImport;
  report: ImportReport;
  plan: {
    row: MenuImportRow;
    rowNumber: number;
    existingItemId: string | null;
    stationId: string;
  }[];
};

const norm = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

async function resolveImport(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  input: MenuImportInput,
  now: Date,
  withData: boolean,
): Promise<Resolved> {
  const brandId = await resolveBrand(tx, context, input.brandId);
  const outletId = await resolveOutlet(tx, context, input.outletId);
  await assertBrandPermission(
    tx,
    context,
    actorUserId,
    MENU_ITEM_PERMISSION,
    brandId,
    now,
  );
  await assertOutletPermission(
    tx,
    context,
    actorUserId,
    MENU_PRICE_MANAGE_PERMISSION,
    outletId,
    now,
  );
  const [outlet] = await tx
    .select({ brandId: outlets.brandId })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, outletId),
      ),
    );
  if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
  if (outlet.brandId !== brandId)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Outlet berada di brand lain.",
    );

  const parsed = parseOrThrow(input);
  const tenantId = context.tenant.tenantId;
  const categories = await tx
    .select({ id: menuCategories.id, name: menuCategories.name })
    .from(menuCategories)
    .where(
      and(
        eq(menuCategories.tenantId, tenantId),
        eq(menuCategories.brandId, brandId),
        isNull(menuCategories.deletedAt),
      ),
    );
  const categoryByName = new Map(categories.map((c) => [norm(c.name), c.id]));
  const stationRows = await tx
    .select({ id: stations.id, name: stations.name })
    .from(stations)
    .where(
      and(
        eq(stations.tenantId, tenantId),
        eq(stations.outletId, outletId),
        isNull(stations.deletedAt),
      ),
    );
  const stationByName = new Map(stationRows.map((s) => [norm(s.name), s.id]));
  const existing = await tx
    .select({
      id: menuItems.id,
      categoryId: menuItems.categoryId,
      name: menuItems.name,
    })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, tenantId),
        eq(menuItems.brandId, brandId),
        isNull(menuItems.deletedAt),
      ),
    );
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const itemByKey = new Map<string, string>();
  for (const item of existing) {
    const category = categoryNameById.get(item.categoryId);
    if (category) itemByKey.set(importKey(category, item.name), item.id);
  }

  const onDuplicate = input.onDuplicate ?? "reject";
  const newCategories = new Set<string>();
  const plan: Resolved["plan"] = [];
  const rows: ImportRowReport[] = [];
  let toCreate = 0;
  let toUpdate = 0;
  for (const parsedRow of parsed.rows) {
    const errors = [...parsedRow.errors];
    const row = parsedRow.data;
    let action: ImportRowReport["action"] = "error";
    if (row && errors.length === 0) {
      const stationId = stationByName.get(norm(row.station));
      const existingId =
        itemByKey.get(importKey(row.category, row.name)) ?? null;
      if (!stationId)
        errors.push({
          field: "station",
          code: "INVALID",
          message: `Stasiun "${row.station}" tidak ditemukan di outlet ini.`,
        });
      if (existingId && onDuplicate === "reject")
        errors.push({
          field: "name",
          code: "DUPLICATE_EXISTING",
          message: "Item dengan kategori dan nama yang sama sudah ada.",
        });
      if (errors.length === 0 && stationId) {
        action = existingId ? "update" : "create";
        if (existingId) toUpdate += 1;
        else toCreate += 1;
        if (!categoryByName.has(norm(row.category)))
          newCategories.add(norm(row.category));
        plan.push({
          row,
          rowNumber: parsedRow.rowNumber,
          existingItemId: existingId,
          stationId,
        });
      }
    }
    rows.push({
      rowNumber: parsedRow.rowNumber,
      action,
      errors,
      ...(withData && row && action !== "error" ? { data: row } : {}),
    });
  }
  const errorRows = rows.filter((r) => r.action === "error").length;
  return {
    brandId,
    outletId,
    parsed,
    plan,
    report: {
      fileHash: parsed.fileHash,
      format: parsed.format,
      outletId,
      totalRows: rows.length,
      validRows: rows.length - errorRows,
      errorRows,
      summary: {
        itemsToCreate: toCreate,
        itemsToUpdate: toUpdate,
        categoriesToCreate: newCategories.size,
      },
      rows,
    },
  };
}

/** Per-row validation report; writes nothing. */
export async function validateMenuImport(
  context: ScopedTenantContext,
  actorUserId: string,
  input: MenuImportInput,
  now = new Date(),
): Promise<ImportReport> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const resolved = await resolveImport(
      tx,
      context,
      actorUserId,
      input,
      now,
      false,
    );
    return resolved.report;
  });
}

/** Validation report plus the normalised rows and planned action; writes nothing. */
export async function previewMenuImport(
  context: ScopedTenantContext,
  actorUserId: string,
  input: MenuImportInput,
  now = new Date(),
): Promise<ImportReport> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const resolved = await resolveImport(
      tx,
      context,
      actorUserId,
      input,
      now,
      true,
    );
    return resolved.report;
  });
}

export function importFingerprint(input: {
  fileHash: string;
  brandId: string;
  outletId: string;
  channel: MenuChannel;
  onDuplicate: "reject" | "update";
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.fileHash,
        input.brandId,
        input.outletId,
        input.channel,
        input.onDuplicate,
      ]),
    )
    .digest("hex");
}

/** Atomic commit. See the file header for the rules. */
export async function commitMenuImport(
  context: ScopedTenantContext,
  actorUserId: string,
  idempotencyKey: string,
  input: MenuImportInput,
  now = new Date(),
): Promise<ImportCommitResult> {
  assertTrustedScopedContext(context);
  const key = idempotencyKeySchema.parse(idempotencyKey);
  const channel = input.channel ?? "dine_in";
  const onDuplicate = input.onDuplicate ?? "reject";
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    // Serialise retries of one key: the second waits, then replays.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`menu-import:${tenantId}:${key}`}))`,
    );
    const resolved = await resolveImport(
      tx,
      context,
      actorUserId,
      input,
      now,
      false,
    );
    const fingerprint = importFingerprint({
      fileHash: resolved.parsed.fileHash,
      brandId: resolved.brandId,
      outletId: resolved.outletId,
      channel,
      onDuplicate,
    });
    const [prior] = await tx
      .select()
      .from(menuImportJobs)
      .where(
        and(
          eq(menuImportJobs.tenantId, tenantId),
          eq(menuImportJobs.idempotencyKey, key),
        ),
      );
    if (prior) {
      if (prior.requestFingerprint !== fingerprint)
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci idempotensi sudah dipakai untuk impor yang berbeda.",
        );
      const stored = prior.result as Record<string, number | string>;
      return {
        jobId: prior.id,
        replayed: true,
        fileHash: prior.fileHash,
        createdItems: Number(stored.createdItems ?? 0),
        updatedItems: Number(stored.updatedItems ?? 0),
        createdCategories: Number(stored.createdCategories ?? 0),
        priceListId: String(stored.priceListId ?? ""),
        draftItems: Number(stored.draftItems ?? 0),
      };
    }
    if (resolved.report.errorRows > 0)
      throw new MenuImportInvalidError(resolved.report);
    if (resolved.plan.length === 0)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Berkas tidak memuat baris data.",
      );

    const { brandId, outletId } = resolved;
    // 1. categories (created on demand, in file order).
    const categoryIds = new Map<string, string>();
    const existingCategories = await tx
      .select({ id: menuCategories.id, name: menuCategories.name })
      .from(menuCategories)
      .where(
        and(
          eq(menuCategories.tenantId, tenantId),
          eq(menuCategories.brandId, brandId),
          isNull(menuCategories.deletedAt),
        ),
      );
    for (const c of existingCategories) categoryIds.set(norm(c.name), c.id);
    let nextCategoryOrder = existingCategories.length;
    let createdCategories = 0;
    for (const { row } of resolved.plan) {
      const k = norm(row.category);
      if (categoryIds.has(k)) continue;
      const [created] = await tx
        .insert(menuCategories)
        .values({
          tenantId,
          brandId,
          name: row.category.trim().replace(/\s+/g, " "),
          sortOrder: nextCategoryOrder,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: menuCategories.id });
      nextCategoryOrder += 1;
      createdCategories += 1;
      categoryIds.set(k, created.id);
      await appendMenuEvent(tx, context, menuUpdatedEvent, {
        aggregateId: created.id,
        actorUserId,
        payload: {
          entity: "category",
          entityId: created.id,
          operation: "created",
        },
        affects: { kind: "brand", brandId },
        now,
      });
    }

    // 2. items.
    const sortCursor = new Map<string, number>();
    const priced: { itemId: string; priceIdr: number }[] = [];
    let createdItems = 0;
    let updatedItems = 0;
    const brandOutlets = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.brandId, brandId)));
    for (const entry of resolved.plan) {
      const { row } = entry;
      const categoryId = categoryIds.get(norm(row.category)) as string;
      let itemId = entry.existingItemId;
      if (itemId) {
        // Template fields only; is_active, media_id and edge/replication
        // fields other than updated_at stay as they are.
        await tx
          .update(menuItems)
          .set({
            description: row.description,
            stationId: entry.stationId,
            course: row.course === "" ? null : row.course,
            labels: row.labels,
            allergens: row.allergens,
            updatedAt: now,
          })
          .where(
            and(eq(menuItems.tenantId, tenantId), eq(menuItems.id, itemId)),
          );
        updatedItems += 1;
      } else {
        if (!sortCursor.has(categoryId)) {
          const [last] = await tx
            .select({
              last: sql<number>`coalesce(max(${menuItems.sortOrder}), -1)`,
            })
            .from(menuItems)
            .where(
              and(
                eq(menuItems.tenantId, tenantId),
                eq(menuItems.categoryId, categoryId),
                isNull(menuItems.deletedAt),
              ),
            );
          sortCursor.set(categoryId, Number(last?.last ?? -1) + 1);
        }
        const sortOrder = sortCursor.get(categoryId) as number;
        sortCursor.set(categoryId, sortOrder + 1);
        const [created] = await tx
          .insert(menuItems)
          .values({
            tenantId,
            brandId,
            categoryId,
            name: row.name.trim().replace(/\s+/g, " "),
            description: row.description,
            type: row.type,
            stationId: entry.stationId,
            course: row.course === "" ? null : row.course,
            labels: row.labels,
            allergens: row.allergens,
            mediaId: null,
            isActive: false, // Q23: draft until a photo exists.
            sortOrder,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: menuItems.id });
        itemId = created.id;
        createdItems += 1;
        for (const outlet of brandOutlets) {
          if (
            context.outletScope.kind === "outlets" &&
            !context.outletScope.outletIds.some(
              (id) => id.toLowerCase() === outlet.id.toLowerCase(),
            )
          )
            continue;
          await tx
            .insert(itemAvailability)
            .values({
              tenantId,
              outletId: outlet.id,
              menuItemId: itemId,
              schedule: [],
              status: "available",
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing();
        }
      }
      const [state] = await tx
        .select({ isActive: menuItems.isActive })
        .from(menuItems)
        .where(and(eq(menuItems.tenantId, tenantId), eq(menuItems.id, itemId)));
      await appendMenuEvent(tx, context, menuItemUpdatedEvent, {
        aggregateId: itemId,
        actorUserId,
        payload: {
          itemId,
          categoryId,
          isActive: state?.isActive ?? false,
          operation: entry.existingItemId ? "updated" : "created",
        },
        affects: { kind: "brand", brandId },
        now,
      });
      priced.push({ itemId, priceIdr: row.priceIdr });
    }

    // 3. prices: today's list for the channel, copy-forward on first use.
    const [clockRow] = await tx
      .select({
        timezone: outlets.timezone,
        businessDayCutoff: outlets.businessDayCutoff,
      })
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
    const today = businessDateOf(now, outletBusinessDayClock(clockRow));
    const listFilter = and(
      eq(priceLists.tenantId, tenantId),
      eq(priceLists.outletId, outletId),
      eq(priceLists.channel, channel),
      isNull(priceLists.deletedAt),
    );
    const lists = await tx
      .select()
      .from(priceLists)
      .where(listFilter)
      .orderBy(sql`${priceLists.effectiveFrom} desc`);
    let list = lists.find((l) => l.effectiveFrom === today);
    let listCreated = false;
    if (!list) {
      const current = lists.find((l) => l.effectiveFrom < today);
      const [created] = await tx
        .insert(priceLists)
        .values({
          tenantId,
          outletId,
          channel,
          effectiveFrom: today,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      list = created;
      listCreated = true;
      if (current) {
        const carried = await tx
          .select()
          .from(priceListItems)
          .where(
            and(
              eq(priceListItems.tenantId, tenantId),
              eq(priceListItems.priceListId, current.id),
              isNull(priceListItems.deletedAt),
            ),
          );
        for (const c of carried)
          await tx.insert(priceListItems).values({
            tenantId,
            priceListId: created.id,
            itemId: c.itemId,
            variantId: c.variantId,
            priceIdr: c.priceIdr,
            createdAt: now,
            updatedAt: now,
          });
      }
    }
    const live = await tx
      .select()
      .from(priceListItems)
      .where(
        and(
          eq(priceListItems.tenantId, tenantId),
          eq(priceListItems.priceListId, list.id),
          inArray(
            priceListItems.itemId,
            priced.map((p) => p.itemId),
          ),
          isNull(priceListItems.variantId),
          isNull(priceListItems.deletedAt),
        ),
      );
    const liveByItem = new Map(live.map((l) => [l.itemId, l.id]));
    for (const p of priced) {
      const liveId = liveByItem.get(p.itemId);
      if (liveId)
        await tx
          .update(priceListItems)
          .set({ priceIdr: idr(p.priceIdr), updatedAt: now })
          .where(
            and(
              eq(priceListItems.tenantId, tenantId),
              eq(priceListItems.id, liveId),
            ),
          );
      else
        await tx.insert(priceListItems).values({
          tenantId,
          priceListId: list.id,
          itemId: p.itemId,
          variantId: null,
          priceIdr: idr(p.priceIdr),
          createdAt: now,
          updatedAt: now,
        });
    }
    await tx
      .update(priceLists)
      .set({ updatedAt: now })
      .where(
        and(eq(priceLists.tenantId, tenantId), eq(priceLists.id, list.id)),
      );
    await appendMenuEvent(tx, context, priceListUpdatedEvent, {
      aggregateId: list.id,
      actorUserId,
      payload: {
        priceListId: list.id,
        outletId,
        channel,
        effectiveFrom: list.effectiveFrom,
        operation: listCreated ? "created" : "items_replaced",
      },
      affects: { kind: "outlet", outletId },
      now,
    });

    // 4. job row + audit (counts only, never row content).
    const result = {
      createdItems,
      updatedItems,
      createdCategories,
      priceListId: list.id,
      draftItems: createdItems,
    };
    const [job] = await tx
      .insert(menuImportJobs)
      .values({
        tenantId,
        outletId,
        brandId,
        actorUserId,
        idempotencyKey: key,
        fileHash: resolved.parsed.fileHash,
        requestFingerprint: fingerprint,
        status: "committed",
        rowCount: resolved.plan.length,
        result,
        createdAt: now,
      })
      .returning({ id: menuImportJobs.id });
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "menu.import.committed",
        objectType: "menu_import_job",
        objectId: job.id,
        reason: null,
        maskedChanges: {
          before: null,
          after: { ...result, fileHash: resolved.parsed.fileHash, channel },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      [],
    );
    return {
      jobId: job.id,
      replayed: false,
      fileHash: resolved.parsed.fileHash,
      createdItems,
      updatedItems,
      createdCategories,
      priceListId: list.id,
      draftItems: createdItems,
    };
  });
}
