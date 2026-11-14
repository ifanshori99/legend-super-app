// Auto-journal consumer (F19, legend-9pz9; design docs/design/auto-journals.md).
// Cloud only, wired in worker-main.ts next to the inventory GL bridge: every
// automatic money journal (sale, sale refund, gateway receipt, gateway payout,
// forfeited reservation DP, cashier shift over/short) posts through
// `postJournalFromRuleInTransaction` inside the outbox consumption
// transaction; a completed-sale void reverses the sale journal instead
// (`reverseJournalInTransaction`, accounting-auto-journal-void.ts). Tenants
// without the accounting module: `ignored`.
//
// Copies the inventory-gl-consumer pattern:
// - a business-fact idempotency key (`aj:...`) is looked up first, so a replay
//   is `already_posted` even when the date would now roll forward differently;
//   a per-key advisory lock serializes the consumer and the sweep;
// - the posting runs in a savepoint. An expected accounting failure rolls the
//   savepoint back and parks the event in `auto_journal_parked` (retryable:
//   mapping/account/legal-entity problems and the closed-period race; not
//   retryable: any other AccountingError, which finance must see). The outbox
//   consumption still commits, so cloud-sync is never held back by the GL.
// - a deterministic non-accounting failure (unreadable payload, missing row,
//   unknown tender method, EDC-linked gateway tender) parks as non-retryable
//   AUTO_JOURNAL_PAYLOAD_INVALID (a DP split between booked and pre-cutover
//   receipts: AUTO_JOURNAL_DEPOSIT_CUTOVER_MIXED): it never throws, because
//   the consumer runs inside the cloud-sync delivery transaction (with no outlet to park under:
//   an `accounting.auto_journal.unparkable` audit row). Any other error (database, transient)
//   propagates (outbox retry, dead letter, replayOutbox).
//
// Late adjustment (CTO decision 1): a money fact whose outlet business date
// falls in a closed month posts on the first day of the month after the latest
// closed one, with `late_adjustment_from` = the natural date, a description
// suffix and an `accounting.journal.late_adjusted` audit row.

import { and, asc, eq, inArray, lte, max, or, sql } from "drizzle-orm";
import { z, ZodError } from "zod";
import {
  AccountingError,
  defaultPostingRules,
  periodOf,
  resolveAutoJournalDate,
  resolvePostingRule,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  businessDateOf,
  createUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { isModuleEnabled } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import {
  autoJournalParked,
  fiscalPeriods,
  journalEntries,
  outlets,
  tenants,
} from "../db/schema/index.ts";
import { purchaseReturns } from "../db/schema/purchase-returns.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { applySupplierDebitNoteInTransaction } from "./accounting-ap.service.ts";
import {
  AutoJournalDepositCutoverMixed,
  AutoJournalLoyaltyEntityAmbiguous,
  AutoJournalPayloadInvalid,
  AutoJournalReceiptDeadLettered,
  AutoJournalReceiptMissing,
  AutoJournalReceiptPending,
  AutoJournalRefundSourcePending,
  autoJournalFactOf,
  autoJournalKeyOf,
  invalidEventKeyOf,
  isAutoJournalEvent,
  isLoyaltyAutoJournalEvent,
  loyaltyAnchorOf,
  lockLoyaltyJournalEntity,
  storedEventOf,
  type AutoJournalEventName,
  type StoredAutoJournalEvent,
} from "./accounting-auto-journal-amounts.ts";
import {
  AutoJournalRecoveryRefundPending,
  recoveryRefundFactOf,
} from "./accounting-auto-journal-recovery-refund.ts";
import {
  AutoJournalSaleMissing,
  AutoJournalSalePending,
  AutoJournalVoidUnsupported,
  voidFactOf,
} from "./accounting-auto-journal-void.ts";
import {
  postJournalFromRuleInTransaction,
  reverseJournalInTransaction,
} from "./accounting-journal.service.ts";
import { wouldPostingBeBlockedByClosedPeriod } from "./accounting-period.service.ts";
import { recordAudit } from "./core-audit.ts";
import { isTrainingOrder } from "./device-training.ts";
import type { Tx } from "./inventory-ops.shared.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";

type TenantId = ScopedTenantContext["tenant"]["tenantId"];

const TRAINING_ORDER_EVENTS: ReadonlySet<string> = new Set([
  "order.paid",
  "order.refunded",
  "order.voided",
  "order_issue.charge_paid",
]);

export type AutoJournalResult =
  | { status: "ignored" }
  | { status: "already_posted"; journalEntryId: string }
  | { status: "parked"; code: string; retryable: boolean }
  | {
      status: "posted";
      journalEntryId: string;
      entryDate: string;
      lateAdjustmentFrom: string | null;
    };

/** Expected failures the sweep retries (design section 6). */
const RETRYABLE_CODES = [
  "ACCOUNT_MAPPING_MISSING",
  "ACCOUNT_INACTIVE",
  "ACCOUNT_NOT_POSTABLE",
  "ACCOUNT_ENTITY_MISMATCH",
  "OUTLET_LEGAL_ENTITY_MISSING",
  "PERIOD_CLOSED",
  "AUTO_JOURNAL_RECEIPT_PENDING",
  "AUTO_JOURNAL_SALE_PENDING",
  "AUTO_JOURNAL_RECOVERY_REFUND_PENDING",
  "AUTO_JOURNAL_REFUND_SOURCE_PENDING",
] as const;

const PAYLOAD_INVALID = "AUTO_JOURNAL_PAYLOAD_INVALID";
const DEAD_LETTERED_CODE = "AUTO_JOURNAL_RECEIPT_DEAD_LETTERED";
const REFUND_SOURCE_PENDING_CODE = "AUTO_JOURNAL_REFUND_SOURCE_PENDING";
const DEBIT_NOTE_SHORT_CODE = "AUTO_JOURNAL_DEBIT_NOTE_SHORT";

/**
 * legend-3fi5v: the supplier's payable no longer covers a debit note (a payment
 * landed after the return). Parked, not retryable at the 10 minute pace, but
 * rechecked daily: a new invoice of the same supplier can absorb the credit.
 * The return journal and its settlement post together or not at all.
 */
class AutoJournalDebitNoteShort extends Error {
  readonly code = DEBIT_NOTE_SHORT_CODE;
}

/** The outlet has no legal entity yet: parked until finance assigns one. */
class OutletLegalEntityMissing extends Error {
  readonly code = "OUTLET_LEGAL_ENTITY_MISSING";
}

const RETRY_BATCH = 100;
/** Backoff between retries of one parked event (matches inventory GL). */
export const AUTO_JOURNAL_RETRY_AFTER_MS = 10 * 60 * 1000;
/** legend-3r6r: recheck pace of a row parked RECEIPT_DEAD_LETTERED. */
export const AUTO_JOURNAL_DEAD_LETTER_RECHECK_MS = 24 * 60 * 60 * 1000;
/** legend-3fi5v: recheck pace of a row parked DEBIT_NOTE_SHORT. */
export const AUTO_JOURNAL_DEBIT_NOTE_SHORT_RECHECK_MS = 24 * 60 * 60 * 1000;
const LATE_AUDIT_FIELDS = [
  "journalId",
  "trigger",
  "sourceId",
  "originalDate",
  "entryDate",
] as const;

const UNPARKABLE_AUDIT_FIELDS = ["eventId", "trigger", "code", "key"] as const;

function parkCodeOf(error: unknown): string | null {
  if (error instanceof OutletLegalEntityMissing) return error.code;
  if (error instanceof AccountingError) return error.code;
  if (error instanceof AutoJournalPayloadInvalid) return error.code;
  if (error instanceof AutoJournalDebitNoteShort) return error.code;
  if (error instanceof AutoJournalReceiptPending) return error.code;
  if (error instanceof AutoJournalRefundSourcePending) return error.code;
  if (error instanceof AutoJournalReceiptMissing) return error.code;
  if (error instanceof AutoJournalReceiptDeadLettered) return error.code;
  if (error instanceof AutoJournalSalePending) return error.code;
  if (error instanceof AutoJournalRecoveryRefundPending) return error.code;
  if (error instanceof AutoJournalSaleMissing) return error.code;
  if (error instanceof AutoJournalVoidUnsupported) return error.code;
  if (error instanceof AutoJournalDepositCutoverMixed) return error.code;
  if (error instanceof AutoJournalLoyaltyEntityAmbiguous) return error.code;
  if (error instanceof ZodError) return PAYLOAD_INVALID;
  return null;
}

const outletIdSchema = z.string().uuid();

/** First candidate that is an outlet of the tenant (the parked row's owner). */
async function parkOutletOf(
  tx: Tx,
  tenantId: TenantId,
  candidates: readonly unknown[],
): Promise<string | null> {
  for (const candidate of candidates) {
    const parsed = outletIdSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const [row] = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, parsed.data)));
    if (row) return row.id;
  }
  return null;
}

/**
 * Parks (or re-parks) one event under its key. The outlet is checked first:
 * a malformed envelope must not turn into a foreign-key error that rolls back
 * the caller. With no outlet to own the row (malformed envelope, outlet of
 * another tenant) it still never throws: a throw would roll back the whole
 * cloud-sync delivery (QR order, POS settlement, reservation) on every retry
 * and dead-letter its aggregate. It writes a tenant-wide
 * `accounting.auto_journal.unparkable` audit row instead, so finance sees the
 * lost fact, and lets the delivery commit.
 */
async function park(
  tx: Tx,
  context: ScopedTenantContext,
  row: {
    key: string;
    outletCandidates: readonly unknown[];
    eventId: string;
    eventName: string;
    payload: Record<string, unknown>;
    code: string;
  },
  now: Date,
): Promise<AutoJournalResult> {
  const tenantId = context.tenant.tenantId;
  const { code } = row;
  const retryable = (RETRYABLE_CODES as readonly string[]).includes(code);
  const outletId = await parkOutletOf(tx, tenantId, row.outletCandidates);
  if (outletId === null) {
    console.error(
      `Auto-journal ${row.eventName} ${row.eventId} not parked (${code}): no outlet`,
    );
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: null,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "accounting.auto_journal.unparkable",
        objectType: "domain_event",
        objectId: null,
        reason: null,
        maskedChanges: {
          before: null,
          after: {
            eventId: row.eventId,
            trigger: row.eventName,
            code,
            key: row.key,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      UNPARKABLE_AUDIT_FIELDS,
    );
    // No row written, so nothing for the sweep to retry.
    return { status: "parked", code, retryable: false };
  }
  // legend-3r6r: the sale stopped retrying; make the stuck row loud.
  if (code === DEAD_LETTERED_CODE || code === REFUND_SOURCE_PENDING_CODE) {
    const [already] = await tx
      .select({ code: autoJournalParked.errorCode })
      .from(autoJournalParked)
      .where(
        and(
          eq(autoJournalParked.tenantId, tenantId),
          eq(autoJournalParked.idempotencyKey, row.key),
        ),
      )
      .limit(1);
    if (already?.code !== code)
      console.error(
        code === DEAD_LETTERED_CODE
          ? `Auto-journal ${row.eventName} ${row.eventId} parked ${code}: replay the dead-lettered payment.paid`
          : `Auto-journal ${row.eventName} ${row.eventId} parked ${code}: refund has no provable gateway source; operator review needed`,
      );
  }
  // A dead-lettered row is not retried at the 10 minute pace, but a daily
  // safety net re-checks it (a release can be missed, or the replayed receipt
  // may never post and the sale must then book the plain way).
  const nextRetryAt = retryable
    ? new Date(now.getTime() + AUTO_JOURNAL_RETRY_AFTER_MS)
    : code === DEAD_LETTERED_CODE
      ? new Date(now.getTime() + AUTO_JOURNAL_DEAD_LETTER_RECHECK_MS)
      : code === DEBIT_NOTE_SHORT_CODE
        ? new Date(now.getTime() + AUTO_JOURNAL_DEBIT_NOTE_SHORT_RECHECK_MS)
        : null;
  await tx
    .insert(autoJournalParked)
    .values({
      tenantId,
      outletId,
      idempotencyKey: row.key,
      eventId: row.eventId,
      eventName: row.eventName,
      payload: row.payload,
      errorCode: code,
      retryable,
      firstFailedAt: now,
      lastFailedAt: now,
      nextRetryAt,
    })
    .onConflictDoUpdate({
      target: [autoJournalParked.tenantId, autoJournalParked.idempotencyKey],
      set: {
        errorCode: code,
        retryable,
        attempts: sql`${autoJournalParked.attempts} + 1`,
        lastFailedAt: now,
        nextRetryAt,
      },
    });
  return { status: "parked", code, retryable };
}

async function accountingEnabled(
  tx: Tx,
  context: ScopedTenantContext,
): Promise<boolean> {
  const [row] = await tx
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, context.tenant.tenantId))
    .limit(1);
  return isModuleEnabled(row?.featureFlags ?? null, "accounting");
}

export async function deliverAutoJournalEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now = new Date(),
): Promise<AutoJournalResult> {
  if (!isAutoJournalEvent(event.name)) return { status: "ignored" };
  if (event.tenantId !== context.tenant.tenantId) return { status: "ignored" };
  if (!(await accountingEnabled(tx, context))) return { status: "ignored" };
  if (isLoyaltyAutoJournalEvent(event.name))
    await lockLoyaltyJournalEntity(tx, context.tenant.tenantId);
  // legend-msqvi: a points event has no outlet; it is stored, dated and
  // parked under the tenant's loyalty anchor outlet (D-msqvi section 7).
  const loyaltyOutletId = isLoyaltyAutoJournalEvent(event.name)
    ? ((await loyaltyAnchorOf(tx, context.tenant.tenantId))?.outletId ?? null)
    : null;
  let stored: StoredAutoJournalEvent;
  try {
    stored = storedEventOf({
      id: event.id,
      name: event.name,
      outletId: event.outletId,
      occurredAt: event.occurredAt,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
      loyaltyOutletId,
    });
  } catch (error) {
    if (parkCodeOf(error) !== PAYLOAD_INVALID) throw error;
    // No business key without a readable payload: parked per event, with
    // nothing but the time stored (the raw payload may hold personal data).
    const raw = event.payload as { outletId?: unknown } | null;
    return park(
      tx,
      context,
      {
        key: invalidEventKeyOf(event.id),
        outletCandidates: [event.outletId, raw?.outletId, loyaltyOutletId],
        eventId: event.id,
        eventName: event.name,
        payload: { occurredAt: event.occurredAt },
        code: PAYLOAD_INVALID,
      },
      now,
    );
  }
  return settleAutoJournal(tx, context, stored, now);
}

async function settleAutoJournal(
  tx: Tx,
  context: ScopedTenantContext,
  stored: StoredAutoJournalEvent,
  now: Date,
): Promise<AutoJournalResult> {
  const tenantId = context.tenant.tenantId;
  if (isLoyaltyAutoJournalEvent(stored.eventName))
    await lockLoyaltyJournalEntity(tx, tenantId);
  const key = autoJournalKeyOf(stored);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`aj:${tenantId}:${key}`}, 0))`,
  );
  const [existing] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.idempotencyKey, key),
      ),
    )
    .limit(1);
  if (existing) {
    await clearParked(tx, tenantId, key);
    await requeueSaleDependents(tx, tenantId, stored, now);
    await requeueReceiptDependents(tx, tenantId, stored, now);
    return { status: "already_posted", journalEntryId: existing.id };
  }
  let result: AutoJournalResult;
  try {
    result = await tx.transaction((savepoint) =>
      postAutoJournal(savepoint, context, stored, key, now),
    );
  } catch (error) {
    const code = parkCodeOf(error);
    if (!code) throw error;
    const parked = await park(
      tx,
      context,
      {
        key,
        outletCandidates: [stored.outletId],
        eventId: stored.eventId,
        eventName: stored.eventName,
        payload: { ...stored.payload, occurredAt: stored.occurredAt },
        code,
      },
      now,
    );
    // A replayed payment.paid that parks (it may never post) also wakes the
    // sales waiting on its dead letter: they decide again on the new state.
    await requeueReceiptDependents(tx, tenantId, stored, now);
    return parked;
  }
  // Posted, or nothing to book any more: either way no longer parked.
  await clearParked(tx, tenantId, key);
  if (result.status === "posted") {
    await requeueSaleDependents(tx, tenantId, stored, now);
    await requeueReceiptDependents(tx, tenantId, stored, now);
  }
  return result;
}

/**
 * legend-3bsyh: a void or refund of order X parks non-retryable
 * `AUTO_JOURNAL_SALE_MISSING` while the sale journal of X is not posted, and
 * the sweep never looks at such a row. Once `aj:sale:X` is posted (here, or
 * replayed over a sale finance posted by hand), those rows become retryable
 * and due now, so the next sweep books them. Tenant-scoped; the orderId is read
 * from the stored payload, the same value the sale key is built from.
 */
async function requeueSaleDependents(
  tx: Tx,
  tenantId: TenantId,
  stored: StoredAutoJournalEvent,
  now: Date,
): Promise<void> {
  if (stored.eventName !== "order.paid") return;
  await tx
    .update(autoJournalParked)
    .set({ retryable: true, nextRetryAt: now })
    .where(
      and(
        eq(autoJournalParked.tenantId, tenantId),
        eq(autoJournalParked.errorCode, "AUTO_JOURNAL_SALE_MISSING"),
        inArray(autoJournalParked.eventName, [
          "order.voided",
          "order.refunded",
          "order_issue.charge_paid",
        ]),
        sql`${autoJournalParked.payload}->>'orderId' = ${String(stored.payload.orderId)}`,
      ),
    );
}

/**
 * legend-3r6r: a row parked non-retryable `AUTO_JOURNAL_RECEIPT_DEAD_LETTERED`
 * waits for its payment.paid, which an operator may replay. Once any
 * payment.paid of the outlet posts, those rows become retryable and due now;
 * a row whose receipt is still dead re-parks (the guard decides again), so
 * the release can neither book twice nor loop. Tenant and outlet scoped.
 */
async function requeueReceiptDependents(
  tx: Tx,
  tenantId: TenantId,
  stored: StoredAutoJournalEvent,
  now: Date,
): Promise<void> {
  if (stored.eventName !== "payment.paid") return;
  await tx
    .update(autoJournalParked)
    .set({ retryable: true, nextRetryAt: now })
    .where(
      and(
        eq(autoJournalParked.tenantId, tenantId),
        eq(autoJournalParked.outletId, stored.outletId),
        eq(autoJournalParked.errorCode, DEAD_LETTERED_CODE),
        eq(autoJournalParked.retryable, false),
      ),
    );
}

async function clearParked(
  tx: Tx,
  tenantId: TenantId,
  key: string,
): Promise<void> {
  await tx
    .delete(autoJournalParked)
    .where(
      and(
        eq(autoJournalParked.tenantId, tenantId),
        eq(autoJournalParked.idempotencyKey, key),
      ),
    );
}

/** Latest closed month of the entity, or null (read under the entity lock). */
async function latestClosedPeriod(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ period: max(fiscalPeriods.period) })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        eq(fiscalPeriods.legalEntityId, legalEntityId),
        eq(fiscalPeriods.status, "closed"),
      ),
    );
  return row?.period ?? null;
}

/** The `aj:sale:<orderId>` journal of the order of a void or refund exists. */
async function saleJournalPosted(
  tx: Tx,
  tenantId: TenantId,
  stored: StoredAutoJournalEvent,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(
          journalEntries.idempotencyKey,
          autoJournalKeyOf({ ...stored, eventName: "order.paid" }),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function postAutoJournal(
  tx: Tx,
  context: ScopedTenantContext,
  stored: StoredAutoJournalEvent,
  key: string,
  now: Date,
): Promise<AutoJournalResult> {
  const tenantId = context.tenant.tenantId;
  // legend-gkc6b: a training order never reaches the books. One check here
  // covers every producer (POS, QR, delivery) and the sweep, and keeps the
  // void/refund of a training sale from parking as SALE_MISSING. A void or
  // refund still reverses a sale journal that was posted before this rule
  // existed: those books are not left half reversed.
  if (
    TRAINING_ORDER_EVENTS.has(stored.eventName) &&
    (await isTrainingOrder(tx, tenantId, String(stored.payload.orderId))) &&
    !(
      stored.eventName !== "order.paid" &&
      (await saleJournalPosted(tx, tenantId, stored))
    )
  )
    return { status: "ignored" };
  // order.voided reverses the sale journal; every other event posts a rule.
  const isVoid = stored.eventName === "order.voided";
  const voidFact = isVoid ? await voidFactOf(tx, tenantId, stored) : null;
  // legend-94q2l: a rejected recovery refund reverses the refund journal.
  const isRefundReversal =
    stored.eventName === "order_issue.refund_reversal_requested";
  const refundReversalFact = isRefundReversal
    ? await recoveryRefundFactOf(tx, tenantId, stored)
    : null;
  const fact =
    isVoid || isRefundReversal
      ? null
      : await autoJournalFactOf(tx, tenantId, stored);
  const target = voidFact ?? refundReversalFact ?? fact;
  if (!target) return { status: "ignored" };
  const [outlet] = await tx
    .select({
      legalEntityId: outlets.legalEntityId,
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(
      and(eq(outlets.tenantId, tenantId), eq(outlets.id, target.outletId)),
    );
  if (!outlet)
    throw new AutoJournalPayloadInvalid(
      "Outlet of the auto-journal event not found",
    );
  if (!outlet.legalEntityId) throw new OutletLegalEntityMissing();
  const legalEntityId = outlet.legalEntityId;

  // A date fact (bank settlement date) is used as is; an instant becomes the
  // outlet business date.
  const naturalDate =
    (fact?.entryDate as ReturnType<typeof businessDateOf> | undefined) ??
    businessDateOf(target.moneyTime, outletBusinessDayClock(outlet));
  // Takes the entity FOR SHARE lock: close/reopen cannot race this post.
  const blocked = await wouldPostingBeBlockedByClosedPeriod(
    tx,
    tenantId,
    legalEntityId,
    periodOf(naturalDate),
  );
  const { entryDate, lateAdjustmentFrom } = resolveAutoJournalDate(
    naturalDate,
    blocked ? await latestClosedPeriod(tx, tenantId, legalEntityId) : null,
  );
  const lateSuffix =
    lateAdjustmentFrom === null
      ? ""
      : ` (penyesuaian terlambat dari ${lateAdjustmentFrom})`;
  let journal: { id: string };
  if (voidFact) {
    journal = await reverseJournalInTransaction(
      tx,
      context,
      voidFact.saleEntryId,
      {
        entryDate: entryDate as typeof naturalDate,
        reason: `Void penjualan ${voidFact.sourceId}${lateSuffix}`,
        idempotencyKey: key,
        lateAdjustmentFrom,
        postedBy: null,
      },
      now,
    );
  } else if (refundReversalFact) {
    journal = await reverseJournalInTransaction(
      tx,
      context,
      refundReversalFact.refundEntryId,
      {
        entryDate: entryDate as typeof naturalDate,
        reason: `Refund item gagal ditolak ${refundReversalFact.sourceId}${lateSuffix}`,
        idempotencyKey: key,
        lateAdjustmentFrom,
        postedBy: null,
      },
      now,
    );
  } else if (fact) {
    const rule = resolvePostingRule(defaultPostingRules, {
      eventName: fact.ruleEvent,
      ...(fact.variant ? { variant: fact.variant } : {}),
    });
    journal = await postJournalFromRuleInTransaction(
      tx,
      context,
      {
        eventName: fact.ruleEvent,
        ...(fact.variant ? { variant: fact.variant } : {}),
        amounts: fact.amounts,
        accountOverrides: fact.accountOverrides,
        legalEntityId,
        // legend-msqvi: a loyalty journal names its own outlet (or none).
        outletId:
          fact.journalOutletId === undefined
            ? fact.outletId
            : fact.journalOutletId,
        entryDate: entryDate as typeof naturalDate,
        sourceId: fact.sourceId,
        orderId: fact.orderId ?? null,
        description: `${rule.description}${lateSuffix}`,
        postedBy: null,
        idempotencyKey: key,
        lateAdjustmentFrom,
      },
      now,
    );
    // A return with an invoiced part is a debit note: the supplier's open
    // items fall in this same savepoint, so the card and the ledger move
    // together or not at all. A replay never gets here (the journal key above
    // returns `already_posted` first).
    if (fact.debitNote) {
      const [purchaseReturn] = await tx
        .select({
          purchaseOrderId: purchaseReturns.purchaseOrderId,
          supplierId: purchaseReturns.supplierId,
        })
        .from(purchaseReturns)
        .where(
          and(
            eq(purchaseReturns.tenantId, tenantId),
            eq(purchaseReturns.id, fact.debitNote.purchaseReturnId),
          ),
        )
        .limit(1);
      // Events from before the payload carried the supplier: read it from the
      // return row; park only when neither knows the supplier.
      const supplierId =
        purchaseReturn?.supplierId ?? fact.debitNote.supplierId;
      if (!supplierId)
        throw new AutoJournalPayloadInvalid(
          "purchase_return with an invoiced value has no supplier for its debit note",
        );
      try {
        await applySupplierDebitNoteInTransaction(
          tx,
          context,
          {
            purchaseReturnId: fact.debitNote.purchaseReturnId,
            amountIdr: fact.debitNote.amountIdr,
            supplierId,
            legalEntityId,
            purchaseOrderId: purchaseReturn?.purchaseOrderId ?? null,
            settledOn: entryDate,
            journalEntryId: journal.id,
          },
          null,
        );
      } catch (error) {
        if (
          error instanceof HttpError &&
          error.code === "PURCHASE_RETURN_EXCEEDS_PAYABLE"
        )
          throw new AutoJournalDebitNoteShort(error.message);
        throw error;
      }
    }
  } else return { status: "ignored" };
  if (lateAdjustmentFrom !== null)
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: target.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "accounting.journal.late_adjusted",
        objectType: "journal_entry",
        objectId: journal.id,
        reason: null,
        maskedChanges: {
          before: null,
          after: {
            journalId: journal.id,
            trigger: stored.eventName,
            sourceId: target.sourceId,
            originalDate: lateAdjustmentFrom,
            entryDate,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      LATE_AUDIT_FIELDS,
    );
  return {
    status: "posted",
    journalEntryId: journal.id,
    entryDate,
    lateAdjustmentFrom,
  };
}

/**
 * Worker sweep: retry the due retryable parked events of one tenant (bounded
 * batch, oldest first). Each event runs in its own transaction and is rebuilt
 * from the stored payload, with the date recomputed. Non-retryable rows
 * (`next_retry_at` null) stay for finance.
 */
export async function retryParkedAutoJournals(
  context: ScopedTenantContext,
  now = new Date(),
): Promise<{ posted: number; stillParked: number; failed: number }> {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new Error("Auto-journal retry requires tenant-wide scope");
  const tenantId = context.tenant.tenantId;
  const due = await withTenant(db, context, async (tx) => {
    if (!(await accountingEnabled(tx, context))) return [];
    return tx
      .select()
      .from(autoJournalParked)
      .where(
        and(
          eq(autoJournalParked.tenantId, tenantId),
          or(
            eq(autoJournalParked.retryable, true),
            eq(autoJournalParked.errorCode, DEAD_LETTERED_CODE),
            eq(autoJournalParked.errorCode, DEBIT_NOTE_SHORT_CODE),
          ),
          lte(autoJournalParked.nextRetryAt, now),
        ),
      )
      .orderBy(
        asc(autoJournalParked.firstFailedAt),
        asc(autoJournalParked.idempotencyKey),
      )
      .limit(RETRY_BATCH);
  });
  let posted = 0;
  let stillParked = 0;
  let failed = 0;
  for (const row of due) {
    const { occurredAt, ...payload } = row.payload;
    const stored: StoredAutoJournalEvent = {
      eventId: row.eventId,
      eventName: row.eventName as AutoJournalEventName,
      outletId: row.outletId,
      occurredAt: String(occurredAt),
      payload,
    };
    try {
      const result = await withTenant(db, context, (tx) =>
        settleAutoJournal(tx, context, stored, now),
      );
      if (result.status === "parked") stillParked += 1;
      else posted += 1;
    } catch (error) {
      failed += 1;
      // Keep the backoff so a row that keeps failing neither retries every
      // tick nor starves newer parked events.
      console.error(
        `Auto-journal retry failed for ${row.eventName}: ${error instanceof Error ? error.name : "unknown"}`,
      );
      await withTenant(db, context, (tx) =>
        tx
          .update(autoJournalParked)
          .set({
            attempts: sql`${autoJournalParked.attempts} + 1`,
            lastFailedAt: now,
            nextRetryAt: new Date(now.getTime() + AUTO_JOURNAL_RETRY_AFTER_MS),
          })
          .where(
            and(
              eq(autoJournalParked.tenantId, tenantId),
              eq(autoJournalParked.idempotencyKey, row.idempotencyKey),
            ),
          ),
      ).catch(() => undefined);
    }
  }
  return { posted, stillParked, failed };
}
