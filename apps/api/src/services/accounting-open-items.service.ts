// AP/AR sub-ledger core + aging (PRD v1.7 §3.19 "Utang & Piutang [P0] —
// Kartu utang supplier dengan umur utang, serta piutang untuk event dan
// corporate account"; bead legend-hpgo). Contract: payables.ts.
//
// Open items are written by the source modules inside their own tenant
// transaction (accounting-ap.service.ts for supplier invoices/payments,
// accounting-ar.service.ts for event / corporate receivables): the source
// document and its open item commit together. The HTTP surface of this
// bead is the read side only (`GET /api/accounting/aging`), exactly what the
// contract defines.
//
// Payment allocation races: a settlement locks the open item row FOR UPDATE,
// re-reads the outstanding amount and refuses an over-allocation; the table
// CHECK (settled <= original) repeats the rule for a writer that skipped it.

import { and, asc, eq, gt, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import {
  buildAgingReport,
  counterpartyTypeSchema,
  legalEntityIdSchema,
  openItemKindSchema,
  openItemListRowSchema,
  openItemSchema,
  type AgingReport,
  type OpenItem,
  type OpenItemListRow,
  type OpenItemKind,
} from "@starter/shared/accounting";
import {
  businessDateSchema,
  CoreError,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  idrSchema,
  outletIdSchema,
  outletIdsForQuery,
  uuidSchema,
  z,
  type CursorPage,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import { journalEntries } from "../db/schema/accounting.ts";
import {
  accountingOpenItems,
  accountingOpenItemSettlements,
  type OpenItemRow,
} from "../db/schema/accounting-ap-fa.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertOutletReach,
  auditApFa,
  idempotentCommand,
  newId,
  outletVisible,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";
import { requireLegalEntity, requireOutlet } from "./accounting-shared.ts";

/**
 * Aging bucket limits (§3.19 "umur utang"). The contract calls them tenant
 * data with 30/60/90 as the default; no tenant setting or endpoint exists in
 * the contract yet, so every tenant uses the default (decision, bead report).
 */
export const DEFAULT_AGING_BUCKET_LIMITS = [30, 60, 90] as const;

const positiveIdr = idrSchema.refine((v) => v > 0, "Amount must be > 0");

/** A source document becoming an open item (strict: no tenant id). */
export const recordOpenItemInputSchema = z
  .strictObject({
    id: uuidSchema,
    kind: openItemKindSchema,
    legalEntityId: legalEntityIdSchema,
    outletId: outletIdSchema.nullable(),
    counterpartyType: counterpartyTypeSchema,
    counterpartyId: uuidSchema,
    counterpartyName: z.string().trim().min(1).max(150),
    documentNumber: z.string().trim().min(1).max(60),
    documentDate: businessDateSchema,
    dueOn: businessDateSchema,
    originalIdr: positiveIdr,
    journalEntryId: uuidSchema.nullable(),
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine((input, ctx) => {
    if (input.dueOn < input.documentDate)
      ctx.addIssue({
        code: "custom",
        path: ["dueOn"],
        message: "dueOn must not be before documentDate",
      });
    const payable = input.kind === "payable";
    if (payable !== (input.counterpartyType === "supplier"))
      ctx.addIssue({
        code: "custom",
        path: ["counterpartyType"],
        message:
          "Payables are owed to suppliers; receivables are owed by event or corporate customers or employees",
      });
  });
export type RecordOpenItemInput = z.input<typeof recordOpenItemInputSchema>;

export const settleOpenItemInputSchema = z
  .strictObject({
    kind: openItemKindSchema,
    openItemId: uuidSchema,
    method: z.enum(["payment", "write_off", "debit_note"]),
    sourceId: uuidSchema.nullable(),
    settledOn: businessDateSchema,
    amountIdr: positiveIdr,
    reason: z.string().trim().min(1).max(200).nullable(),
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine((input, ctx) => {
    if (input.method === "write_off" && input.reason === null)
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A write-off needs a reason",
      });
    // A debit note is the supplier-return credit: it names its return document.
    if (input.method === "debit_note" && input.sourceId === null)
      ctx.addIssue({
        code: "custom",
        path: ["sourceId"],
        message: "A debit note needs its purchase return",
      });
  });
export type SettleOpenItemInput = z.input<typeof settleOpenItemInputSchema>;

export function toOpenItem(
  row: OpenItemRow,
  settledIdr: number = row.settledIdr,
): OpenItem {
  return openItemSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    kind: row.kind,
    counterpartyType: row.counterpartyType,
    counterpartyId: row.counterpartyId,
    counterpartyName: row.counterpartyName,
    documentNumber: row.documentNumber,
    documentDate: row.documentDate,
    dueOn: row.dueOn,
    originalIdr: row.originalIdr,
    settledIdr,
    outstandingIdr: row.originalIdr - settledIdr,
  });
}

/** A journal entry of this tenant and legal entity (link must not cross). */
async function requireJournalOfEntity(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  journalEntryId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.legalEntityId, legalEntityId),
        eq(journalEntries.id, journalEntryId),
      ),
    )
    .limit(1);
  if (!row)
    throw new HttpError(422, "VALIDATION_ERROR", "Journal entry not found.");
}

/**
 * Records a source document as an open item inside the caller's tenant
 * transaction. Idempotent on `idempotencyKey` (fingerprint-bound) and unique
 * per (tenant, kind, document id).
 */
export async function recordOpenItemInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  rawInput: RecordOpenItemInput,
  actorId: UserId | null,
): Promise<OpenItem> {
  const input = recordOpenItemInputSchema.parse(rawInput);
  assertOutletReach(context, input.outletId);
  const tenantId = context.tenant.tenantId;
  const { idempotencyKey, ...request } = input;
  return idempotentCommand(
    tx,
    context,
    { key: idempotencyKey, operation: "open_item.record", request },
    async () => {
      await requireLegalEntity(tx, tenantId, input.legalEntityId);
      if (input.outletId !== null)
        await requireOutlet(tx, tenantId, input.outletId);
      if (input.journalEntryId !== null)
        await requireJournalOfEntity(
          tx,
          tenantId,
          input.legalEntityId,
          input.journalEntryId,
        );
      const [row] = await tx
        .insert(accountingOpenItems)
        .values({
          tenantId: context.tenant.tenantId,
          kind: input.kind,
          id: input.id,
          legalEntityId: input.legalEntityId,
          outletId: input.outletId,
          counterpartyType: input.counterpartyType,
          counterpartyId: input.counterpartyId,
          counterpartyName: input.counterpartyName,
          documentNumber: input.documentNumber,
          documentDate: input.documentDate,
          dueOn: input.dueOn,
          originalIdr: input.originalIdr,
          journalEntryId: input.journalEntryId,
          createdBy: actorId,
        })
        .onConflictDoNothing()
        .returning();
      // Another key already recorded this document: one document, one item.
      if (!row)
        throw new CoreError(
          "CONFLICT",
          "This document already has an open item.",
        );
      return toOpenItem(row);
    },
  );
}

export type SettlementResult = {
  readonly openItem: OpenItem;
  readonly settlementId: string;
  readonly journalEntryId: string | null;
};

/**
 * Allocates a payment / receipt / write-off to one open item. The item row is
 * locked FOR UPDATE, so two allocations against the same invoice serialize
 * and the second sees the first's settled amount (no over-allocation).
 * `postJournal` runs inside the lock and returns the journal it posted (AP
 * supplier payment) or the caller-posted journal to link (AR).
 */
export async function settleOpenItemInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  rawInput: SettleOpenItemInput,
  actorId: UserId | null,
  postJournal: (
    item: OpenItemRow,
    settlementId: string,
  ) => Promise<string | null>,
): Promise<SettlementResult> {
  const input = settleOpenItemInputSchema.parse(rawInput);
  const tenantId = context.tenant.tenantId;
  const { idempotencyKey, ...request } = input;
  return idempotentCommand(
    tx,
    context,
    { key: idempotencyKey, operation: "open_item.settle", request },
    async () => {
      const [item] = await tx
        .select()
        .from(accountingOpenItems)
        .where(
          and(
            eq(accountingOpenItems.tenantId, tenantId),
            eq(accountingOpenItems.kind, input.kind),
            eq(accountingOpenItems.id, input.openItemId),
          ),
        )
        .limit(1)
        .for("update");
      if (!item || !outletVisible(context, item.outletId))
        throw new HttpError(404, "NOT_FOUND", "Open item not found.");
      if (input.settledOn < item.documentDate)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "A settlement cannot be dated before its document.",
        );
      const outstanding = item.originalIdr - item.settledIdr;
      if (input.amountIdr > outstanding)
        throw new CoreError(
          "CONFLICT",
          "The amount exceeds the outstanding balance.",
        );
      const settlementId = newId();
      const journalEntryId = await postJournal(item, settlementId);
      if (journalEntryId !== null)
        await requireJournalOfEntity(
          tx,
          tenantId,
          item.legalEntityId,
          journalEntryId,
        );
      await tx.insert(accountingOpenItemSettlements).values({
        id: settlementId,
        tenantId,
        kind: input.kind,
        openItemId: input.openItemId,
        method: input.method,
        sourceId: input.sourceId,
        settledOn: input.settledOn,
        amountIdr: input.amountIdr,
        journalEntryId,
        reason: input.reason,
        createdBy: actorId,
      });
      const [updated] = await tx
        .update(accountingOpenItems)
        .set({
          settledIdr: sql`${accountingOpenItems.settledIdr} + ${input.amountIdr}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(accountingOpenItems.tenantId, tenantId),
            eq(accountingOpenItems.kind, input.kind),
            eq(accountingOpenItems.id, input.openItemId),
          ),
        )
        .returning();
      if (!updated) throw new Error("Open item vanished under its lock.");
      // A write-off forgives money: sensitive, always audited with its reason.
      if (input.method === "write_off")
        await auditApFa(tx, context, {
          actorId,
          action: `accounting.${input.kind}.written_off`,
          objectType: "open_item",
          objectId: input.openItemId,
          outletId: item.outletId,
          reason: input.reason,
          before: { outstandingIdr: outstanding },
          after: {
            outstandingIdr: outstanding - input.amountIdr,
            amountIdr: input.amountIdr,
            journalEntryId,
          },
        });
      // A debit note forgives nothing but moves the debt without cash: it is
      // audited (the return is the settlement's source_id).
      if (input.method === "debit_note")
        await auditApFa(tx, context, {
          actorId,
          action: `accounting.${input.kind}.debit_noted`,
          objectType: "open_item",
          objectId: input.openItemId,
          outletId: item.outletId,
          reason: null,
          before: { outstandingIdr: outstanding },
          after: {
            outstandingIdr: outstanding - input.amountIdr,
            amountIdr: input.amountIdr,
            journalEntryId,
          },
        });
      return {
        openItem: toOpenItem(updated),
        settlementId,
        journalEntryId,
      };
    },
  );
}

export type AgingQuery = {
  legalEntityId: string;
  kind: OpenItemKind;
  asOf: string;
  outletId?: string;
};

/**
 * Aging as of `asOf` (§3.19 "umur utang"): documents dated on or before
 * `asOf`, outstanding = original − settlements dated on or before `asOf`, so a
 * past date reproduces the report as it stood then. TEN-03: an outlet-scoped
 * caller sees its outlets' items only; entity-level items need tenant scope.
 */
export async function getAgingReport(
  context: ScopedTenantContext,
  query: AgingQuery,
): Promise<AgingReport> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, query.legalEntityId);
    const filters: SQL[] = [
      eq(accountingOpenItems.tenantId, tenantId),
      eq(accountingOpenItems.legalEntityId, query.legalEntityId),
      eq(accountingOpenItems.kind, query.kind),
      lte(accountingOpenItems.documentDate, query.asOf),
    ];
    const outlets = outletIdsForQuery(
      context.outletScope,
      query.outletId ? [query.outletId] : undefined,
    );
    if (outlets.kind === "outlets")
      filters.push(
        inArray(accountingOpenItems.outletId, [...outlets.outletIds]),
      );
    const settledAsOf = tx
      .select({
        openItemId: accountingOpenItemSettlements.openItemId,
        settledIdr:
          sql<string>`sum(${accountingOpenItemSettlements.amountIdr})`.as(
            "settled_idr_as_of",
          ),
      })
      .from(accountingOpenItemSettlements)
      .where(
        and(
          eq(accountingOpenItemSettlements.tenantId, tenantId),
          eq(accountingOpenItemSettlements.kind, query.kind),
          lte(accountingOpenItemSettlements.settledOn, query.asOf),
        ),
      )
      .groupBy(accountingOpenItemSettlements.openItemId)
      .as("settled_as_of");
    const rows = await tx
      .select({ item: accountingOpenItems, settledIdr: settledAsOf.settledIdr })
      .from(accountingOpenItems)
      .leftJoin(settledAsOf, eq(settledAsOf.openItemId, accountingOpenItems.id))
      .where(and(...filters));
    const items = rows.map(({ item, settledIdr }) =>
      toOpenItem(item, Number(settledIdr ?? 0)),
    );
    return buildAgingReport(
      items,
      query.kind,
      query.asOf,
      DEFAULT_AGING_BUCKET_LIMITS,
    );
  });
}

export type OpenItemListQuery = {
  legalEntityId: string;
  kind: OpenItemKind;
  counterpartyId?: string;
  outletId?: string;
  asOf?: string;
  cursor?: string;
  limit: number;
};

/**
 * Open invoices behind the aging cells: one row per document with money still
 * outstanding, keyset-paged on (due_on, id) so the oldest due date comes
 * first. `asOf` replays the past exactly like `getAgingReport` (documents
 * dated on or before it, settlements dated on or before it); omitted, every
 * settlement counts. TEN-03: an outlet-scoped caller sees its outlets' items
 * only; entity-level items need tenant scope.
 */
export async function listOpenItems(
  context: ScopedTenantContext,
  query: OpenItemListQuery,
): Promise<CursorPage<OpenItemListRow>> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, query.legalEntityId);
    const filters: SQL[] = [
      eq(accountingOpenItems.tenantId, tenantId),
      eq(accountingOpenItems.legalEntityId, query.legalEntityId),
      eq(accountingOpenItems.kind, query.kind),
    ];
    if (query.asOf)
      filters.push(lte(accountingOpenItems.documentDate, query.asOf));
    if (query.counterpartyId)
      filters.push(
        eq(accountingOpenItems.counterpartyId, query.counterpartyId),
      );
    const outlets = outletIdsForQuery(
      context.outletScope,
      query.outletId ? [query.outletId] : undefined,
    );
    if (outlets.kind === "outlets")
      filters.push(
        inArray(accountingOpenItems.outletId, [...outlets.outletIds]),
      );
    if (query.cursor) {
      let keys: ReturnType<typeof decodeCursor>;
      try {
        keys = decodeCursor(query.cursor);
      } catch {
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      }
      const dueOn = businessDateSchema.safeParse(keys[0]);
      const id = uuidSchema.safeParse(keys[1]);
      if (!dueOn.success || !id.success)
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      const after = or(
        gt(accountingOpenItems.dueOn, dueOn.data),
        and(
          eq(accountingOpenItems.dueOn, dueOn.data),
          gt(accountingOpenItems.id, id.data),
        ),
      );
      if (after) filters.push(after);
    }
    const settlementFilters: SQL[] = [
      eq(accountingOpenItemSettlements.tenantId, tenantId),
      eq(accountingOpenItemSettlements.kind, query.kind),
    ];
    if (query.asOf)
      settlementFilters.push(
        lte(accountingOpenItemSettlements.settledOn, query.asOf),
      );
    const settled = tx
      .select({
        openItemId: accountingOpenItemSettlements.openItemId,
        settledIdr:
          sql<string>`sum(${accountingOpenItemSettlements.amountIdr})`.as(
            "settled_idr_listed",
          ),
      })
      .from(accountingOpenItemSettlements)
      .where(and(...settlementFilters))
      .groupBy(accountingOpenItemSettlements.openItemId)
      .as("settled_listed");
    const settledSql = sql`coalesce(${settled.settledIdr}, 0)`;
    const rows = await tx
      .select({
        item: accountingOpenItems,
        settledIdr: sql<string>`${settledSql}`,
      })
      .from(accountingOpenItems)
      .leftJoin(settled, eq(settled.openItemId, accountingOpenItems.id))
      .where(
        and(
          ...filters,
          sql`${accountingOpenItems.originalIdr} - ${settledSql} > 0`,
        ),
      )
      .orderBy(asc(accountingOpenItems.dueOn), asc(accountingOpenItems.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(({ item, settledIdr }) =>
        openItemListRowSchema.parse({
          id: item.id,
          outletId: item.outletId,
          counterpartyType: item.counterpartyType,
          counterpartyId: item.counterpartyId,
          counterpartyName: item.counterpartyName,
          documentNumber: item.documentNumber,
          documentDate: item.documentDate,
          dueOn: item.dueOn,
          originalIdr: item.originalIdr,
          settledIdr: Number(settledIdr),
          outstandingIdr: item.originalIdr - Number(settledIdr),
        }),
      ),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.item.dueOn, last.item.id])
            : null,
      },
    };
  });
}
