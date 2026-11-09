// Auto-journal consumer (F19, legend-9pz9; design docs/design/auto-journals.md).
// Cloud only, wired in worker-main.ts next to the inventory GL bridge: every
// automatic money journal (sale, sale refund, gateway receipt, gateway payout)
// posts through `postJournalFromRuleInTransaction` inside the outbox
// consumption transaction. Tenants without the accounting module: `ignored`.
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
//   Any other error propagates (outbox retry, dead letter, replayOutbox).
//
// Late adjustment (CTO decision 1): a money fact whose outlet business date
// falls in a closed month posts on the first day of the month after the latest
// closed one, with `late_adjustment_from` = the natural date, a description
// suffix and an `accounting.journal.late_adjusted` audit row.

import { and, asc, eq, lte, max, sql } from "drizzle-orm";
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
import { withTenant } from "../db/tenant.ts";
import {
  autoJournalFactOf,
  autoJournalKeyOf,
  isAutoJournalEvent,
  storedEventOf,
  type AutoJournalEventName,
  type StoredAutoJournalEvent,
} from "./accounting-auto-journal-amounts.ts";
import { postJournalFromRuleInTransaction } from "./accounting-journal.service.ts";
import { wouldPostingBeBlockedByClosedPeriod } from "./accounting-period.service.ts";
import { recordAudit } from "./core-audit.ts";
import type { Tx } from "./inventory-ops.shared.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";

type TenantId = ScopedTenantContext["tenant"]["tenantId"];

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
] as const;

/** The outlet has no legal entity yet: parked until finance assigns one. */
class OutletLegalEntityMissing extends Error {
  readonly code = "OUTLET_LEGAL_ENTITY_MISSING";
}

const RETRY_BATCH = 100;
/** Backoff between retries of one parked event (matches inventory GL). */
export const AUTO_JOURNAL_RETRY_AFTER_MS = 10 * 60 * 1000;
const LATE_AUDIT_FIELDS = [
  "journalId",
  "trigger",
  "sourceId",
  "originalDate",
  "entryDate",
] as const;

function parkCodeOf(error: unknown): string | null {
  if (error instanceof OutletLegalEntityMissing) return error.code;
  if (error instanceof AccountingError) return error.code;
  return null;
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
  const stored = storedEventOf({
    id: event.id,
    name: event.name,
    outletId: event.outletId,
    occurredAt: event.occurredAt,
    payload: event.payload,
  });
  return settleAutoJournal(tx, context, stored, now);
}

async function settleAutoJournal(
  tx: Tx,
  context: ScopedTenantContext,
  stored: StoredAutoJournalEvent,
  now: Date,
): Promise<AutoJournalResult> {
  const tenantId = context.tenant.tenantId;
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
    const retryable = (RETRYABLE_CODES as readonly string[]).includes(code);
    const nextRetryAt = retryable
      ? new Date(now.getTime() + AUTO_JOURNAL_RETRY_AFTER_MS)
      : null;
    await tx
      .insert(autoJournalParked)
      .values({
        tenantId,
        outletId: stored.outletId,
        idempotencyKey: key,
        eventId: stored.eventId,
        eventName: stored.eventName,
        payload: { ...stored.payload, occurredAt: stored.occurredAt },
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
  // Posted, or nothing to book any more: either way no longer parked.
  await clearParked(tx, tenantId, key);
  return result;
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

async function postAutoJournal(
  tx: Tx,
  context: ScopedTenantContext,
  stored: StoredAutoJournalEvent,
  key: string,
  now: Date,
): Promise<AutoJournalResult> {
  const tenantId = context.tenant.tenantId;
  const fact = await autoJournalFactOf(tx, tenantId, stored);
  if (!fact) return { status: "ignored" };
  const [outlet] = await tx
    .select({
      legalEntityId: outlets.legalEntityId,
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, fact.outletId)));
  if (!outlet) throw new Error("Outlet of the auto-journal event not found");
  if (!outlet.legalEntityId) throw new OutletLegalEntityMissing();
  const legalEntityId = outlet.legalEntityId;

  const naturalDate = businessDateOf(
    fact.moneyTime,
    outletBusinessDayClock(outlet),
  );
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
  const rule = resolvePostingRule(defaultPostingRules, {
    eventName: fact.ruleEvent,
  });
  const journal = await postJournalFromRuleInTransaction(
    tx,
    context,
    {
      eventName: fact.ruleEvent,
      amounts: fact.amounts,
      legalEntityId,
      outletId: fact.outletId,
      entryDate: entryDate as typeof naturalDate,
      sourceId: fact.sourceId,
      description:
        lateAdjustmentFrom === null
          ? rule.description
          : `${rule.description} (penyesuaian terlambat dari ${lateAdjustmentFrom})`,
      postedBy: null,
      idempotencyKey: key,
      lateAdjustmentFrom,
    },
    now,
  );
  if (lateAdjustmentFrom !== null)
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: fact.outletId,
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
            sourceId: fact.sourceId,
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
          eq(autoJournalParked.retryable, true),
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
