// Walk-in seating by staff (POS B1, brief 1268). The cashier opens a session
// on an empty table; reservations already do the same through
// `openStaffSeatedSession`, so this is the same session, credential, seal and
// `table_session.opened` event, and a later guest scan joins it.
//
// Money and isolation rules (architect review docs/qa/1268-b1-review.md):
// - Only an `available` table is seated. `reserved` (held for a party) and
//   `occupied` without a session of its own (the second table of a reservation
//   party) are refused, so a walk-in bill never shares a table with a
//   reservation's guests and closing the reservation cannot free this table.
//   The one exception is a table whose own session is past its 12-hour window:
//   it is expired first, after its charge payment links were confirmed unpaid
//   at the provider (network I/O outside any transaction), like scan, close and
//   reservation seating. A link already paid at the provider keeps the session.
// - Replay: the idempotency key is claimed in `reservation_idempotency`
//   (`claimIdempotencyKey`, unique per tenant) with a fingerprint of outlet,
//   table and pax. The same request answers the stored session and writes
//   nothing; the same key with another table or pax is IDEMPOTENCY_KEY_REUSED.
//   Two keys racing for one table serialize on the table's live-state lock: one
//   wins, the other gets 409 "Meja masih dipakai tamu lain." (never a second
//   session).

import { and, eq } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { TableSession } from "@starter/shared/qr-order";
import { db } from "../db";
import { tables } from "../db/schema";
import { withTenant } from "../db/tenant";
import { confirmChargeLinksUnpaid } from "./order-recovery-charge.ts";
import {
  claimIdempotencyKey,
  storeIdempotencyResult,
} from "./reservation-core.ts";
import { requestFingerprint } from "./reservation-plan.ts";
import {
  activeSessionForTable,
  audit,
  loadSession,
  lockTableLiveState,
  openStaffSeatedSession,
  sessionDto,
  tokenExpired,
} from "./table-session.service";

export type OpenWalkInSessionInput = {
  pax: number;
  idempotencyKey: string;
};

const OPERATION = "table_session.staff_open";

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

  // An expired session on this table is expired inside the transaction below.
  // Its charge payment links are confirmed unpaid at the provider first; an
  // unconfirmed answer (409 PAYMENT_PROVIDER_UNCONFIRMED) propagates and
  // nothing is seated.
  const expiring = await withTenant(db, context, async (tx) => {
    const active = await activeSessionForTable(tx, tenantId, tableId);
    return active && tokenExpired(active, now) ? active.id : null;
  });
  if (expiring)
    await confirmChargeLinksUnpaid(context, { sessionId: expiring }, now);

  return withTenant(db, context, async (tx) => {
    const claim = await claimIdempotencyKey(tx, context, {
      outletId: outlet,
      key: input.idempotencyKey,
      operation: OPERATION,
      fingerprint: requestFingerprint(OPERATION, {
        outletId: outlet,
        tableId,
        pax: input.pax,
      }),
    });
    if (claim.kind === "replay") {
      const stored = claim.response.sessionId;
      if (typeof stored !== "string")
        throw new CoreError("CONFLICT", "Coba kirim permintaan sekali lagi.");
      return sessionDto(tx, await loadSession(tx, tenantId, stored));
    }
    if (claim.kind === "resume")
      throw new CoreError("CONFLICT", "Coba kirim permintaan sekali lagi.");

    await lockTableLiveState(tx, tenantId, tableId);
    const [table] = await tx
      .select()
      .from(tables)
      .where(and(eq(tables.tenantId, tenantId), eq(tables.id, tableId)));
    if (!table || table.outletId !== outlet)
      throw new CoreError("NOT_FOUND", "Meja tidak ditemukan.");
    // Re-read under the lock: the session may have closed or a guest scanned.
    const active = await activeSessionForTable(tx, tenantId, tableId);
    const staleOwnSession = active !== undefined && tokenExpired(active, now);
    if (table.status !== "available" && !staleOwnSession) {
      if (active)
        throw new CoreError("CONFLICT", "Meja masih dipakai tamu lain.");
      if (table.status === "reserved")
        throw new CoreError("CONFLICT", "Meja sedang dipesan.");
      throw new CoreError("CONFLICT", "Meja belum siap dipakai.");
    }

    const opened = await openStaffSeatedSession(tx, context, {
      outletId: outlet,
      tableIds: [tableId],
      pax: input.pax,
      confirmedBy: actorUserId,
      reservationId: null,
      now,
    });
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "table_session.staff_opened",
        outletId: outlet,
        objectId: opened.sessionId,
        after: {
          id: opened.sessionId,
          tableId,
          pax: input.pax,
          paymentMode: opened.paymentMode,
          // An open-bill zone opens at once: the host who seats is the confirmer.
          confirmedBy: opened.paymentMode === "open_bill" ? actorUserId : null,
        },
      },
      now,
    );
    await storeIdempotencyResult(tx, context, input.idempotencyKey, null, {
      sessionId: opened.sessionId,
    });
    return sessionDto(tx, await loadSession(tx, tenantId, opened.sessionId));
  });
}
