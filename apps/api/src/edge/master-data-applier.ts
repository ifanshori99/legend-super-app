// legend-3x9l: full-state catalog documents arriving on the edge link. The
// existing HTTP catalog protocol and its checkpoints remain independent.
import {
  assertOutletInScope,
  CoreError,
  outletIdSchema,
} from "@starter/shared/core";
import {
  catalogRecordUpdatedEvent,
  catalogSyncRecordSchemas,
  type CatalogSyncStream,
} from "@starter/shared/edge";
import type { EventEnvelope } from "@starter/shared/events";
import { and, eq, getTableName, sql } from "drizzle-orm";
import { menuItems, priceListItems } from "../db/schema/menu.ts";
import { recipeLines } from "../db/schema/recipe.ts";
import { promotionOutlets } from "../db/schema/crm-promo.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { catalogRecordIdFromKeys } from "../lib/edge-catalog-identity.ts";
import {
  applyCatalogRecords,
  CatalogMissingRefError,
  repairCategoryParents,
  repairPrinterFallbacks,
  STREAM_TABLES,
  unresolvedCategoryParents,
  unresolvedPrinterFallbacks,
  type CatalogApplyResult,
} from "../services/edge-catalog-apply.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
} from "./applier-registry.ts";
import {
  ensureCatalogStreamInitialized,
  loadPendingParents,
  savePendingParents,
} from "./catalog-puller.ts";
import { EdgeApplyDeferredError, type EdgeApplyMeta } from "./ports.ts";

/** Only missing catalog/master references, not arbitrary FK violations, defer. */
async function isCatalogReferenceViolation(
  tx: EdgeTx,
  error: unknown,
): Promise<boolean> {
  let cause = error;
  let writeQuery = false;
  for (
    let depth = 0;
    depth < 8 && cause && typeof cause === "object";
    depth++
  ) {
    const pg = cause as {
      code?: unknown;
      constraint?: unknown;
      table?: unknown;
      schema?: unknown;
      query?: unknown;
      cause?: unknown;
    };
    if (typeof pg.query === "string")
      writeQuery = /^\s*(?:insert\s+into|update)\b/i.test(pg.query);
    if (pg.code === "23503") {
      if (
        !writeQuery ||
        typeof pg.constraint !== "string" ||
        typeof pg.table !== "string" ||
        typeof pg.schema !== "string"
      )
        return false;
      const targets = [
        ...Object.values(STREAM_TABLES).map(getTableName),
        "uoms",
      ];
      const sources = [
        ...Object.values(STREAM_TABLES).map(getTableName),
        ...[priceListItems, recipeLines, promotionOutlets].map(getTableName),
      ];
      if (!sources.includes(pg.table)) return false;
      const result = await tx.execute(sql`SELECT target.relname AS target_name
        FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_class source ON source.oid = c.conrelid
        JOIN pg_catalog.pg_namespace source_ns ON source_ns.oid = source.relnamespace
        JOIN pg_catalog.pg_class target ON target.oid = c.confrelid
        JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
        WHERE c.contype = 'f' AND c.conname = ${pg.constraint}
          AND source.relname = ${pg.table} AND source_ns.nspname = ${pg.schema}
          AND target_ns.nspname = 'public'`);
      return result.rows.some(
        (row) =>
          typeof row.target_name === "string" &&
          targets.includes(row.target_name),
      );
    }
    cause = pg.cause;
  }
  return false;
}

/**
 * UUIDv8 identity of one catalog document. The stream is part of the key, so
 * equal row UUIDs in different tables cannot supersede each other. Join rows
 * use both key columns. All versions of the same document share this ID.
 */
export function catalogRecordAggregateId(
  stream: CatalogSyncStream,
  record: unknown,
): string {
  const parsed = catalogSyncRecordSchemas[stream].parse(record);
  const keys =
    "id" in parsed ? [parsed.id] : [parsed.menuItemId, parsed.groupId];
  return catalogRecordIdFromKeys(stream, keys);
}

function refuse(message: string): never {
  throw new CoreError("VALIDATION_ERROR", message);
}

/** Persist optional links in the same transaction, including across restarts. */
async function repairPendingLinks(
  tx: EdgeTx,
  meta: EdgeApplyMeta,
  stream: CatalogSyncStream,
  outcome: CatalogApplyResult,
): Promise<void> {
  if (stream !== "menu_categories" && stream !== "printers") return;
  const checkpoint =
    stream === "menu_categories"
      ? "catalog:menu_categories:parents"
      : "catalog:printers:fallbacks";
  const fresh =
    stream === "menu_categories"
      ? outcome.deferredParents
      : outcome.deferredFallbacks;
  const held = await loadPendingParents(tx, meta.edgeNodeId, checkpoint);
  const pending = [
    ...held.filter((pair) => !fresh.some((entry) => entry.id === pair.id)),
    ...fresh,
  ];
  if (pending.length === 0) return;
  const input = { tenantId: meta.context.tenant.tenantId, pairs: pending };
  if (stream === "menu_categories") await repairCategoryParents(tx, input);
  else await repairPrinterFallbacks(tx, input);
  const remaining =
    stream === "menu_categories"
      ? await unresolvedCategoryParents(tx, input)
      : await unresolvedPrinterFallbacks(tx, input);
  // The link must not acknowledge a partially applied document as held.
  // Roll back its savepoint and let the ordered HTTP pull recover it.
  if (remaining.some((pair) => fresh.some((entry) => entry.id === pair.id)))
    throw new EdgeApplyDeferredError(stream);
  await savePendingParents(
    tx,
    meta.edgeNodeId,
    remaining,
    new Date(),
    checkpoint,
  );
}

/** Apply inside the link's transaction; never advance an HTTP pull cursor. */
export async function applyCatalogRecordUpdated(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  if (meta.direction !== "cloud_to_edge" || meta.kind !== "master_data")
    throw new CoreError(
      "FORBIDDEN",
      "Catalog records only travel cloud to edge",
    );
  const parsed = catalogRecordUpdatedEvent.envelopeSchema.safeParse(event);
  // A malformed transport document is not a business refusal and must not
  // be acknowledged: the sender retains the batch for investigation.
  if (!parsed.success)
    throw new Error("Catalog event must carry one complete record.");
  const envelope = parsed.data;
  const { stream, record } = envelope.payload;
  const tenantId = meta.context.tenant.tenantId;
  if (envelope.tenantId !== tenantId || record.tenantId !== tenantId)
    throw new CoreError("FORBIDDEN", "Catalog event belongs to another tenant");
  if (envelope.outletId === null) refuse("Catalog event has no outlet.");
  assertOutletInScope(meta.context.outletScope, envelope.outletId);
  if ("outletId" in record && record.outletId !== envelope.outletId)
    throw new CoreError(
      "FORBIDDEN",
      "Catalog record belongs to another outlet",
    );
  if (
    "brandId" in record &&
    meta.context.tenant.brandId !== null &&
    record.brandId !== meta.context.tenant.brandId
  )
    throw new CoreError("FORBIDDEN", "Catalog record belongs to another brand");
  if (envelope.aggregateId !== catalogRecordAggregateId(stream, record))
    refuse("Catalog event does not match its document key.");
  if (BigInt(record.syncTxid) !== BigInt(envelope.sequence))
    refuse("Catalog event does not match its document version.");
  // Edge credential contexts intentionally do not pin a brand. Resolve it
  // from the authenticated outlet instead of treating null as unrestricted.
  if ("brandId" in record || "menuItemId" in record) {
    const [outlet] = await tx
      .select({ brandId: outlets.brandId })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, tenantId),
          eq(outlets.id, outletIdSchema.parse(envelope.outletId)),
        ),
      )
      .limit(1);
    if (!outlet)
      throw new CoreError("FORBIDDEN", "Catalog outlet is unavailable");
    if ("brandId" in record && record.brandId !== outlet.brandId)
      throw new CoreError(
        "FORBIDDEN",
        "Catalog record belongs to another brand",
      );
    if ("menuItemId" in record) {
      const [item] = await tx
        .select({ brandId: menuItems.brandId })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.tenantId, tenantId),
            eq(menuItems.id, record.menuItemId),
          ),
        )
        .limit(1);
      if (!item) throw new EdgeApplyDeferredError(stream);
      if (item.brandId !== outlet.brandId)
        throw new CoreError(
          "FORBIDDEN",
          "Catalog item belongs to another brand",
        );
    }
  }
  try {
    await tx.transaction(async (savepoint) => {
      await ensureCatalogStreamInitialized(savepoint, {
        tenantId,
        edgeNodeId: meta.edgeNodeId,
        stream,
        at: new Date(),
      });
      const outcome = await applyCatalogRecords(savepoint, {
        tenantId,
        stream,
        records: [record],
      });
      await repairPendingLinks(savepoint, meta, stream, outcome);
    });
  } catch (error) {
    if (
      error instanceof CatalogMissingRefError ||
      (await isCatalogReferenceViolation(tx, error))
    )
      throw new EdgeApplyDeferredError(stream);
    throw error;
  }
}

/** Idempotent; register alongside QR and Wi-Fi, preserving their handlers. */
export function registerMasterDataEdgeApplier(): void {
  registerEdgeEventHandler(
    "cloud_to_edge",
    catalogRecordUpdatedEvent.name,
    applyCatalogRecordUpdated,
  );
  registerEdgeAggregateKind(
    catalogRecordUpdatedEvent.entry.aggregateType,
    "master_data",
  );
}
