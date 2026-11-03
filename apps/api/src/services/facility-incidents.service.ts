// Facility incident log (PRD v1.7 §3 F22/F25 "Keselamatan", FAC-08; bead
// legend-8dpm). Route: GET /api/facility/incidents in routes/facility.routes.ts.
//
// Raising and answering an incident belong to another bead; this module reads
// the log the staff emergency screen needs, newest first, cursor paginated on
// (triggered_at, id) — the same tuple as `facility_incidents_log_idx`. Reads
// run inside `withTenant` (RLS scopes rows to the tenant and the caller's
// outlets) and re-check `facility.booth.operate` on the facility's outlet
// (TEN-03).
import { and, desc, eq, lt, or } from "drizzle-orm";
import {
  decodeCursor,
  encodeCursor,
  userIdSchema,
  uuidSchema,
  type CursorPage,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  facilityIncidentSchema,
  type FacilityIncident,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { facilityIncidents } from "../db/schema/facility.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertFacilityPermission,
  loadFacility,
  OPERATE_PERMISSION,
} from "./facility-shared.ts";

type IncidentRow = typeof facilityIncidents.$inferSelect;

export function toFacilityIncident(row: IncidentRow): FacilityIncident {
  return facilityIncidentSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    facilityId: row.facilityId,
    unitId: row.unitId,
    accessTicketId: row.accessTicketId,
    type: row.type,
    triggeredAt: row.triggeredAt.toISOString(),
    offline: row.offline,
    respondedBy: row.respondedBy,
    respondedAt: row.respondedAt?.toISOString() ?? null,
    resolution: row.resolution,
  });
}

/** Strict keyset decode; a tampered cursor is a 422, never a 500. */
function decodeIncidentCursor(cursor: string): { at: Date; id: string } {
  let keys: ReturnType<typeof decodeCursor>;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Periksa cursor.");
  }
  const [at, id] = keys;
  const parsedId = typeof id === "string" ? uuidSchema.safeParse(id) : null;
  if (
    typeof at !== "string" ||
    Number.isNaN(Date.parse(at)) ||
    parsedId === null ||
    !parsedId.success
  )
    throw new HttpError(422, "VALIDATION_ERROR", "Periksa cursor.");
  return { at: new Date(at), id: parsedId.data };
}

export async function listFacilityIncidents(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { facilityId: string; cursor?: string; limit: number },
): Promise<CursorPage<FacilityIncident>> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, query.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      facility.outletId,
    );
    const filters = [
      eq(facilityIncidents.tenantId, context.tenant.tenantId),
      eq(facilityIncidents.facilityId, facility.id),
    ];
    if (query.cursor) {
      const cursor = decodeIncidentCursor(query.cursor);
      const cursorFilter = or(
        lt(facilityIncidents.triggeredAt, cursor.at),
        and(
          eq(facilityIncidents.triggeredAt, cursor.at),
          lt(facilityIncidents.id, cursor.id),
        ),
      );
      if (cursorFilter) filters.push(cursorFilter);
    }
    const rows = await tx
      .select()
      .from(facilityIncidents)
      .where(and(...filters))
      .orderBy(desc(facilityIncidents.triggeredAt), desc(facilityIncidents.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toFacilityIncident),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.triggeredAt.toISOString(), last.id])
            : null,
      },
    };
  });
}
