// Facility incident log (PRD v1.7 §3 F22/F25 "Keselamatan", FAC-08; bead
// legend-8dpm). Route: GET /api/facility/incidents in routes/facility.routes.ts.
//
// Raising and answering an incident (bead legend-1cj0) sit next to the log
// read: this module reads the log the staff emergency screen needs, newest
// first, cursor paginated on (triggered_at, id) — the same tuple as
// `facility_incidents_log_idx`. Everything runs inside `withTenant` (RLS scopes
// rows to the tenant and the caller's outlets) and re-checks
// `facility.booth.operate` on the incident's outlet (TEN-03).
import { and, desc, eq, lt, or } from "drizzle-orm";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  userIdSchema,
  uuidSchema,
  type CursorPage,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  facilityIncidentRaisedEvent,
  facilityIncidentSchema,
  type FacilityIncident,
  type RaiseFacilityIncidentInput,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import {
  accessTickets,
  facilityIncidents,
  facilityUnits,
} from "../db/schema/facility.ts";
import { withTenant } from "../db/tenant.ts";
import { appendOutbox } from "./core-outbox.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertFacilityPermission,
  auditFacility,
  loadFacility,
  notFound,
  OPERATE_PERMISSION,
} from "./facility-shared.ts";
import { storeFacilityIdempotentResult } from "./facility-config-guard.ts";
import {
  operationsFingerprint,
  readIdempotentResult,
} from "./operations-idempotency.ts";

/** Outbox destination of facility events (same as the WS-06 inventory writers). */
const FACILITY_EVENT_DESTINATION = "cloud-sync";

/** Outbox destination the notification worker reads (same as approvals). */
const FACILITY_NOTIFICATION_DESTINATION = "notification";

/** `operations_idempotency.result_table` value of a raised incident. */
export const FACILITY_INCIDENT_RESULT_TABLE = "facility_incidents";

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

/**
 * FAC-08: staff raise an incident (panic / assist / damage) for a unit or an
 * access ticket. The contract body names no facility, so it is resolved from
 * the unit (or the ticket's facility); a body naming neither is a 422. RLS
 * hides records of other outlets (404) and the permission is re-checked on
 * the record's own outlet (403). An optional `Idempotency-Key` makes a retry
 * return the first incident (`replayed: true`); the same key with another
 * payload is IDEMPOTENCY_KEY_REUSED. The contract `note` has no column and
 * is not stored. A first raise also appends `facility_incident.raised`
 * (bead legend-5rgl) to the outbox in the same transaction; a replay appends
 * nothing.
 */
export async function raiseFacilityIncident(
  context: ScopedTenantContext,
  actorUserId: string,
  input: RaiseFacilityIncidentInput,
  idempotencyKey: string | null = null,
  now = new Date(),
): Promise<{ incident: FacilityIncident; replayed: boolean }> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    if (!input.unitId && !input.accessTicketId)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Sebutkan bilik atau tiket untuk insiden ini.",
      );
    const [unit] = input.unitId
      ? await tx
          .select()
          .from(facilityUnits)
          .where(
            and(
              eq(facilityUnits.tenantId, tenantId),
              eq(facilityUnits.id, input.unitId),
            ),
          )
          .limit(1)
      : [];
    if (input.unitId && !unit) throw notFound("Bilik");
    const [ticket] = input.accessTicketId
      ? await tx
          .select()
          .from(accessTickets)
          .where(
            and(
              eq(accessTickets.tenantId, tenantId),
              eq(accessTickets.id, input.accessTicketId),
            ),
          )
          .limit(1)
      : [];
    if (input.accessTicketId && !ticket) throw notFound("Tiket");
    const record = unit ?? ticket;
    if (
      unit &&
      ticket &&
      (ticket.unitId !== unit.id || ticket.facilityId !== unit.facilityId)
    )
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Tiket tidak cocok dengan bilik.",
      );
    const facility = await loadFacility(tx, context, record.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      facility.outletId,
    );
    const fingerprint = operationsFingerprint({
      unitId: input.unitId ?? null,
      accessTicketId: input.accessTicketId ?? null,
      type: input.type,
      note: input.note ?? null,
    });
    if (idempotencyKey) {
      const replayed = await readIdempotentResult(
        tx,
        context,
        idempotencyKey,
        fingerprint,
        FACILITY_INCIDENT_RESULT_TABLE,
      );
      if (replayed) {
        const [first] = await tx
          .select()
          .from(facilityIncidents)
          .where(
            and(
              eq(facilityIncidents.tenantId, tenantId),
              eq(facilityIncidents.id, replayed),
            ),
          )
          .limit(1);
        if (!first) throw notFound("Insiden");
        return { incident: toFacilityIncident(first), replayed: true };
      }
    }
    const [row] = await tx
      .insert(facilityIncidents)
      .values({
        tenantId,
        outletId: facility.outletId,
        facilityId: facility.id,
        unitId: unit?.id ?? ticket?.unitId ?? null,
        accessTicketId: ticket?.id ?? null,
        type: input.type,
        triggeredAt: now,
        offline: false,
      })
      .returning();
    if (idempotencyKey)
      await storeFacilityIdempotentResult(tx, context, {
        key: idempotencyKey,
        fingerprint,
        outletId: facility.outletId,
        resultTable: FACILITY_INCIDENT_RESULT_TABLE,
        resultId: row.id,
      });
    await auditFacility(tx, context, actor, now, {
      action: "facility_incident.raise",
      objectType: "facility_incident",
      objectId: row.id,
      outletId: row.outletId,
      before: null,
      after: {
        id: row.id,
        facilityId: row.facilityId,
        unitId: row.unitId,
        type: row.type,
      },
    });
    // One aggregate per incident: sequence 1, no ordering race. The idempotency
    // key is per incident id, so a retried transaction never doubles the event.
    const event = facilityIncidentRaisedEvent.envelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId,
      outletId: row.outletId,
      name: "facility_incident.raised",
      version: 1,
      aggregateType: "facility_incident",
      aggregateId: row.id,
      sequence: 1,
      occurredAt: row.triggeredAt.toISOString(),
      actor: { type: "user", id: actor },
      deviceId: null,
      idempotencyKey: `facility_incident.raised:${row.id}`,
      payloadSchemaRef: "facility_incident.raised.v1",
      payload: {
        incidentId: row.id,
        facilityId: row.facilityId,
        unitId: row.unitId,
        type: row.type,
        triggeredAt: row.triggeredAt.toISOString(),
        offline: row.offline,
      },
    });
    // One row per destination: cloud-sync, and notification so the worker
    // runs facilityIncidentRaisedRule. Sequence 1 is unique per destination.
    for (const destination of [
      FACILITY_EVENT_DESTINATION,
      FACILITY_NOTIFICATION_DESTINATION,
    ]) {
      await appendOutbox(tx, context, {
        id: createUlid(now.getTime()),
        event,
        destination,
        direction: null,
        peerId: null,
      });
    }
    return { incident: toFacilityIncident(row), replayed: false };
  });
}

/**
 * FAC-08: staff answer an incident with a resolution. The row is locked, so
 * two responders cannot both win: the second gets 409. Repeating the same
 * answer by the same staff member returns the recorded incident unchanged.
 */
export async function respondFacilityIncident(
  context: ScopedTenantContext,
  actorUserId: string,
  incidentId: string,
  input: { resolution: string },
  now = new Date(),
): Promise<FacilityIncident> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const [locked] = await tx
      .select()
      .from(facilityIncidents)
      .where(
        and(
          eq(facilityIncidents.tenantId, tenantId),
          eq(facilityIncidents.id, incidentId),
        ),
      )
      .limit(1)
      .for("update");
    if (!locked) throw notFound("Insiden");
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      locked.outletId,
    );
    if (locked.respondedAt) {
      if (
        locked.respondedBy === actor &&
        locked.resolution === input.resolution
      )
        return toFacilityIncident(locked);
      throw new HttpError(
        409,
        "INCIDENT_ALREADY_RESPONDED",
        "Insiden ini sudah ditangani.",
      );
    }
    const [row] = await tx
      .update(facilityIncidents)
      .set({
        respondedBy: actor,
        respondedAt: now,
        resolution: input.resolution,
      })
      .where(
        and(
          eq(facilityIncidents.tenantId, tenantId),
          eq(facilityIncidents.id, incidentId),
        ),
      )
      .returning();
    await auditFacility(tx, context, actor, now, {
      action: "facility_incident.respond",
      objectType: "facility_incident",
      objectId: row.id,
      outletId: row.outletId,
      before: { id: locked.id, status: "open" },
      after: { id: row.id, status: "responded" },
    });
    return toFacilityIncident(row);
  });
}
