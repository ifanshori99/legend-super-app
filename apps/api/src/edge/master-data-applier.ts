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
import { and, eq } from "drizzle-orm";
import { menuItems } from "../db/schema/menu.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { catalogRecordIdFromKeys } from "../lib/edge-catalog-identity.ts";
import {
  applyCatalogRecords,
  CatalogMissingRefError,
  repairCategoryParents,
  repairPrinterFallbacks,
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
import type { EdgeApplyMeta } from "./ports.ts";

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
  if (!parsed.success) refuse("Catalog event must carry one complete record.");
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
      if (!item) throw new CatalogMissingRefError();
      if (item.brandId !== outlet.brandId)
        throw new CoreError(
          "FORBIDDEN",
          "Catalog item belongs to another brand",
        );
    }
  }
  if (envelope.aggregateId !== catalogRecordAggregateId(stream, record))
    refuse("Catalog event does not match its document key.");
  // Transport ordering and catalog ordering must name the same version.
  // Otherwise an inflated envelope sequence could hide a later valid update.
  if (BigInt(record.syncTxid) !== BigInt(envelope.sequence))
    refuse("Catalog event does not match its document version.");
  await ensureCatalogStreamInitialized(tx, {
    tenantId,
    edgeNodeId: meta.edgeNodeId,
    stream,
    at: new Date(),
  });
  const outcome = await applyCatalogRecords(tx, {
    tenantId,
    stream,
    records: [record],
  });
  await repairPendingLinks(tx, meta, stream, outcome);
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
