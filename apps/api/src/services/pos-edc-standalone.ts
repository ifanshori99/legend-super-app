// POS standalone EDC tender (bead legend-m4fv; EDC-04; X1 legend-wasr7.10).
//
// The cashier keyed the sale on the terminal by hand. The API never calls a
// terminal here. Since X1 (cloud-only release §3) this is the normal EDC path:
// the bank reference printed on the slip is required and books the remaining
// bill (computed here, never sent by the till) without a supervisor PIN. A
// supervisor override (`edc_standalone`, worth exactly the remaining bill) is
// still accepted and spent when the till sends one. Nothing counts as settled
// with the bank: every entry stays flagged until the H+1 reconciliation
// matches it (edc-reconciliation.service.ts; overdue entries alert their shift).
//
// - One `edc_transactions` row is written in the order transaction: mode
//   `standalone`, status `approved`, `needs_reconciliation` true (a human
//   matches it to the bank settlement later), `rrn` = the bank reference. The
//   tender links to it through `edc_transaction_id`; no tender column is new.
// - An override, when sent, is spent in `pos_order_approval_uses` (purpose
//   `edc_standalone`): one approval pays one bill once.
// - The advisory lock is the agent's `writeAhead` lock for this reference, so
//   a standalone entry cannot interleave with a sale the agent is starting. A
//   card-terminal row for the bill that is approved, pending, unknown or
//   flagged blocks it (the same set `writeAhead` refuses to start over).
// - One slip is one charge on the machine (legend-9yw78.15): the bank reference
//   (no hyphens, upper case, as the resolve flow compares it) of an approved,
//   pending or unknown sale of the tenant, whatever the bank or terminal, never
//   pays a second bill (a look-alike across banks only costs a supervisor). The
//   check runs under an advisory lock on that reference, so two bills sent
//   together with one slip cannot both pass. Doubt refuses: the cashier asks
//   the supervisor, who can see the slip. The ledger key is the slip number
//   (`standalone:slip:<ref>`), so the unique (tenant, idempotency_key) index
//   backs the check: one slip is one manual entry, whatever the lock does.
// - 1273: a used slip is still refused (409 `EDC_SLIP_REF_USED`), but a
//   supervisor may let it through when the till sends `allowDuplicateSlip`
//   with the override. The kafe is never locked out of a real card charge; the
//   row stays flagged, its ledger key and message carry the duplicate mark, an
//   audit row names the supervisor, the slip and the first bill, and the bank
//   file import never clears a flag whose slip number is shared.

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  CoreError,
  createUlid,
  idr,
  outletIdSchema,
  toIsoDateTime,
  ulidSchema,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { PosError } from "@starter/shared/pos";
import { emitEdcTransactionEvent } from "../edge/edc/events.ts";
import { edcTransactions } from "../db/schema/edc.ts";
import { paymentEdcTerminals, posOverrides } from "../db/schema/index.ts";
import type { Tx } from "./menu-internals.ts";
import { recordAudit } from "./core-audit.ts";
import { consumeApproval } from "./pos-order-support.ts";

const METHOD_OF_TENDER = { edc_card: "card", edc_qris: "qris" } as const;

/** The slip number as the resolve flow compares it. */
const slipNumber = (value: string) => value.replaceAll("-", "").toUpperCase();

export type PosStandaloneEdcInput = {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly outletId: OutletId;
  readonly method: "edc_card" | "edc_qris";
  /** The remaining bill: the override must be worth exactly this. */
  readonly amountIdr: number;
  readonly terminalId: string;
  readonly bankRef: string;
  readonly approvalCode: string | null;
  /** Optional since X1: the slip reference alone books a manual payment. */
  readonly overrideId: string | null;
  /** The till asked to book a slip number that already paid a bill. */
  readonly allowDuplicateSlip?: boolean;
  readonly cashierId: UserId;
  readonly deviceId: string | null;
  readonly at: Date;
};

export type PosStandaloneEdcSettlement = {
  readonly reference: string;
  /** The supervisor of a sent override; null for the normal manual path. */
  readonly approvedBy: UserId | null;
  readonly edcTransactionId: string;
};

export async function settlePosEdcStandalone(
  tx: Tx,
  context: ScopedTenantContext,
  input: PosStandaloneEdcInput,
): Promise<PosStandaloneEdcSettlement> {
  const tenantId = context.tenant.tenantId;
  const refuse = () => new PosError("EDC_STANDALONE_APPROVAL_REQUIRED");
  const outletId = outletIdSchema.parse(input.outletId);
  // Same lock as the agent's write-ahead for this reference.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${`${outletId}:${input.orderNumber}`}))`,
  );
  const [terminal] = await tx
    .select()
    .from(paymentEdcTerminals)
    .where(
      and(
        eq(paymentEdcTerminals.tenantId, tenantId),
        eq(paymentEdcTerminals.outletId, outletId),
        eq(paymentEdcTerminals.id, input.terminalId),
      ),
    )
    .limit(1);
  // Same answer for "missing" and "another outlet's": no probing of ids.
  if (!terminal)
    throw new CoreError("NOT_FOUND", "Terminal EDC tidak ditemukan.");
  const edcMethod = METHOD_OF_TENDER[input.method];
  if (
    terminal.status !== "active" ||
    !terminal.supportedMethods.includes(edcMethod)
  )
    throw new CoreError(
      "CONFLICT",
      "Terminal EDC ini tidak aktif atau tidak mendukung metode tersebut.",
    );
  const blocking = await tx
    .select({ id: edcTransactions.id })
    .from(edcTransactions)
    .where(
      and(
        eq(edcTransactions.tenantId, tenantId),
        eq(edcTransactions.outletId, outletId),
        eq(edcTransactions.reference, input.orderNumber),
        or(
          inArray(edcTransactions.status, ["approved", "pending", "unknown"]),
          eq(edcTransactions.needsReconciliation, true),
        ),
      ),
    )
    .limit(1);
  if (blocking.length > 0)
    throw new CoreError(
      "CONFLICT",
      "Tagihan ini sudah punya transaksi EDC yang disetujui, menunggu hasil atau menunggu rekonsiliasi.",
    );
  // One slip, one bill: the lock comes after the bill's own, and the check
  // sees every charge of this bank, whichever bill or path wrote it.
  const slip = slipNumber(input.bankRef);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${`edc-slip:${slip}`}))`,
  );
  const sameSlip = await tx
    .select({
      id: edcTransactions.id,
      reference: edcTransactions.reference,
    })
    .from(edcTransactions)
    .where(
      and(
        eq(edcTransactions.tenantId, tenantId),
        eq(edcTransactions.type, "sale"),
        inArray(edcTransactions.status, ["approved", "pending", "unknown"]),
        sql`upper(replace(${edcTransactions.rrn}, '-', '')) = ${slip}`,
      ),
    )
    .orderBy(edcTransactions.createdAt, edcTransactions.id)
    .limit(1);
  const firstUse = sameSlip[0] ?? null;
  // A used slip passes only with the cashier's explicit ask AND an override;
  // the override is verified and spent below like any other.
  if (
    firstUse &&
    (input.allowDuplicateSlip !== true || input.overrideId === null)
  )
    throw new PosError("EDC_SLIP_REF_USED");
  let approvedBy: UserId | null = null;
  let overrideUsed: string | null = null;
  if (input.overrideId !== null) {
    // The approver comes from the override row, never from the client; the
    // shared check below still requires it to be someone other than the
    // cashier.
    const overrideUlid = ulidSchema.safeParse(input.overrideId);
    if (!overrideUlid.success) throw refuse();
    const [stored] = await tx
      .select({ approvedBy: posOverrides.approvedBy })
      .from(posOverrides)
      .where(
        and(
          eq(posOverrides.tenantId, tenantId),
          eq(posOverrides.outletId, outletId),
          eq(posOverrides.id, overrideUlid.data),
        ),
      )
      .limit(1);
    if (!stored?.approvedBy) throw refuse();
    const override = await consumeApproval(tx, context, {
      action: "edc_standalone",
      purpose: "edc_standalone",
      outletId,
      orderId: input.orderId,
      objectType: "pos_order",
      objectId: input.orderId,
      requesterId: input.cashierId,
      approvedBy: stored.approvedBy,
      overrideId: overrideUlid.data,
      minValueIdr: input.amountIdr,
      deviceId: input.deviceId,
      now: input.at,
    });
    // Exactly the remaining bill: a bigger approval is not a licence to book
    // less, and a smaller one never reaches here (minValueIdr).
    if (override.valueIdr !== input.amountIdr) throw refuse();
    approvedBy = stored.approvedBy as UserId;
    overrideUsed = overrideUlid.data;
  }
  const row = {
    id: randomUUID(),
    tenantId,
    outletId,
    terminalId: terminal.id,
    bank: terminal.bankCode,
    reference: input.orderNumber,
    // One slip, one entry: the unique (tenant, key) index backs the check. A
    // supervisor-approved repeat of a used slip carries its override id, so it
    // does not collide and a retry of the same approval still does.
    idempotencyKey: firstUse
      ? `standalone:slip:${slip}:dup:${overrideUsed}`
      : `standalone:slip:${slip}`,
    requestFingerprint: createHash("sha256")
      .update(
        `${input.orderNumber}:${input.amountIdr}:${edcMethod}:${input.bankRef}`,
      )
      .digest("hex"),
    amountIdr: idr(input.amountIdr),
    method: edcMethod,
    status: "approved",
    type: "sale",
    mode: "standalone",
    trace: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
    approvalCode: input.approvalCode,
    rrn: input.bankRef,
    message: firstUse
      ? `Ref ganda disetujui supervisor; slip sama dengan tagihan ${firstUse.reference}`.slice(
          0,
          200,
        )
      : null,
    needsReconciliation: true,
    completedAt: input.at,
    createdAt: input.at,
    updatedAt: input.at,
  };
  const [inserted] = await tx.insert(edcTransactions).values(row).returning();
  if (!inserted) throw new Error("EDC standalone insert returned no row");
  await emitEdcTransactionEvent(tx, context, {
    name: "edc_transaction.approved",
    row: inserted,
    now: input.at,
  });
  if (firstUse) {
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(input.at.getTime()),
        tenantId,
        outletId,
        actorType: "user",
        actorId: input.cashierId,
        deviceId: input.deviceId,
        action: "edc_transaction.duplicate_slip_approved",
        objectType: "edc_transaction",
        objectId: inserted.id,
        reason: "Slip EDC ganda disetujui supervisor",
        maskedChanges: {
          before: null,
          after: {
            approvedBy,
            overrideId: overrideUsed,
            slipRef: input.bankRef,
            orderNumber: input.orderNumber,
            firstOrderNumber: firstUse.reference,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: toIsoDateTime(input.at),
      },
      [
        "approvedBy",
        "overrideId",
        "slipRef",
        "orderNumber",
        "firstOrderNumber",
      ],
    );
  }
  return {
    reference: input.bankRef,
    approvedBy,
    edcTransactionId: inserted.id,
  };
}
