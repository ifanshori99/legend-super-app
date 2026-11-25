// Walk-in seating by staff (POS B1, brief 1268). The cashier opens a session
// on an empty table; reservations already do the same through
// `openStaffSeatedSession`, so this is the same session, credential, seal and
// `table_session.opened` event, and a later guest scan joins it.
//
// Replay: the idempotency key is stored as the opening participant's device
// hash (`staff-open:<key>`), so no schema change is needed. The same key with
// the same table and pax answers the stored session and writes nothing; the
// same key with another table or pax is IDEMPOTENCY_KEY_REUSED. Two keys racing
// for one table serialize on the table's live-state lock: one wins, the other
// gets 409 "Meja masih dipakai tamu lain." (never a second session).

import { and, eq, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { TableSession } from "@starter/shared/qr-order";
import { db } from "../db";
import { sessionParticipants } from "../db/schema";
import { withTenant } from "../db/tenant";
import {
  lockTableLiveState,
  loadSession,
  openStaffSeatedSession,
  sessionDto,
} from "./table-session.service";

export type OpenWalkInSessionInput = {
  pax: number;
  idempotencyKey: string;
};

export const staffOpenDeviceHash = (idempotencyKey: string): string =>
  `staff-open:${idempotencyKey}`;

export async function openWalkInSession(
  context: ScopedTenantContext,
  outletId: string,
  tableId: string,
  input: OpenWalkInSessionInput,
  actorUserId: string,
  now = new Date(),
): Promise<TableSession> {
  const outlet = outletIdSchema.parse(outletId);
  assertOutletInScope(context.outletScope, outlet);
  const tenantId = context.tenant.tenantId;
  const deviceHash = staffOpenDeviceHash(input.idempotencyKey);
  return withTenant(db, context, async (tx) => {
    // Key lock first, then the table lock inside `openStaffSeatedSession`: the
    // same key sent for two tables cannot open two sessions.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-open:${tenantId}:${input.idempotencyKey}`}, 0))`,
    );
    const [stored] = await tx
      .select({ sessionId: sessionParticipants.tableSessionId })
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.tenantId, tenantId),
          eq(sessionParticipants.outletId, outlet),
          eq(sessionParticipants.deviceHash, deviceHash),
        ),
      );
    if (stored) {
      const row = await loadSession(tx, tenantId, stored.sessionId);
      if (row.tableId !== tableId || row.pax !== input.pax)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci permintaan ini sudah dipakai untuk meja atau jumlah tamu lain.",
        );
      return sessionDto(tx, row);
    }
    await lockTableLiveState(tx, tenantId, tableId);
    const opened = await openStaffSeatedSession(tx, context, {
      outletId: outlet,
      tableIds: [tableId],
      pax: input.pax,
      confirmedBy: actorUserId,
      reservationId: null,
      deviceHash,
      now,
    });
    const row = await loadSession(tx, tenantId, opened.sessionId);
    return sessionDto(tx, row);
  });
}
