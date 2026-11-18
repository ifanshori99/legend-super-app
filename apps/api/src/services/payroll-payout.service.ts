// Payroll disbursement batches (bead legend-wnkep.1; founder Q15-Q17; design
// docs/design/payroll-disbursement.md sections 4-7). Money area: nobody is paid
// twice, nobody is paid more than net pay, no item is lost. When a rule is
// unclear this file picks the one that limits payment.
//
// Trusted in-transaction writers: the caller wraps `withTenant`, a throw rolls
// back everything. Lock order everywhere: payroll run row, then the batch row,
// then items, then the batch advisory lock of the GL (`loadBatchRunFirst` does
// this for a batch that already exists). The run row is also the parent lock of
// a freeze (920): once the run and batch rows are held, `assertBatchOpenUnderRunLock`
// re-reads the freeze state, because a dispute committed while this step waited
// for the lock is visible only to a statement that starts after it.
// The database is the net (partial unique indexes, CHECKs and the guard
// triggers of migration 0344); these functions choose the happy path and give
// every refusal a readable code.
//
// Flow: create (draft) -> submit by the requester (pending_approval, content
// hash stored, blocked items cancelled) -> approve by a DIFFERENT person who
// saw the same hash (approved, valid 24h) -> export or cash handover
// (payroll-payout-manual.service.ts). Cancel is possible until a file left.
//
// Net pay is the amount, always in full. The bank fee is paid by the company
// (Q15): it is stored per item (sealed) and never subtracted from the amount.
// Only `manual_bank` and `cash` batches exist in this slice; `duitku` is
// refused 409 PAYOUT_CHANNEL_NOT_AVAILABLE.

import { createHash, randomUUID } from "node:crypto";
import type { ErrorRequestHandler } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { maskAccountNumber } from "@starter/shared/accounting";
import {
  createUlid,
  idr,
  type Idr,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  payslipCalculationSchema,
  type PayrollRunId,
  type PayslipId,
} from "@starter/shared/hris/payroll";
import type {
  PayoutBatchFreezeDto,
  PayrollDisbursementBatchDto,
  PayrollDisbursementItemDto,
} from "@starter/shared/types";
import {
  payrollDisbursementBatches,
  payrollDisbursementItems,
  payrollPayoutConfigs,
  PAYOUT_LIVE_ITEM_STATUSES,
  type PayoutChannel,
  type PayoutItemStatus,
} from "../db/schema/payroll-payout.ts";
import {
  bankTransferFiles,
  payrollRuns,
  payslipBankSnapshots,
  payslips,
} from "../db/schema/payroll.ts";
import { HttpError } from "../lib/http-error.ts";
import { getBankFormatter } from "../lib/payroll-export/bank-formats.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  openPayrollAmount,
  openPayrollValue,
  sealPayrollAmount,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { entityLock } from "./accounting-bank-matching.ts";
import { availableCash1102 } from "./accounting-petty-cash.service.ts";
import { recordAudit } from "./core-audit.ts";
import type { Tx } from "./hris-access.ts";
import { openPayeeBankSnapshot } from "./payroll-bank-snapshot.service.ts";
import type {
  PayoutGrantBinding,
  PayoutGrantIssuer,
} from "./payroll-payout-grant.service.ts";
import {
  accountingEnabled,
  assertManualPayoutSetup,
  configuredSourceBankAccountId,
} from "./payroll-payout-setup.ts";

/**
 * The verified caller. `sessionId` is the Better Auth session of the request.
 * `grants` mints the one-time step grant (migration 0419+) that every trusted
 * payout function consumes; it exists only after the request's step-up. The
 * functions read the actor and the session from the grant, never from the app.
 */
export type PayoutActor = {
  tenantId: string;
  userId: string;
  sessionId?: string;
  /** Required by the trusted paths (see `payoutTrustedGrant`). */
  readonly grants?: PayoutGrantIssuer;
};
export type BatchRow = typeof payrollDisbursementBatches.$inferSelect;
export type ItemRow = typeof payrollDisbursementItems.$inferSelect;

/** An approval is valid this long; export or handover after it is refused. */
export const PAYOUT_APPROVAL_TTL_HOURS = 24;

/** The BI code of BCA: the only bank the `bca` file format can pay. */
const BCA_BANK_CODE = "014";

/** Last attempt states that free a payslip for a new batch (R7). */
const RETRYABLE_ITEM_STATUSES: readonly PayoutItemStatus[] = [
  "failed",
  "not_sent",
  "returned",
  "cancelled",
];
const FINAL_BATCH_STATUSES = [
  "completed",
  "partially_failed",
  "cancelled",
] as const;

// ------------------------------------------------------------ small helpers

const UUID_FORMAT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const payoutRefuse = (
  status: number,
  code: string,
  message: string,
): HttpError => new HttpError(status, code, message);

/**
 * The one-time grant the trusted payout functions need, bound to exactly the
 * values the caller passes to SQL. Refused before any SQL runs when the caller
 * has no issuer (system actors have no session or step-up).
 */
export async function payoutTrustedGrant(
  actor: PayoutActor,
  binding: PayoutGrantBinding,
): Promise<string> {
  if (!actor.grants)
    throw payoutRefuse(
      401,
      "PAYOUT_SESSION_REQUIRED",
      "Sesi login diperlukan untuk aksi ini.",
    );
  return actor.grants.issue(binding);
}

/** A UUID in its canonical text form (used before ids reach a grant or SQL). */
export const isPayoutUuid = (value: string): boolean => UUID_FORMAT.test(value);

/**
 * A step moved between the grant (issued before the batch lock, so the grantor
 * connection cannot wait on our own `FOR UPDATE`) and the locked re-read:
 * refused, nothing written, the caller retries (fail closed).
 */
export const payoutStateChanged = (): HttpError =>
  payoutRefuse(
    409,
    "PAYOUT_BATCH_STATE_CHANGED",
    "Status item berubah saat diproses. Coba lagi.",
  );

/**
 * The trusted propose functions refuse to replace the proof of an open
 * proposal (legend-911 P1-2). Matches that database error, also behind a
 * driver wrapper, so a race past the service pre-check answers 409, not 5xx.
 */
export function isProposalReplaceViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { message?: unknown; cause?: unknown };
  return (
    (typeof candidate.message === "string" &&
      /PAYOUT-73:/.test(candidate.message)) ||
    isProposalReplaceViolation(candidate.cause, depth + 1)
  );
}

/** Postgres check_violation (23514), also behind a driver wrapper. */
function checkViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23514" || checkViolation(candidate.cause, depth + 1)
  );
}

/** SQLSTATE of the error, also behind a driver wrapper. */
function sqlStateOf(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown; cause?: unknown };
  return typeof candidate.code === "string"
    ? candidate.code
    : sqlStateOf(candidate.cause, depth + 1);
}

function messageHas(error: unknown, pattern: RegExp, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { message?: unknown; cause?: unknown };
  return (
    (typeof candidate.message === "string" &&
      pattern.test(candidate.message)) ||
    messageHas(candidate.cause, pattern, depth + 1)
  );
}

/** A frozen batch refuses every payout step until it is unfrozen. */
const batchFrozen = (): HttpError =>
  payoutRefuse(
    409,
    "PAYOUT_BATCH_FROZEN",
    'Batch pembayaran ini dibekukan karena ada pengakuan "bukan saya". Finance perlu memeriksanya dan membuka pembekuan.',
  );

/**
 * A payout guard or deferred commit check (trigger or trusted function, code
 * 23514) refused the change: the client sees a 409, never the raw database
 * error. Returns null for every other error. The database text is not echoed.
 */
export function payoutGuardViolation(error: unknown): HttpError | null {
  // PAYOUT-70 (42501): the step grant is invalid, spent or expired.
  if (sqlStateOf(error) === "42501" && messageHas(error, /PAYOUT-70:/))
    return payoutRefuse(
      409,
      "PAYOUT_STEP_GRANT_INVALID",
      "Izin langkah pembayaran kedaluwarsa. Coba lagi.",
    );
  // PAYOUT-84 (42501): the disowner of a batch main approval approves again.
  if (sqlStateOf(error) === "42501" && messageHas(error, /PAYOUT-84:/))
    return payoutRefuse(
      403,
      "PAYOUT_DISOWNER_REFUSED",
      'Anda sudah menyatakan "bukan saya" pada persetujuan batch ini, jadi tidak boleh menyetujuinya lagi.',
    );
  // PAYOUT-6x (42501), e.g. PAYOUT-64: a separation-of-duties or step order
  // refusal (same person twice, requester, first step not attested).
  if (sqlStateOf(error) === "42501" && messageHas(error, /PAYOUT-6\d:/))
    return payoutRefuse(
      409,
      "PAYOUT_GUARD_REFUSED",
      "Perubahan ditolak oleh aturan pembayaran. Muat ulang dan coba lagi.",
    );
  // PAYOUT-69 / PAYOUT-77 (P0002): the batch, item or claim is gone.
  if (sqlStateOf(error) === "P0002" && messageHas(error, /PAYOUT-(69|77):/))
    return payoutRefuse(
      409,
      "PAYOUT_BATCH_STATE_CHANGED",
      "Data pembayaran berubah atau tidak ditemukan. Muat ulang dan coba lagi.",
    );
  // PAYOUT-79 (23514): the batch has an open "not me" dispute (legend-l2zru).
  if (checkViolation(error) && messageHas(error, /PAYOUT-79:/))
    return batchFrozen();
  // PAYOUT-88 (23514): a return without a usable bank transaction reference.
  if (checkViolation(error) && messageHas(error, /PAYOUT-88:/))
    return payoutRefuse(
      422,
      "PAYOUT_RETURN_BANK_REF_REQUIRED",
      "Nomor referensi transaksi bank wajib diisi (4-64 karakter).",
    );
  // PAYOUT-89 (23514): the second step names another bank reference.
  if (checkViolation(error) && messageHas(error, /PAYOUT-89:/))
    return payoutRefuse(
      409,
      "PAYOUT_RETURN_BANK_REF_MISMATCH",
      "Nomor referensi bank berbeda dari catatan orang pertama.",
    );
  if (!checkViolation(error)) return null;
  return payoutRefuse(
    409,
    "PAYOUT_GUARD_REFUSED",
    "Perubahan ditolak oleh aturan pembayaran. Muat ulang dan coba lagi.",
  );
}

/**
 * Router-level error middleware: mount last on each payout router so a 23514
 * raised inside a handler or at COMMIT (deferred checks) answers 409.
 */
export const payoutGuardErrorMapper: ErrorRequestHandler = (
  error,
  _req,
  _res,
  next,
) => next(payoutGuardViolation(error) ?? error);

const asTenant = (tenantId: string) => tenantId as TenantId;
const asUser = (userId: string) => userId as UserId;

export function payoutScope(tenantId: string) {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: asTenant(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

const PAYOUT_AUDIT_SAFE_FIELDS = [
  "status",
  "channel",
  "itemCount",
  "runId",
  "by",
  "contentHash",
  "checksum",
  "confirmed",
  "failed",
  "outcome",
  "resolved",
  "evidenceKey",
  "method",
  "enabled",
  "bankFormat",
  "postingId",
  "sourceGlId",
  "kind",
  "settleNetIdr",
] as const;

/**
 * Audit row of a payout step. Values are ids, statuses and counts only: no
 * names or account numbers; the one amount kept is the net of a waived posting
 * (`settleNetIdr`, legend-5qqb9). The masker redacts anything else.
 */
export async function recordPayoutAudit(
  tx: Tx,
  actor: PayoutActor,
  input: {
    action: string;
    objectType: string;
    objectId: string;
    reason?: string | null;
    before: Record<string, string | number | null>;
    after: Record<string, string | number | null>;
  },
): Promise<void> {
  const now = new Date();
  // The audit schema wants a UUID actor; the user id is also kept in `by`.
  const actorId = UUID_FORMAT.test(actor.userId) ? actor.userId : null;
  await recordAudit(
    tx,
    payoutScope(actor.tenantId),
    {
      id: createUlid(now.getTime()),
      tenantId: asTenant(actor.tenantId),
      outletId: null,
      actorType: actorId ? "user" : "system",
      actorId,
      deviceId: null,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      reason: input.reason ?? null,
      maskedChanges: {
        before: input.before,
        after: { ...input.after, by: actor.userId },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    PAYOUT_AUDIT_SAFE_FIELDS,
  );
}

// ------------------------------------------------------------ sealed values

const itemBinding = (
  tenantId: string,
  itemId: string,
  field: "amount" | "fee",
) =>
  ({
    tenantId,
    table: "payroll_disbursement_items",
    rowId: itemId,
    field,
  }) as const;

const batchTotalsBinding = (tenantId: string, batchId: string) =>
  ({
    tenantId,
    table: "payroll_disbursement_batches",
    rowId: batchId,
    field: "totals",
  }) as const;

/** Net pay of one item, whole rupiah, sealed to this item row. */
export function sealItemAmount(
  tenantId: string,
  itemId: string,
  amountIdr: number,
): Buffer {
  return sealPayrollAmount(
    idr(amountIdr),
    itemBinding(tenantId, itemId, "amount"),
  );
}

/** Opens the sealed net pay of an item (throws on tamper or wrong row). */
export function openItemAmount(
  row: Pick<ItemRow, "id" | "tenantId" | "amountEncrypted" | "piiKeyVersion">,
): Idr {
  return openPayrollAmount(
    row.amountEncrypted,
    itemBinding(row.tenantId, row.id, "amount"),
    row.piiKeyVersion,
  );
}

export function sealItemFee(
  tenantId: string,
  itemId: string,
  feeIdr: number,
): Buffer {
  return sealPayrollAmount(idr(feeIdr), itemBinding(tenantId, itemId, "fee"));
}

export function openItemFee(
  row: Pick<ItemRow, "id" | "tenantId" | "feeIdrEncrypted" | "piiKeyVersion">,
): Idr {
  return openPayrollAmount(
    row.feeIdrEncrypted,
    itemBinding(row.tenantId, row.id, "fee"),
    row.piiKeyVersion,
  );
}

type BatchTotals = { totalIdr: number; totalFeeIdr: number; itemCount: number };

function sealBatchTotals(
  tenantId: string,
  batchId: string,
  totals: BatchTotals,
): Buffer {
  return sealPayrollValue(
    JSON.stringify(totals),
    batchTotalsBinding(tenantId, batchId),
    PAYROLL_SEAL_KEY_VERSION,
  );
}

export function openBatchTotals(
  row: Pick<BatchRow, "id" | "tenantId" | "totalsEncrypted" | "piiKeyVersion">,
): BatchTotals {
  const parsed: unknown = JSON.parse(
    openPayrollValue(
      row.totalsEncrypted,
      batchTotalsBinding(row.tenantId, row.id),
      row.piiKeyVersion,
    ),
  );
  const value = parsed as Partial<BatchTotals>;
  if (
    !Number.isSafeInteger(value.totalIdr) ||
    !Number.isSafeInteger(value.totalFeeIdr) ||
    !Number.isSafeInteger(value.itemCount)
  )
    throw new Error("Sealed batch totals are malformed");
  return value as BatchTotals;
}

// ------------------------------------------------------------- content hash

export type HashItem = {
  payslipId: string;
  amountIdr: number;
  bankSnapshotId: string | null;
  bankCode: string | null;
};

/**
 * SHA-256 of the ordered items of one batch: payslip, net amount, the frozen
 * bank snapshot (its id stands for the account, which is never copied) and the
 * bank code. The approver stores the hash they saw; export recomputes it, so
 * an item changed after approval stops the file (R5).
 */
export function computeBatchContentHash(items: readonly HashItem[]): string {
  const lines = [...items]
    .sort((a, b) =>
      a.payslipId < b.payslipId ? -1 : a.payslipId > b.payslipId ? 1 : 0,
    )
    .map((item) =>
      [
        item.payslipId,
        String(item.amountIdr),
        item.bankSnapshotId ?? "",
        item.bankCode ?? "",
      ].join("|"),
    );
  return createHash("sha256")
    .update(`payout-batch-v1\n${lines.join("\n")}`)
    .digest("hex");
}

/** Hash over the batch items that are in one of `statuses` right now. */
export async function batchContentHash(
  tx: Tx,
  batch: Pick<BatchRow, "id" | "tenantId">,
  statuses: readonly PayoutItemStatus[],
): Promise<string> {
  const rows = await tx
    .select()
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, batch.tenantId),
        eq(payrollDisbursementItems.batchId, batch.id),
        inArray(payrollDisbursementItems.status, [...statuses]),
      ),
    );
  return computeBatchContentHash(
    rows.map((row) => ({
      payslipId: row.payslipId,
      amountIdr: openItemAmount(row),
      bankSnapshotId: row.bankSnapshotId,
      bankCode: row.bankCode,
    })),
  );
}

// --------------------------------------------------------------- row loaders

const batchNotFound = () =>
  payoutRefuse(
    404,
    "PAYOUT_BATCH_NOT_FOUND",
    "Batch pembayaran tidak ditemukan.",
  );

/** Reads a batch row without a lock (to find its run before the lock order). */
export async function readBatch(
  tx: Tx,
  tenantId: string,
  batchId: string,
): Promise<BatchRow> {
  if (!UUID_FORMAT.test(batchId)) throw batchNotFound();
  const [row] = await tx
    .select()
    .from(payrollDisbursementBatches)
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, asTenant(tenantId)),
        eq(payrollDisbursementBatches.id, batchId),
      ),
    );
  if (!row) throw batchNotFound();
  return row;
}

/** Reads a batch row and locks it (`FOR UPDATE`) for the rest of the transaction. */
export async function loadBatchForUpdate(
  tx: Tx,
  tenantId: string,
  batchId: string,
): Promise<BatchRow> {
  if (!UUID_FORMAT.test(batchId)) throw batchNotFound();
  const [row] = await tx
    .select()
    .from(payrollDisbursementBatches)
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, asTenant(tenantId)),
        eq(payrollDisbursementBatches.id, batchId),
      ),
    )
    .for("update");
  if (!row) throw batchNotFound();
  return row;
}

/**
 * Freeze check that must run AFTER the run and batch rows are locked (920).
 * The early `assertBatchNotFrozen` runs before the lock and can pass while a
 * "not me" dispute commits; under READ COMMITTED this statement starts after the
 * wait and sees it. Same refusal as the early check (409 PAYOUT_BATCH_FROZEN;
 * the database's PAYOUT-79 answers alike). It reads only: the caller holds the
 * locks, so it never takes one.
 */
export async function assertBatchOpenUnderRunLock(
  tx: Tx,
  tenantId: string,
  batchId: string,
): Promise<void> {
  try {
    await tx.transaction((savepoint) =>
      savepoint.execute(
        sql`SELECT app.payout_batch_assert_open_nolock(${tenantId}::uuid, ${batchId}::uuid)`,
      ),
    );
  } catch (error) {
    throw payoutGuardViolation(error) ?? error;
  }
}

/**
 * Lock order of every step on an existing batch: the run row first, then the
 * batch row (create, submit and approve do the same). The run lock is `update`
 * because a result step may turn the run `paid` in the same transaction.
 */
export async function loadBatchRunFirst(
  tx: Tx,
  tenantId: string,
  batchId: string,
): Promise<BatchRow> {
  const peek = await readBatch(tx, tenantId, batchId);
  await lockRun(tx, tenantId, peek.payrollRunId, "update");
  return loadBatchForUpdate(tx, tenantId, batchId);
}

export async function loadBatchItems(
  tx: Tx,
  tenantId: string,
  batchId: string,
  lock = false,
): Promise<ItemRow[]> {
  const query = tx
    .select()
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, asTenant(tenantId)),
        eq(payrollDisbursementItems.batchId, batchId),
      ),
    )
    .orderBy(
      asc(payrollDisbursementItems.createdAt),
      asc(payrollDisbursementItems.id),
    );
  return lock ? query.for("update") : query;
}

/** Reads the run row with a lock; the status gate of every payout step. */
async function lockRun(
  tx: Tx,
  tenantId: string,
  runId: string,
  mode: "update" | "share",
) {
  const query = tx
    .select({
      id: payrollRuns.id,
      status: payrollRuns.status,
      legalEntityId: payrollRuns.legalEntityId,
    })
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, asTenant(tenantId)),
        eq(payrollRuns.id, runId as PayrollRunId),
      ),
    );
  const [run] = await (mode === "update"
    ? query.for("update")
    : query.for("share"));
  if (!run)
    throw payoutRefuse(
      404,
      "PAYROLL_RUN_NOT_FOUND",
      "Payroll tidak ditemukan.",
    );
  return run;
}

/**
 * Step gate: the run must still be locked (or paid, for a follow-up batch).
 * `mode` is the run lock: `share` by default; a step that spends a trusted
 * grant (approve) takes `update`, because the database function asks for the
 * run `FOR UPDATE` and a share lock held by two callers would deadlock.
 */
export async function assertRunPayable(
  tx: Tx,
  tenantId: string,
  runId: string,
  mode: "update" | "share" = "share",
): Promise<void> {
  const run = await lockRun(tx, tenantId, runId, mode);
  if (run.status !== "locked" && run.status !== "paid")
    throw payoutRefuse(
      409,
      "PAYOUT_RUN_NOT_PAYABLE",
      "Payroll belum dikunci atau sudah dibatalkan, pembayaran tidak bisa dilanjutkan.",
    );
}

/** Per-PT switch (R15): a manual batch moves only while its PT config is on. */
export async function assertManualConfigEnabled(
  tx: Tx,
  tenantId: string,
  legalEntityId: string,
) {
  const [config] = await tx
    .select()
    .from(payrollPayoutConfigs)
    .where(
      and(
        eq(payrollPayoutConfigs.tenantId, asTenant(tenantId)),
        eq(payrollPayoutConfigs.legalEntityId, legalEntityId),
      ),
    )
    .for("share");
  if (!config || !config.enabled)
    throw payoutRefuse(
      409,
      "PAYOUT_CONFIG_DISABLED",
      "Pembayaran gaji untuk PT ini belum diaktifkan di pengaturan.",
    );
  // L6: a config set to another method (duitku) never opens a manual batch.
  if (config.method !== "manual_bank")
    throw payoutRefuse(
      409,
      "PAYOUT_CHANNEL_NOT_AVAILABLE",
      "Pengaturan PT ini bukan transfer bank manual.",
    );
  return config;
}

// ------------------------------------------------------------------- freeze

/**
 * Open disputes that freeze `batchIds`, one row per (batch, dispute): the
 * dispute of the batch itself, or of any batch sharing a payslip with it (a
 * retry batch of the same pay). Same rule as `app.payout_batch_frozen`
 * (migration 0660). Open dispute = a dispute row with no unfreeze row.
 */
async function openFreezingDisputes(
  tx: Tx,
  tenantId: string,
  batchIds: readonly string[],
) {
  const ids = batchIds.filter((id) => UUID_FORMAT.test(id));
  if (ids.length === 0) return [];
  const result = await tx.execute(sql`
    SELECT t.batch_id::text AS target_batch_id, d.id::text AS id,
           d.batch_id::text AS batch_id,
           d.log_id::text AS log_id, d.actor AS actor, d.reason AS reason,
           d.batch_status_at AS batch_status_at, d.created_at AS created_at
      FROM unnest(${`{${ids.join(",")}}`}::uuid[]) AS t(batch_id)
      JOIN payroll_payout_batch_disputes d
        ON d.tenant_id = ${tenantId}::uuid
       AND NOT EXISTS (
         SELECT 1 FROM payroll_payout_batch_unfreezes u
          WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id)
       AND (d.batch_id = t.batch_id
         OR EXISTS (
           SELECT 1
             FROM payroll_disbursement_items mine
             JOIN payroll_disbursement_items sibling
               ON sibling.tenant_id = mine.tenant_id
              AND sibling.payslip_id = mine.payslip_id
            WHERE mine.tenant_id = d.tenant_id AND mine.batch_id = t.batch_id
              AND sibling.batch_id = d.batch_id))
     ORDER BY d.created_at, d.id`);
  return (
    result.rows as {
      target_batch_id: string;
      id: string;
      batch_id: string;
      log_id: string;
      actor: string;
      reason: string;
      batch_status_at: string;
      created_at: Date | string;
    }[]
  ).map((row) => ({ ...row, created_at: new Date(row.created_at) }));
}

/**
 * Friendly early refusal for a frozen batch (409 PAYOUT_BATCH_FROZEN), checked
 * before a grant is issued. The database refuses the same step with PAYOUT-79
 * (`payoutGuardViolation` answers it alike), so this is not the net. A batch
 * that shares a payslip with a disputed batch is frozen too.
 */
export async function assertBatchNotFrozen(
  tx: Tx,
  tenantId: string,
  batchId: string,
): Promise<void> {
  const open = await openFreezingDisputes(tx, tenantId, [batchId]);
  if (open.length > 0) throw batchFrozen();
}

const NOT_FROZEN: PayoutBatchFreezeDto = { frozen: false, disputes: [] };

/**
 * Freeze state of many batches in one query: open disputes only, including
 * those that freeze a batch through a sibling. `viewerId` marks the claims the
 * caller filed (`mine`); nobody else's identity is read.
 */
export async function loadBatchFreezes(
  tx: Tx,
  tenantId: string,
  batchIds: readonly string[],
  viewerId?: string,
): Promise<Map<string, PayoutBatchFreezeDto>> {
  const out = new Map<string, PayoutBatchFreezeDto>();
  if (batchIds.length === 0) return out;
  const rows = await openFreezingDisputes(tx, tenantId, batchIds);
  for (const row of rows) {
    const freeze = out.get(row.target_batch_id) ?? {
      frozen: true,
      disputes: [],
    };
    freeze.disputes.push({
      id: row.id,
      batchId: row.batch_id,
      logId: row.log_id,
      createdAt: row.created_at.toISOString(),
      batchStatusAt:
        row.batch_status_at as PayoutBatchFreezeDto["disputes"][number]["batchStatusAt"],
      reason: row.reason,
      mine: viewerId !== undefined && row.actor === viewerId,
    });
    out.set(row.target_batch_id, freeze);
  }
  return out;
}

// --------------------------------------------------------------------- DTOs

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function toItemDto(row: ItemRow): PayrollDisbursementItemDto {
  return {
    id: row.id,
    batchId: row.batchId,
    payslipId: row.payslipId,
    employeeId: row.employeeId,
    channel: row.channel,
    attemptNo: row.attemptNo,
    status: row.status,
    excludedReason:
      row.excludedReason as PayrollDisbursementItemDto["excludedReason"],
    amountIdr: openItemAmount(row),
    feeIdr: openItemFee(row),
    bankCode: row.bankCode,
    accountHolderName: row.accountHolderName,
    maskedAccountNumber: row.maskedAccountNumber,
    nameMatch: row.nameMatch === null ? null : row.nameMatch === "exact",
    providerRef: row.providerRef,
    confirmedBy: row.confirmedBy,
    confirmationRef: row.confirmationRef,
    settledAt: iso(row.settledAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toBatchDto(
  row: BatchRow,
  items: readonly ItemRow[],
  freeze: PayoutBatchFreezeDto = NOT_FROZEN,
): PayrollDisbursementBatchDto {
  return {
    id: row.id,
    legalEntityId: row.legalEntityId,
    payrollRunId: row.payrollRunId,
    channel: row.channel,
    status: row.status,
    haltReason: row.haltReason,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    approvedBy: row.approvedBy,
    approvedAt: iso(row.approvedAt),
    approvalExpiresAt: iso(row.approvalExpiresAt),
    contentHash: row.contentHash,
    sourceBankAccountId: row.sourceBankAccountId,
    itemCount: row.itemCount,
    totalIdr: openBatchTotals(row).totalIdr,
    bankFormat: row.bankFormat as PayrollDisbursementBatchDto["bankFormat"],
    exportChecksumSha256: row.exportChecksumSha256,
    exportedBy: row.exportedBy,
    exportedAt: iso(row.exportedAt),
    cancelledBy: row.cancelledBy,
    cancelledAt: iso(row.cancelledAt),
    cancelReason: row.cancelledReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    freeze,
    items: items.map(toItemDto),
  };
}

export async function getDisbursementBatch(
  tx: Tx,
  tenantId: string,
  batchId: string,
  viewerId?: string,
): Promise<PayrollDisbursementBatchDto> {
  if (!UUID_FORMAT.test(batchId)) throw batchNotFound();
  const [row] = await tx
    .select()
    .from(payrollDisbursementBatches)
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, asTenant(tenantId)),
        eq(payrollDisbursementBatches.id, batchId),
      ),
    );
  if (!row) throw batchNotFound();
  const freezes = await loadBatchFreezes(tx, tenantId, [batchId], viewerId);
  return toBatchDto(
    row,
    await loadBatchItems(tx, tenantId, batchId),
    freezes.get(batchId),
  );
}

export async function listDisbursementBatches(
  tx: Tx,
  tenantId: string,
  payrollRunId: string,
  viewerId?: string,
): Promise<PayrollDisbursementBatchDto[]> {
  if (!UUID_FORMAT.test(payrollRunId)) return [];
  const batches = await tx
    .select()
    .from(payrollDisbursementBatches)
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, asTenant(tenantId)),
        eq(
          payrollDisbursementBatches.payrollRunId,
          payrollRunId as PayrollRunId,
        ),
      ),
    )
    .orderBy(
      asc(payrollDisbursementBatches.createdAt),
      asc(payrollDisbursementBatches.id),
    );
  const freezes = await loadBatchFreezes(
    tx,
    tenantId,
    batches.map((batch) => batch.id),
    viewerId,
  );
  const out: PayrollDisbursementBatchDto[] = [];
  for (const batch of batches)
    out.push(
      toBatchDto(
        batch,
        await loadBatchItems(tx, tenantId, batch.id),
        freezes.get(batch.id),
      ),
    );
  return out;
}

// ------------------------------------------------------------------- create

/** Net pay of a payslip. Fails closed: an unreadable slip stops the batch. */
function netOfPayslip(row: {
  id: string;
  tenantId: string;
  employeeId: string;
  paymentMethod: string;
  calculationEncrypted: Buffer;
  piiKeyVersion: number;
}): number {
  let calculation: ReturnType<typeof payslipCalculationSchema.parse>;
  try {
    calculation = payslipCalculationSchema.parse(
      JSON.parse(
        openPayrollValue(
          row.calculationEncrypted,
          {
            tenantId: row.tenantId,
            table: "payslips",
            rowId: row.id,
            field: "calculation",
          },
          row.piiKeyVersion,
        ),
      ),
    );
  } catch {
    // Never echo the decrypt or parse error: it may carry payroll values.
    throw payoutRefuse(
      422,
      "PAYOUT_PAYSLIP_UNREADABLE",
      "Slip gaji tidak bisa dibaca atau tidak sesuai format, batch tidak bisa dibuat.",
    );
  }
  if (
    calculation.employeeId !== row.employeeId ||
    calculation.paymentMethod !== row.paymentMethod
  )
    throw payoutRefuse(
      422,
      "PAYOUT_PAYSLIP_MISMATCH",
      "Isi slip gaji tidak sama dengan barisnya, batch tidak bisa dibuat.",
    );
  return calculation.netIdr;
}

/** True when the PT's manual bank file format can pay this bank code. */
function formatSupportsBank(format: string, bankCode: string): boolean {
  try {
    getBankFormatter(format as never);
  } catch {
    return false;
  }
  return format === "bca" ? bankCode === BCA_BANK_CODE : true;
}

type PlannedItem = {
  id: string;
  payslipId: string;
  employeeId: string;
  attemptNo: number;
  amountIdr: number;
  status: "prepared" | "blocked";
  excludedReason: "bank_code_missing" | "bank_format_unsupported" | null;
  bankSnapshotId: string | null;
  bankCode: string | null;
  accountHolderName: string | null;
  maskedAccountNumber: string | null;
};

/**
 * Slip ids with an open row in `payroll_payout_recon_exceptions` (migration
 * 0410, insert-only) on one of their items. A row is open until it has an
 * approved two-person clearance (`payroll_payout_recon_clearances`, migration
 * 0461, same test as `app.payout_payslip_held_by_recon`) bound to the flag's
 * LIVE fingerprint (`app.payout_recon_flag_fingerprint`, migration 0464): a
 * clearance of other flagged data, or a proposal alone (`approved_at` null),
 * still holds the slip, also when the data changed after the approval.
 */
async function slipsHeldByReconException(
  tx: Tx,
  tenantId: string,
  payslipIds: string[],
): Promise<Set<string>> {
  if (payslipIds.length === 0) return new Set();
  const rows = await tx.execute<{ payslip_id: string }>(
    sql`SELECT DISTINCT i.payslip_id
          FROM payroll_payout_recon_exceptions e
          JOIN payroll_disbursement_items i
            ON i.tenant_id = e.tenant_id AND i.id = e.item_id
         WHERE e.tenant_id = ${tenantId}
           AND NOT EXISTS (
             SELECT 1
               FROM payroll_payout_recon_clearances c
              WHERE c.tenant_id = e.tenant_id AND c.exception_id = e.id
                AND c.approved_at IS NOT NULL
                AND c.flag_sha256 =
                  app.payout_recon_flag_fingerprint(e.tenant_id, e.id))
           AND i.payslip_id IN (${sql.join(
             payslipIds.map((id) => sql`${id}`),
             sql`, `,
           )})`,
  );
  return new Set(rows.rows.map((row) => row.payslip_id));
}

/**
 * Slip ids with an open correction or overpaid proposal over a closed proof key
 * (legend-911 P1-2). The insert guard (`app.payroll_disbursement_items_closed_key_guard`)
 * refuses a new attempt for them in SQL; this keeps the batch from failing on
 * it with a raw database error (5xx): the slip stays held like any other.
 */
async function slipsHeldByClosedKeyProposal(
  tx: Tx,
  tenantId: string,
  payslipIds: string[],
): Promise<Set<string>> {
  if (payslipIds.length === 0) return new Set();
  const ids = sql.join(
    payslipIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await tx.execute<{ payslip_id: string }>(
    sql`SELECT i.payslip_id
          FROM payroll_disbursement_items i
          JOIN payroll_payout_failed_corrections c
            ON c.tenant_id = i.tenant_id AND c.item_id = i.id
         WHERE i.tenant_id = ${tenantId} AND i.payslip_id IN (${ids})
           AND c.status IN ('proposed', 'withdrawn')
           AND app.payout_proof_key_closed(c.tenant_id, c.evidence_key)
        UNION
        SELECT i.payslip_id
          FROM payroll_disbursement_items i
          JOIN payroll_payout_overpaid_proposals p
            ON p.tenant_id = i.tenant_id AND p.item_id = i.id
         WHERE i.tenant_id = ${tenantId} AND i.payslip_id IN (${ids})
           AND p.status IN ('proposed', 'withdrawn')
           AND app.payout_proof_key_closed(p.tenant_id, p.evidence_key)`,
  );
  return new Set(rows.rows.map((row) => row.payslip_id));
}

/**
 * Creates a draft batch for a `locked` run (or a follow-up batch for a `paid`
 * run that already has batches). `cash` takes the cash payslips, `manual_bank`
 * the bank_transfer payslips and needs the PT config enabled. Only slips with
 * net > 0 and no live item (R7) are taken; each item's amount is the sealed net
 * pay of its slip (R8) and the sum is checked against the slips.
 */
export async function createDisbursementBatch(
  tx: Tx,
  actor: PayoutActor,
  input: { payrollRunId: string; channel: PayoutChannel },
): Promise<PayrollDisbursementBatchDto> {
  const { channel } = input;
  if (channel === "duitku")
    throw payoutRefuse(
      409,
      "PAYOUT_CHANNEL_NOT_AVAILABLE",
      "Pembayaran lewat Duitku belum tersedia.",
    );
  if (channel !== "manual_bank" && channel !== "cash")
    throw payoutRefuse(
      422,
      "PAYOUT_CHANNEL_INVALID",
      "Kanal pembayaran tidak dikenal.",
    );
  const tenantId = actor.tenantId;
  if (!UUID_FORMAT.test(input.payrollRunId))
    throw payoutRefuse(
      404,
      "PAYROLL_RUN_NOT_FOUND",
      "Payroll tidak ditemukan.",
    );

  // The run row lock serialises creators of one run and blocks a reversal.
  const run = await lockRun(tx, tenantId, input.payrollRunId, "update");
  if (run.status !== "locked" && run.status !== "paid")
    throw payoutRefuse(
      409,
      "PAYOUT_RUN_NOT_PAYABLE",
      "Hanya payroll yang sudah dikunci yang bisa dibayarkan.",
    );
  const batchesOfRun = await tx
    .select({
      channel: payrollDisbursementBatches.channel,
      status: payrollDisbursementBatches.status,
    })
    .from(payrollDisbursementBatches)
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, asTenant(tenantId)),
        eq(
          payrollDisbursementBatches.payrollRunId,
          input.payrollRunId as PayrollRunId,
        ),
      ),
    );
  // A paid run without any batch was paid the old way: paying again is refused.
  if (
    run.status === "paid" &&
    !batchesOfRun.some((batch) => batch.status !== "cancelled")
  )
    throw payoutRefuse(
      409,
      "PAYOUT_RUN_ALREADY_PAID",
      "Payroll ini sudah ditandai dibayar tanpa batch pembayaran.",
    );
  if (
    batchesOfRun.some(
      (batch) =>
        batch.channel === channel &&
        !(FINAL_BATCH_STATUSES as readonly string[]).includes(batch.status),
    )
  )
    throw payoutRefuse(
      409,
      "PAYOUT_BATCH_ALREADY_OPEN",
      "Masih ada batch terbuka untuk payroll dan kanal ini.",
    );

  // H1: the old bank file path and a bank batch never both pay one run.
  if (channel !== "cash") {
    const [bankFile] = await tx
      .select({ id: bankTransferFiles.id })
      .from(bankTransferFiles)
      .where(
        and(
          eq(bankTransferFiles.tenantId, asTenant(tenantId)),
          eq(
            bankTransferFiles.payrollRunId,
            input.payrollRunId as PayrollRunId,
          ),
        ),
      )
      .limit(1);
    if (bankFile)
      throw payoutRefuse(
        409,
        "PAYOUT_RUN_HAS_BANK_FILE",
        "Payroll ini sudah punya berkas transfer bank lama, jadi tidak bisa dibayar lewat batch bank.",
      );
  }

  const config =
    channel === "manual_bank"
      ? await assertManualConfigEnabled(tx, tenantId, run.legalEntityId)
      : null;
  const feeIdr = config ? config.feePerTransferIdr : 0;

  const slipMethod = channel === "cash" ? "cash" : "bank_transfer";
  const slips = await tx
    .select({
      id: payslips.id,
      tenantId: payslips.tenantId,
      employeeId: payslips.employeeId,
      paymentMethod: payslips.paymentMethod,
      calculationEncrypted: payslips.calculationEncrypted,
      piiKeyVersion: payslips.piiKeyVersion,
    })
    .from(payslips)
    .where(
      and(
        eq(payslips.tenantId, asTenant(tenantId)),
        eq(payslips.payrollRunId, input.payrollRunId as PayrollRunId),
        eq(payslips.paymentMethod, slipMethod),
      ),
    )
    .orderBy(asc(payslips.id));

  // R7: a slip is free only when it has no live item and its last attempt
  // ended failed/not_sent/returned/cancelled (or it never had one).
  const history = new Map<
    string,
    { last: number; status: string; live: boolean; overpaid: boolean }
  >();
  if (slips.length > 0) {
    const past = await tx
      .select({
        payslipId: payrollDisbursementItems.payslipId,
        attemptNo: payrollDisbursementItems.attemptNo,
        status: payrollDisbursementItems.status,
      })
      .from(payrollDisbursementItems)
      .where(
        and(
          eq(payrollDisbursementItems.tenantId, asTenant(tenantId)),
          inArray(
            payrollDisbursementItems.payslipId,
            slips.map((slip) => slip.id),
          ),
        ),
      );
    for (const item of past) {
      const seen = history.get(item.payslipId) ?? {
        last: 0,
        status: "",
        live: false,
        overpaid: false,
      };
      // An overpaid attempt means the money already reached the employee:
      // the slip is settled by hand (receivable), never by a new batch.
      if (item.status === "overpaid") seen.overpaid = true;
      if (
        (PAYOUT_LIVE_ITEM_STATUSES as readonly string[]).includes(item.status)
      )
        seen.live = true;
      if (item.attemptNo > seen.last) {
        seen.last = item.attemptNo;
        seen.status = item.status;
      }
      history.set(item.payslipId, seen);
    }
  }
  // 905: a slip with an open reconciliation exception on any of its attempts
  // is held from retry (a new attempt could pay it twice). The insert guard
  // refuses it in SQL as well; this keeps the batch from failing on it.
  const held = await slipsHeldByReconException(
    tx,
    tenantId,
    slips.map((slip) => slip.id),
  );
  // 911: the same for an open proposal over a closed proof key.
  for (const id of await slipsHeldByClosedKeyProposal(
    tx,
    tenantId,
    slips.map((slip) => slip.id),
  ))
    held.add(id);
  const open = slips.filter((slip) => {
    if (held.has(slip.id)) return false;
    const seen = history.get(slip.id);
    if (!seen) return true;
    return (
      !seen.live &&
      !seen.overpaid &&
      (RETRYABLE_ITEM_STATUSES as readonly string[]).includes(seen.status)
    );
  });

  const snapshots = new Map<
    string,
    {
      id: string;
      tenantId: string;
      bankCode: string | null;
      snapshotEncrypted: Buffer;
      piiKeyVersion: number;
    }
  >();
  if (channel === "manual_bank" && open.length > 0) {
    const rows = await tx
      .select({
        id: payslipBankSnapshots.id,
        tenantId: payslipBankSnapshots.tenantId,
        payslipId: payslipBankSnapshots.payslipId,
        bankCode: payslipBankSnapshots.bankCode,
        snapshotEncrypted: payslipBankSnapshots.snapshotEncrypted,
        piiKeyVersion: payslipBankSnapshots.piiKeyVersion,
      })
      .from(payslipBankSnapshots)
      .where(
        and(
          eq(payslipBankSnapshots.tenantId, asTenant(tenantId)),
          inArray(
            payslipBankSnapshots.payslipId,
            open.map((slip) => slip.id),
          ),
        ),
      );
    for (const row of rows) snapshots.set(row.payslipId, row);
  }

  const planned: PlannedItem[] = [];
  let netOfIncludedSlips = 0;
  for (const slip of open) {
    const net = netOfPayslip(slip);
    if (net <= 0) continue;
    netOfIncludedSlips += net;
    const base = {
      id: randomUUID(),
      payslipId: slip.id,
      employeeId: slip.employeeId,
      attemptNo: (history.get(slip.id)?.last ?? 0) + 1,
      amountIdr: net,
    };
    if (channel === "cash") {
      planned.push({
        ...base,
        status: "prepared",
        excludedReason: null,
        bankSnapshotId: null,
        bankCode: null,
        accountHolderName: null,
        maskedAccountNumber: null,
      });
      continue;
    }
    const snapshot = snapshots.get(slip.id);
    // No frozen bank data: the item cannot exist, so the batch is refused.
    if (!snapshot)
      throw payoutRefuse(
        422,
        "PAYOUT_BANK_SNAPSHOT_MISSING",
        "Data rekening slip gaji belum dibekukan, batch tidak bisa dibuat.",
      );
    const bankCode = snapshot.bankCode;
    const excludedReason =
      bankCode === null
        ? "bank_code_missing"
        : !formatSupportsBank(config!.manualBankFormat, bankCode)
          ? "bank_format_unsupported"
          : null;
    // Display copy of the payee: the holder name and the last four digits only.
    // An account number that is not all digits (letters allowed by the HRIS
    // normaliser) cannot be masked; the item then carries no masked number.
    // A snapshot that cannot be opened (wrong key, tamper, malformed body)
    // refuses the batch; the cause is never echoed.
    let payee: ReturnType<typeof openPayeeBankSnapshot>;
    try {
      payee = openPayeeBankSnapshot(snapshot);
    } catch {
      throw payoutRefuse(
        422,
        "PAYROLL_BANK_ACCOUNT_UNREADABLE",
        "Data rekening slip gaji tidak bisa dibaca, batch tidak bisa dibuat.",
      );
    }
    const maskedAccountNumber = /^\d{4,}$/.test(payee.accountNumber)
      ? maskAccountNumber(payee.accountNumber)
      : null;
    planned.push({
      ...base,
      status: excludedReason ? "blocked" : "prepared",
      excludedReason,
      bankSnapshotId: snapshot.id,
      bankCode,
      accountHolderName: payee.accountHolder,
      maskedAccountNumber,
    });
  }
  if (planned.length === 0)
    throw payoutRefuse(
      409,
      "PAYOUT_NOTHING_TO_PAY",
      "Tidak ada slip yang perlu dibayar lewat kanal ini.",
    );
  // R8: the items add up to exactly the net pay of the slips they stand for.
  const itemSum = planned.reduce((sum, item) => sum + item.amountIdr, 0);
  if (itemSum !== netOfIncludedSlips)
    throw new Error("Payout items do not add up to the net pay of the slips");

  const payable = planned.filter((item) => item.status === "prepared");
  const batchId = randomUUID();
  const now = new Date();
  await tx.insert(payrollDisbursementBatches).values({
    id: batchId,
    tenantId: asTenant(tenantId),
    legalEntityId: run.legalEntityId,
    payrollRunId: input.payrollRunId as PayrollRunId,
    channel,
    status: "draft",
    requestedBy: asUser(actor.userId),
    requestedAt: now,
    itemCount: planned.length,
    totalsEncrypted: sealBatchTotals(tenantId, batchId, {
      totalIdr: payable.reduce((sum, item) => sum + item.amountIdr, 0),
      totalFeeIdr: payable.length * feeIdr,
      itemCount: payable.length,
    }),
    piiKeyVersion: PAYROLL_SEAL_KEY_VERSION,
    bankFormat: config ? config.manualBankFormat : null,
  });
  await tx.insert(payrollDisbursementItems).values(
    planned.map((item) => ({
      id: item.id,
      tenantId: asTenant(tenantId),
      batchId,
      payrollRunId: input.payrollRunId as PayrollRunId,
      payslipId: item.payslipId as PayslipId,
      employeeId: item.employeeId,
      channel,
      attemptNo: item.attemptNo,
      idempotencyKey: `payslip:${item.payslipId}:attempt:${item.attemptNo}`,
      amountEncrypted: sealItemAmount(tenantId, item.id, item.amountIdr),
      feeIdrEncrypted: sealItemFee(tenantId, item.id, feeIdr),
      piiKeyVersion: PAYROLL_SEAL_KEY_VERSION,
      bankSnapshotId: item.bankSnapshotId,
      bankCode: item.bankCode,
      accountHolderName: item.accountHolderName,
      maskedAccountNumber: item.maskedAccountNumber,
      status: item.status,
      excludedReason: item.excludedReason,
    })),
  );
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.batch_created",
    objectType: "payroll_disbursement_batch",
    objectId: batchId,
    before: { status: null },
    after: {
      status: "draft",
      channel,
      runId: input.payrollRunId,
      itemCount: planned.length,
    },
  });
  return getDisbursementBatch(tx, tenantId, batchId, actor.userId);
}

// ------------------------------------------------------------------- submit

export type SubmitResult = {
  batch: PayrollDisbursementBatchDto;
  /** Items left out of the batch (no bank code, unsupported bank). */
  excluded: {
    itemId: string;
    payslipId: string;
    employeeId: string;
    reason: string | null;
  }[];
};

/**
 * The requester sends a draft batch to approval. Blocked items are cancelled
 * and listed (their slips stay free); the content hash of the remaining items
 * is stored. A batch with nothing left to pay is refused.
 */
export async function submitDisbursementBatch(
  tx: Tx,
  actor: PayoutActor,
  batchId: string,
): Promise<SubmitResult> {
  const tenantId = actor.tenantId;
  const peek = await readBatch(tx, tenantId, batchId);
  await assertBatchNotFrozen(tx, tenantId, batchId);
  // Lock order: run row first, then the batch row (create does the same).
  await assertRunPayable(tx, tenantId, peek.payrollRunId);
  const batch = await loadBatchForUpdate(tx, tenantId, batchId);
  await assertBatchOpenUnderRunLock(tx, tenantId, batchId);
  if (batch.status !== "draft")
    throw payoutRefuse(
      409,
      "PAYOUT_BATCH_STATE",
      "Batch ini sudah diajukan atau tidak lagi berstatus draf.",
    );
  if (batch.requestedBy !== actor.userId)
    throw payoutRefuse(
      403,
      "PAYOUT_SUBMIT_REQUESTER_ONLY",
      "Hanya pembuat batch yang bisa mengajukannya.",
    );
  if (batch.channel === "manual_bank")
    await assertManualConfigEnabled(tx, tenantId, batch.legalEntityId);

  const items = await loadBatchItems(tx, tenantId, batchId, true);
  const prepared = items.filter((item) => item.status === "prepared");
  if (prepared.length === 0)
    throw payoutRefuse(
      422,
      "PAYOUT_BATCH_EMPTY",
      "Batch tidak punya item yang bisa dibayar, batalkan batch ini.",
    );
  const blocked = items.filter((item) => item.status === "blocked");
  if (blocked.length > 0) {
    const moved = await tx
      .update(payrollDisbursementItems)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(payrollDisbursementItems.tenantId, asTenant(tenantId)),
          eq(payrollDisbursementItems.batchId, batchId),
          eq(payrollDisbursementItems.status, "blocked"),
        ),
      )
      .returning({ id: payrollDisbursementItems.id });
    if (moved.length !== blocked.length)
      throw payoutRefuse(
        409,
        "PAYOUT_BATCH_STATE",
        "Batch berubah, coba lagi.",
      );
  }

  const contentHash = await batchContentHash(tx, batch, ["prepared"]);
  const totalIdr = prepared.reduce(
    (sum, item) => sum + openItemAmount(item),
    0,
  );
  const totalFeeIdr = prepared.reduce(
    (sum, item) => sum + openItemFee(item),
    0,
  );
  const [updated] = await tx
    .update(payrollDisbursementBatches)
    .set({
      status: "pending_approval",
      contentHash,
      itemCount: prepared.length,
      totalsEncrypted: sealBatchTotals(tenantId, batchId, {
        totalIdr,
        totalFeeIdr,
        itemCount: prepared.length,
      }),
      piiKeyVersion: PAYROLL_SEAL_KEY_VERSION,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, asTenant(tenantId)),
        eq(payrollDisbursementBatches.id, batchId),
        eq(payrollDisbursementBatches.status, "draft"),
      ),
    )
    .returning();
  if (!updated)
    throw payoutRefuse(409, "PAYOUT_BATCH_STATE", "Batch berubah, coba lagi.");
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.batch_submitted",
    objectType: "payroll_disbursement_batch",
    objectId: batchId,
    before: { status: "draft", itemCount: items.length },
    after: {
      status: "pending_approval",
      itemCount: prepared.length,
      contentHash: updated.contentHash,
    },
  });
  return {
    batch: await getDisbursementBatch(tx, tenantId, batchId, actor.userId),
    excluded: blocked.map((item) => ({
      itemId: item.id,
      payslipId: item.payslipId,
      employeeId: item.employeeId,
      reason: item.excludedReason,
    })),
  };
}

// ------------------------------------------------------------------ approve

const rupiah = (amount: number) => `Rp${amount.toLocaleString("id-ID")}`;

/**
 * Refuses (409 PAYOUT_CASH_INSUFFICIENT) a cash batch whose net total is more
 * than the entity's available petty cash: GL 1102 minus the credits not on the
 * GL yet, the same figure the petty cash return guard uses (legend-rvao9). The
 * entity lock comes AFTER the run and batch rows (every payout GL writer takes
 * them in that order, `lockBatchPayoutGl`; the other order deadlocks with a
 * handover of another batch of the same run) and BEFORE the pending credits are
 * read, so a return, a top-up or another approval of the entity cannot slip in
 * between. The items of this batch are still `prepared` here, so the pending
 * sum does not count them: call this before they turn `approved`. Accounting on
 * and no `petty_cash` mapping: refused 409 PAYOUT_PETTY_CASH_MAPPING_MISSING
 * (the handover would fail ACCOUNT_MAPPING_MISSING). Accounting off: skipped.
 */
async function assertCashCoversBatch(
  tx: Tx,
  tenantId: string,
  batch: BatchRow,
): Promise<void> {
  // Accounting module off: a handover never reaches the GL (`settle_skipped`),
  // so 1102 cannot go negative and the skipped credits would count as pending
  // forever, blocking every later cash batch (architect 1053 P1).
  if (!(await accountingEnabled(tx, asTenant(tenantId)))) return;
  await entityLock(tx, tenantId, batch.legalEntityId);
  const cash = await availableCash1102(
    tx,
    asTenant(tenantId),
    batch.legalEntityId,
  );
  // Accounting on but no petty_cash mapping: the handover could not post to the
  // GL (ACCOUNT_MAPPING_MISSING) and the money would be stuck, so refuse the
  // approval now instead of skipping the check.
  if (cash === null)
    throw payoutRefuse(
      409,
      "PAYOUT_PETTY_CASH_MAPPING_MISSING",
      "Mapping kas kecil (petty_cash) belum diatur. Atur mapping akun kas kecil lalu setujui batch lagi.",
    );
  const items = await loadBatchItems(tx, tenantId, batch.id);
  let totalIdr = 0;
  for (const item of items)
    if (item.status === "prepared") totalIdr += Number(openItemAmount(item));
  if (totalIdr <= cash.availableIdr) return;
  const availableIdr = Math.max(0, cash.availableIdr);
  throw payoutRefuse(
    409,
    "PAYOUT_CASH_INSUFFICIENT",
    `Kas tunai (1102) tidak cukup untuk batch ini. Saldo tersedia ${rupiah(availableIdr)} (sudah dikurangi pembayaran tunai lain yang menunggu dijurnal), total batch ${rupiah(totalIdr)}, kurang ${rupiah(totalIdr - availableIdr)}. Isi kas (top-up kas kecil) lalu setujui batch lagi.`,
  );
}

/**
 * A second person approves the batch they saw (same content hash). Valid for
 * 24 hours. The database also refuses approver = requester (CHECK).
 */
export async function approveDisbursementBatch(
  tx: Tx,
  actor: PayoutActor,
  batchId: string,
  input: { contentHash: string; sourceBankAccountId: string | null },
): Promise<PayrollDisbursementBatchDto> {
  const tenantId = actor.tenantId;
  const peek = await readBatch(tx, tenantId, batchId);
  await assertBatchNotFrozen(tx, tenantId, batchId);
  // Same answers as the checks under the lock, so the grant (which the
  // database issues only for a pending batch of another requester) is rarely
  // the first thing to refuse them. A batch that changes between this peek and
  // the grant (a lost approve race) is refused by the grant with PAYOUT-83 or
  // PAYOUT-16, which the grant service maps to the same 409 and 403.
  if (peek.status !== "pending_approval")
    throw payoutRefuse(
      409,
      "PAYOUT_BATCH_STATE",
      "Batch belum diajukan atau sudah diproses.",
    );
  if (peek.requestedBy === actor.userId)
    throw payoutRefuse(
      403,
      "PAYOUT_SELF_APPROVAL",
      "Pembuat batch tidak boleh menyetujui batchnya sendiri.",
    );
  // Whoever said "not me" to a main approval of this batch cannot approve it
  // again (legend-s20iu, PAYOUT-84); the grant and the attest refuse the same.
  const disowned = await tx.execute(
    sql`SELECT app.payout_batch_approval_disowned_by(${tenantId}::uuid, ${batchId}::uuid, ${actor.userId}::text) AS disowned`,
  );
  if ((disowned.rows[0] as { disowned: boolean }).disowned)
    throw payoutRefuse(
      403,
      "PAYOUT_DISOWNER_REFUSED",
      'Anda sudah menyatakan "bukan saya" pada persetujuan batch ini, jadi tidak boleh menyetujuinya lagi.',
    );
  // The main approval spends one step-up grant (legend-xp8mc): issued before
  // any lock, like the correction grant. No session or step-up: refused
  // 401 before anything is written.
  const approveGrant = await payoutTrustedGrant(actor, {
    kind: "batch_approve",
    step: "approve",
    batchId,
    itemIds: [],
    evidenceKey: null,
    refId: null,
    targetId: null,
  });
  // Lock order as `loadBatchRunFirst`: run `update` (the attest function
  // asks for it, so a `share` lock here would deadlock two approvals), then
  // the batch row. The second approval of a batch waits, then sees 409.
  await assertRunPayable(tx, tenantId, peek.payrollRunId, "update");
  const batch = await loadBatchForUpdate(tx, tenantId, batchId);
  await assertBatchOpenUnderRunLock(tx, tenantId, batchId);
  if (batch.status !== "pending_approval")
    throw payoutRefuse(
      409,
      "PAYOUT_BATCH_STATE",
      "Batch belum diajukan atau sudah diproses.",
    );
  if (batch.requestedBy === actor.userId)
    throw payoutRefuse(
      403,
      "PAYOUT_SELF_APPROVAL",
      "Pembuat batch tidak boleh menyetujui batchnya sendiri.",
    );
  // The bank account this batch pays from, frozen with the approval (legend-hkh57).
  let sourceBankAccountId: string | null = null;
  if (batch.channel === "manual_bank") {
    // Hold the config row (shared lock) for this transaction so the setup
    // check, the compare below and the freeze all see one version of the
    // source account; a config change waits until the approval commits.
    await tx
      .select({ id: payrollPayoutConfigs.id })
      .from(payrollPayoutConfigs)
      .where(
        and(
          eq(payrollPayoutConfigs.tenantId, asTenant(tenantId)),
          eq(payrollPayoutConfigs.legalEntityId, batch.legalEntityId),
        ),
      )
      .for("share");
    await assertManualConfigEnabled(tx, tenantId, batch.legalEntityId);
    // Fail closed (legend-8codi): no approval while the fee or the source
    // account cannot be journaled.
    await assertManualPayoutSetup(tx, asTenant(tenantId), batch.legalEntityId);
    sourceBankAccountId = await configuredSourceBankAccountId(
      tx,
      asTenant(tenantId),
      batch.legalEntityId,
    );
    // The approver must have seen the account that gets frozen (legend-3j9yz).
    // A mismatch refuses before anything is written: no audit, batch stays
    // pending_approval.
    if (
      sourceBankAccountId === null ||
      input.sourceBankAccountId !== sourceBankAccountId
    )
      throw payoutRefuse(
        409,
        "PAYOUT_SOURCE_MISMATCH",
        "Rekening sumber berubah sejak Anda membuka batch. Muat ulang lalu setujui lagi.",
      );
  }

  // The approver must have seen exactly what is stored, and what is stored
  // must still be what the items say now.
  const current = await batchContentHash(tx, batch, ["prepared"]);
  if (
    batch.contentHash === null ||
    input.contentHash !== batch.contentHash ||
    current !== batch.contentHash
  )
    throw payoutRefuse(
      409,
      "PAYOUT_HASH_MISMATCH",
      "Isi batch berubah sejak diajukan. Buka ulang batch lalu setujui.",
    );

  // A cash batch is refused when the entity's petty cash (1102) cannot pay it
  // (legend-rvao9, founder Q43).
  if (batch.channel === "cash")
    await assertCashCoversBatch(tx, tenantId, batch);

  // Spends the grant and writes the append-only approval log row, so the
  // "not me" notice reaches the approver of the main approval too.
  await tx.execute(
    sql`SELECT app.payout_batch_approve_attest(${batchId}::uuid, ${approveGrant}) AS grant_id`,
  );

  // The approval window runs on the database clock, the same one the pending
  // cash credits (`approval_expires_at > now()`), the export and the handover
  // compare against (legend-f250r): an app server with a skewed clock cannot
  // open a gap between them.
  const now = sql`now()`;
  const expires = sql`now() + make_interval(hours => ${PAYOUT_APPROVAL_TTL_HOURS})`;
  const [approved] = await tx
    .update(payrollDisbursementBatches)
    .set({
      status: "approved",
      approvedBy: asUser(actor.userId),
      approvedAt: now,
      approvalExpiresAt: expires,
      sourceBankAccountId,
      updatedAt: now,
    })
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, asTenant(tenantId)),
        eq(payrollDisbursementBatches.id, batchId),
        eq(payrollDisbursementBatches.status, "pending_approval"),
      ),
    )
    .returning();
  if (!approved)
    throw payoutRefuse(409, "PAYOUT_BATCH_STATE", "Batch berubah, coba lagi.");
  // Items move after the batch: the database lets an item become approved only
  // while its batch is approved by a second person (R5).
  const moved = await tx
    .update(payrollDisbursementItems)
    .set({ status: "approved", updatedAt: now })
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, asTenant(tenantId)),
        eq(payrollDisbursementItems.batchId, batchId),
        eq(payrollDisbursementItems.status, "prepared"),
      ),
    )
    .returning({ id: payrollDisbursementItems.id });
  if (moved.length !== batch.itemCount)
    throw payoutRefuse(
      409,
      "PAYOUT_BATCH_STATE",
      "Item batch berubah, coba lagi.",
    );
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.batch_approved",
    objectType: "payroll_disbursement_batch",
    objectId: batchId,
    before: { status: "pending_approval" },
    after: {
      status: "approved",
      itemCount: moved.length,
      contentHash: batch.contentHash,
    },
  });
  return getDisbursementBatch(tx, tenantId, batchId, actor.userId);
}

// ------------------------------------------------------------------- cancel

/**
 * Cancels a batch that has not left yet (draft, pending_approval, approved).
 * Items that were never sent become `cancelled` (or `not_sent` when they were
 * already approved), which frees their slips for a new batch (R7). An exported
 * or finished batch cannot be cancelled here.
 */
export async function cancelDisbursementBatch(
  tx: Tx,
  actor: PayoutActor,
  batchId: string,
  input: { reason: string },
): Promise<PayrollDisbursementBatchDto> {
  const tenantId = actor.tenantId;
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500)
    throw payoutRefuse(
      422,
      "PAYOUT_CANCEL_REASON_INVALID",
      "Alasan pembatalan wajib diisi (maksimal 500 karakter).",
    );
  await assertBatchNotFrozen(tx, tenantId, batchId);
  const batch = await loadBatchRunFirst(tx, tenantId, batchId);
  await assertBatchOpenUnderRunLock(tx, tenantId, batchId);
  if (
    batch.status !== "draft" &&
    batch.status !== "pending_approval" &&
    batch.status !== "approved"
  )
    throw payoutRefuse(
      409,
      "PAYOUT_BATCH_STATE",
      "Batch ini sudah diekspor atau selesai dan tidak bisa dibatalkan.",
    );
  const now = new Date();
  const items = await loadBatchItems(tx, tenantId, batchId, true);
  // M2: cash already handed over stays paid. The rest of the batch is stopped
  // and the batch closes as `partially_failed` instead of being refused.
  const handedOver = items.filter((item) => item.status === "succeeded").length;
  // approved -> not_sent first (never reached a bank), the rest -> cancelled.
  await tx
    .update(payrollDisbursementItems)
    .set({ status: "not_sent", updatedAt: now })
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, asTenant(tenantId)),
        eq(payrollDisbursementItems.batchId, batchId),
        eq(payrollDisbursementItems.status, "approved"),
      ),
    );
  await tx
    .update(payrollDisbursementItems)
    .set({ status: "cancelled", updatedAt: now })
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, asTenant(tenantId)),
        eq(payrollDisbursementItems.batchId, batchId),
        inArray(payrollDisbursementItems.status, ["prepared", "blocked"]),
      ),
    );
  const [left] = await tx
    .select({ id: payrollDisbursementItems.id })
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, asTenant(tenantId)),
        eq(payrollDisbursementItems.batchId, batchId),
        inArray(
          payrollDisbursementItems.status,
          PAYOUT_LIVE_ITEM_STATUSES.filter((status) => status !== "succeeded"),
        ),
      ),
    )
    .limit(1);
  if (left)
    throw payoutRefuse(
      409,
      "PAYOUT_BATCH_STATE",
      "Ada item yang sudah berjalan, batch tidak bisa dibatalkan.",
    );
  const [cancelled] = await tx
    .update(payrollDisbursementBatches)
    .set(
      handedOver > 0
        ? { status: "partially_failed", updatedAt: now }
        : {
            status: "cancelled",
            cancelledBy: asUser(actor.userId),
            cancelledAt: now,
            cancelledReason: reason,
            updatedAt: now,
          },
    )
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, asTenant(tenantId)),
        eq(payrollDisbursementBatches.id, batchId),
        eq(payrollDisbursementBatches.status, batch.status),
      ),
    )
    .returning();
  if (!cancelled)
    throw payoutRefuse(409, "PAYOUT_BATCH_STATE", "Batch berubah, coba lagi.");
  await recordPayoutAudit(tx, actor, {
    action: "payroll.disbursement.batch_cancelled",
    objectType: "payroll_disbursement_batch",
    objectId: batchId,
    reason,
    before: { status: batch.status },
    after: { status: cancelled.status, confirmed: handedOver },
  });
  return getDisbursementBatch(tx, tenantId, batchId, actor.userId);
}
