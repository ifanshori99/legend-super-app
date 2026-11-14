// Table session lifecycle (PRD v1.7 §3 F10 "Scan & Sesi Meja", "Keamanan
// Sesi", "Kontrol Open Bill"; §6 C table_sessions/session_participants; ORD-04,
// ORD-10).
//
// The first scan of a table QR opens the session; later scans join it while it
// is active. A pay-first zone opens immediately; an open-bill zone waits for a
// waiter or cashier to confirm before the first order fires. The guest
// credential is opaque, stored only as a hash plus an AES-GCM seal (so a
// joined guest gets the same token again), lives at most 12 hours from the
// session open and is rotated when the session closes (contract
// TABLE_SESSION_TOKEN_MAX_HOURS, tableSessionTokenExpiresAt).
//
// ORD-04: a closed or voided session's credential can never be used again;
// the permanent table QR does stay valid and the next scan opens a new
// session. ORD-10: a table is emptied only when its bill is settled and the
// table is cleaned, or when a waiter explicitly confirms it.
//
// Domain decisions reuse the shared contract helpers (transitionTableSession,
// canApplyTableStatusAction, canCloseTableSession, assertQrTokenMatchesTable);
// this service only loads rows, computes server-side facts and writes.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  idr,
  toIsoDateTime,
  z,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  assertCanApplyTableStatusAction,
  assertQrTokenMatchesTable,
  closeTableSessionInputSchema,
  floorZoneSchema,
  qrScanInputSchema,
  qrScanResultSchema,
  tableLiveStatusSchema,
  tableSchema,
  tableSessionSchema,
  tableSessionSummarySchema,
  tableSessionTokenExpiresAt,
  tableStatusActionTarget,
  transitionTableSession,
  updateTableStatusInputSchema,
  type FloorZone,
  type QrScanResult,
  type Table,
  type TableLiveStatus,
  type TableSession,
  type TableSessionAction,
  type TableSessionStatus,
  type TableStatus,
} from "@starter/shared/qr-order";
import { qrOrderEvents, type QrOrderEventName } from "@starter/shared/qr-order";
import { db } from "../db";
import * as schema from "../db/schema";
import {
  brands,
  floorZones,
  tableSessions,
  tables,
  sessionParticipants,
  outlets,
  domainEventOutbox,
  serviceRequests,
} from "../db/schema";
import { reservationTables } from "../db/schema/reservation";
import { withTenant } from "../db/tenant";
import { openSecret, sealSecret } from "../lib/secrets";
import { recordAudit } from "./core-audit";
import {
  linkGroupsForTables,
  releaseLinksOfSession,
} from "./table-link.service";
import { appendOutbox } from "./core-outbox";
import {
  confirmChargeLinksUnpaid,
  expireOpenChargesOfSession,
} from "./order-recovery-charge";
import { verifyTableQrToken } from "./qr-token";
import { finalizeReservationDepositRemainders } from "./reservation-deposit-remainder.ts";

type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

type QrScanInput = z.infer<typeof qrScanInputSchema>;
type CloseTableSessionInput = z.infer<typeof closeTableSessionInputSchema>;
type UpdateTableStatusInput = z.infer<typeof updateTableStatusInputSchema>;

const ACTIVE_STATUSES: TableSessionStatus[] = [
  "pending_confirmation",
  "open",
  "bill_requested",
];
const EVENT_DESTINATION = "cloud-sync";
const AUDIT_SAFE_FIELDS = [
  "id",
  "status",
  "paymentMode",
  "pax",
  "tableId",
  "outletId",
  "closedReason",
  "tableCleaned",
  "waiterConfirmedEmpty",
  "action",
  "fromTableId",
  "toTableId",
  "sourceId",
  "toId",
  "billTotalIdr",
  "movedItemCount",
  "movedTotalIdr",
  "groupId",
  "tableIds",
  "reason",
] as const;

export type SessionRow = typeof tableSessions.$inferSelect;
type ParticipantRow = typeof sessionParticipants.$inferSelect;

function isActive(status: TableSessionStatus): boolean {
  return status !== "closed" && status !== "voided";
}

function credentialHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function sessionSealAad(tenantId: string, sessionId: string): string {
  return `table-session:${tenantId}:${sessionId}`;
}

export function newSessionCredential(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: credentialHash(token) };
}

/**
 * Settlement port. The orders/bill module (legend-e2x) owns the per-session
 * bill; it wires the lookup here. A null result means the bill cannot be
 * verified, and every close path then fails closed instead of assuming the
 * bill is paid (Codex pre-review HIGH: ORD-10 settlement must never be
 * guessed).
 */
export type TableSessionSettlement = {
  billTotalIdr: Idr;
  paidIdr: Idr;
};

export type TableSessionSettlementLookup = (input: {
  tx: Tx;
  tenantId: TenantId;
  sessionId: string;
}) => Promise<TableSessionSettlement | null>;

let settlementLookup: TableSessionSettlementLookup | null = null;

/**
 * Wiring point for the orders module (legend-e2x) and test double. Unset is
 * the production default until the orders table exists: unverifiable bill.
 */
export function setTableSessionSettlementLookup(
  lookup: TableSessionSettlementLookup | null,
): void {
  settlementLookup = lookup;
}

export async function loadSettlement(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
): Promise<TableSessionSettlement | null> {
  if (settlementLookup === null) return null;
  return settlementLookup({
    tx,
    tenantId: context.tenant.tenantId,
    sessionId,
  });
}

/** Outstanding rupiah, or null when settlement cannot be verified. */
function outstandingOf(settlement: TableSessionSettlement | null): Idr | null {
  if (settlement === null) return null;
  return idr(Math.max(0, settlement.billTotalIdr - settlement.paidIdr));
}

/** Contract transition; an invalid status/action pair is a 409, not a 500. */
function nextStatus(
  status: TableSessionStatus,
  action: TableSessionAction,
): TableSessionStatus {
  try {
    return transitionTableSession(status, action);
  } catch {
    throw new CoreError(
      "CONFLICT",
      `Aksi ${action} tidak berlaku untuk sesi berstatus ${status}.`,
    );
  }
}

function toSession(
  row: SessionRow,
  participants: readonly ParticipantRow[],
): TableSession {
  return tableSessionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    tableId: row.tableId,
    pax: row.pax,
    paymentMode: row.paymentMode,
    status: row.status,
    confirmedBy: row.confirmedBy,
    reservationId: row.reservationId,
    participants: participants.map((participant) => ({
      id: participant.id,
      tenantId: participant.tenantId,
      tableSessionId: participant.tableSessionId,
      deviceHash: participant.deviceHash,
      userId: participant.userId,
      joinedAt: participant.joinedAt.toISOString(),
      lastSeenAt: participant.lastSeenAt.toISOString(),
    })),
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    lastActivityAt: row.lastActivityAt.toISOString(),
    billRequestedAt: row.billRequestedAt?.toISOString() ?? null,
    closedReason: row.closedReason,
  });
}

export function toTable(row: typeof tables.$inferSelect): Table {
  return tableSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    zoneId: row.zoneId,
    code: row.code,
    capacity: row.capacity,
    type: row.type,
    layout: row.layout,
    status: row.status,
  });
}

export function toZone(row: typeof floorZones.$inferSelect): FloorZone {
  return floorZoneSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    name: row.name,
    paymentMode: row.paymentMode,
    serviceChargeBp: row.serviceChargeBp,
    minimumSpendIdr: row.minimumSpendIdr,
    hours: row.hours,
    status: row.status,
    sortOrder: row.sortOrder,
  });
}

async function participantsOf(
  tx: Tx,
  tenantId: TenantId,
  sessionId: string,
): Promise<ParticipantRow[]> {
  return tx
    .select()
    .from(sessionParticipants)
    .where(
      and(
        eq(sessionParticipants.tenantId, tenantId),
        eq(sessionParticipants.tableSessionId, sessionId),
      ),
    )
    .orderBy(asc(sessionParticipants.joinedAt), asc(sessionParticipants.id));
}

export async function sessionDto(
  tx: Tx,
  row: SessionRow,
): Promise<TableSession> {
  return toSession(row, await participantsOf(tx, row.tenantId, row.id));
}

/**
 * Loads one session inside the tenant transaction. Staff lifecycle writes pass
 * `forUpdate` so concurrent confirm/close requests serialize on the row and
 * the status edge is decided from the committed state (Codex pre-review HIGH).
 */
export async function loadSession(
  tx: Tx,
  tenantId: TenantId,
  sessionId: string,
  options: { forUpdate?: boolean } = {},
): Promise<SessionRow> {
  const query = tx
    .select()
    .from(tableSessions)
    .where(
      and(
        eq(tableSessions.tenantId, tenantId),
        eq(tableSessions.id, sessionId),
      ),
    );
  const [row] = options.forUpdate ? await query.for("update") : await query;
  if (!row) throw new CoreError("NOT_FOUND", "Sesi meja tidak ditemukan.");
  return row;
}

/**
 * Serializes every writer of one table's live state — the guest scan, the
 * staff status action, open-bill confirm and close — on a transaction-scoped
 * advisory lock taken before any row lock (Opus review). Without it a staff
 * "mark available" could read "no active session" while a concurrent first
 * scan opens one (ORD-10), and the next party would be seated into — and join
 * — the first party's session. One lock taken first in every path also keeps
 * the session/table row locks from forming a cycle.
 */
export async function lockTableLiveState(
  tx: Tx,
  tenantId: TenantId,
  tableId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`table-live:${tenantId}:${tableId}`}, 0))`,
  );
}

export async function activeSessionForTable(
  tx: Tx,
  tenantId: TenantId,
  tableId: string,
): Promise<SessionRow | undefined> {
  const [row] = await tx
    .select()
    .from(tableSessions)
    .where(
      and(
        eq(tableSessions.tenantId, tenantId),
        eq(tableSessions.tableId, tableId),
        inArray(tableSessions.status, ACTIVE_STATUSES),
      ),
    )
    .orderBy(desc(tableSessions.openedAt))
    .limit(1);
  return row;
}

/**
 * A guest scanning a SECONDARY table of a multi-table party: the session is
 * bound to the primary table only, so the scanned table has no session of its
 * own. The link is the party's live `reservation_tables` hold plus the
 * session's `reservation_id` (see `openStaffSeatedSession`).
 */
async function partySessionForSecondaryTable(
  tx: Tx,
  tenantId: TenantId,
  table: { id: string; outletId: OutletId; status: string },
): Promise<SessionRow | undefined> {
  // Seating marks every table of the party occupied and closing frees them, so
  // a table that is not occupied cannot be part of a live party: a stale hold
  // must never pull a later guest into (or block a status change on) it.
  if (table.status !== "occupied") return undefined;
  const [row] = await tx
    .select({ session: tableSessions })
    .from(reservationTables)
    .innerJoin(
      tableSessions,
      and(
        eq(tableSessions.tenantId, reservationTables.tenantId),
        eq(tableSessions.reservationId, reservationTables.reservationId),
        eq(tableSessions.outletId, table.outletId),
      ),
    )
    .where(
      and(
        eq(reservationTables.tenantId, tenantId),
        eq(reservationTables.tableId, table.id),
        isNull(reservationTables.releasedAt),
        inArray(tableSessions.status, ACTIVE_STATUSES),
      ),
    )
    .orderBy(desc(tableSessions.openedAt))
    .limit(1);
  return row?.session;
}

/**
 * The guest left: a request still open when its session closes (or is voided
 * or expires) must not absorb the next session's call at the same table (the
 * open-dedupe key is per table and type). Same transaction as the close.
 */
export async function cancelOpenServiceRequests(
  tx: Tx,
  tenantId: TenantId,
  sessionId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(serviceRequests)
    .set({ status: "cancelled", updatedAt: now })
    .where(
      and(
        eq(serviceRequests.tenantId, tenantId),
        eq(serviceRequests.tableSessionId, sessionId),
        inArray(serviceRequests.status, ["pending", "acknowledged"]),
      ),
    );
}

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** Append one catalogued QR-order event inside the caller's transaction. */
export async function appendSessionEvent(
  tx: Tx,
  context: ScopedTenantContext,
  name: QrOrderEventName,
  input: {
    sessionId: string;
    outletId: string;
    payload: Record<string, unknown>;
    actor: EventEnvelope["actor"];
    now: Date;
  },
): Promise<void> {
  const { sessionId, ...rest } = input;
  await appendAggregateEvent(tx, context, name, {
    ...rest,
    aggregateId: sessionId,
  });
}

/** Same as `appendSessionEvent` for an aggregate that is not a session (a table). */
export async function appendAggregateEvent(
  tx: Tx,
  context: ScopedTenantContext,
  name: QrOrderEventName,
  input: {
    aggregateId: string;
    outletId: string;
    payload: Record<string, unknown>;
    actor: EventEnvelope["actor"];
    now: Date;
  },
): Promise<void> {
  const definition = qrOrderEvents[name];
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    definition.entry.aggregateType,
    input.aggregateId,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: toIsoDateTime(input.now),
    actor: input.actor,
    deviceId: null,
    idempotencyKey: `${name}:${input.aggregateId}:${sequence}`.slice(0, 100),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

export type TableStatusCause =
  | "staff_action"
  | "session_closed"
  | "session_expired"
  | "session_moved"
  | "session_merged";

/** Status and zone of the given tables, read before a change to emit `from`. */
export async function readTableStates(
  tx: Tx,
  tenantId: TenantId,
  tableIds: readonly string[],
): Promise<Map<string, { status: TableStatus; zoneId: string }>> {
  if (tableIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: tables.id, status: tables.status, zoneId: tables.zoneId })
    .from(tables)
    .where(
      and(eq(tables.tenantId, tenantId), inArray(tables.id, [...tableIds])),
    );
  return new Map(
    rows.map((r) => [r.id, { status: r.status, zoneId: r.zoneId }]),
  );
}

/** `table.status_changed` (aggregate: the table). No event when nothing changed. */
export async function emitTableStatusChanged(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    tableId: string;
    outletId: string;
    zoneId: string;
    from: TableStatus;
    to: TableStatus;
    cause: TableStatusCause;
    actor: EventEnvelope["actor"];
    now: Date;
  },
): Promise<void> {
  if (input.from === input.to) return;
  await appendAggregateEvent(tx, context, "table.status_changed", {
    aggregateId: input.tableId,
    outletId: input.outletId,
    payload: {
      tableId: input.tableId,
      zoneId: input.zoneId,
      from: input.from,
      to: input.to,
      cause: input.cause,
    },
    actor: input.actor,
    now: input.now,
  });
}

export async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    actorUserId: string;
    action: string;
    outletId: string;
    objectId: string;
    objectType?: "table_session" | "table";
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
  now: Date,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      actorType: "user",
      actorId: input.actorUserId,
      deviceId: null,
      action: input.action,
      objectType: input.objectType ?? "table_session",
      objectId: input.objectId,
      reason: null,
      maskedChanges: {
        before: input.before ?? null,
        after: input.after ?? null,
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    AUDIT_SAFE_FIELDS,
  );
}

// ---- Read helpers shared with the scan ------------------------------------

async function outletRefs(
  tx: Tx,
  tenantId: string,
  outletId: string,
): Promise<Record<string, unknown>> {
  const [outlet] = await tx
    .select()
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
  const [brand] = await tx
    .select()
    .from(brands)
    .where(and(eq(brands.tenantId, tenantId), eq(brands.id, outlet.brandId)));
  if (!brand) throw new CoreError("NOT_FOUND", "Brand tidak ditemukan.");
  return {
    outlet: {
      id: outlet.id,
      tenantId: outlet.tenantId,
      brandId: outlet.brandId,
      code: outlet.code,
      name: outlet.name,
      timeZone: outlet.timezone,
      businessDayCutoff: outlet.businessDayCutoff,
      status: outlet.status,
    },
    brand: {
      id: brand.id,
      tenantId: brand.tenantId,
      slug: brand.slug,
      name: brand.name,
    },
  };
}

function scanResult(input: {
  outcome: "opened" | "joined";
  table: typeof tables.$inferSelect;
  zone: typeof floorZones.$inferSelect;
  session: TableSession;
  token: string;
  refs: Record<string, unknown>;
  now: Date;
}): QrScanResult {
  return qrScanResultSchema.parse({
    outcome: input.outcome,
    table: toTable(input.table),
    zone: toZone(input.zone),
    outlet: input.refs.outlet,
    brand: input.refs.brand,
    session: input.session,
    sessionToken: input.token,
    sessionTokenExpiresAt: tableSessionTokenExpiresAt(input.session),
    // Menu tables land with legend-lmk; until then the scan reports no
    // sold-out items and the menu payload is as fresh as this response.
    menuUpdatedAt: toIsoDateTime(input.now),
    soldOutItemIds: [],
    serverTime: toIsoDateTime(input.now),
  });
}

function tokenExpired(row: SessionRow, now: Date): boolean {
  const expiresAt = new Date(
    tableSessionTokenExpiresAt({
      openedAt: row.openedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
    }),
  ).getTime();
  return !Number.isNaN(expiresAt) && expiresAt <= now.getTime();
}

/** Sealed credential; a seal that cannot be opened means the row is unusable. */
function openSessionToken(row: SessionRow): string {
  try {
    return openSecret(
      row.sessionTokenSealed,
      sessionSealAad(row.tenantId, row.id),
    );
  } catch {
    throw new CoreError(
      "UNAUTHORIZED",
      "Sesi meja tidak dapat dipulihkan; pindai QR meja lagi.",
    );
  }
}

/**
 * Closes an active session whose 12-hour credential window ran out. The guest
 * must rescan, which opens a fresh session (contract decision, ORD-04).
 *
 * ORD-10 (Codex pre-review HIGH): expiry may only close a session whose bill
 * is verified settled. An unverifiable or outstanding bill fails closed, so
 * the table stays bound to its session until staff settle or explicitly close
 * it — an expiry must never erase an unsettled open bill.
 */
async function expireSession(
  tx: Tx,
  context: ScopedTenantContext,
  row: SessionRow,
  now: Date,
): Promise<void> {
  const settlement = await loadSettlement(tx, context, row.id);
  const outstandingIdr = outstandingOf(settlement);
  if (outstandingIdr !== 0)
    throw new CoreError(
      "CONFLICT",
      outstandingIdr === null
        ? "ORD-10: tagihan sesi meja sebelumnya belum dapat diverifikasi; minta staf menutup meja."
        : "ORD-10: sesi meja sebelumnya masih memiliki tagihan belum lunas; minta staf menutup meja.",
    );
  const credential = newSessionCredential();
  await tx
    .update(tableSessions)
    .set({
      status: "closed",
      closedAt: now,
      closedReason: "expired",
      lastActivityAt: now,
      sessionTokenHash: credential.hash,
      sessionTokenSealed: sealSecret(
        credential.token,
        sessionSealAad(row.tenantId, row.id),
      ),
    })
    .where(
      and(
        eq(tableSessions.tenantId, context.tenant.tenantId),
        eq(tableSessions.id, row.id),
      ),
    );
  await cancelOpenServiceRequests(tx, row.tenantId, row.id, now);
  // A settled bill can still carry an open charge (a deposit credit covers it):
  // expire it with the session.
  await expireOpenChargesOfSession(tx, context, row.id, now);
  await releaseLinksOfSession(
    tx,
    context,
    row.id,
    "session_closed",
    { type: "system" },
    now,
  );
  await appendSessionEvent(tx, context, "table_session.closed", {
    sessionId: row.id,
    outletId: row.outletId,
    payload: {
      sessionId: row.id,
      tableId: row.tableId,
      reason: "expired",
      billTotalIdr: settlement?.billTotalIdr ?? 0,
      paidIdr: settlement?.paidIdr ?? 0,
      orderCount: 0,
      closedBy: "system",
    },
    actor: { type: "system" },
    now,
  });
}

// ---- Guest scan -----------------------------------------------------------

/**
 * POST /api/qr/sessions. Verifies the signed token against the tenant resolved
 * from the request host, then joins the active session or opens a new one.
 */
export async function openOrJoinTableSession(
  context: ScopedTenantContext,
  input: QrScanInput,
  now = new Date(),
): Promise<QrScanResult> {
  const verified = verifyTableQrToken({
    token: input.qrToken,
    resolvedTenantId: context.tenant.tenantId,
  });
  // legend-ukbq3: a session past its window is expired inside the transaction
  // below. Its charge payment links are confirmed unpaid at the provider first,
  // outside any transaction or lock (network I/O); an unconfirmed answer
  // (409 PAYMENT_PROVIDER_UNCONFIRMED) propagates and nothing is closed. The
  // `settled` verdict is not read here: a payment it just applied reaches the
  // charge through the worker, and `expireOpenChargesOfSession` then throws 409
  // in the transaction for a charge still `open` whose link has a paid intent.
  const expiring = await withTenant(db, context, async (tx) => {
    const [scanned] = await tx
      .select({ id: tables.id })
      .from(tables)
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          eq(tables.qrTokenHash, verified.hash),
        ),
      );
    if (!scanned) return null;
    const current = await activeSessionForTable(
      tx,
      context.tenant.tenantId,
      scanned.id,
    );
    return current && tokenExpired(current, now) ? current.id : null;
  });
  if (expiring)
    await confirmChargeLinksUnpaid(context, { sessionId: expiring }, now);
  return withTenant(db, context, async (tx) => {
    const [found] = await tx
      .select()
      .from(tables)
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          eq(tables.qrTokenHash, verified.hash),
        ),
      );
    // Every failure is the same NOT_FOUND: no oracle for valid ids (ORD-04).
    if (!found) throw new CoreError("NOT_FOUND", "QR meja tidak dikenali");
    await lockTableLiveState(tx, context.tenant.tenantId, found.id);
    // Re-read under the lock: staff may have changed the status (or rotated
    // the QR) between the lookup and the lock.
    const [table] = await tx
      .select()
      .from(tables)
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          eq(tables.id, found.id),
          eq(tables.qrTokenHash, verified.hash),
        ),
      );
    if (!table) throw new CoreError("NOT_FOUND", "QR meja tidak dikenali");
    assertQrTokenMatchesTable(
      verified.payload,
      context.tenant.tenantId,
      toTable(table),
    );
    const [zone] = await tx
      .select()
      .from(floorZones)
      .where(
        and(
          eq(floorZones.tenantId, context.tenant.tenantId),
          eq(floorZones.id, table.zoneId),
        ),
      );
    if (!zone) throw new CoreError("NOT_FOUND", "QR meja tidak dikenali");
    if (zone.status === "inactive")
      throw new CoreError("CONFLICT", "Zona meja sedang tidak aktif.");
    if (table.status === "dirty")
      throw new CoreError("CONFLICT", "Meja sedang dibersihkan.");

    const refs = await outletRefs(tx, context.tenant.tenantId, table.outletId);
    // The scanned table may be a secondary table of a multi-table party; its
    // session sits on the primary table, so join that one (legend-rml8).
    let active = await activeSessionForTable(
      tx,
      context.tenant.tenantId,
      table.id,
    );
    if (!active) {
      const party = await partySessionForSecondaryTable(
        tx,
        context.tenant.tenantId,
        table,
      );
      if (party) {
        // Re-read under a row lock: the party may have closed since the lookup.
        const fresh = await loadSession(tx, context.tenant.tenantId, party.id, {
          forUpdate: true,
        });
        if (ACTIVE_STATUSES.includes(fresh.status)) {
          // A secondary scan never expires the party's session: the primary
          // table owns it, and expiry settles the whole party's bill.
          if (tokenExpired(fresh, now))
            throw new CoreError(
              "CONFLICT",
              "Sesi meja sudah berakhir; pindai QR meja utama atau minta bantuan staf.",
            );
          active = fresh;
        }
      }
    }
    if (active && !tokenExpired(active, now)) {
      // The session is bound to its own table, so the scan result reports
      // that table (the scan contract requires `session.tableId === table.id`).
      // For a secondary-table scan that is the party's primary table.
      let sessionTable = table;
      let sessionZone = zone;
      if (active.tableId !== table.id) {
        const [primary] = await tx
          .select()
          .from(tables)
          .where(
            and(
              eq(tables.tenantId, context.tenant.tenantId),
              eq(tables.id, active.tableId),
            ),
          );
        const [primaryZone] = primary
          ? await tx
              .select()
              .from(floorZones)
              .where(
                and(
                  eq(floorZones.tenantId, context.tenant.tenantId),
                  eq(floorZones.id, primary.zoneId),
                ),
              )
          : [];
        if (!primary || !primaryZone)
          throw new CoreError("NOT_FOUND", "QR meja tidak dikenali");
        sessionTable = primary;
        sessionZone = primaryZone;
      }
      const [participant] = await tx
        .insert(sessionParticipants)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: sessionTable.outletId,
          tableSessionId: active.id,
          deviceHash: input.deviceHash,
          joinedAt: now,
          lastSeenAt: now,
        })
        .onConflictDoNothing()
        .returning();
      await tx
        .update(tableSessions)
        .set({ lastActivityAt: now })
        .where(
          and(
            eq(tableSessions.tenantId, context.tenant.tenantId),
            eq(tableSessions.id, active.id),
          ),
        );
      if (participant) {
        await appendSessionEvent(tx, context, "table_session.joined", {
          sessionId: active.id,
          outletId: sessionTable.outletId,
          payload: {
            sessionId: active.id,
            tableId: sessionTable.id,
            zoneId: sessionZone.id,
            participantId: participant.id,
          },
          actor: { type: "system" },
          now,
        });
      }
      const refreshed = { ...active, lastActivityAt: now };
      return scanResult({
        outcome: "joined",
        table: sessionTable,
        zone: sessionZone,
        session: await sessionDto(tx, refreshed),
        token: openSessionToken(active),
        refs,
        now,
      });
    }

    // The previous visit's 12-hour window ran out; close it and start fresh.
    if (active) await expireSession(tx, context, active, now);

    const sessionId = randomUUID();
    const credential = newSessionCredential();
    const paymentMode = zone.paymentMode;
    const status: TableSessionStatus =
      paymentMode === "open_bill" ? "pending_confirmation" : "open";
    const [inserted] = await tx
      .insert(tableSessions)
      .values({
        id: sessionId,
        tenantId: context.tenant.tenantId,
        outletId: table.outletId,
        tableId: table.id,
        pax: input.pax,
        paymentMode,
        status,
        sessionTokenHash: credential.hash,
        sessionTokenSealed: sealSecret(
          credential.token,
          sessionSealAad(context.tenant.tenantId, sessionId),
        ),
        openedAt: now,
        lastActivityAt: now,
      })
      // A concurrent first scan may win the one-active-session-per-table key;
      // DO NOTHING keeps the transaction usable, and the loser joins the
      // winner below instead of failing the guest.
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      const winner = await activeSessionForTable(
        tx,
        context.tenant.tenantId,
        table.id,
      );
      if (!winner)
        throw new CoreError(
          "CONFLICT",
          "Sesi meja baru saja berubah; pindai QR meja sekali lagi.",
        );
      const [participant] = await tx
        .insert(sessionParticipants)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: table.outletId,
          tableSessionId: winner.id,
          deviceHash: input.deviceHash,
          joinedAt: now,
          lastSeenAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (participant) {
        await appendSessionEvent(tx, context, "table_session.joined", {
          sessionId: winner.id,
          outletId: table.outletId,
          payload: {
            sessionId: winner.id,
            tableId: table.id,
            zoneId: zone.id,
            participantId: participant.id,
          },
          actor: { type: "system" },
          now,
        });
      }
      return scanResult({
        outcome: "joined",
        table,
        zone,
        session: await sessionDto(tx, winner),
        token: openSessionToken(winner),
        refs,
        now,
      });
    }
    const [participant] = await tx
      .insert(sessionParticipants)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: table.outletId,
        tableSessionId: sessionId,
        deviceHash: input.deviceHash,
        joinedAt: now,
        lastSeenAt: now,
      })
      .returning();
    if (!participant) throw new Error("Participant insert returned no row");
    // A seated table shows as occupied; reserved becomes occupied only now.
    const seated =
      table.status === "available" || table.status === "reserved"
        ? { ...table, status: "occupied" as const }
        : table;
    if (seated !== table)
      await tx
        .update(tables)
        .set({ status: "occupied", updatedAt: now })
        .where(
          and(
            eq(tables.tenantId, context.tenant.tenantId),
            eq(tables.id, table.id),
          ),
        );
    await appendSessionEvent(tx, context, "table_session.opened", {
      sessionId,
      outletId: table.outletId,
      payload: {
        sessionId,
        tableId: table.id,
        zoneId: zone.id,
        pax: input.pax,
        paymentMode,
        openedBy: "guest",
        participantId: participant.id,
      },
      actor: { type: "system" },
      now,
    });
    return scanResult({
      outcome: "opened",
      table: seated,
      zone,
      session: toSession(inserted, [participant]),
      token: credential.token,
      refs,
      now,
    });
  });
}

export type OpenStaffSeatedSessionInput = {
  outletId: OutletId;
  /** The party's tables; the first is primary and carries the session. */
  tableIds: string[];
  pax: number;
  /** The host who seats the party; doubles as the open-bill confirmer. */
  confirmedBy: string;
  reservationId: string;
  now: Date;
};

export type OpenStaffSeatedSessionResult = {
  sessionId: string;
  participantId: string;
  zoneId: string;
  paymentMode: "pay_first" | "open_bill";
};

/**
 * Staff-seated open (reservation seating, RSV-02). Same session, credential,
 * seal and `table_session.opened` event as a guest scan, so a later guest QR
 * scan of the table joins this session instead of opening a second one.
 *
 * Multi-table parties: every table's live-state lock is taken in ascending id
 * order (deadlock-safe), each must be seatable (zone active, not dirty or
 * inactive, no live session; a session past its 12-hour window is expired
 * first, failing closed on an unsettled bill) before anything is written. The
 * session binds to the primary table; secondary tables are marked occupied and
 * are released when that session closes (see `closeTableSession`).
 */
export async function openStaffSeatedSession(
  tx: Tx,
  context: ScopedTenantContext,
  input: OpenStaffSeatedSessionInput,
): Promise<OpenStaffSeatedSessionResult> {
  const { now } = input;
  const tenantId = context.tenant.tenantId;
  const primaryId = input.tableIds[0];
  if (!primaryId) throw new CoreError("NOT_FOUND", "Meja tidak ditemukan.");
  const ordered = [...new Set(input.tableIds)].sort();
  for (const id of ordered) await lockTableLiveState(tx, tenantId, id);

  const seatable = new Map<
    string,
    { table: typeof tables.$inferSelect; zone: typeof floorZones.$inferSelect }
  >();
  for (const id of ordered) {
    const [table] = await tx
      .select()
      .from(tables)
      .where(and(eq(tables.tenantId, tenantId), eq(tables.id, id)));
    if (!table) throw new CoreError("NOT_FOUND", "Meja tidak ditemukan.");
    assertOutletInScope(context.outletScope, table.outletId);
    if (table.outletId !== input.outletId)
      throw new CoreError("NOT_FOUND", "Meja tidak ditemukan.");
    const [zone] = await tx
      .select()
      .from(floorZones)
      .where(
        and(eq(floorZones.tenantId, tenantId), eq(floorZones.id, table.zoneId)),
      );
    if (!zone) throw new CoreError("NOT_FOUND", "Zona tidak ditemukan.");
    if (zone.status === "inactive")
      throw new CoreError("CONFLICT", "Zona meja sedang tidak aktif.");
    if (table.status === "dirty" || table.status === "inactive")
      throw new CoreError("CONFLICT", "Meja belum siap dipakai.");
    const active = await activeSessionForTable(tx, tenantId, table.id);
    if (active) {
      if (!tokenExpired(active, now))
        throw new CoreError("CONFLICT", "Meja masih dipakai tamu lain.");
      await expireSession(tx, context, active, now);
    }
    seatable.set(id, { table, zone });
  }

  const primary = seatable.get(primaryId)!;
  const sessionId = randomUUID();
  const credential = newSessionCredential();
  const paymentMode = primary.zone.paymentMode;
  const pax = Math.min(input.pax, 30);
  await tx.insert(tableSessions).values({
    id: sessionId,
    tenantId,
    outletId: input.outletId,
    tableId: primaryId,
    pax,
    paymentMode,
    status: "open",
    sessionTokenHash: credential.hash,
    sessionTokenSealed: sealSecret(
      credential.token,
      sessionSealAad(tenantId, sessionId),
    ),
    // A pay-first session is opened by the guest, never confirmed by staff.
    confirmedBy: paymentMode === "open_bill" ? input.confirmedBy : null,
    reservationId: input.reservationId,
    openedAt: now,
    lastActivityAt: now,
  });
  const [participant] = await tx
    .insert(sessionParticipants)
    .values({
      tenantId,
      outletId: input.outletId,
      tableSessionId: sessionId,
      deviceHash: `reservation:${input.reservationId}`,
      joinedAt: now,
      lastSeenAt: now,
    })
    .returning();
  if (!participant) throw new Error("Participant insert returned no row");
  await tx
    .update(tables)
    .set({ status: "occupied", updatedAt: now })
    .where(and(eq(tables.tenantId, tenantId), inArray(tables.id, ordered)));
  await appendSessionEvent(tx, context, "table_session.opened", {
    sessionId,
    outletId: input.outletId,
    payload: {
      sessionId,
      tableId: primaryId,
      zoneId: primary.zone.id,
      pax,
      paymentMode,
      openedBy: "staff",
      participantId: participant.id,
    },
    actor: { type: "user", id: input.confirmedBy },
    now,
  });
  return {
    sessionId,
    participantId: participant.id,
    zoneId: primary.zone.id,
    paymentMode,
  };
}

/**
 * Resolves the guest credential for the session routes that land next
 * (cart/quote/order). ORD-04: a closed, voided or expired session is refused
 * even if the client kept its token; the guest rescans the table QR.
 */
export async function authenticateGuestSession(
  context: ScopedTenantContext,
  rawToken: string,
  now = new Date(),
): Promise<{ session: TableSession; table: Table }> {
  if (rawToken.length < 20 || rawToken.length > 256)
    throw new CoreError(
      "UNAUTHORIZED",
      "Sesi meja tidak dikenali; pindai QR meja lagi.",
    );
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(tableSessions)
      .where(
        and(
          eq(tableSessions.tenantId, context.tenant.tenantId),
          eq(tableSessions.sessionTokenHash, credentialHash(rawToken)),
        ),
      );
    if (!row)
      throw new CoreError(
        "UNAUTHORIZED",
        "Sesi meja tidak dikenali; pindai QR meja lagi.",
      );
    if (!isActive(row.status) || tokenExpired(row, now))
      throw new CoreError(
        "UNAUTHORIZED",
        "ORD-04: sesi meja sudah ditutup; pindai QR meja lagi.",
      );
    const [table] = await tx
      .select()
      .from(tables)
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          eq(tables.id, row.tableId),
        ),
      );
    if (!table) throw new CoreError("NOT_FOUND", "Meja sesi tidak ditemukan.");
    return {
      session: await sessionDto(tx, row),
      table: toTable(table),
    };
  });
}

// ---- Staff lifecycle ------------------------------------------------------

/** Waiter or cashier confirms an open-bill session before the first order. */
export async function confirmOpenBillSession(
  context: ScopedTenantContext,
  sessionId: string,
  actorUserId: string,
  now = new Date(),
): Promise<TableSession> {
  return withTenant(db, context, async (tx) => {
    const located = await loadSession(tx, context.tenant.tenantId, sessionId);
    await lockTableLiveState(tx, context.tenant.tenantId, located.tableId);
    const row = await loadSession(tx, context.tenant.tenantId, sessionId, {
      forUpdate: true,
    });
    assertOutletInScope(context.outletScope, row.outletId);
    const status = nextStatus(row.status, "confirm");
    const [updated] = await tx
      .update(tableSessions)
      .set({
        status,
        confirmedBy: actorUserId,
        lastActivityAt: now,
      })
      .where(
        and(
          eq(tableSessions.tenantId, context.tenant.tenantId),
          eq(tableSessions.id, row.id),
        ),
      )
      .returning();
    if (row.confirmedBy === null) {
      const [table] = await tx
        .select()
        .from(tables)
        .where(
          and(
            eq(tables.tenantId, context.tenant.tenantId),
            eq(tables.id, row.tableId),
          ),
        );
      if (
        table &&
        (table.status === "available" || table.status === "reserved")
      )
        await tx
          .update(tables)
          .set({ status: "occupied", updatedAt: now })
          .where(
            and(
              eq(tables.tenantId, context.tenant.tenantId),
              eq(tables.id, table.id),
            ),
          );
    }
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "table_session.confirmed",
        outletId: row.outletId,
        objectId: row.id,
        before: {
          id: row.id,
          status: row.status,
          paymentMode: row.paymentMode,
        },
        after: { id: updated.id, status: updated.status },
      },
      now,
    );
    return sessionDto(tx, updated);
  });
}

/**
 * ORD-10: close the session after the bill is settled and the table is
 * cleaned, or when a waiter explicitly confirms the table is empty. The guest
 * credential rotates on close, so it can never order for this session again
 * (ORD-04). Bill totals come from the settlement port (legend-e2x); when the
 * bill cannot be verified the close fails closed, and a supervisor override
 * on an unsettled/unverified bill is recorded as voided (Codex pre-review
 * HIGH: never assume the bill is paid).
 */
export async function closeTableSession(
  context: ScopedTenantContext,
  sessionId: string,
  input: CloseTableSessionInput,
  actorUserId: string,
  now = new Date(),
): Promise<TableSession> {
  // legend-ukbq3: charge payment links are confirmed unpaid at the provider
  // before the close transaction (network I/O stays outside it); an unconfirmed
  // answer (409 PAYMENT_PROVIDER_UNCONFIRMED) propagates and nothing is closed.
  // The `settled` verdict is not read here: `expireOpenChargesOfSession` throws
  // 409 in the transaction for a charge still `open` whose link has a paid
  // intent (the worker has not applied it yet), so nothing is closed either.
  await confirmChargeLinksUnpaid(context, { sessionId }, now);
  return withTenant(db, context, async (tx) => {
    const located = await loadSession(tx, context.tenant.tenantId, sessionId);
    // A reservation-seated party may hold secondary tables (marked occupied by
    // `openStaffSeatedSession`); they are freed with the session. Lock every
    // table in ascending id order, the same order seating uses.
    const secondaryIds = located.reservationId
      ? (
          await tx
            .select({ tableId: reservationTables.tableId })
            .from(reservationTables)
            .where(
              and(
                eq(reservationTables.tenantId, context.tenant.tenantId),
                eq(reservationTables.reservationId, located.reservationId),
                isNull(reservationTables.releasedAt),
              ),
            )
        )
          .map((hold) => hold.tableId)
          .filter((id) => id !== located.tableId)
      : [];
    for (const id of [...new Set([located.tableId, ...secondaryIds])].sort())
      await lockTableLiveState(tx, context.tenant.tenantId, id);
    const row = await loadSession(tx, context.tenant.tenantId, sessionId, {
      forUpdate: true,
    });
    assertOutletInScope(context.outletScope, row.outletId);
    const status = nextStatus(row.status, "close");
    let settlement = await loadSettlement(tx, context, row.id);
    // null = the orders module cannot prove the bill is settled; only the
    // explicit waiter override may close that session.
    let billOutstandingIdr = outstandingOf(settlement);
    const canClose =
      input.waiterConfirmedEmpty ||
      (billOutstandingIdr === 0 && input.tableCleaned);
    if (!canClose)
      throw new CoreError(
        "CONFLICT",
        billOutstandingIdr === null
          ? "ORD-10: tagihan meja belum dapat diverifikasi; minta waiter mengonfirmasi meja kosong."
          : "ORD-10: meja belum bisa dikosongkan sebelum tagihan lunas atau dikonfirmasi waiter.",
      );
    // The forced close ends the session: swap charges nobody can pay any more
    // expire with it and leave the bill, so a fully paid pay-first session is
    // not recorded as voided because of them.
    if (
      (await expireOpenChargesOfSession(tx, context, row.id, now)) > 0 &&
      billOutstandingIdr !== null
    ) {
      settlement = await loadSettlement(tx, context, row.id);
      billOutstandingIdr = outstandingOf(settlement);
    }
    const credential = newSessionCredential();
    // Only a verified-settled bill counts as paid_and_cleaned; an override on
    // an outstanding or unverifiable bill is a voided session.
    const closedReason =
      billOutstandingIdr === 0
        ? ("paid_and_cleaned" as const)
        : ("voided" as const);
    const [updated] = await tx
      .update(tableSessions)
      .set({
        status,
        closedAt: now,
        closedReason,
        lastActivityAt: now,
        sessionTokenHash: credential.hash,
        sessionTokenSealed: sealSecret(
          credential.token,
          sessionSealAad(row.tenantId, row.id),
        ),
      })
      .where(
        and(
          eq(tableSessions.tenantId, context.tenant.tenantId),
          eq(tableSessions.id, row.id),
        ),
      )
      .returning();
    if (!updated) throw new Error("Session close returned no row");
    await finalizeReservationDepositRemainders(tx, context, {
      tableSessionId: row.id,
      validFinalBill: closedReason === "paid_and_cleaned",
      actorUserId,
      now,
    });
    await cancelOpenServiceRequests(tx, row.tenantId, row.id, now);
    const tablesBefore = await readTableStates(tx, row.tenantId, [
      row.tableId,
      ...secondaryIds,
    ]);
    await tx
      .update(tables)
      .set({
        status: input.tableCleaned ? "available" : "dirty",
        updatedAt: now,
      })
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          eq(tables.id, row.tableId),
        ),
      );
    if (secondaryIds.length > 0)
      await tx
        .update(tables)
        .set({
          status: input.tableCleaned ? "available" : "dirty",
          updatedAt: now,
        })
        .where(
          and(
            eq(tables.tenantId, context.tenant.tenantId),
            inArray(tables.id, secondaryIds),
            eq(tables.status, "occupied"),
          ),
        );
    const closeTarget = input.tableCleaned ? "available" : "dirty";
    for (const id of [row.tableId, ...secondaryIds]) {
      const before = tablesBefore.get(id);
      // Secondary tables only change when they were occupied (see update above).
      if (!before || (id !== row.tableId && before.status !== "occupied"))
        continue;
      await emitTableStatusChanged(tx, context, {
        tableId: id,
        outletId: row.outletId,
        zoneId: before.zoneId,
        from: before.status,
        to: closeTarget,
        cause: "session_closed",
        actor: { type: "user", id: actorUserId },
        now,
      });
    }
    await releaseLinksOfSession(
      tx,
      context,
      row.id,
      "session_closed",
      { type: "user", id: actorUserId },
      now,
    );
    await appendSessionEvent(tx, context, "table_session.closed", {
      sessionId: row.id,
      outletId: row.outletId,
      payload: {
        sessionId: row.id,
        tableId: row.tableId,
        reason: closedReason,
        billTotalIdr: settlement?.billTotalIdr ?? 0,
        paidIdr: settlement?.paidIdr ?? 0,
        orderCount: 0,
        closedBy: "staff",
      },
      actor: { type: "user", id: actorUserId },
      now,
    });
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "table_session.closed",
        outletId: row.outletId,
        objectId: row.id,
        before: { id: row.id, status: row.status },
        after: {
          id: updated.id,
          status: updated.status,
          closedReason,
          tableCleaned: input.tableCleaned,
          waiterConfirmedEmpty: input.waiterConfirmedEmpty,
        },
      },
      now,
    );
    return sessionDto(tx, updated);
  });
}

/**
 * Staff table status action (PRD "Papan Status"). ORD-10 is enforced by the
 * shared `assertCanApplyTableStatusAction`: emptying a table that still has a
 * session is refused with TABLE_SESSION_ACTIVE.
 */
export async function updateTableStatus(
  context: ScopedTenantContext,
  tableId: string,
  input: UpdateTableStatusInput,
  actorUserId: string,
  now = new Date(),
): Promise<TableLiveStatus> {
  return withTenant(db, context, async (tx) => {
    await lockTableLiveState(tx, context.tenant.tenantId, tableId);
    const [row] = await tx
      .select()
      .from(tables)
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          eq(tables.id, tableId),
        ),
      );
    if (!row) throw new CoreError("NOT_FOUND", "Meja tidak ditemukan.");
    assertOutletInScope(context.outletScope, row.outletId);
    // A secondary table of a seated party has no session of its own; it is
    // still in use while the party's session is live (no mark_available).
    const session =
      (await activeSessionForTable(tx, context.tenant.tenantId, row.id)) ??
      (await partySessionForSecondaryTable(tx, context.tenant.tenantId, row));
    assertCanApplyTableStatusAction({
      action: input.action,
      tableStatus: row.status,
      hasActiveSession: session !== undefined,
    });
    const [updated] = await tx
      .update(tables)
      .set({ status: tableStatusActionTarget(input.action), updatedAt: now })
      .where(
        and(
          eq(tables.tenantId, context.tenant.tenantId),
          eq(tables.id, row.id),
        ),
      )
      .returning();
    await emitTableStatusChanged(tx, context, {
      tableId: row.id,
      outletId: row.outletId,
      zoneId: row.zoneId,
      from: row.status,
      to: updated.status,
      cause: "staff_action",
      actor: { type: "user", id: actorUserId },
      now,
    });
    const linkGroup =
      (
        await linkGroupsForTables(tx, context.tenant.tenantId, row.outletId)
      ).get(row.id) ?? null;
    await audit(
      tx,
      context,
      {
        actorUserId,
        action: "table.status_changed",
        outletId: row.outletId,
        objectId: row.id,
        objectType: "table",
        before: { id: row.id, status: row.status },
        after: { id: row.id, status: updated.status, action: input.action },
      },
      now,
    );
    return tableLiveStatusSchema.parse({
      table: toTable(updated),
      session:
        session === undefined
          ? null
          : tableSessionSummarySchema.parse({
              id: session.id,
              status: session.status,
              pax: session.pax,
              paymentMode: session.paymentMode,
              openedAt: session.openedAt.toISOString(),
              lastActivityAt: session.lastActivityAt.toISOString(),
              billTotalIdr: 0,
            }),
      openServiceRequestCount: 0,
      outstandingIdr: 0,
      linkGroup,
    });
  });
}
