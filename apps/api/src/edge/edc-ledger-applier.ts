// Cloud mirror of the EDC ledger an outlet runs on its edge (1269 E4,
// legend-osqou.25). The edge EDC agent and the standalone EDC path write
// `edc_transactions` on the edge and append one `edc_transaction.*` event per
// status change (edge/edc/events.ts, full row state after the change). Here
// each event is parked like the other POS events, then mirrored into the
// cloud's `edc_transactions`, so reconciliation and the bank settlement match
// (payment-settlement-import.service.ts, by RRN) see the edge's card charges.
//
// Rules (money: in doubt refuse, never book a charge twice):
//  R1 One row per edge transaction, keyed by its id. The ledger
//     `edge_edc_ingests` holds the last applied sequence: a replay, or an
//     older event arriving late, writes nothing. Twice or in any order, the
//     result is one row in the state of the newest event.
//  R2 What the charge is never changes: outlet, terminal, bank, bill
//     reference, amount, method, type, mode and trace are fixed by the first
//     event mirrored. A later event that says otherwise is refused.
//  R3 Status only moves forward, as on the edge: a final status never goes
//     back to pending/unknown, a decline/cancel/fail never becomes approved
//     (late approval), and an approved charge only becomes a decline while it
//     waits for reconciliation (the edge's resolve). Anything else is refused.
//  R4 One slip is one charge (legend-9yw78.15): an approved, pending or
//     unknown sale whose bank reference another such sale of the tenant
//     already has (no dashes, upper case, any bank or terminal) is refused,
//     under the same advisory lock as the standalone path. Two approved sales
//     for one bill hit `edc_transactions_approved_reference_key`: refused.
//  R5 A mirrored row the cloud changed itself (state hash differs from what
//     the edge last set) is never overwritten: refused for a human.
//  R6 No card number is stored: the envelope is scrubbed before parking
//     (envelope-secrets.ts) and an event that held one is refused. The
//     payload schema only admits a masked PAN.
//  R7 A refusal is final (ledger row `refused`, guard trigger) and alerts the
//     outlet supervisors once. Nothing is appended to the outbox (apply
//     scope). A transient database error (lock, deadlock, serialization) is
//     rethrown: the receive batch rolls back and the edge sends it again.
import { createHash } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import {
  EDC_TRANSACTION_EVENTS,
  edcTransactionEventPayloadSchema,
  type EdcTransactionEventPayload,
} from "@starter/shared/edc/events";
import type { EventEnvelope } from "@starter/shared/events";
import { edcTransactions } from "../db/schema/edc.ts";
import { edgeEdcIngests } from "../db/schema/edge-edc-ingest.ts";
import { paymentEdcTerminals } from "../db/schema/payment-admin.ts";
import { logger } from "../lib/logger.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import { uniqueViolationOf } from "../services/pos-shift-support.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
  type EdgeEventHandler,
} from "./applier-registry.ts";
import { applyEdgeDeferredEvent } from "./deferred-event-applier.ts";
import {
  edcCardNumberKeys,
  redactEdgeEnvelopeSecrets,
} from "./envelope-secrets.ts";
import { alertSupervisors, edgeAlertId } from "./late-adjustment.ts";
import { isTransientReason, sqlStateOf } from "./order-ingest.ts";
import type { EdgeApplyMeta } from "./ports.ts";

export const EDC_AGGREGATE = "edc_transaction";
/** The edge's ledger events; `edc_transaction.settled` is a cloud event. */
export const EDC_LEDGER_EVENTS: readonly string[] = EDC_TRANSACTION_EVENTS.map(
  (definition) => definition.name,
);

/** Final: recorded as `refused`. */
class Refusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type Payload = EdcTransactionEventPayload;
type Row = typeof edcTransactions.$inferSelect;
type Mirrored = Payload & {
  method: NonNullable<Payload["method"]>;
  type: NonNullable<Payload["type"]>;
  mode: NonNullable<Payload["mode"]>;
  trace: string;
  rrn: string | null;
  completedAt: string | null;
};

const OPEN = new Set(["pending", "unknown"]);
const FINAL = new Set(["approved", "declined", "cancelled", "failed"]);
/** Bill-unique statuses of the slip rule (pos-edc-standalone.ts). */
const SLIP_STATUSES = ["approved", "pending", "unknown"] as const;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const slipNumber = (value: string) => value.replaceAll("-", "").toUpperCase();
const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

/** The status each event name must carry. */
function statusFits(name: string, payload: Payload): boolean {
  switch (name) {
    case "edc_transaction.created":
      return payload.status === "pending";
    case "edc_transaction.approved":
      return payload.status === "approved";
    case "edc_transaction.declined":
      return payload.status === "declined";
    case "edc_transaction.failed":
      return payload.status === "failed";
    case "edc_transaction.cancelled":
      return payload.status === "cancelled";
    case "edc_transaction.flagged":
      return payload.needsReconciliation || payload.status === "unknown";
    default:
      return false;
  }
}

/** The fields R5 compares, as the edge set them. */
function stateHashOf(state: {
  status: string;
  approvalCode: string | null;
  rrn: string | null;
  maskedPan: string | null;
  needsReconciliation: boolean;
  completedAt: Date | string | null;
}): string {
  return sha256(
    JSON.stringify([
      state.status,
      state.approvalCode,
      state.rrn,
      state.maskedPan,
      state.needsReconciliation,
      iso(state.completedAt),
    ]),
  );
}

/** Validated payload of a mirrorable event, or a refusal. */
function mirroredOf(event: EventEnvelope, context: ScopedTenantContext) {
  const parsed = edcTransactionEventPayloadSchema.safeParse(event.payload);
  if (!parsed.success) throw new Refusal("payload_invalid");
  const payload = parsed.data;
  if (
    event.aggregateType !== EDC_AGGREGATE ||
    !same(payload.transactionId, event.aggregateId) ||
    !same(payload.tenantId, context.tenant.tenantId) ||
    !event.outletId ||
    !same(payload.outletId, event.outletId)
  )
    throw new Refusal("scope_mismatch");
  if (
    payload.method === undefined ||
    payload.type === undefined ||
    payload.mode === undefined ||
    payload.rrn === undefined ||
    payload.completedAt === undefined
  )
    throw new Refusal("legacy_payload");
  if (!statusFits(event.name, payload)) throw new Refusal("status_mismatch");
  // The table's own rule: final statuses carry completed_at, open ones never.
  if (FINAL.has(payload.status) !== (payload.completedAt !== null))
    throw new Refusal("status_mismatch");
  // The edge row always has one (NOT NULL); it is part of the charge (R2).
  if (payload.trace === null) throw new Refusal("payload_invalid");
  return payload as Mirrored;
}

/** R2: the fixed fields of the charge. */
function assertSameCharge(row: Row, payload: Mirrored): void {
  if (
    !same(row.outletId, payload.outletId) ||
    !same(row.terminalId, payload.terminalId) ||
    row.bank !== payload.bank ||
    row.reference !== payload.reference ||
    Number(row.amountIdr) !== Number(payload.amountIdr) ||
    row.method !== payload.method ||
    row.type !== payload.type ||
    row.mode !== payload.mode ||
    row.trace !== payload.trace
  )
    throw new Refusal("charge_changed");
}

/** R3: the status move from the mirrored row to the event. */
function assertForward(row: Row, payload: Mirrored): void {
  if (row.status === payload.status) return;
  if (OPEN.has(row.status)) return;
  if (OPEN.has(payload.status)) throw new Refusal("status_regressed");
  if (payload.status === "approved") throw new Refusal("late_approval");
  if (row.status === "approved" && row.needsReconciliation) return;
  throw new Refusal("status_changed");
}

/** R4: one slip, one charge, across the tenant. */
async function assertSlipFree(
  tx: EdgeTx,
  tenantId: string,
  payload: Mirrored,
): Promise<void> {
  if (
    payload.type !== "sale" ||
    payload.rrn === null ||
    !(SLIP_STATUSES as readonly string[]).includes(payload.status)
  )
    return;
  const slip = slipNumber(payload.rrn);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${`edc-slip:${slip}`}))`,
  );
  const [other] = await tx
    .select({ id: edcTransactions.id })
    .from(edcTransactions)
    .where(
      and(
        eq(edcTransactions.tenantId, tenantId),
        ne(edcTransactions.id, payload.transactionId),
        eq(edcTransactions.type, "sale"),
        inArray(edcTransactions.status, [...SLIP_STATUSES]),
        sql`upper(replace(${edcTransactions.rrn}, '-', '')) = ${slip}`,
      ),
    )
    .limit(1);
  if (other) throw new Refusal("slip_used");
}

function refusalOf(error: unknown): string | null {
  if (error instanceof Refusal) return error.code;
  const constraint = uniqueViolationOf(error);
  if (constraint === "edc_transactions_approved_reference_key")
    return "reference_approved_twice";
  // An id, idempotency key or trace the applier cannot see (another
  // tenant's or outlet's row): never somebody else's charge.
  if (constraint !== null) return "row_exists";
  const state = sqlStateOf(error);
  const reason = state ? `db_error:${state}` : "error";
  return isTransientReason(reason) ? null : reason;
}

async function lockTransaction(
  tx: EdgeTx,
  tenantId: string,
  transactionId: string,
): Promise<void> {
  const key = `edge-edc-ingest:${tenantId}:${transactionId}`.toLowerCase();
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

async function ledgerOf(tx: EdgeTx, tenantId: string, transactionId: string) {
  const [row] = await tx
    .select()
    .from(edgeEdcIngests)
    .where(
      and(
        eq(edgeEdcIngests.tenantId, tenantId),
        eq(edgeEdcIngests.transactionId, transactionId),
      ),
    );
  return row;
}

async function writeLedger(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  row: {
    state: "ingested" | "refused";
    reason: string | null;
    sequence: number;
    stateHash: string | null;
  },
): Promise<void> {
  const values = {
    eventId: event.id,
    sequence: row.sequence,
    state: row.state,
    reason: row.reason,
    stateHash: row.stateHash,
    edgeNodeId: meta.edgeNodeId,
    updatedAt: new Date(),
  };
  await tx
    .insert(edgeEdcIngests)
    .values({
      tenantId: meta.context.tenant.tenantId,
      transactionId: event.aggregateId,
      outletId: event.outletId as OutletId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [edgeEdcIngests.tenantId, edgeEdcIngests.transactionId],
      set: values,
      setWhere: sql`${edgeEdcIngests.state} <> 'refused'`,
    });
}

/** Mirrors one event inside the caller's savepoint; throws to refuse. */
async function mirror(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  hadCardNumber: boolean,
): Promise<boolean> {
  const tenantId = meta.context.tenant.tenantId;
  await lockTransaction(tx, tenantId, event.aggregateId);
  const prior = await ledgerOf(tx, tenantId, event.aggregateId);
  if (prior?.state === "refused") return false; // R7: stays refused
  if (prior && event.sequence <= prior.sequence) {
    // R1: a replay or an older event. Same event: nothing to do. Another
    // event at the same sequence is history rewritten.
    if (event.sequence === prior.sequence && !same(prior.eventId, event.id))
      throw new Refusal("sequence_conflict");
    return false;
  }
  if (hadCardNumber) throw new Refusal("card_number");
  const payload = mirroredOf(event, meta.context);

  const [terminal] = await tx
    .select({ bankCode: paymentEdcTerminals.bankCode })
    .from(paymentEdcTerminals)
    .where(
      and(
        eq(paymentEdcTerminals.tenantId, tenantId),
        eq(paymentEdcTerminals.outletId, payload.outletId as OutletId),
        eq(paymentEdcTerminals.id, payload.terminalId),
      ),
    );
  if (!terminal || terminal.bankCode !== payload.bank)
    throw new Refusal("terminal_mismatch");

  const [row] = await tx
    .select()
    .from(edcTransactions)
    .where(
      and(
        eq(edcTransactions.tenantId, tenantId),
        eq(edcTransactions.id, payload.transactionId),
      ),
    );
  if (!prior && row) throw new Refusal("row_exists");
  if (prior && !row) throw new Refusal("row_missing");
  if (row) {
    assertSameCharge(row, payload);
    if (stateHashOf(row) !== prior!.stateHash)
      throw new Refusal("cloud_changed");
    assertForward(row, payload);
  }
  await assertSlipFree(tx, tenantId, payload);

  const now = new Date();
  const completedAt =
    payload.completedAt === null ? null : new Date(payload.completedAt);
  const state = {
    status: payload.status,
    approvalCode: payload.approvalCode,
    rrn: payload.rrn,
    maskedPan: payload.maskedPan,
    needsReconciliation: payload.needsReconciliation,
    completedAt,
  };
  if (row) {
    await tx
      .update(edcTransactions)
      .set({ ...state, updatedAt: now })
      .where(
        and(
          eq(edcTransactions.tenantId, tenantId),
          eq(edcTransactions.id, row.id),
        ),
      );
  } else {
    await tx.insert(edcTransactions).values({
      id: payload.transactionId,
      tenantId,
      outletId: payload.outletId as OutletId,
      terminalId: payload.terminalId,
      bank: payload.bank,
      reference: payload.reference,
      // Edge rows never meet a cloud request: their own key space.
      idempotencyKey: `edge:${payload.transactionId}`,
      requestFingerprint: sha256(
        JSON.stringify([
          payload.terminalId,
          payload.reference,
          payload.amountIdr,
          payload.method,
          payload.type,
          payload.mode,
        ]),
      ),
      amountIdr: payload.amountIdr,
      method: payload.method,
      type: payload.type,
      mode: payload.mode,
      trace: payload.trace,
      ...state,
      createdAt: new Date(event.occurredAt),
      updatedAt: now,
    });
  }
  await writeLedger(tx, event, meta, {
    state: "ingested",
    reason: null,
    sequence: event.sequence,
    stateHash: stateHashOf(state),
  });
  return true;
}

/**
 * Mirrors one parked `edc_transaction.*` event. Returns true when this call
 * wrote the cloud row. Refusals are recorded, never thrown; a transient
 * database error is rethrown (R7).
 */
export async function ingestEdgeEdcEvent(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  options: { hadCardNumber?: boolean } = {},
): Promise<boolean> {
  try {
    return await tx.transaction((sp) =>
      mirror(sp, event, meta, options.hadCardNumber ?? false),
    );
  } catch (error) {
    const reason = refusalOf(error);
    if (reason === null) throw error;
    logger.warn(
      { eventId: event.id, reason },
      "Edge EDC transaction not mirrored",
    );
    try {
      await tx.transaction(async (sp) => {
        const tenantId = meta.context.tenant.tenantId;
        const prior = await ledgerOf(sp, tenantId, event.aggregateId);
        if (prior?.state === "refused") return;
        await writeLedger(sp, event, meta, {
          state: "refused",
          reason,
          sequence: Math.max(prior?.sequence ?? 0, event.sequence, 1),
          stateHash: null,
        });
        await alertSupervisors(sp, meta.context, {
          outletId: event.outletId as OutletId,
          id: edgeAlertId("edge_edc_ingest", tenantId, event.aggregateId),
          eventName: "edge_edc_ingest.refused",
          aggregateType: EDC_AGGREGATE,
          aggregateId: event.aggregateId,
          payload: { reason },
          title: "Transaksi EDC server lokal perlu ditinjau",
          body: "Transaksi kartu dari server lokal tidak cocok dan belum dicatat di pusat. Hubungi finance.",
        });
      });
    } catch {
      // The parked row stays the durable evidence.
      logger.warn({ eventId: event.id }, "Edge EDC ledger row not recorded");
    }
    return false;
  }
}

// Stable identity: the registry treats a different handler as a wiring bug.
const applyEdgeEdcEvent: EdgeEventHandler = async (tx, event, meta) => {
  const hadCardNumber = edcCardNumberKeys(event).length > 0;
  await applyEdgeDeferredEvent(tx, event, meta, "deferred");
  await ingestEdgeEdcEvent(tx, redactEdgeEnvelopeSecrets(event), meta, {
    hadCardNumber,
  });
};

/**
 * Cloud boot (registerEdgeLink): the edge's EDC ledger events are parked and
 * mirrored instead of parked as unclassified.
 */
export function registerEdcLedgerEdgeApplier(): void {
  for (const name of EDC_LEDGER_EVENTS)
    registerEdgeEventHandler("edge_to_cloud", name, applyEdgeEdcEvent);
  registerEdgeAggregateKind(EDC_AGGREGATE, "transaction_event");
}
