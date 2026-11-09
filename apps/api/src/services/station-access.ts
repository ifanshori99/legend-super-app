// Station authorization for station-bound services (bead legend-fsb7; PRD v1.7
// §3 F7 "Routing Stasiun", §6 B role_assignments, TEN-03).
//
// TEN-03 deliberately expands a station assignment to its outlet for RLS: the
// only query filter the database can install is `app.outlet_ids`, which is
// outlet-level. Every service that reads or mutates a station-bound resource
// (KDS tickets and boards, expo, kitchen station config, a printer or device
// bound to a station, any route that takes a stationId) must therefore run one
// of these checks on the caller's transaction, next to its query:
//
// - `assertStationPermission`: the caller's assignment covers THIS station for
//   the permission. A station-scoped account reaches only its own station(s);
//   outlet/brand/tenant scopes cover every station they contain. A resource
//   whose station cannot be determined (null/blank id, a row without a
//   station) is denied — fail closed, never "all stations".
// - `stationScopeFilter` / `stationScopeCondition` (legend-cot3): the SQL
//   filter for a list over a station-bound table, `station_id IN (reach)`,
//   `false` for an empty reach. Outlet/tenant RLS cannot express this, so a
//   list without it shows a station-only caller every station of the outlet.
// - `permittedStationIds`: the stations a list may show for the permission,
//   from the same snapshot (`AccessSnapshot.stationsFor`, i.e.
//   `stationReachOf`). An empty list means the caller may read no station, so
//   a list returns nothing for it (fail closed).
//
// Both read assignments, roles and the org index inside the tenant
// transaction, so the decision and the data come from one snapshot. Ids are
// branded StationId on the wire; the helpers accept the raw string the route
// or row carries and let the authorization fail closed on an unknown value.

import {
  AccessError,
  stationIdSchema,
  type PermissionCode,
} from "@starter/shared/access";
import type { ScopedTenantContext } from "@starter/shared/core";
import { inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { accessSnapshotInTransaction, type Tx } from "./permission-resolver";

/** The message every station denial uses; it must not reveal other stations. */
const STATION_DENIED = "Anda hanya dapat mengakses stasiun yang ditugaskan.";

/**
 * The permission must be held on `stationId`'s own target. Missing, blank or
 * malformed station ids deny instead of widening to the outlet (fail closed).
 */
export async function assertStationPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  stationId: string | null | undefined,
  now: Date,
): Promise<void> {
  const parsed = stationIdSchema.safeParse(stationId);
  if (!parsed.success)
    throw new AccessError("PERMISSION_DENIED", STATION_DENIED);
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    actorUserId,
    now,
  );
  // authorize() fails closed when the station is not part of the caller's org
  // index (other tenant, other brand, soft-deleted), so an unknown id never
  // reaches the "covered" branch.
  if (!snapshot.allows(permission, { type: "station", id: parsed.data }))
    throw new AccessError("PERMISSION_DENIED", STATION_DENIED);
}

/**
 * The station-aware query filter (legend-cot3, TEN-03): `column IN
 * (stationIds)`, and a literal `false` when the list is empty, so a caller
 * without a station never matches a row, including rows whose station is NULL
 * (outlet-level rows stay outside a station-only reach). Combine it with the
 * tenant and outlet conditions; it narrows, it never widens.
 */
export function stationScopeCondition(
  column: AnyPgColumn,
  stationIds: readonly string[],
): SQL {
  return stationIds.length === 0
    ? sql`false`
    : inArray(column, [...stationIds]);
}

/**
 * `stationScopeCondition` for the caller's own reach on `permission`, read
 * from the same snapshot as `permittedStationIds`. Use it in every list or
 * bulk read of a station-bound table that a station-scoped grant can reach.
 */
export async function stationScopeFilter(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  column: AnyPgColumn,
  now: Date,
): Promise<SQL> {
  return stationScopeCondition(
    column,
    await permittedStationIds(tx, context, actorUserId, permission, now),
  );
}

/**
 * Stations a list or board selector may show for `permission`. Empty denies.
 */
export async function permittedStationIds(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  now: Date,
): Promise<string[]> {
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    actorUserId,
    now,
  );
  return snapshot.stationsFor(permission);
}
