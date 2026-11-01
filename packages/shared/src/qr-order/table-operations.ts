// Staff table operations and the live status board (PRD v1.7 §3 "9. Denah &
// Meja": Operasi Meja, Papan Status; "10. QR Order Pelanggan": Kontrol Open
// Bill; ORD-10).
//
// This module extends the QR order contract (schemas.ts, endpoints.ts) with the
// staff actions the floor board needs but the guest journey does not:
//   - table status transitions (kosong, perlu dibersihkan, direservasi,
//     nonaktif) with the ORD-10 guard,
//   - pindah meja / pemindahan sesi (move an active session to another table),
//   - gabung meja (merge two sessions into one bill),
//   - pindah item (move order items between active sessions).
// Pisah tagihan stays on the existing split-bill contract (createSplitsInput,
// ORD-06): a second split shape would fork the money rules.
//
// Decisions where the PRD is silent (reported by the bead):
// - A session snapshots its zone's payment mode at open (schemas.ts), so a
//   session may only move to a table whose zone uses the same mode; changing
//   the mode mid-session would rewrite how the bill is settled.
// - Merging is refused for a session that is still `pending_confirmation`
//   (Kontrol Open Bill: a waiter confirms before the first order fires), and
//   the source session closes as `voided` — the merge moves its orders, so it
//   ends with no bill of its own.
// - "Gabung meja (merge/link)" is modelled as one merge to a shared bill. A
//   service-only "link" that keeps two separate bills has no stored meaning
//   yet; it is a follow-up rather than a mode the API cannot honour.

import {
  z,
  clientInputSchema,
  dataResponseSchema,
  CoreError,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  orderItemIdSchema,
  tableIdSchema,
  tableLiveStatusSchema,
  tableSchema,
  tableSessionIdSchema,
  tableSessionSchema,
} from "./schemas.ts";
import type { TableLiveStatus, TableSession, TableStatus } from "./schemas.ts";

const note = z.string().max(200);

/** PRD "Papan Status": the six floor states plus the two contract states. */
export const TABLE_BOARD_STATUSES = [
  "available",
  "seated",
  "awaiting_order",
  "awaiting_bill",
  "needs_cleaning",
  "reserved",
  "awaiting_confirmation",
  "inactive",
] as const;
export const tableBoardStatusSchema = z.enum(TABLE_BOARD_STATUSES);
export type TableBoardStatus = z.infer<typeof tableBoardStatusSchema>;

/**
 * Derives the board status from one floor-board row. PRD "Papan Status" lists
 * kosong, terisi, menunggu pesanan, menunggu tagihan, perlu dibersihkan dan
 * direservasi; `awaiting_confirmation` (open-bill session not yet confirmed,
 * "Kontrol Open Bill") and `inactive` (a table switched off in the floor plan)
 * are real operational states the board must show too.
 */
export function tableBoardStatus(row: TableLiveStatus): TableBoardStatus {
  const { session, table } = row;
  if (table.status === "inactive") return "inactive";
  if (session) {
    if (session.status === "pending_confirmation")
      return "awaiting_confirmation";
    if (session.status === "bill_requested") return "awaiting_bill";
    if (session.status === "open")
      // Nothing ordered yet is "menunggu pesanan"; a bill means guests seated.
      return session.billTotalIdr > 0 ? "seated" : "awaiting_order";
  }
  if (table.status === "reserved") return "reserved";
  if (table.status === "dirty") return "needs_cleaning";
  if (table.status === "occupied") return "seated";
  return "available";
}

/** Whole minutes since the session opened, or null when the table is empty. */
export function tableSeatMinutes(
  row: Pick<TableLiveStatus, "session">,
  now: Date | string,
): number | null {
  if (!row.session) return null;
  const opened = new Date(row.session.openedAt).getTime();
  const at = typeof now === "string" ? new Date(now).getTime() : now.getTime();
  if (Number.isNaN(opened) || Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((at - opened) / 60_000));
}

// ---- Table status transitions --------------------------------------------

/**
 * PRD "Operasi Meja" + "Papan Status". Staff set these from the board; the
 * session lifecycle itself stays on closeTableSession (ORD-10).
 */
export const TABLE_STATUS_ACTIONS = [
  "mark_available",
  "mark_dirty",
  "reserve",
  "release_reservation",
  "deactivate",
  "activate",
] as const;
export const tableStatusActionSchema = z.enum(TABLE_STATUS_ACTIONS);
export type TableStatusAction = z.infer<typeof tableStatusActionSchema>;

export function tableStatusActionTarget(
  action: TableStatusAction,
): TableStatus {
  switch (action) {
    case "mark_available":
    case "release_reservation":
    case "activate":
      return "available";
    case "mark_dirty":
      return "dirty";
    case "reserve":
      return "reserved";
    case "deactivate":
      return "inactive";
  }
}

/**
 * ORD-10: an open-bill table cannot be marked empty before the bill is settled
 * or a waiter confirms. Emptying (available, dirty, deactivate) while a
 * session is active is therefore refused; `hasActiveSession` is derived on the
 * server from the session bound to the table, never from the client.
 */
export function canApplyTableStatusAction(input: {
  action: TableStatusAction;
  tableStatus: TableStatus;
  hasActiveSession: boolean;
}): boolean {
  const { action, tableStatus, hasActiveSession } = input;
  if (
    hasActiveSession &&
    (action === "mark_available" ||
      action === "mark_dirty" ||
      action === "deactivate")
  )
    return false;
  switch (action) {
    case "mark_available":
      return tableStatus === "dirty" || tableStatus === "occupied";
    case "mark_dirty":
      return tableStatus === "available" || tableStatus === "occupied";
    case "reserve":
      return tableStatus === "available" && !hasActiveSession;
    case "release_reservation":
      return tableStatus === "reserved";
    case "deactivate":
      return tableStatus === "available" && !hasActiveSession;
    case "activate":
      return tableStatus === "inactive";
  }
}

export function assertCanApplyTableStatusAction(input: {
  action: TableStatusAction;
  tableStatus: TableStatus;
  hasActiveSession: boolean;
}): void {
  if (canApplyTableStatusAction(input)) return;
  const code =
    input.hasActiveSession &&
    (input.action === "mark_available" ||
      input.action === "mark_dirty" ||
      input.action === "deactivate")
      ? "TABLE_SESSION_ACTIVE"
      : "TABLE_STATUS_CONFLICT";
  throw new CoreError(
    "CONFLICT",
    code === "TABLE_SESSION_ACTIVE"
      ? "ORD-10: meja belum bisa dikosongkan sebelum tagihan lunas atau dikonfirmasi waiter."
      : `Aksi ${input.action} tidak berlaku untuk meja berstatus ${input.tableStatus}.`,
  );
}

/** Sessions that may take part in a merge or receive moved items. */
export function isOperableSession(session: Pick<TableSession, "status">) {
  return session.status === "open" || session.status === "bill_requested";
}

export function assertSessionsCanMerge(input: {
  target: Pick<TableSession, "id" | "outletId" | "status" | "paymentMode">;
  source: Pick<TableSession, "id" | "outletId" | "status" | "paymentMode">;
}): void {
  const { target, source } = input;
  if (target.id === source.id)
    throw new CoreError("CONFLICT", "Sesi sumber dan tujuan tidak boleh sama.");
  if (target.outletId !== source.outletId)
    throw new CoreError(
      "CONFLICT",
      "Sesi dari outlet berbeda tidak dapat digabung.",
    );
  if (target.paymentMode !== source.paymentMode)
    throw new CoreError(
      "CONFLICT",
      "Sesi dengan mode bayar berbeda tidak dapat digabung ke satu tagihan.",
    );
  for (const session of [target, source])
    if (!isOperableSession(session))
      throw new CoreError(
        "CONFLICT",
        "Hanya sesi yang sudah berjalan (open atau menunggu tagihan) yang dapat digabung; konfirmasi sesi open bill terlebih dahulu.",
      );
}

export function assertItemsCanMove(input: {
  from: Pick<TableSession, "id" | "outletId" | "status">;
  to: Pick<TableSession, "id" | "outletId" | "status">;
}): void {
  const { from, to } = input;
  if (from.id === to.id)
    throw new CoreError("CONFLICT", "Pilih sesi tujuan yang berbeda.");
  if (from.outletId !== to.outletId)
    throw new CoreError("CONFLICT", "Item tidak dapat dipindah antar-outlet.");
  for (const session of [from, to])
    if (!isOperableSession(session))
      throw new CoreError(
        "CONFLICT",
        "Pindah item hanya berlaku untuk sesi yang sedang berjalan.",
      );
}

/** PRD "Mode Bayar": the session keeps the zone's mode it opened with. */
export function assertSessionPaymentModeMatches(input: {
  sessionPaymentMode: TableSession["paymentMode"];
  targetPaymentMode: TableSession["paymentMode"];
}): void {
  if (input.sessionPaymentMode !== input.targetPaymentMode)
    throw new CoreError(
      "CONFLICT",
      "Mode bayar sesi berbeda dengan zona meja tujuan; pilih meja di zona dengan mode bayar yang sama.",
    );
}

// ---- Contracts -----------------------------------------------------------

export const updateTableStatusInputSchema = clientInputSchema({
  action: tableStatusActionSchema,
  note: note.optional(),
});

export const updateTableStatusResultSchema = z.strictObject({
  table: tableLiveStatusSchema,
});

export const moveTableSessionInputSchema = clientInputSchema({
  toTableId: tableIdSchema,
  note: note.optional(),
});

export const moveTableSessionResultSchema = z.strictObject({
  session: tableSessionSchema,
  fromTable: tableSchema,
  toTable: tableSchema,
});

export const mergeTableSessionsInputSchema = clientInputSchema({
  sourceSessionId: tableSessionIdSchema,
  note: note.optional(),
});

export const mergeTableSessionsResultSchema = z.strictObject({
  target: tableSessionSchema,
  source: tableSessionSchema,
  movedItemCount: z.number().int().nonnegative(),
  movedTotalIdr: z.number().int().nonnegative(),
});

export const moveSessionItemsInputSchema = clientInputSchema({
  toSessionId: tableSessionIdSchema,
  orderItemIds: z.array(orderItemIdSchema).min(1).max(50),
});

export const moveSessionItemsResultSchema = z.strictObject({
  fromSessionId: tableSessionIdSchema,
  toSessionId: tableSessionIdSchema,
  movedItemCount: z.number().int().positive(),
  movedTotalIdr: z.number().int().nonnegative(),
});

const tableParams = z.strictObject({ tableId: tableIdSchema });
const sessionParams = z.strictObject({ sessionId: tableSessionIdSchema });

/** Staff move a table between floor states; ORD-10 refuses emptying in use. */
export const updateTableStatus = defineEndpoint({
  method: "POST",
  path: "/api/tables/:tableId/status",
  params: tableParams,
  body: updateTableStatusInputSchema,
  response: dataResponseSchema(updateTableStatusResultSchema),
});

/** PRD "pindah meja"/"pemindahan sesi": move the session and its bill. */
export const moveTableSession = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/move",
  params: sessionParams,
  body: moveTableSessionInputSchema,
  response: dataResponseSchema(moveTableSessionResultSchema),
});

/** PRD "gabung meja": merge the source session into the target's bill. */
export const mergeTableSessions = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/merge",
  params: sessionParams,
  body: mergeTableSessionsInputSchema,
  response: dataResponseSchema(mergeTableSessionsResultSchema),
});

/** PRD "pindah item": move order items to another table's session. */
export const moveSessionItems = defineEndpoint({
  method: "POST",
  path: "/api/table-sessions/:sessionId/move-items",
  params: sessionParams,
  body: moveSessionItemsInputSchema,
  response: dataResponseSchema(moveSessionItemsResultSchema),
});
