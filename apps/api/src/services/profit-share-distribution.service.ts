// Profit-share distribution cycle (PRD v1.7 §3.37 Siklus Distribusi, §4 P, §6 I
// `distribution_runs` / `distribution_lines`; SH-02, SH-04; bead legend-2ljb).
//
// - A regular run is calculated from the closed fiscal period's net profit
//   (`profit-share-net-profit.ts`) and the approved share version in force on
//   the period's last day. The money maths and the state machine are the
//   contract's (`calculateDistribution`, `transitionDistributionRun`); this
//   module only loads rows, applies the result and writes it in one tenant
//   transaction. The database repeats the hard rules (closed period, approved
//   version, frozen approved runs, no deletes).
// - One live regular run per profit entity and period; a correction is a new
//   adjustment run (SH-04) that keeps the split of the run it corrects.
// - Recording the LAST payment posts the automatic journal in the same
//   transaction as the status change (§4 P step 4): a regular or positive
//   adjustment run posts `distribution.completed`; a negative adjustment posts
//   the same rule with negative amounts, which mirrors the entry (claw-back).
//   Its id goes to `journal_entry_id` / `reversal_journal_entry_id` in the same
//   UPDATE that sets the run `paid`.
// - Create commands carry an idempotency key stored on the row (same key and
//   body replays the row, other body is IDEMPOTENCY_KEY_REUSED). Submit, decide
//   and payment claim their key in `profit_share_commands` inside the command's
//   transaction: the same key and request replays the current state (200), any
//   other request with that key is IDEMPOTENCY_KEY_REUSED.
// - Founder rule Q83 (carry): a claw-back the paid gross could not absorb keeps
//   its rest per shareholder (`distribution_run_shortfalls`, written with the
//   adjustment run). Once that adjustment is approved or paid, the next regular
//   run cuts it from the SAME shareholder's share (FIFO) before tax and records
//   the cut in `distribution_carry_deductions`. A cancelled run releases its cut.
// - Events `distribution.approved|paid|completed` go through the domain outbox
//   in the same transaction. The statement PDF is issued after commit; a failure
//   is logged and leaves `statement_file_key` null (issuing again is allowed).
// - Shareholders read only their own paid lines (SH-01); everything else is a
//   404 so a row's existence does not leak.

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  max,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { messagesId } from "@starter/shared/i18n";
import {
  AccountingError,
  assertAdjustmentMatchesTarget,
  assertAdjustmentTarget,
  assertNoDuplicateRegularRun,
  assertShareVersionUsable,
  buildDistributionStatement,
  buildMyProfitShare,
  calculateAdjustmentDistribution,
  calculateDistribution,
  CARRY_ABSORBED_PAYMENT_REF,
  isMoneyPaidLine,
  distributionApprovedEvent,
  distributionCompletedEvent,
  distributionPaidEvent,
  distributionRunSchema,
  distributionRunSummarySchema,
  effectiveShareAllocationVersion,
  listDistributionRuns,
  periodBounds,
  profitEntitySchema,
  resolveAutoJournalDate,
  transitionDistributionRun,
  type createAdjustmentDistributionInputSchema,
  type createDistributionRunInputSchema,
  type CarryDeduction,
  type CarryShortfall,
  type distributionDecisionInputSchema,
  type DistributionRun,
  type HeldPaid,
  type DistributionRunSummary,
  type DistributionStatement,
  type MyProfitShare,
  type ProfitEntity,
  type recordDistributionPaymentInputSchema,
  type CancelApprovedDistributionInput,
  type ShareAllocationVersion,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  businessDateOf,
  CoreError,
  createUlid,
  decodeCursor,
  encodeCursor,
  idr,
  isoDateTimeSchema,
  userIdSchema,
  type BusinessDate,
  type BusinessDayClock,
  type CursorPage,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import type { z } from "zod";
import { db } from "../db";
import {
  distributionCarryDeductions,
  distributionLines,
  distributionRunShortfalls,
  distributionRuns,
  fiscalPeriods,
  outlets,
  profitEntities,
  shareAllocationVersions,
  shareAllocations,
  shareholders,
} from "../db/schema";
import { approvalRequests } from "../db/schema/platform-approval";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import {
  auditAccountingChange,
  type TenantTransaction,
} from "./accounting-shared";
import { postJournalFromRuleInTransaction } from "./accounting-journal.service";
import { appendOutbox } from "./core-outbox";
import {
  cancelApprovalRequest,
  openApprovalRequest,
  resolveApprovalChainOutcome,
} from "./platform-approval.service";
import {
  DISTRIBUTION_RUN_OBJECT_TYPE,
  PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
} from "./profit-share-approval";
import { claimProfitShareCommand } from "./profit-share-idempotency";
import {
  assertNoUnallocatedEntityExpense,
  loadClosedPeriodNetProfit,
} from "./profit-share-net-profit";
import { issueDistributionStatement } from "./profit-share-statement.service";

type Tx = TenantTransaction;
type RunRow = typeof distributionRuns.$inferSelect;
type LineRow = typeof distributionLines.$inferSelect;
type EntityRow = typeof profitEntities.$inferSelect;

export type CreateDistributionRunInput = z.infer<
  typeof createDistributionRunInputSchema
>;
export type CreateAdjustmentInput = z.infer<
  typeof createAdjustmentDistributionInputSchema
>;
export type DistributionDecisionInput = z.infer<
  typeof distributionDecisionInputSchema
>;
export type RecordPaymentInput = z.infer<
  typeof recordDistributionPaymentInputSchema
>;
export type ListRunsQuery = ReturnType<typeof listDistributionRuns.query.parse>;

/** Who reads a statement: a manager, or a shareholder (own paid line only). */
export type StatementViewer =
  { kind: "manager" } | { kind: "shareholder"; userId: string };

export type DistributionDeps = {
  /** Issues the statement PDF of one paid line; injected for tests. */
  issueStatement: (
    context: ScopedTenantContext,
    input: { distributionRunId: string; distributionLineId: string },
  ) => Promise<void>;
};

export const defaultDistributionDeps: DistributionDeps = {
  issueStatement: (context, input) =>
    issueDistributionStatement(context, input),
};

const EVENT_DESTINATION = "cloud-sync";
/** Journal dates follow the Jakarta calendar day of the payment (D-CORE-6). */
const JOURNAL_CLOCK: BusinessDayClock = {
  timeZone: "Asia/Jakarta",
  cutoff: "00:00",
};

const iso = (value: Date | string) => new Date(value).toISOString();
const notFound = () =>
  new HttpError(404, "NOT_FOUND", "Distribusi tidak ditemukan.");

// ------------------------------------------------------------- row mapping

type CarryTrail = {
  shareholderId: string;
  shortfallRunId: string;
  amountIdr: number;
};

function toRun(
  row: RunRow,
  lineRows: readonly LineRow[],
  carryDeductions: readonly CarryTrail[],
): DistributionRun {
  const lines = [...lineRows]
    .sort((a, b) => a.position - b.position)
    .map((line) => ({
      id: line.id,
      tenantId: line.tenantId,
      distributionRunId: line.distributionRunId,
      shareholderId: line.shareholderId,
      shareBp: line.shareBp,
      grossIdr: line.grossIdr,
      carryDeductedIdr: line.carryDeductedIdr,
      taxWithheldIdr: line.taxWithheldIdr,
      netIdr: line.netIdr,
      paymentStatus: line.paymentStatus,
      paymentRef: line.paymentRef,
      paidAt: line.paidAt ? iso(line.paidAt) : null,
      statementFileKey: line.statementFileKey,
    }));
  return distributionRunSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    profitEntityId: row.profitEntityId,
    fiscalPeriodId: row.fiscalPeriodId,
    period: row.period,
    type: row.type,
    basis: row.basis,
    status: row.status,
    shareVersion: row.shareVersion,
    periodNetProfitIdr: row.periodNetProfitIdr,
    reserveIdr: row.reserveIdr,
    distributableIdr: row.distributableIdr,
    lines,
    totalGrossIdr: row.totalGrossIdr,
    totalTaxWithheldIdr: row.totalTaxWithheldIdr,
    totalNetIdr: row.totalNetIdr,
    requestedBy: row.requestedBy,
    requestedAt: iso(row.requestedAt),
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt ? iso(row.approvedAt) : null,
    paidAt: row.paidAt ? iso(row.paidAt) : null,
    adjustsRunId: row.adjustsRunId,
    adjustmentReason: row.adjustmentReason,
    reversalJournalEntryId: row.reversalJournalEntryId,
    unabsorbedIdr: row.unabsorbedIdr,
    carryDeductedIdr: row.carryDeductedIdr,
    carryDeductions,
  });
}

function toEntity(row: EntityRow): ProfitEntity {
  return profitEntitySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    type: row.type,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    policy: {
      basis: row.basis,
      reserveBp: row.reserveBp,
      frequency: row.frequency,
      taxWithholdingBp: row.taxWithholdingBp,
    },
    isActive: row.isActive,
  });
}

// ------------------------------------------------------------------- loads

async function loadEntityRow(
  tx: Tx,
  tenantId: string,
  profitEntityId: string,
  lock = false,
): Promise<EntityRow> {
  const query = tx
    .select()
    .from(profitEntities)
    .where(
      and(
        eq(profitEntities.tenantId, tenantId),
        eq(profitEntities.id, profitEntityId),
      ),
    )
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  if (!row)
    throw new HttpError(
      404,
      "NOT_FOUND",
      "Entitas bagi hasil tidak ditemukan.",
    );
  return row;
}

/** The legal entity whose ledger the entity's profit comes from. */
async function legalEntityOf(
  tx: Tx,
  tenantId: string,
  entity: EntityRow,
): Promise<string> {
  if (entity.type === "legal_entity" && entity.legalEntityId)
    return entity.legalEntityId;
  if (!entity.outletId) throw notFound();
  const [outlet] = await tx
    .select({ legalEntityId: outlets.legalEntityId })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, entity.outletId)))
    .limit(1);
  if (!outlet) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
  return outlet.legalEntityId;
}

/**
 * Bead 1210: an outlet entity must not pay out (regular run or top-up) while
 * the period holds expense that reaches no outlet. Re-checked at approval and
 * payment because the ledger can change after the run was calculated.
 */
async function assertOutletPayoutAllowed(
  tx: Tx,
  tenantId: string,
  entityRow: EntityRow,
  run: { period: string; distributableIdr: number },
): Promise<void> {
  if (entityRow.type !== "outlet" || run.distributableIdr <= 0) return;
  await assertNoUnallocatedEntityExpense(tx, tenantId, {
    legalEntityId: await legalEntityOf(tx, tenantId, entityRow),
    outletId: entityRow.outletId,
    period: run.period,
  });
}

/** A fiscal period that belongs to the entity's legal entity, else 404. */
async function loadPeriod(
  tx: Tx,
  tenantId: string,
  legalEntityId: string,
  fiscalPeriodId: string,
  lock = false,
) {
  const query = tx
    .select()
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        eq(fiscalPeriods.id, fiscalPeriodId),
        eq(fiscalPeriods.legalEntityId, legalEntityId),
      ),
    )
    .limit(1);
  // FOR SHARE: a close or reopen of the period waits for this transaction.
  const [period] = await (lock ? query.for("share") : query);
  if (!period)
    throw new HttpError(404, "NOT_FOUND", "Periode buku tidak ditemukan.");
  return period;
}

async function loadRunRow(
  tx: Tx,
  tenantId: string,
  runId: string,
  lock = false,
): Promise<RunRow> {
  const query = tx
    .select()
    .from(distributionRuns)
    .where(
      and(
        eq(distributionRuns.tenantId, tenantId),
        eq(distributionRuns.id, runId),
      ),
    )
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound();
  return row;
}

async function loadLineRows(
  tx: Tx,
  tenantId: string,
  runIds: readonly string[],
): Promise<LineRow[]> {
  if (runIds.length === 0) return [];
  return tx
    .select()
    .from(distributionLines)
    .where(
      and(
        eq(distributionLines.tenantId, tenantId),
        inArray(distributionLines.distributionRunId, [...runIds]),
      ),
    )
    .orderBy(asc(distributionLines.position));
}

/** Carry deductions of the given runs, each traced to the claw-back it came from. */
async function loadCarryTrails(
  tx: Tx,
  tenantId: string,
  runIds: readonly string[],
): Promise<Map<string, CarryTrail[]>> {
  const trails = new Map<string, CarryTrail[]>();
  if (runIds.length === 0) return trails;
  const rows = await tx
    .select({
      runId: distributionCarryDeductions.distributionRunId,
      shareholderId: distributionCarryDeductions.shareholderId,
      shortfallRunId: distributionRunShortfalls.distributionRunId,
      amountIdr: distributionCarryDeductions.amountIdr,
    })
    .from(distributionCarryDeductions)
    .innerJoin(
      distributionRunShortfalls,
      and(
        eq(
          distributionRunShortfalls.tenantId,
          distributionCarryDeductions.tenantId,
        ),
        eq(
          distributionRunShortfalls.id,
          distributionCarryDeductions.shortfallId,
        ),
      ),
    )
    .where(
      and(
        eq(distributionCarryDeductions.tenantId, tenantId),
        inArray(distributionCarryDeductions.distributionRunId, [...runIds]),
      ),
    )
    .orderBy(
      asc(distributionCarryDeductions.shareholderId),
      asc(distributionRunShortfalls.createdAt),
      asc(distributionRunShortfalls.id),
    );
  for (const row of rows) {
    const list = trails.get(row.runId) ?? [];
    list.push({
      shareholderId: row.shareholderId,
      shortfallRunId: row.shortfallRunId,
      amountIdr: row.amountIdr,
    });
    trails.set(row.runId, list);
  }
  return trails;
}

async function loadRun(
  tx: Tx,
  tenantId: string,
  runId: string,
  lock = false,
): Promise<{ row: RunRow; run: DistributionRun }> {
  const row = await loadRunRow(tx, tenantId, runId, lock);
  const lines = await loadLineRows(tx, tenantId, [runId]);
  const trails = await loadCarryTrails(tx, tenantId, [runId]);
  return { row, run: toRun(row, lines, trails.get(runId) ?? []) };
}

/**
 * The open correction shortfalls of an entity (founder rule Q83) per
 * shareholder, oldest first. Only claw-backs that are approved or paid count;
 * what regular runs that are not cancelled already cut is taken off, so a
 * rejected run releases its cut and a draft run keeps its cut reserved.
 */
async function loadOpenCarry(
  tx: Tx,
  tenantId: string,
  profitEntityId: string,
): Promise<Map<string, CarryShortfall[]>> {
  const rows = await tx
    .execute<{ id: string; shareholder_id: string; open_idr: string }>(
      sql`
    SELECT s.id, s.shareholder_id,
           (s.amount_idr - coalesce(
             sum(d.amount_idr) FILTER (WHERE r.status <> 'cancelled'), 0
           ))::text AS open_idr
    FROM distribution_run_shortfalls s
    JOIN distribution_runs adj
      ON adj.tenant_id = s.tenant_id AND adj.id = s.distribution_run_id
    LEFT JOIN distribution_carry_deductions d
      ON d.tenant_id = s.tenant_id AND d.shortfall_id = s.id
    LEFT JOIN distribution_runs r
      ON r.tenant_id = d.tenant_id AND r.id = d.distribution_run_id
    WHERE s.tenant_id = ${tenantId}
      AND s.profit_entity_id = ${profitEntityId}
      AND adj.status IN ('approved', 'paid')
    GROUP BY s.id, s.shareholder_id, s.amount_idr, s.created_at
    ORDER BY s.shareholder_id, s.created_at, s.id
  `,
    )
    .then((result) => result.rows);
  const carry = new Map<string, CarryShortfall[]>();
  for (const row of rows) {
    const amountIdr = Number(row.open_idr);
    if (amountIdr <= 0) continue;
    const list = carry.get(row.shareholder_id) ?? [];
    list.push({ shortfallId: row.id, amountIdr });
    carry.set(row.shareholder_id, list);
  }
  return carry;
}

// ---------------------------------------------------------- audit & events

async function auditRun(
  tx: Tx,
  context: ScopedTenantContext,
  actorId: string,
  action: string,
  run: Pick<DistributionRun, "id" | "type" | "lines" | "carryDeductedIdr">,
  outletId: string | null,
  reason: string | null = null,
): Promise<void> {
  await auditAccountingChange(tx, context, {
    actorId: userIdSchema.parse(actorId),
    action,
    objectType: "distribution_run",
    objectId: run.id,
    outletId,
    reason,
    before: null,
    after: {
      type: run.type,
      count: run.lines.length,
      carryDeductedIdr: run.carryDeductedIdr,
    },
  });
}

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  const [row] = await tx
    .execute<{ last: string | number }>(
      sql`
    SELECT coalesce(max(sequence), 0) AS last
    FROM domain_event_outbox
    WHERE tenant_id = ${tenantId}
      AND destination = ${EVENT_DESTINATION}
      AND aggregate_type = ${aggregateType}
      AND aggregate_id = ${aggregateId}
  `,
    )
    .then((result) => result.rows);
  return Number(row?.last ?? 0) + 1;
}

type DistributionEvent =
  | typeof distributionApprovedEvent
  | typeof distributionPaidEvent
  | typeof distributionCompletedEvent;

async function appendDistributionEvent(
  tx: Tx,
  context: ScopedTenantContext,
  definition: DistributionEvent,
  input: {
    run: Pick<DistributionRun, "id">;
    outletId: string | null;
    actorId: string;
    now: Date;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    definition.entry.aggregateType,
    input.run.id,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.run.id,
    sequence,
    occurredAt: input.now.toISOString(),
    actor: { type: "user", id: input.actorId },
    deviceId: null,
    idempotencyKey: `${definition.name}:${input.run.id}:${sequence}`.slice(
      0,
      100,
    ),
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

// ------------------------------------------------------------------ insert

type CalculatedRun = {
  type: "regular" | "adjustment";
  profitEntityId: string;
  fiscalPeriodId: string;
  /** `fiscal_periods.version` read under FOR SHARE when the run was calculated. */
  fiscalPeriodVersion: number;
  period: string;
  shareVersion: number;
  periodNetProfitIdr: number | null;
  reserveIdr: number;
  distributableIdr: number;
  totalGrossIdr: number;
  totalTaxWithheldIdr: number;
  totalNetIdr: number;
  taxWithholdingBp: number;
  adjustsRunId: string | null;
  adjustmentReason: string | null;
  /** Claw-back rest no shareholder could absorb (founder rule Q83). */
  unabsorbedIdr?: number;
  /** Claw-back rest per shareholder; the rows add up to `unabsorbedIdr`. */
  shortfalls?: ReadonlyMap<string, number>;
  /** Regular run: earlier shortfalls cut from the shares (Q83). */
  carryDeductedIdr?: number;
  carryDeductions?: readonly CarryDeduction[];
  lines: readonly {
    shareholderId: string;
    shareBp: number;
    grossIdr: number;
    carryDeductedIdr?: number;
    taxWithheldIdr: number;
    netIdr: number;
  }[];
};

/** The rows of the carry tables must agree with the run's own totals. */
function assertCarryConsistent(calc: CalculatedRun): void {
  const shortfalls = [...(calc.shortfalls?.values() ?? [])];
  if (
    shortfalls.reduce((sum, amount) => sum + amount, 0) !==
    (calc.unabsorbedIdr ?? 0)
  )
    throw new Error("Shortfall rows must add up to unabsorbedIdr");
  const deductions = calc.carryDeductions ?? [];
  const deducted = deductions.reduce((sum, row) => sum + row.amountIdr, 0);
  if (deducted !== (calc.carryDeductedIdr ?? 0))
    throw new Error("Carry deductions must add up to carryDeductedIdr");
  // Every shareholder has a line (a share absorbed to zero is a gross 0 line),
  // so the line carry adds up to the run carry.
  const lineCarry = calc.lines.reduce(
    (sum, line) => sum + (line.carryDeductedIdr ?? 0),
    0,
  );
  if (lineCarry !== deducted)
    throw new Error("Line carry must add up to the run carry");
}

async function insertRun(
  tx: Tx,
  tenantId: string,
  actorId: string,
  idempotencyKey: string,
  calc: CalculatedRun,
): Promise<DistributionRun> {
  assertCarryConsistent(calc);
  const [row] = await tx
    .insert(distributionRuns)
    .values({
      tenantId,
      profitEntityId: calc.profitEntityId,
      fiscalPeriodId: calc.fiscalPeriodId,
      period: calc.period,
      type: calc.type,
      basis:
        calc.type === "regular"
          ? "closed_period_net_profit"
          : "approved_run_adjustment",
      status: "draft",
      fiscalPeriodVersion: calc.fiscalPeriodVersion,
      shareVersion: calc.shareVersion,
      periodNetProfitIdr:
        calc.periodNetProfitIdr === null ? null : idr(calc.periodNetProfitIdr),
      reserveIdr: idr(calc.reserveIdr),
      distributableIdr: idr(calc.distributableIdr),
      totalGrossIdr: idr(calc.totalGrossIdr),
      totalTaxWithheldIdr: idr(calc.totalTaxWithheldIdr),
      totalNetIdr: idr(calc.totalNetIdr),
      taxWithholdingBp: calc.taxWithholdingBp,
      requestedBy: actorId,
      adjustsRunId: calc.adjustsRunId,
      adjustmentReason: calc.adjustmentReason,
      unabsorbedIdr: idr(calc.unabsorbedIdr ?? 0),
      carryDeductedIdr: idr(calc.carryDeductedIdr ?? 0),
      idempotencyKey,
    })
    .returning();
  // Each line keeps the login its shareholder has NOW (Codex 379): statement
  // access follows this snapshot, so a later recipient change cannot hand the
  // next login this line's history.
  const recipients = await tx
    .select({ id: shareholders.id, userId: shareholders.userId })
    .from(shareholders)
    .where(
      and(
        eq(shareholders.tenantId, tenantId),
        inArray(
          shareholders.id,
          calc.lines.map((line) => line.shareholderId),
        ),
      ),
    );
  const recipientOf = new Map(recipients.map((r) => [r.id, r.userId]));
  const lineRows = await tx
    .insert(distributionLines)
    .values(
      calc.lines.map((line, position) => ({
        tenantId,
        distributionRunId: row!.id,
        shareholderId: line.shareholderId,
        recipientUserId: recipientOf.get(line.shareholderId) ?? null,
        shareBp: line.shareBp,
        grossIdr: idr(line.grossIdr),
        taxWithheldIdr: idr(line.taxWithheldIdr),
        netIdr: idr(line.netIdr),
        carryDeductedIdr: idr(line.carryDeductedIdr ?? 0),
        position,
      })),
    )
    .returning();
  // A claw-back keeps what no shareholder could absorb, one row per shareholder.
  if (calc.shortfalls && calc.shortfalls.size > 0)
    await tx.insert(distributionRunShortfalls).values(
      [...calc.shortfalls].map(([shareholderId, amountIdr]) => ({
        tenantId,
        distributionRunId: row!.id,
        profitEntityId: calc.profitEntityId,
        shareholderId,
        amountIdr: idr(amountIdr),
      })),
    );
  if (calc.carryDeductions && calc.carryDeductions.length > 0)
    await tx.insert(distributionCarryDeductions).values(
      calc.carryDeductions.map((deduction) => ({
        tenantId,
        distributionRunId: row!.id,
        shortfallId: deduction.shortfallId,
        profitEntityId: calc.profitEntityId,
        shareholderId: deduction.shareholderId,
        amountIdr: deduction.amountIdr,
      })),
    );
  const trails = await loadCarryTrails(tx, tenantId, [row!.id]);
  return toRun(row!, lineRows, trails.get(row!.id) ?? []);
}

/** A unique violation after the entity lock can only be the regular-run index. */
function constraintOf(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "23505" && typeof candidate.constraint === "string")
    return candidate.constraint;
  return constraintOf(candidate.cause, depth + 1);
}

/** Unique violations are mapped by constraint name, anything else is rethrown. */
function translateRunError(error: unknown): unknown {
  switch (constraintOf(error)) {
    case "distribution_runs_regular_period_key":
      return new AccountingError("DISTRIBUTION_ALREADY_EXISTS");
    case "distribution_runs_tenant_idempotency_key":
      // A concurrent create with the same key won the race.
      return reusedKey();
    default:
      return error;
  }
}

async function findByIdempotency(
  tx: Tx,
  tenantId: string,
  key: string,
): Promise<RunRow | null> {
  const [row] = await tx
    .select()
    .from(distributionRuns)
    .where(
      and(
        eq(distributionRuns.tenantId, tenantId),
        eq(distributionRuns.idempotencyKey, key),
      ),
    )
    .limit(1);
  return row ?? null;
}

function reusedKey(): CoreError {
  return new CoreError(
    "IDEMPOTENCY_KEY_REUSED",
    "That idempotency key was used for a different request.",
  );
}

// ----------------------------------------------------------- create (regular)

/** POST distributions: calculate and simulate, saved as a draft run. */
export async function createDistributionRunService(
  context: ScopedTenantContext,
  actorUserId: string,
  profitEntityId: string,
  input: CreateDistributionRunInput,
): Promise<DistributionRun> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  try {
    return await withTenant(db, context, async (tx) => {
      // The entity row lock serialises runs of one entity (idempotency, duplicates).
      const entityRow = await loadEntityRow(tx, tenantId, profitEntityId, true);
      const replay = await findByIdempotency(
        tx,
        tenantId,
        input.idempotencyKey,
      );
      if (replay) {
        if (
          replay.type !== "regular" ||
          replay.profitEntityId !== profitEntityId ||
          replay.fiscalPeriodId !== input.fiscalPeriodId ||
          replay.requestedBy !== actorUserId
        )
          throw reusedKey();
        return (await loadRun(tx, tenantId, replay.id)).run;
      }
      if (!entityRow.isActive)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Entitas bagi hasil tidak aktif.",
        );
      const entity = toEntity(entityRow);
      const legalEntityId = await legalEntityOf(tx, tenantId, entityRow);
      const period = await loadPeriod(
        tx,
        tenantId,
        legalEntityId,
        input.fiscalPeriodId,
        true,
      );
      // SH-02: refuse an open period before any other work.
      if (period.status !== "closed")
        throw new AccountingError("PERIOD_NOT_CLOSED");

      const existing = await tx
        .select({
          id: distributionRuns.id,
          profitEntityId: distributionRuns.profitEntityId,
          fiscalPeriodId: distributionRuns.fiscalPeriodId,
          type: distributionRuns.type,
          status: distributionRuns.status,
        })
        .from(distributionRuns)
        .where(
          and(
            eq(distributionRuns.tenantId, tenantId),
            eq(distributionRuns.profitEntityId, profitEntityId),
            eq(distributionRuns.fiscalPeriodId, input.fiscalPeriodId),
          ),
        );
      assertNoDuplicateRegularRun(existing as never, {
        profitEntityId,
        fiscalPeriodId: input.fiscalPeriodId,
      });

      // SH-03: the approved version in force on the period's last day.
      const versionRows = await tx
        .select()
        .from(shareAllocationVersions)
        .where(
          and(
            eq(shareAllocationVersions.tenantId, tenantId),
            eq(shareAllocationVersions.profitEntityId, profitEntityId),
            eq(shareAllocationVersions.status, "approved"),
          ),
        );
      const effective = effectiveShareAllocationVersion(
        versionRows.map((row) => ({
          profitEntityId: row.profitEntityId as never,
          version: row.version,
          effectiveFrom: row.effectiveFrom,
          status: row.status,
        })),
        profitEntityId,
        periodBounds(period.period).end,
      );
      const allocationRows = effective
        ? await tx
            .select({
              shareholderId: shareAllocations.shareholderId,
              shareBp: shareAllocations.shareBp,
            })
            .from(shareAllocations)
            .where(
              and(
                eq(shareAllocations.tenantId, tenantId),
                eq(shareAllocations.profitEntityId, profitEntityId),
                eq(shareAllocations.version, effective.version),
              ),
            )
        : [];
      assertShareVersionUsable(
        effective
          ? {
              status: effective.status,
              allocations:
                allocationRows as unknown as ShareAllocationVersion["allocations"],
            }
          : null,
      );

      const netProfit = await loadClosedPeriodNetProfit(tx, tenantId, {
        legalEntityId,
        outletId: entityRow.type === "outlet" ? entityRow.outletId : null,
        period: period.period,
      });
      const calculation = calculateDistribution({
        profitEntityId: entity.id,
        fiscalPeriodId: input.fiscalPeriodId as never,
        period: period.period,
        periodStatus: "closed",
        periodNetProfitIdr: netProfit,
        policy: entity.policy,
        allocations: allocationRows as never,
        carry: await loadOpenCarry(tx, tenantId, profitEntityId),
      });
      const run = await insertRun(
        tx,
        tenantId,
        actorUserId,
        input.idempotencyKey,
        {
          type: "regular",
          profitEntityId,
          fiscalPeriodId: input.fiscalPeriodId,
          fiscalPeriodVersion: period.version,
          period: period.period,
          shareVersion: effective!.version,
          periodNetProfitIdr: calculation.periodNetProfitIdr,
          reserveIdr: calculation.reserveIdr,
          distributableIdr: calculation.distributableIdr,
          totalGrossIdr: calculation.totalGrossIdr,
          totalTaxWithheldIdr: calculation.totalTaxWithheldIdr,
          totalNetIdr: calculation.totalNetIdr,
          taxWithholdingBp: entity.policy.taxWithholdingBp,
          adjustsRunId: null,
          adjustmentReason: null,
          carryDeductedIdr: calculation.carryDeductedIdr,
          carryDeductions: calculation.carryDeductions,
          lines: calculation.lines,
        },
      );
      await auditRun(
        tx,
        context,
        actorUserId,
        "profit_share.distribution_calculated",
        run,
        entityRow.outletId,
      );
      return run;
    });
  } catch (error) {
    throw translateRunError(error);
  }
}

// ------------------------------------------------------- create (adjustment)

/** POST adjustment (SH-04): a NEW run that corrects an approved or paid one. */
export async function createAdjustmentDistributionService(
  context: ScopedTenantContext,
  actorUserId: string,
  targetRunId: string,
  input: CreateAdjustmentInput,
): Promise<DistributionRun> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  try {
    return await withTenant(db, context, async (tx) => {
      const targetRow = await loadRunRow(tx, tenantId, targetRunId);
      const entityRow = await loadEntityRow(
        tx,
        tenantId,
        targetRow.profitEntityId,
        true,
      );
      const replay = await findByIdempotency(
        tx,
        tenantId,
        input.idempotencyKey,
      );
      if (replay) {
        if (
          replay.type !== "adjustment" ||
          replay.adjustsRunId !== targetRunId ||
          replay.fiscalPeriodId !== input.fiscalPeriodId ||
          // What was asked: the amount absorbed plus the open rest (Q83).
          replay.distributableIdr - replay.unabsorbedIdr !==
            input.adjustmentIdr ||
          replay.adjustmentReason !== input.reason.trim() ||
          replay.requestedBy !== actorUserId
        )
          throw reusedKey();
        return (await loadRun(tx, tenantId, replay.id)).run;
      }
      const target = (await loadRun(tx, tenantId, targetRunId)).run;
      assertAdjustmentTarget(target);
      const legalEntityId = await legalEntityOf(tx, tenantId, entityRow);
      const period = await loadPeriod(
        tx,
        tenantId,
        legalEntityId,
        input.fiscalPeriodId,
        true,
      );
      if (input.adjustmentIdr > 0)
        await assertOutletPayoutAllowed(tx, tenantId, entityRow, {
          period: period.period,
          distributableIdr: input.adjustmentIdr,
        });
      const held =
        input.adjustmentIdr < 0
          ? await paidStillHeld(tx, tenantId, target)
          : undefined;
      // Every line zero (all absorbed by the carry) and no top-up since: there
      // is nothing paid to take back, which is not "more than was paid".
      if (
        held &&
        target.lines.every((line) => line.grossIdr === 0) &&
        [...held.values()].every((paid) => paid.grossIdr === 0)
      )
        throw new AccountingError(
          "ADJUSTMENT_TARGET_INVALID",
          "Run ini seluruhnya terserap kekurangan koreksi; tidak ada yang bisa ditarik kembali.",
        );
      const calculation = calculateAdjustmentDistribution({
        profitEntityId: target.profitEntityId,
        fiscalPeriodId: input.fiscalPeriodId as never,
        period: period.period,
        periodStatus: period.status,
        adjustsRunId: target.id,
        reason: input.reason,
        adjustmentIdr: input.adjustmentIdr,
        // The rate frozen with the corrected run, not today's policy.
        taxWithholdingBp: targetRow.taxWithholdingBp,
        allocations: await shareVersionAllocations(
          tx,
          tenantId,
          target.profitEntityId,
          target.shareVersion,
        ),
        held,
        // A top-up pays down the open carry of each shareholder first (Q83).
        carry:
          input.adjustmentIdr > 0
            ? await loadOpenCarry(tx, tenantId, target.profitEntityId)
            : undefined,
      });
      assertAdjustmentMatchesTarget(
        target,
        {
          profitEntityId: target.profitEntityId,
          shareVersion: target.shareVersion,
          lines: calculation.lines,
        },
        { allowSubset: input.adjustmentIdr < 0 },
      );
      const run = await insertRun(
        tx,
        tenantId,
        actorUserId,
        input.idempotencyKey,
        {
          type: "adjustment",
          profitEntityId: target.profitEntityId,
          fiscalPeriodId: input.fiscalPeriodId,
          fiscalPeriodVersion: period.version,
          period: period.period,
          shareVersion: target.shareVersion,
          periodNetProfitIdr: null,
          reserveIdr: 0,
          distributableIdr: calculation.adjustmentIdr,
          unabsorbedIdr: calculation.unabsorbedIdr,
          shortfalls: calculation.unabsorbedByShareholder,
          carryDeductedIdr: calculation.carryDeductedIdr,
          carryDeductions: calculation.carryDeductions,
          totalGrossIdr: calculation.totalGrossIdr,
          totalTaxWithheldIdr: calculation.totalTaxWithheldIdr,
          totalNetIdr: calculation.totalNetIdr,
          taxWithholdingBp: targetRow.taxWithholdingBp,
          adjustsRunId: target.id,
          adjustmentReason: calculation.reason,
          lines: calculation.lines,
        },
      );
      await auditRun(
        tx,
        context,
        actorUserId,
        "profit_share.adjustment_created",
        run,
        entityRow.outletId,
        calculation.reason,
      );
      return run;
    });
  } catch (error) {
    throw translateRunError(error);
  }
}

type AdjustmentAllocations = Parameters<
  typeof calculateAdjustmentDistribution
>[0]["allocations"];

/**
 * The corrected run's split: every holder of its share version, not only the
 * ones with a line. A holder fully absorbed by a carry deduction has no line
 * but still owns their share, so the shares keep adding up to 100%.
 */
async function shareVersionAllocations(
  tx: Tx,
  tenantId: string,
  profitEntityId: string,
  version: number,
): Promise<AdjustmentAllocations> {
  const rows = await tx
    .select({
      shareholderId: shareAllocations.shareholderId,
      shareBp: shareAllocations.shareBp,
    })
    .from(shareAllocations)
    .where(
      and(
        eq(shareAllocations.tenantId, tenantId),
        eq(shareAllocations.profitEntityId, profitEntityId),
        eq(shareAllocations.version, version),
      ),
    );
  return rows as unknown as AdjustmentAllocations;
}

/**
 * What each shareholder still holds of the corrected run's paid gross: the run's
 * line plus every live (not cancelled) adjustment of it, the pending ones
 * included. A claw-back is capped by this per shareholder (founder rule Q83).
 */
async function paidStillHeld(
  tx: Tx,
  tenantId: string,
  target: DistributionRun,
): Promise<Map<string, HeldPaid>> {
  const rows = await tx
    .select({
      shareholderId: distributionLines.shareholderId,
      total: sql<string>`sum(${distributionLines.grossIdr})::text`,
      tax: sql<string>`sum(${distributionLines.taxWithheldIdr})::text`,
    })
    .from(distributionLines)
    .innerJoin(
      distributionRuns,
      and(
        eq(distributionRuns.tenantId, distributionLines.tenantId),
        eq(distributionRuns.id, distributionLines.distributionRunId),
      ),
    )
    .where(
      and(
        eq(distributionRuns.tenantId, tenantId),
        eq(distributionRuns.adjustsRunId, target.id),
        sql`${distributionRuns.status} <> 'cancelled'`,
        // A top-up that is not approved yet may still be rejected: it is not
        // room for a claw-back. Pending claw-backs always count.
        sql`(${distributionRuns.distributableIdr} < 0 OR ${distributionRuns.status} IN ('approved', 'paid'))`,
      ),
    )
    .groupBy(distributionLines.shareholderId);
  const adjusted = new Map(
    rows.map((row) => [
      row.shareholderId,
      { grossIdr: Number(row.total), taxWithheldIdr: Number(row.tax) },
    ]),
  );
  return new Map(
    target.lines.map((line) => [
      line.shareholderId,
      {
        grossIdr:
          line.grossIdr + (adjusted.get(line.shareholderId)?.grossIdr ?? 0),
        taxWithheldIdr:
          line.taxWithheldIdr +
          (adjusted.get(line.shareholderId)?.taxWithheldIdr ?? 0),
      },
    ]),
  );
}

// -------------------------------------------------------------------- reads

/** created_at keeps microseconds; a JS Date does not, so the cursor carries text. */
const CURSOR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cursorKeys(cursor: string): [string, string] {
  let keys: ReturnType<typeof decodeCursor>;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  }
  const [at, id] = keys;
  if (
    keys.length !== 2 ||
    typeof at !== "string" ||
    typeof id !== "string" ||
    !CURSOR_INSTANT.test(at) ||
    !CURSOR_UUID.test(id)
  )
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  return [at, id];
}

/** GET distributions of one entity, newest first (cursor page of summaries). */
export async function listDistributionRunsService(
  context: ScopedTenantContext,
  profitEntityId: string,
  query: ListRunsQuery,
): Promise<CursorPage<DistributionRunSummary>> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await loadEntityRow(tx, tenantId, profitEntityId);
    const filters: SQL[] = [
      eq(distributionRuns.tenantId, tenantId),
      eq(distributionRuns.profitEntityId, profitEntityId),
    ];
    if (query.status) filters.push(eq(distributionRuns.status, query.status));
    if (query.cursor) {
      const [at, id] = cursorKeys(query.cursor);
      const keyset = or(
        sql`${distributionRuns.requestedAt} < ${at}::timestamptz`,
        and(
          sql`${distributionRuns.requestedAt} = ${at}::timestamptz`,
          lt(distributionRuns.id, id),
        ),
      );
      if (keyset) filters.push(keyset);
    }
    const rows = await tx
      .select({
        row: distributionRuns,
        // SO 1216 F-P1a: the period moved on since the run was calculated and
        // no approved/paid adjustment of it exists at the current version.
        needsCorrection: sql<boolean>`(
          "distribution_runs"."type" = 'regular'
          AND "distribution_runs"."status" IN ('approved', 'paid')
          AND EXISTS (
            SELECT 1 FROM fiscal_periods fp
            WHERE fp.tenant_id = "distribution_runs"."tenant_id"
              AND fp.id = "distribution_runs"."fiscal_period_id"
              AND fp.version <> "distribution_runs"."fiscal_period_version"
              AND NOT EXISTS (
                SELECT 1 FROM distribution_runs adj
                WHERE adj.tenant_id = fp.tenant_id
                  AND adj.adjusts_run_id = "distribution_runs"."id"
                  AND adj.status IN ('approved', 'paid')
                  AND adj.fiscal_period_id = fp.id
                  AND adj.fiscal_period_version = fp.version
              )
          )
        )`,
        key: sql<string>`to_char(${distributionRuns.requestedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(distributionRuns)
      .where(and(...filters))
      .orderBy(desc(distributionRuns.requestedAt), desc(distributionRuns.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const counts = new Map<string, { total: number; paid: number }>();
    if (page.length > 0) {
      const countRows = await tx
        .select({
          runId: distributionLines.distributionRunId,
          total: sql<number>`count(*)::int`,
          paid: sql<number>`(count(*) FILTER (WHERE ${distributionLines.paymentStatus} = 'paid'))::int`,
        })
        .from(distributionLines)
        .where(
          and(
            eq(distributionLines.tenantId, tenantId),
            inArray(
              distributionLines.distributionRunId,
              page.map(({ row }) => row.id),
            ),
          ),
        )
        .groupBy(distributionLines.distributionRunId);
      for (const row of countRows)
        counts.set(row.runId, { total: row.total, paid: row.paid });
    }
    const data = page.map(({ row, needsCorrection }) => {
      const count = counts.get(row.id) ?? { total: 0, paid: 0 };
      return distributionRunSummarySchema.parse({
        id: row.id,
        profitEntityId: row.profitEntityId,
        fiscalPeriodId: row.fiscalPeriodId,
        period: row.period,
        type: row.type,
        status: row.status,
        shareVersion: row.shareVersion,
        distributableIdr: row.distributableIdr,
        totalTaxWithheldIdr: row.totalTaxWithheldIdr,
        totalNetIdr: row.totalNetIdr,
        lineCount: count.total,
        paidLineCount: count.paid,
        requestedBy: row.requestedBy,
        requestedAt: iso(row.requestedAt),
        approvedBy: row.approvedBy,
        approvedAt: row.approvedAt ? iso(row.approvedAt) : null,
        paidAt: row.paidAt ? iso(row.paidAt) : null,
        needsCorrection,
      });
    });
    const last = page.at(-1);
    return {
      data,
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.key, last.row.id])
            : null,
      },
    };
  });
}

/** GET one run with its lines. */
export async function getDistributionRunService(
  context: ScopedTenantContext,
  runId: string,
): Promise<DistributionRun> {
  assertTrustedScopedContext(context);
  return withTenant(
    db,
    context,
    async (tx) => (await loadRun(tx, context.tenant.tenantId, runId)).run,
  );
}

// ------------------------------------------------------------ state changes

/** POST submit: draft to pending_approval, requester only. */
export async function submitDistributionRunService(
  context: ScopedTenantContext,
  actorUserId: string,
  runId: string,
  input: { idempotencyKey: string },
): Promise<DistributionRun> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const actorId = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const { row, run } = await loadRun(tx, tenantId, runId, true);
    // Same key and request: replay the current state, no second transition.
    const claim = await claimProfitShareCommand(tx, {
      tenantId,
      idempotencyKey: input.idempotencyKey,
      operation: "distribution.submit",
      targetId: runId,
      actorId,
      request: {},
    });
    if (claim === "replay") return run;
    const next = transitionDistributionRun(run, { type: "submit", actorId });
    await tx
      .update(distributionRuns)
      .set({ status: next.status, updatedAt: new Date() })
      .where(
        and(
          eq(distributionRuns.tenantId, tenantId),
          eq(distributionRuns.id, runId),
          eq(distributionRuns.status, "draft"),
        ),
      );
    const entityRow = await loadEntityRow(tx, tenantId, row.profitEntityId);
    // The tenant's approval matrix (`dividend_distribution`) decides who
    // approves and in how many levels; the permission alone never does.
    // APPROVAL_POLICY_MISSING propagates: nobody may approve, fail closed.
    // `required: false` (amount below every tier) keeps the direct approve.
    await openApprovalRequest(tx, context, {
      sourceModule: PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
      actionType: "dividend_distribution",
      objectType: DISTRIBUTION_RUN_OBJECT_TYPE,
      objectId: runId,
      amountIdr: idr(Math.abs(run.totalGrossIdr)),
      outletId: entityRow.outletId,
      requestedBy: actorId,
      source: "user",
      requestReason: `Distribusi bagi hasil ${run.period}`,
      now: new Date(),
    });
    await auditRun(
      tx,
      context,
      actorUserId,
      "profit_share.distribution_submitted",
      run,
      entityRow.outletId,
    );
    return next;
  });
}

/**
 * The latest approval chain opened for a run (level-1 row id), or null when the
 * matrix needed none (amount below every tier). No column on the run: the chain
 * is found by (tenant, source module, object type, object id).
 */
async function distributionChainOf(
  tx: Tx,
  tenantId: TenantId,
  runId: string,
): Promise<string | null> {
  const [head] = await tx
    .select({ chainId: approvalRequests.chainId })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.sourceModule, PROFIT_SHARE_APPROVAL_SOURCE_MODULE),
        eq(approvalRequests.objectType, DISTRIBUTION_RUN_OBJECT_TYPE),
        eq(approvalRequests.objectId, runId),
        eq(approvalRequests.level, 1),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(1);
  return head?.chainId ?? null;
}

/**
 * Freezes a pending run as approved by `approverId`: the period must still be
 * closed at the version the numbers were calculated from, then the status
 * change, the `distribution.approved` event and the audit row. Shared by the
 * direct path (no chain) and the chain settle.
 */
/**
 * SO 1216 F-P1a: an adjustment is approved or paid only while the run it
 * corrects stands; a cancelled target leaves nothing to correct. Locks the
 * target FOR SHARE so a concurrent cancel-approved waits (the DB guards
 * refuse the same).
 */
async function assertAdjustmentTargetStands(
  tx: Tx,
  tenantId: string,
  row: RunRow,
): Promise<void> {
  if (row.adjustsRunId === null) return;
  const [target] = await tx
    .select({ status: distributionRuns.status })
    .from(distributionRuns)
    .where(
      and(
        eq(distributionRuns.tenantId, tenantId),
        eq(distributionRuns.id, row.adjustsRunId),
      ),
    )
    .for("share");
  if (!target || target.status === "cancelled")
    throw new AccountingError(
      "ADJUSTMENT_TARGET_INVALID",
      "Distribusi yang dikoreksi sudah dibatalkan; penyesuaian ini tidak bisa disetujui atau dibayar.",
    );
}

async function applyDistributionApproval(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    row: RunRow;
    run: DistributionRun;
    entityRow: EntityRow;
    approverId: UserId;
    now: Date;
    note: string | null;
  },
): Promise<DistributionRun> {
  const { row, run, entityRow, approverId, now } = input;
  const tenantId = context.tenant.tenantId;
  const next = transitionDistributionRun(run, {
    type: "approve",
    actorId: approverId,
    now: isoDateTimeSchema.parse(now.toISOString()),
  });
  // The numbers were calculated from this closed period at this version;
  // a reopen (or close again) since then makes them stale.
  const period = await loadPeriod(
    tx,
    tenantId,
    await legalEntityOf(tx, tenantId, entityRow),
    run.fiscalPeriodId,
    true,
  );
  if (period.status !== "closed" || period.version !== row.fiscalPeriodVersion)
    throw new AccountingError("PERIOD_CHANGED");
  await assertAdjustmentTargetStands(tx, tenantId, row);
  await assertOutletPayoutAllowed(tx, tenantId, entityRow, run);
  await tx
    .update(distributionRuns)
    .set({
      status: "approved",
      approvedBy: approverId,
      approvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(distributionRuns.tenantId, tenantId),
        eq(distributionRuns.id, run.id),
        eq(distributionRuns.status, "pending_approval"),
      ),
    );
  // Lines the carry absorbed to zero have nothing to pay: settled now
  // (no statement). All lines zero: the run is paid at once, no journal.
  const settled = next.lines.filter(
    (line) =>
      line.grossIdr === 0 &&
      run.lines.find((before) => before.id === line.id)?.paymentStatus ===
        "pending",
  );
  for (const line of settled)
    await tx
      .update(distributionLines)
      .set({
        paymentStatus: "paid",
        paymentRef: CARRY_ABSORBED_PAYMENT_REF,
        paidAt: now,
        paidBy: approverId,
      })
      .where(
        and(
          eq(distributionLines.tenantId, tenantId),
          eq(distributionLines.id, line.id),
          eq(distributionLines.distributionRunId, run.id),
          eq(distributionLines.paymentStatus, "pending"),
        ),
      );
  if (next.status === "paid")
    await tx
      .update(distributionRuns)
      .set({ status: "paid", paidAt: now, updatedAt: now })
      .where(
        and(
          eq(distributionRuns.tenantId, tenantId),
          eq(distributionRuns.id, run.id),
          eq(distributionRuns.status, "approved"),
        ),
      );
  await appendDistributionEvent(tx, context, distributionApprovedEvent, {
    run,
    outletId: entityRow.outletId,
    actorId: approverId,
    now,
    payload: {
      distributionRunId: run.id,
      profitEntityId: run.profitEntityId,
      fiscalPeriodId: run.fiscalPeriodId,
      period: run.period,
      type: run.type,
      shareVersion: run.shareVersion,
      totalGrossIdr: run.totalGrossIdr,
      totalTaxWithheldIdr: run.totalTaxWithheldIdr,
      totalNetIdr: run.totalNetIdr,
      carryDeductedIdr: run.carryDeductedIdr,
      shareholderCount: run.lines.length,
      approvedBy: approverId,
      approvedAt: now.toISOString(),
    },
  });
  // Paid on approval (every line zero): completed with no journal.
  if (next.status === "paid")
    await appendDistributionEvent(tx, context, distributionCompletedEvent, {
      run,
      outletId: entityRow.outletId,
      actorId: approverId,
      now,
      payload: {
        distributionRunId: run.id,
        profitEntityId: run.profitEntityId,
        fiscalPeriodId: run.fiscalPeriodId,
        period: run.period,
        type: run.type,
        distributedIdr: run.totalGrossIdr,
        taxWithheldIdr: run.totalTaxWithheldIdr,
        paidNetIdr: run.totalNetIdr,
        carryDeductedIdr: run.carryDeductedIdr,
        shareholderCount: run.lines.length,
        journalEntryId: null,
        completedAt: now.toISOString(),
      },
    });
  await auditRun(
    tx,
    context,
    approverId,
    "profit_share.distribution_approved",
    run,
    entityRow.outletId,
    input.note,
  );
  return next;
}

/** Cancels a pending run (rejected or refused) and audits it. */
async function cancelPendingRun(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    run: DistributionRun;
    entityRow: EntityRow;
    cancelledBy: UserId;
    reason: string;
    now: Date;
  },
): Promise<DistributionRun> {
  const { run, entityRow, cancelledBy, now } = input;
  const reason = input.reason.trim();
  await tx
    .update(distributionRuns)
    .set({
      status: "cancelled",
      cancelledBy,
      cancelledAt: now,
      cancelReason: reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(distributionRuns.tenantId, context.tenant.tenantId),
        eq(distributionRuns.id, run.id),
        eq(distributionRuns.status, "pending_approval"),
      ),
    );
  await auditRun(
    tx,
    context,
    cancelledBy,
    "profit_share.distribution_rejected",
    run,
    entityRow.outletId,
    reason,
  );
  return { ...run, status: "cancelled" };
}

/**
 * Applies the approval chain's outcome to a pending run, on the caller's
 * transaction (row locked FOR UPDATE). Idempotent: a run that is no longer
 * pending, has no chain, or whose chain is still open comes back unchanged.
 * The final approver is the last level's decider (read after the chain lock),
 * never the caller. A refusal while applying (period reopened, approver equal
 * to the requester) cancels the run with a reason, inside a savepoint so no
 * partial write survives; like the journal's `rejectSettled`.
 */
async function settleLoadedRun(
  tx: Tx,
  context: ScopedTenantContext,
  loaded: { row: RunRow; run: DistributionRun; entityRow: EntityRow },
  now: Date,
): Promise<DistributionRun> {
  const { row, run, entityRow } = loaded;
  if (run.status !== "pending_approval") return run;
  const tenantId = context.tenant.tenantId;
  const chainId = await distributionChainOf(tx, tenantId, run.id);
  if (chainId === null) return run;
  const outcome = await resolveApprovalChainOutcome(tx, context, {
    chainId,
    sourceModule: PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
    now,
  });
  if (outcome === "pending") return run;
  const [last] = await tx
    .select({ decidedBy: approvalRequests.decidedBy })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.chainId, chainId),
      ),
    )
    .orderBy(desc(approvalRequests.level))
    .limit(1);
  if (!last) throw notFound();
  const decider =
    last.decidedBy !== null &&
    last.decidedBy.toLowerCase() !== run.requestedBy.toLowerCase()
      ? userIdSchema.parse(last.decidedBy)
      : null;
  // `cancelled_by` is required by the table: the deciding user when there is
  // one, else the requester (expiry or an invalid approver has no other actor).
  const cancel = (reason: string) =>
    cancelPendingRun(tx, context, {
      run,
      entityRow,
      cancelledBy: decider ?? userIdSchema.parse(run.requestedBy),
      reason,
      now,
    });
  if (outcome !== "approved") return cancel(`approval ${outcome}`);
  if (decider === null) return cancel("approval approver invalid");
  try {
    return await tx.transaction((sp) =>
      applyDistributionApproval(sp, context, {
        row,
        run,
        entityRow,
        approverId: decider,
        now,
        note: null,
      }),
    );
  } catch (error) {
    if (!(error instanceof AccountingError)) throw error;
    return cancel(`approval refused: ${error.code}`);
  }
}

/**
 * Settles a run from its approval chain (decide route and the
 * `approval.resolved` consumer). Idempotent: a non-pending run, or one without
 * a chain, is returned unchanged.
 */
export async function settleDistributionRunForApproval(
  tx: Tx,
  context: ScopedTenantContext,
  runId: string,
  now: Date = new Date(),
): Promise<DistributionRun> {
  const tenantId = context.tenant.tenantId;
  const { row, run } = await loadRun(tx, tenantId, runId, true);
  const entityRow = await loadEntityRow(tx, tenantId, row.profitEntityId);
  return settleLoadedRun(tx, context, { row, run, entityRow }, now);
}

/** POST decision: approve (freezes the run) or reject (cancels it). */
export async function decideDistributionRunService(
  context: ScopedTenantContext,
  actorUserId: string,
  runId: string,
  input: DistributionDecisionInput,
): Promise<DistributionRun> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const actorId = userIdSchema.parse(actorUserId);
  // Opening a chain here must commit before the 409 is answered, so the
  // answer is thrown after the transaction instead of inside it.
  let chainOpenedNow = false;
  const decided = await withTenant(db, context, async (tx) => {
    const { row, run } = await loadRun(tx, tenantId, runId, true);
    const entityRow = await loadEntityRow(tx, tenantId, row.profitEntityId);
    const now = new Date();
    const claim = await claimProfitShareCommand(tx, {
      tenantId,
      idempotencyKey: input.idempotencyKey,
      operation: "distribution.decide",
      targetId: runId,
      actorId,
      request: { decision: input.decision, note: input.note },
    });
    if (claim === "replay") return run;
    const chainId = await distributionChainOf(tx, tenantId, runId);
    if (input.decision === "approve") {
      // Same guards as the direct path: pending status and requester != caller.
      transitionDistributionRun(run, {
        type: "approve",
        actorId,
        now: isoDateTimeSchema.parse(now.toISOString()),
      });
      if (chainId === null) {
        // Submit found no tier for this amount. The matrix may have tightened
        // since: ask it again with the same open path before approving
        // directly. A chain opened now is the requester's, like at submit.
        const opened = await openApprovalRequest(tx, context, {
          sourceModule: PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
          actionType: "dividend_distribution",
          objectType: DISTRIBUTION_RUN_OBJECT_TYPE,
          objectId: runId,
          amountIdr: idr(Math.abs(run.totalGrossIdr)),
          outletId: entityRow.outletId,
          requestedBy: userIdSchema.parse(run.requestedBy),
          source: "user",
          requestReason: `Distribusi bagi hasil ${run.period}`,
          now,
        });
        if (opened.required) {
          chainOpenedNow = true;
          return run;
        }
        return applyDistributionApproval(tx, context, {
          row,
          run,
          entityRow,
          approverId: actorId,
          now,
          note: input.note ?? null,
        });
      }
      // A chain decides: this call only settles it (the approver is the last
      // level's user), or answers 409 while levels are still open.
      const settled = await settleLoadedRun(
        tx,
        context,
        { row, run, entityRow },
        now,
      );
      if (settled.status === "pending_approval")
        throw new HttpError(
          409,
          "APPROVAL_PENDING",
          "Persetujuan belum selesai di kotak masuk approval.",
        );
      return settled;
    }
    const note = input.note ?? "";
    transitionDistributionRun(run, {
      type: "reject",
      actorId,
      reason: note,
    });
    // An open chain is cancelled first; one that already ended "approved"
    // cannot be rejected any more: the decision exists, settle applies it.
    if (chainId !== null) {
      const outcome = await cancelApprovalRequest(tx, context, {
        chainId,
        sourceModule: PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
        actorUserId: actorId,
        now,
      });
      if (outcome === "approved")
        throw new AccountingError("INVALID_TRANSITION");
    }
    return cancelPendingRun(tx, context, {
      run,
      entityRow,
      cancelledBy: actorId,
      reason: note,
      now,
    });
  });
  if (chainOpenedNow)
    throw new HttpError(
      409,
      "APPROVAL_PENDING",
      "Persetujuan belum selesai di kotak masuk approval.",
    );
  return decided;
}

/** The automatic journal of a completed run (§4 P step 4). */
async function postCompletionJournal(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    run: DistributionRun;
    entity: EntityRow;
    actorId: string;
    paidAt: Date;
    now: Date;
  },
): Promise<string> {
  const tenantId = context.tenant.tenantId;
  const legalEntityId = await legalEntityOf(tx, tenantId, input.entity);
  const negative = input.run.distributableIdr < 0;
  // A closed month does not block completion: the entry moves to the first
  // day after the latest closed period and keeps the natural date (F19).
  const [latest] = await tx
    .select({ period: max(fiscalPeriods.period) })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        eq(fiscalPeriods.legalEntityId, legalEntityId),
        eq(fiscalPeriods.status, "closed"),
      ),
    );
  const { entryDate, lateAdjustmentFrom } = resolveAutoJournalDate(
    businessDateOf(input.paidAt, JOURNAL_CLOCK),
    latest?.period ?? null,
  );
  // A claw-back posts the same rule with negative amounts: every side flips,
  // giving Dr bank, Dr dividend_tax_payable, Cr retained_earnings.
  const entry = await postJournalFromRuleInTransaction(
    tx,
    context,
    {
      eventName: "distribution.completed",
      amounts: {
        distributedIdr: input.run.totalGrossIdr,
        paidNetIdr: input.run.totalNetIdr,
        taxWithheldIdr: input.run.totalTaxWithheldIdr,
      },
      legalEntityId,
      outletId: input.entity.type === "outlet" ? input.entity.outletId : null,
      entryDate: entryDate as BusinessDate,
      lateAdjustmentFrom,
      sourceId: input.run.id,
      description: negative
        ? "Koreksi distribusi bagi hasil (pengembalian)"
        : input.run.type === "adjustment"
          ? "Koreksi distribusi bagi hasil"
          : input.run.carryDeductedIdr > 0
            ? `Distribusi bagi hasil (dipotong kekurangan koreksi Rp${new Intl.NumberFormat("id-ID").format(input.run.carryDeductedIdr)})`
            : undefined,
      postedBy: userIdSchema.parse(input.actorId),
      idempotencyKey: `distribution:${input.run.id}:completed`,
    },
    input.now,
  );
  return entry.id;
}

/**
 * POST cancel-approved (SO 1216 F-P1a): withdraws an approved run before any
 * line is paid (e.g. stale after a reopen), so the period can be reopened or
 * a new run calculated. Approver permission (route), reason >= 10 characters,
 * audited. A run with a paid line stays (it is corrected by an adjustment).
 */
export async function cancelApprovedDistributionRunService(
  context: ScopedTenantContext,
  actorUserId: string,
  runId: string,
  input: CancelApprovedDistributionInput,
): Promise<DistributionRun> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const actorId = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const { run } = await loadRun(tx, tenantId, runId, true);
    const entityRow = await loadEntityRow(tx, tenantId, run.profitEntityId);
    const claim = await claimProfitShareCommand(tx, {
      tenantId,
      idempotencyKey: input.idempotencyKey,
      operation: "distribution.cancel_approved",
      targetId: run.id,
      actorId,
      request: { reason: input.reason },
    });
    if (claim === "replay") return run;
    // A zero line settled by the carry on approval is no payment.
    if (
      run.status === "approved" &&
      run.lines.some((line) => isMoneyPaidLine(line))
    )
      throw new HttpError(
        409,
        "DISTRIBUTION_PARTIALLY_PAID",
        "Distribusi ini sudah dibayar sebagian dan tidak bisa dibatalkan. Catat koreksi lewat distribusi penyesuaian.",
      );
    // A live adjustment (any status but cancelled) corrects this run: its
    // money would stand on nothing. The DB guard refuses the same.
    const [liveAdjustment] = await tx
      .select({ id: distributionRuns.id })
      .from(distributionRuns)
      .where(
        and(
          eq(distributionRuns.tenantId, tenantId),
          eq(distributionRuns.adjustsRunId, run.id),
          ne(distributionRuns.status, "cancelled"),
        ),
      )
      .limit(1);
    if (liveAdjustment)
      throw new HttpError(
        409,
        "DISTRIBUTION_HAS_ADJUSTMENT",
        "Distribusi ini punya penyesuaian yang belum dibatalkan. Batalkan atau tolak penyesuaiannya dulu.",
      );
    const next = transitionDistributionRun(run, {
      type: "cancel_approved",
      actorId,
      reason: input.reason,
    });
    const now = new Date();
    const reason = input.reason.trim();
    await tx
      .update(distributionRuns)
      .set({
        status: "cancelled",
        cancelledBy: actorId,
        cancelledAt: now,
        cancelReason: reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(distributionRuns.tenantId, tenantId),
          eq(distributionRuns.id, run.id),
          eq(distributionRuns.status, "approved"),
        ),
      );
    await auditRun(
      tx,
      context,
      actorId,
      "profit_share.distribution_cancelled",
      run,
      entityRow.outletId,
      reason,
    );
    return next;
  });
}

/** POST payment: pays one line; the last line completes the run and journals. */
export async function recordDistributionPaymentService(
  context: ScopedTenantContext,
  actorUserId: string,
  runId: string,
  lineId: string,
  input: RecordPaymentInput,
  deps: DistributionDeps = defaultDistributionDeps,
): Promise<DistributionRun> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const actorId = userIdSchema.parse(actorUserId);
  const outcome = await withTenant(db, context, async (tx) => {
    const { row, run } = await loadRun(tx, tenantId, runId, true);
    const entityRow = await loadEntityRow(tx, tenantId, row.profitEntityId);
    const target = run.lines.find((line) => line.id === lineId);
    if (!target) throw notFound();
    // Same key and request: replay the current state, no second transition.
    const claim = await claimProfitShareCommand(tx, {
      tenantId,
      idempotencyKey: input.idempotencyKey,
      operation: "distribution.pay",
      targetId: lineId,
      actorId,
      request: { paymentRef: input.paymentRef, paidAt: input.paidAt },
    });
    if (claim === "replay") return { run, paid: false };
    // SO 1216 F-P1a: the money goes out only at the figures it was approved
    // on. A reopen (or a reopen + re-close) bumps the version: refuse
    // (PERIOD_CHANGED), the DB line guard refuses the same.
    const period = await loadPeriod(
      tx,
      tenantId,
      await legalEntityOf(tx, tenantId, entityRow),
      run.fiscalPeriodId,
      true,
    );
    if (
      period.status !== "closed" ||
      period.version !== row.fiscalPeriodVersion
    )
      throw new AccountingError(
        "PERIOD_CHANGED",
        messagesId.accounting.share.runs.paymentPeriodChanged,
      );
    await assertAdjustmentTargetStands(tx, tenantId, row);
    const paidAt = new Date(input.paidAt);
    const next = transitionDistributionRun(run, {
      type: "record_payment",
      actorId,
      lineId: target.id,
      paymentRef: input.paymentRef,
      paidAt: isoDateTimeSchema.parse(paidAt.toISOString()),
    });
    await assertOutletPayoutAllowed(tx, tenantId, entityRow, run);
    const now = new Date();
    // The payment cannot predate the approval or lie in the future.
    if (
      Number.isNaN(paidAt.getTime()) ||
      paidAt.getTime() > now.getTime() ||
      (run.approvedAt !== null &&
        paidAt.getTime() < new Date(run.approvedAt).getTime())
    )
      throw new HttpError(
        422,
        "INVALID_PAID_AT",
        "Tanggal pembayaran harus setelah persetujuan dan tidak boleh di masa depan.",
      );
    // The statement goes to the login the shareholder has at payment time: one
    // linked after the run was created must read it (set once, with the pay).
    // A shareholder left without a login keeps the one the line was made for.
    const [holder] = await tx
      .select({ userId: shareholders.userId })
      .from(shareholders)
      .where(
        and(
          eq(shareholders.tenantId, tenantId),
          eq(shareholders.id, target.shareholderId),
        ),
      )
      .limit(1);
    await tx
      .update(distributionLines)
      .set({
        paymentStatus: "paid",
        paymentRef: input.paymentRef.trim(),
        paidAt,
        paidBy: actorId,
        // The login linked when the money moves (an approved change may have
        // removed it: then nobody, not the creation-time login).
        recipientUserId: holder?.userId ?? null,
      })
      .where(
        and(
          eq(distributionLines.tenantId, tenantId),
          eq(distributionLines.id, lineId),
          eq(distributionLines.distributionRunId, runId),
          eq(distributionLines.paymentStatus, "pending"),
        ),
      );
    await appendDistributionEvent(tx, context, distributionPaidEvent, {
      run,
      outletId: entityRow.outletId,
      actorId,
      now,
      payload: {
        distributionRunId: run.id,
        distributionLineId: target.id,
        profitEntityId: run.profitEntityId,
        shareholderId: target.shareholderId,
        grossIdr: target.grossIdr,
        taxWithheldIdr: target.taxWithheldIdr,
        netIdr: target.netIdr,
        paymentRef: input.paymentRef.trim(),
        paidAt: paidAt.toISOString(),
      },
    });
    if (next.status === "paid") {
      // The run is paid when its latest line was paid, not when the last
      // request arrived (payments may be entered out of order).
      const completedAt = new Date(
        Math.max(
          ...next.lines.map((line) => new Date(line.paidAt ?? 0).getTime()),
        ),
      );
      const journalId = await postCompletionJournal(tx, context, {
        run: next,
        entity: entityRow,
        actorId,
        paidAt: completedAt,
        now,
      });
      const negative = next.distributableIdr < 0;
      // Status, paid_at and the journal id change together (DB guard).
      await tx
        .update(distributionRuns)
        .set({
          status: "paid",
          paidAt: completedAt,
          ...(negative
            ? { reversalJournalEntryId: journalId }
            : { journalEntryId: journalId }),
          updatedAt: now,
        })
        .where(
          and(
            eq(distributionRuns.tenantId, tenantId),
            eq(distributionRuns.id, runId),
            eq(distributionRuns.status, "approved"),
          ),
        );
      await appendDistributionEvent(tx, context, distributionCompletedEvent, {
        run,
        outletId: entityRow.outletId,
        actorId,
        now,
        payload: {
          distributionRunId: run.id,
          profitEntityId: run.profitEntityId,
          fiscalPeriodId: run.fiscalPeriodId,
          period: run.period,
          type: run.type,
          distributedIdr: run.totalGrossIdr,
          taxWithheldIdr: run.totalTaxWithheldIdr,
          paidNetIdr: run.totalNetIdr,
          carryDeductedIdr: run.carryDeductedIdr,
          shareholderCount: run.lines.length,
          journalEntryId: journalId,
          completedAt: completedAt.toISOString(),
        },
      });
    }
    await auditRun(
      tx,
      context,
      actorUserId,
      "profit_share.distribution_line_paid",
      run,
      entityRow.outletId,
    );
    return { run: (await loadRun(tx, tenantId, runId)).run, paid: true };
  });
  if (!outcome.paid) return outcome.run;
  // After commit: a failed statement must not undo the payment.
  try {
    await deps.issueStatement(context, {
      distributionRunId: runId,
      distributionLineId: lineId,
    });
  } catch (error) {
    logger.warn(
      { err: error, distributionRunId: runId, distributionLineId: lineId },
      "profit-share statement could not be issued; the payment stands",
    );
    return outcome.run;
  }
  return withTenant(
    db,
    context,
    async (tx) => (await loadRun(tx, tenantId, runId)).run,
  );
}

// --------------------------------------------------------------- statements

/** Read side of a line for statements: shareholder row + entity name. */
async function loadStatementParts(
  tx: Tx,
  tenantId: string,
  run: DistributionRun,
  shareholderId: string,
) {
  const [shareholder] = await tx
    .select({
      id: shareholders.id,
      name: shareholders.name,
    })
    .from(shareholders)
    .where(
      and(
        eq(shareholders.tenantId, tenantId),
        eq(shareholders.id, shareholderId),
      ),
    )
    .limit(1);
  if (!shareholder) throw notFound();
  const entityRow = await loadEntityRow(tx, tenantId, run.profitEntityId);
  return { shareholder, entityRow };
}

/** The login a line was created for; null when its shareholder had none. */
async function lineRecipient(
  tx: Tx,
  tenantId: string,
  lineId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ recipientUserId: distributionLines.recipientUserId })
    .from(distributionLines)
    .where(
      and(
        eq(distributionLines.tenantId, tenantId),
        eq(distributionLines.id, lineId),
      ),
    )
    .limit(1);
  return row?.recipientUserId ?? null;
}

/** A line the carry absorbed to zero (gross 0, carry > 0): settled, no payout. */
function isCarrySettledLine(line: {
  grossIdr: number;
  carryDeductedIdr: number;
}): boolean {
  return line.grossIdr === 0 && line.carryDeductedIdr > 0;
}

/** GET statement: a manager, or the line's own shareholder once it is paid. */
export async function getDistributionStatementService(
  context: ScopedTenantContext,
  viewer: StatementViewer,
  runId: string,
  lineId: string,
): Promise<DistributionStatement> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const { run } = await loadRun(tx, tenantId, runId);
    const line = run.lines.find((candidate) => candidate.id === lineId);
    // A zero line settled by the carry is no payout: it has no statement.
    if (!line || isCarrySettledLine(line)) throw notFound();
    const { shareholder, entityRow } = await loadStatementParts(
      tx,
      tenantId,
      run,
      line.shareholderId,
    );
    if (viewer.kind === "shareholder") {
      // SH-01: own line only, and only once it is paid; else it does not exist.
      // "Own" is the login the line was created for (`recipient_user_id`), not
      // the shareholder's login today (Codex 379).
      if (
        (await lineRecipient(tx, tenantId, line.id)) !== viewer.userId ||
        line.paymentStatus !== "paid"
      )
        throw notFound();
    }
    return buildDistributionStatement({
      run,
      line,
      shareholder: { id: line.shareholderId, name: shareholder.name },
      profitEntity: { id: run.profitEntityId, name: entityRow.name },
    });
  });
}

/**
 * GET my-profit-share (F35): the caller's own holdings, share history and paid
 * statements. Running estimates are not computed yet: `estimates` is `[]`.
 */
export async function getMyProfitShareService(
  context: ScopedTenantContext,
  actorUserId: string,
  now = new Date(),
): Promise<MyProfitShare> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [me] = await tx
      .select({ id: shareholders.id, name: shareholders.name })
      .from(shareholders)
      .where(
        and(
          eq(shareholders.tenantId, tenantId),
          eq(shareholders.userId, actorUserId),
        ),
      )
      .limit(1);
    // A former login (no shareholder row points at it any more) still reads
    // its own paid history below; holdings need a current row.
    // Own allocation rows in approved versions only: drafts are never shown.
    const mine = !me
      ? []
      : await tx
          .select({
            allocationId: shareAllocations.id,
            profitEntityId: shareAllocations.profitEntityId,
            version: shareAllocations.version,
            shareBp: shareAllocations.shareBp,
          })
          .from(shareAllocations)
          .innerJoin(
            shareAllocationVersions,
            and(
              eq(shareAllocationVersions.tenantId, shareAllocations.tenantId),
              eq(
                shareAllocationVersions.profitEntityId,
                shareAllocations.profitEntityId,
              ),
              eq(shareAllocationVersions.version, shareAllocations.version),
            ),
          )
          .where(
            and(
              eq(shareAllocations.tenantId, tenantId),
              eq(shareAllocations.shareholderId, me.id),
              eq(shareAllocationVersions.status, "approved"),
            ),
          );
    const entityIds = [...new Set(mine.map((row) => row.profitEntityId))];
    const entityRows =
      entityIds.length === 0
        ? []
        : await tx
            .select()
            .from(profitEntities)
            .where(
              and(
                eq(profitEntities.tenantId, tenantId),
                inArray(profitEntities.id, entityIds),
              ),
            );
    // Every approved version header decides which version is in force; only
    // this shareholder's own allocation row is attached to it.
    const versionRows =
      entityIds.length === 0
        ? []
        : await tx
            .select()
            .from(shareAllocationVersions)
            .where(
              and(
                eq(shareAllocationVersions.tenantId, tenantId),
                inArray(shareAllocationVersions.profitEntityId, entityIds),
                eq(shareAllocationVersions.status, "approved"),
              ),
            );
    const versions = versionRows.map((row) => {
      const own = mine.find(
        (item) =>
          item.profitEntityId === row.profitEntityId &&
          item.version === row.version,
      );
      return {
        tenantId: row.tenantId,
        profitEntityId: row.profitEntityId,
        version: row.version,
        effectiveFrom: row.effectiveFrom,
        status: row.status,
        allocations:
          own && me
            ? [
                {
                  id: own.allocationId,
                  shareholderId: me.id,
                  shareBp: own.shareBp,
                },
              ]
            : [],
        requestedBy: row.requestedBy,
        requestedAt: iso(row.requestedAt),
        decidedBy: row.decidedBy,
        decidedAt: row.decidedAt ? iso(row.decidedAt) : null,
        decisionNote: row.decisionNote,
      };
    }) as unknown as ShareAllocationVersion[];

    // Paid lines of this shareholder only; the run is loaded whole because the
    // contract builder validates it, but only this line's statement leaves.
    const ownLines = await tx
      .select()
      .from(distributionLines)
      .where(
        and(
          eq(distributionLines.tenantId, tenantId),
          // Historical identity: lines issued to this login, wherever the
          // shareholder row points today (Codex 379).
          eq(distributionLines.recipientUserId, actorUserId),
          eq(distributionLines.paymentStatus, "paid"),
          // Zero lines settled by the carry have no statement.
          sql`NOT (${distributionLines.grossIdr} = 0 AND ${distributionLines.carryDeductedIdr} > 0)`,
        ),
      )
      .orderBy(desc(distributionLines.paidAt), desc(distributionLines.id));
    // No current row and no paid line of this login: there is nothing to show.
    if (!me && ownLines.length === 0)
      throw new HttpError(
        404,
        "NOT_FOUND",
        "Data pemegang saham tidak ditemukan.",
      );
    const runIds = [...new Set(ownLines.map((line) => line.distributionRunId))];
    // A line may belong to another shareholder row than today's (the login was
    // moved between rows): each statement names its own shareholder.
    const holderIds = [...new Set(ownLines.map((line) => line.shareholderId))];
    const holderNames = new Map<string, string>();
    if (holderIds.length > 0)
      for (const holder of await tx
        .select({ id: shareholders.id, name: shareholders.name })
        .from(shareholders)
        .where(
          and(
            eq(shareholders.tenantId, tenantId),
            inArray(shareholders.id, holderIds),
          ),
        ))
        holderNames.set(holder.id, holder.name);
    const runRows =
      runIds.length === 0
        ? []
        : await tx
            .select()
            .from(distributionRuns)
            .where(
              and(
                eq(distributionRuns.tenantId, tenantId),
                inArray(distributionRuns.id, runIds),
              ),
            );
    const allLines = await loadLineRows(tx, tenantId, runIds);
    const trails = await loadCarryTrails(tx, tenantId, runIds);
    const entityNames = new Map<string, string>();
    for (const entity of entityRows) entityNames.set(entity.id, entity.name);
    const missingEntityIds = [
      ...new Set(
        runRows
          .map((row) => row.profitEntityId)
          .filter((id) => !entityNames.has(id)),
      ),
    ];
    if (missingEntityIds.length > 0) {
      const extra = await tx
        .select({ id: profitEntities.id, name: profitEntities.name })
        .from(profitEntities)
        .where(
          and(
            eq(profitEntities.tenantId, tenantId),
            inArray(profitEntities.id, missingEntityIds),
          ),
        );
      for (const entity of extra) entityNames.set(entity.id, entity.name);
    }
    const runsById = new Map<string, DistributionRun>();
    for (const row of runRows)
      runsById.set(
        row.id,
        toRun(
          row,
          allLines.filter((line) => line.distributionRunId === row.id),
          trails.get(row.id) ?? [],
        ),
      );
    const statements: DistributionStatement[] = [];
    for (const ownLine of ownLines) {
      const run = runsById.get(ownLine.distributionRunId);
      // A cancelled run never has paid lines; skip anything unexpected.
      if (!run || (run.status !== "approved" && run.status !== "paid"))
        continue;
      const line = run.lines.find((candidate) => candidate.id === ownLine.id);
      if (!line) continue;
      statements.push(
        buildDistributionStatement({
          run,
          line,
          shareholder: {
            id: ownLine.shareholderId as never,
            name:
              holderNames.get(ownLine.shareholderId) ?? me?.name ?? "Pemegang",
          },
          profitEntity: {
            id: run.profitEntityId,
            name: entityNames.get(run.profitEntityId) ?? "Entitas",
          },
        }),
      );
    }

    // The self view names the current row, else the row of the newest paid line.
    const subject = me ?? {
      id: ownLines[0]!.shareholderId,
      name: holderNames.get(ownLines[0]!.shareholderId) ?? "Pemegang",
    };
    return buildMyProfitShare({
      shareholder: { id: subject.id, name: subject.name } as never,
      entities: entityRows.map(toEntity),
      versions,
      statements,
      estimates: [],
      asOf: businessDateOf(now, JOURNAL_CLOCK),
    });
  });
}
