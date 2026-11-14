// KDS station configuration (bead legend-bopi2; PRD v1.7 §3 F12; contract
// @starter/shared/kitchen `listKitchenStations` + `updateKitchenStations`).
//
// The tab order, the active flag and the "Fallback Cetak" flag live on the
// `stations` row (migration 0363), so a save is an update of those rows.
//
// - `listKitchenStationConfig`: every live station of the outlet, in display
//   order, then name, then id. Tenant and outlet are filtered in SQL as well
//   as by RLS.
// - `listKitchenStationConfigInScope`: the same rows for a caller who holds
//   `kds.ticket.process` only (a cook; the KDS board reads this list for its
//   tabs). Narrowed in SQL to `permittedStationIds`, like `/station-labels`.
// - `saveKitchenStationConfig`: one `withTenant` transaction. It locks the
//   outlet's live stations in id order (FOR NO KEY UPDATE, so ticket routing
//   keeps its FK checks and two concurrent saves run one after the other),
//   merges the body over the stored rows and refuses the save when no active
//   station would remain. A station the body does not name is left as it is.
//   A duplicated station id, or an id that is not a live station of this
//   tenant and outlet, is refused with the same "not found" answer, so the
//   response never says whether the id exists elsewhere. Only rows that really
//   change are written; the stations sync_txid trigger stamps them for the
//   catalog down-sync (the edge side is bead legend-i78o6).

import { and, asc, eq, isNull } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  toIsoDateTime,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  stationConfigSchema,
  type StationConfig,
  type updateKitchenStationsBodySchema,
} from "@starter/shared/kitchen";
import type { z } from "zod";
import { db } from "../db/index.ts";
import { outlets, stations } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./core-audit.ts";
import type { KdsActor } from "./kds-support.ts";
import type { Tx } from "./menu-internals.ts";
import {
  permittedStationIds,
  stationScopeCondition,
} from "./station-access.ts";

type StationRow = typeof stations.$inferSelect;
type SaveBody = z.infer<typeof updateKitchenStationsBodySchema>;

const stationNotFound = () =>
  new CoreError("NOT_FOUND", "Stasiun dapur tidak ditemukan di outlet ini.");

/** A stations row has no separate config id: the station id is the row id. */
function configDto(row: StationRow): StationConfig {
  return stationConfigSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    id: row.id,
    stationId: row.id,
    displayOrder: row.displayOrder,
    isActive: row.isActive,
    autoPrintFallback: row.autoPrintFallback,
  });
}

function inDisplayOrder(rows: StationRow[]): StationRow[] {
  return [...rows].sort(
    (a, b) =>
      a.displayOrder - b.displayOrder ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

async function readOutletStations(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  lock: boolean,
  reach?: readonly string[],
): Promise<StationRow[]> {
  const query = tx
    .select()
    .from(stations)
    .where(
      and(
        eq(stations.tenantId, context.tenant.tenantId),
        eq(stations.outletId, outletId),
        isNull(stations.deletedAt),
        reach ? stationScopeCondition(stations.id, reach) : undefined,
      ),
    )
    .orderBy(asc(stations.id));
  return lock ? query.for("no key update") : query;
}

export async function listKitchenStationConfig(
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<StationConfig[]> {
  return withTenant(db, context, async (tx) =>
    inDisplayOrder(await readOutletStations(tx, context, outletId, false)).map(
      configDto,
    ),
  );
}

/**
 * The cook's view of the tabs: only the stations the caller may process. An
 * unknown outlet, or one of another tenant, answers 404, so the status cannot
 * probe which outlets exist; an empty reach answers an empty list.
 */
export async function listKitchenStationConfigInScope(
  context: ScopedTenantContext,
  actor: KdsActor,
  outletId: OutletId,
  now: Date,
): Promise<StationConfig[]> {
  return withTenant(db, context, async (tx) => {
    assertOutletInScope(context.outletScope, outletId);
    const [outlet] = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          eq(outlets.id, outletId),
        ),
      );
    if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
    const reach = await permittedStationIds(
      tx,
      context,
      actor.userId,
      "kds.ticket.process",
      now,
    );
    return inDisplayOrder(
      await readOutletStations(tx, context, outletId, false, reach),
    ).map(configDto);
  });
}

export async function saveKitchenStationConfig(
  context: ScopedTenantContext,
  outletId: OutletId,
  body: SaveBody,
  actor: KdsActor,
  now: Date,
): Promise<StationConfig[]> {
  const requested = new Map<string, SaveBody["stations"][number]>();
  for (const entry of body.stations) {
    if (requested.has(entry.stationId))
      throw new CoreError(
        "VALIDATION_ERROR",
        "Stasiun yang sama tidak boleh disebut dua kali.",
      );
    requested.set(entry.stationId, entry);
  }
  return withTenant(db, context, async (tx) => {
    const current = await readOutletStations(tx, context, outletId, true);
    const known = new Set(current.map((row) => row.id));
    for (const stationId of requested.keys())
      if (!known.has(stationId)) throw stationNotFound();

    const next = current.map((row) => {
      const entry = requested.get(row.id);
      return entry
        ? {
            ...row,
            displayOrder: entry.displayOrder,
            isActive: entry.isActive,
            autoPrintFallback: entry.autoPrintFallback,
          }
        : row;
    });
    // The rule is judged on the merged result, not on the body alone.
    if (!next.some((row) => row.isActive))
      throw new CoreError(
        "VALIDATION_ERROR",
        "Minimal satu stasiun dapur harus aktif.",
      );

    const changed: { old: StationRow; row: StationRow }[] = [];
    for (const [index, old] of current.entries()) {
      const row = next[index];
      if (
        row &&
        (old.displayOrder !== row.displayOrder ||
          old.isActive !== row.isActive ||
          old.autoPrintFallback !== row.autoPrintFallback)
      )
        changed.push({ old, row });
    }
    for (const { row } of changed)
      await tx
        .update(stations)
        .set({
          displayOrder: row.displayOrder,
          isActive: row.isActive,
          autoPrintFallback: row.autoPrintFallback,
          updatedAt: now,
        })
        .where(
          and(
            eq(stations.tenantId, context.tenant.tenantId),
            eq(stations.outletId, outletId),
            eq(stations.id, row.id),
            isNull(stations.deletedAt),
          ),
        );

    if (changed.length > 0) {
      const view = (row: StationRow) => ({
        stationId: row.id,
        displayOrder: row.displayOrder,
        isActive: row.isActive,
        autoPrintFallback: row.autoPrintFallback,
      });
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
          tenantId: context.tenant.tenantId,
          outletId,
          actorType: "user",
          actorId: actor.userId,
          deviceId: actor.deviceId,
          action: "kitchen_station_config.updated",
          objectType: "kitchen_station_config",
          objectId: outletId,
          reason: null,
          maskedChanges: {
            before: { stations: changed.map(({ old }) => view(old)) },
            after: { stations: changed.map(({ row }) => view(row)) },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: toIsoDateTime(now),
        },
        ["stationId", "displayOrder", "isActive", "autoPrintFallback"],
      );
    }
    return inDisplayOrder(next).map(configDto);
  });
}
