// WS-05 `settlement.reconciled` emitter (1269 C4a, legend-osqou.7; contract:
// packages/shared/src/payment/settlement-events.ts). Finance ties imported
// gateway settlements to the bank statement line that paid them; each
// settlement then emits one event, which the auto-journal books as bank money.
//
// Anything in doubt is refused and left to a manual journal:
// - Gateway reports only, every line matched to POS, no case still open on the
//   report and no late funds of a written-off sale in it.
// - The bank line is free, money in, dated on or after the report's end, on an
//   active account that is the legal entity's mapped bank account (the journal
//   debits that mapping), and equals the sum of the nets to the rupiah.
// - No unmatched document books the same money already: any free journal that
//   debits the bank and credits gateway_clearing (whatever its amount), a
//   journal of the line amount or of one net, or a cash deposit of the line
//   amount, from the report's start up to today.
// - Every line's fee is within the cap of its payment method: the gateway
//   integration config of the outlet (else of the tenant) holds
//   `maxFeeBps_<method>` (basis points of the line) and `maxFeeFlatIdr_<method>`
//   (rupiah, default 0). No number for the method, or an integration that is
//   not active, refuses: a short payment never hides as a fee.
// - One settlement per outlet on one bank line.
// - Once, ever: the match row is kept, and an unmatch leaves a rejection row
//   that blocks both the line and the settlement. The outbox key (aggregate,
//   sequence 2; sequence 1 is `settlement.imported`) is the last guard.
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  createUlid,
  DEFAULT_TIME_ZONE,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { settlementReconciledPayloadSchema } from "@starter/shared/payment";
import {
  reconcileSettlements as reconcileEndpoint,
  settlementReconciledViewSchema,
} from "@starter/shared/payment/admin";
import { db } from "../db/index.ts";
import {
  bankReconciliationCases,
  bankStatementLineMatches,
  bankStatementLines,
  bankStatementMatchRejections,
} from "../db/schema/accounting-cash-bank.ts";
import { paymentIntents } from "../db/schema/payment.ts";
import {
  paymentReconciliationCases as cases,
  paymentReconciliationCorrections as corrections,
} from "../db/schema/payment-admin.ts";
import {
  paymentSettlementLines as lines,
  paymentSettlements as settlements,
} from "../db/schema/payment-settlement.ts";
import { tenantIntegrations } from "../db/schema/platform-integrations.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertTenantScope,
  loadAccountMap,
} from "./accounting-ap-fa-shared.ts";
import {
  applyMatch,
  entityLock,
  hasUnmatchedDocument,
} from "./accounting-bank-matching.ts";
import { loadBankAccount, notFound } from "./accounting-cash-bank-shared.ts";
import type { TenantTransaction } from "./accounting-shared.ts";
import { loadMatchingPolicy } from "./accounting-finance-policy.service.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import {
  assertPaymentPermission,
  EVENT_DESTINATION,
} from "./payment-support.ts";

const REF_TYPE = "gateway_settlement";

const refuse = (message: string) =>
  new HttpError(409, "SETTLEMENT_NOT_RECONCILABLE", message);

type FeeCap = { bps: number; flatIdr: number };

/** A whole number in [0, max]; anything else is no number at all. */
function capNumber(value: unknown, max: number): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
    ? value
    : null;
}

/**
 * The fee cap of one payment method for one outlet's report: the outlet's
 * active integration config of the provider, per key falling back to the
 * tenant's. Null (refuse) when the provider has no active config or the
 * method has neither number, or a number is not a whole, plausible value.
 */
function feeCapOf(
  configs: readonly (Record<string, unknown> | null)[],
  method: string,
): FeeCap | null {
  const pick = (key: string) => {
    for (const config of configs)
      if (config && key in config) return config[key];
    return undefined;
  };
  const bpsRaw = pick(`maxFeeBps_${method}`);
  const flatRaw = pick(`maxFeeFlatIdr_${method}`);
  if (bpsRaw === undefined && flatRaw === undefined) return null;
  const bps = bpsRaw === undefined ? 0 : capNumber(bpsRaw, 10_000);
  const flatIdr = flatRaw === undefined ? 0 : capNumber(flatRaw, 1_000_000_000);
  return bps === null || flatIdr === null ? null : { bps, flatIdr };
}

const todayOf = (now: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

/**
 * Every line's fee is at most its method's cap (see header). The method is the
 * one of the matched payment intent; a line without one cannot be capped.
 */
async function assertFeesWithinCap(
  tx: TenantTransaction,
  tenantId: string,
  report: { id: string; outletId: string; provider: string },
) {
  const integrations = await tx
    .select({
      outletId: tenantIntegrations.outletId,
      config: tenantIntegrations.config,
    })
    .from(tenantIntegrations)
    .where(
      and(
        eq(tenantIntegrations.tenantId, tenantId),
        eq(tenantIntegrations.provider, report.provider as never),
        eq(tenantIntegrations.status, "active"),
        or(
          isNull(tenantIntegrations.outletId),
          eq(tenantIntegrations.outletId, report.outletId),
        ),
      ),
    );
  const configs = [
    integrations.find((row) => row.outletId === report.outletId)?.config,
    integrations.find((row) => row.outletId === null)?.config,
  ].map((config) => (config as Record<string, unknown> | undefined) ?? null);
  const reportLines = await tx
    .select({
      amountIdr: lines.amountIdr,
      feeIdr: lines.feeIdr,
      method: paymentIntents.method,
    })
    .from(lines)
    .leftJoin(
      paymentIntents,
      and(
        eq(paymentIntents.tenantId, lines.tenantId),
        eq(paymentIntents.id, lines.matchedPaymentIntentId),
      ),
    )
    .where(
      and(eq(lines.tenantId, tenantId), eq(lines.settlementId, report.id)),
    );
  for (const line of reportLines) {
    const cap = line.method ? feeCapOf(configs, line.method) : null;
    if (
      !cap ||
      line.feeIdr > Math.ceil((line.amountIdr * cap.bps) / 10_000) + cap.flatIdr
    )
      throw refuse(
        "The fee of a settlement line has no limit configured or is above it.",
      );
  }
}

export async function reconcileSettlements(
  context: ScopedTenantContext,
  actorId: string,
  body: unknown,
  key: string,
) {
  assertTrustedScopedContext(context);
  // A bank line belongs to the legal entity: no outlet-scoped caller.
  assertTenantScope(context);
  const input = reconcileEndpoint.body.parse(body);
  const tenantId = context.tenant.tenantId;
  const matchingPolicy = await loadMatchingPolicy(context);
  return withTenant(db, context, async (tx) => {
    const now = new Date();
    for (const permission of [
      "payment.reconcile",
      "accounting.reconcile",
    ] as const)
      await assertPaymentPermission(
        tx,
        context,
        actorId,
        permission,
        { type: "tenant" },
        now,
      );
    const settlementIds = [...input.settlementIds].sort();

    async function run() {
      // Same lock order as the bank services: entity, then the line.
      const lineFilter = and(
        eq(bankStatementLines.tenantId, tenantId),
        eq(bankStatementLines.id, input.bankStatementLineId),
      );
      const [probe] = await tx
        .select({ bankAccountId: bankStatementLines.bankAccountId })
        .from(bankStatementLines)
        .where(lineFilter);
      if (!probe) throw notFound("Mutasi bank");
      const { legalEntityId } = await loadBankAccount(
        tx,
        tenantId,
        probe.bankAccountId,
      );
      await entityLock(tx, tenantId, legalEntityId);
      const [bankLine] = await tx
        .select()
        .from(bankStatementLines)
        .where(lineFilter)
        .for("update");
      if (!bankLine) throw notFound("Mutasi bank");
      const account = await loadBankAccount(tx, tenantId, probe.bankAccountId);

      const reports = await tx
        .select({
          id: settlements.id,
          outletId: settlements.outletId,
          source: settlements.source,
          provider: settlements.provider,
          periodStart: settlements.periodStart,
          periodEnd: settlements.periodEnd,
          grossIdr: settlements.grossIdr,
          feeIdr: settlements.feeIdr,
          netIdr: settlements.netIdr,
          lineCount: settlements.lineCount,
          legalEntityId: outlets.legalEntityId,
        })
        .from(settlements)
        .innerJoin(
          outlets,
          and(
            eq(outlets.tenantId, settlements.tenantId),
            eq(outlets.id, settlements.outletId),
          ),
        )
        .where(
          and(
            eq(settlements.tenantId, tenantId),
            inArray(settlements.id, settlementIds),
          ),
        )
        .orderBy(settlements.id);
      if (reports.length !== settlementIds.length)
        throw notFound("Laporan settlement");

      if (bankLine.matchStatus !== "unmatched" || bankLine.amountIdr <= 0)
        throw refuse("The bank line is not a free incoming payment.");
      const accountMap = await loadAccountMap(tx, tenantId, legalEntityId);
      const clearingAccountId = accountMap.get("gateway_clearing");
      if (
        !account.isActive ||
        !clearingAccountId ||
        accountMap.get("bank") !== account.glAccountId ||
        reports.some((r) => r.legalEntityId !== legalEntityId)
      )
        throw refuse(
          "The bank account is not the active mapped bank account of the outlet's legal entity.",
        );
      if (
        reports.some((r) => r.source !== "gateway") ||
        new Set(reports.map((r) => r.provider)).size !== 1
      )
        throw refuse("One bank line pays the settlements of one gateway.");
      if (new Set(reports.map((r) => r.outletId)).size !== reports.length)
        throw refuse("One bank line pays one settlement per outlet.");
      if (reports.some((r) => r.periodEnd > bankLine.postedOn))
        throw refuse("The bank line is older than the settlement period.");
      const netIdr = reports.reduce((sum, r) => sum + r.netIdr, 0);
      if (netIdr !== bankLine.amountIdr || reports.some((r) => r.netIdr <= 0))
        throw refuse("The settlements do not add up to the bank line.");

      const from = reports.reduce(
        (min, r) => (r.periodStart < min ? r.periodStart : min),
        bankLine.postedOn,
      );
      if (
        await hasUnmatchedDocument(tx, tenantId, account, {
          lineAmountIdr: bankLine.amountIdr,
          journalAmountsIdr: [
            bankLine.amountIdr,
            ...reports.map((r) => r.netIdr),
          ],
          clearingAccountId,
          from,
          // A journal dated after the line (month end, a late fix) books the
          // same money just as well: the window runs up to today.
          to: [bankLine.postedOn, todayOf(now)].reduce((a, b) =>
            a > b ? a : b,
          ),
          toleranceDays: matchingPolicy.dateToleranceDays,
        })
      )
        throw refuse(
          "A journal or cash deposit of this amount is not matched yet; match or reverse it first.",
        );

      // Once, ever: matched now, or matched before and unmatched since.
      const usedMatch = await tx
        .select({ id: bankStatementLineMatches.id })
        .from(bankStatementLineMatches)
        .where(
          and(
            eq(bankStatementLineMatches.tenantId, tenantId),
            eq(bankStatementLineMatches.refType, REF_TYPE),
            inArray(bankStatementLineMatches.refId, settlementIds),
          ),
        )
        .limit(1);
      const usedBefore = await tx
        .select({ id: bankStatementMatchRejections.id })
        .from(bankStatementMatchRejections)
        .where(
          and(
            eq(bankStatementMatchRejections.tenantId, tenantId),
            eq(bankStatementMatchRejections.refType, REF_TYPE),
            or(
              eq(bankStatementMatchRejections.lineId, bankLine.id),
              inArray(bankStatementMatchRejections.refId, settlementIds),
            ),
          ),
        )
        .limit(1);
      if (usedMatch.length > 0 || usedBefore.length > 0)
        throw refuse(
          "The bank line or a settlement was already reconciled; correct it with a manual journal.",
        );

      // Imports of these outlets wait, so no case changes under the checks.
      for (const report of [...reports].sort((a, b) =>
        a.outletId < b.outletId ? -1 : 1,
      ))
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`settlement:${tenantId}:${report.source}:${report.provider}:${report.outletId}`}, 0))`,
        );
      for (const report of reports) {
        const [total] = await tx
          .select({
            matched: sql<number>`count(*) FILTER (WHERE ${lines.matchStatus} = 'matched')::int`,
            all: sql<number>`count(*)::int`,
            grossIdr: sql<number>`coalesce(sum(${lines.amountIdr}), 0)::float8`,
            feeIdr: sql<number>`coalesce(sum(${lines.feeIdr}), 0)::float8`,
          })
          .from(lines)
          .where(
            and(
              eq(lines.tenantId, tenantId),
              eq(lines.settlementId, report.id),
            ),
          );
        if (
          !total ||
          total.all !== report.lineCount ||
          total.matched !== total.all ||
          total.grossIdr !== report.grossIdr ||
          total.feeIdr !== report.feeIdr
        )
          throw refuse("Every settlement line must match a POS transaction.");
        await assertFeesWithinCap(tx, tenantId, report);
        const openCase = await tx
          .select({ id: cases.id })
          .from(cases)
          .where(
            and(
              eq(cases.tenantId, tenantId),
              eq(cases.settlementId, report.id),
              inArray(cases.status, ["open", "pending_approval"]),
            ),
          )
          .limit(1);
        // A written-off sale is already out of clearing: never book it twice.
        const lateFunds = await tx
          .select({ id: corrections.id })
          .from(corrections)
          .where(
            and(
              eq(corrections.tenantId, tenantId),
              eq(corrections.settlementId, report.id),
            ),
          )
          .limit(1);
        const bankCase = await tx
          .select({ id: bankReconciliationCases.id })
          .from(bankReconciliationCases)
          .where(
            and(
              eq(bankReconciliationCases.tenantId, tenantId),
              inArray(bankReconciliationCases.status, [
                "open",
                "in_progress",
                "written_off",
              ]),
              sql`${bankReconciliationCases.refs} @> ${JSON.stringify([{ type: REF_TYPE, id: report.id }])}::jsonb`,
            ),
          )
          .limit(1);
        if (openCase.length + lateFunds.length + bankCase.length > 0)
          throw refuse("The settlement still has a reconciliation case.");
      }

      await applyMatch(tx, tenantId, {
        bankAccountId: account.id,
        lineId: bankLine.id,
        documents: reports.map((r) => ({
          ref: { type: REF_TYPE, id: r.id },
          amountIdr: r.netIdr,
          date: bankLine.postedOn,
        })),
        source: "manual",
        actorId,
      });
      for (const report of reports) {
        const event = eventEnvelopeSchema.parse({
          id: createUlid(now.getTime()),
          tenantId,
          outletId: report.outletId,
          name: "settlement.reconciled",
          version: 1,
          aggregateType: "settlement",
          aggregateId: report.id,
          sequence: 2,
          occurredAt: now.toISOString(),
          actor: { type: "user", id: actorId },
          deviceId: null,
          idempotencyKey: `settlement.reconciled:${report.id}`,
          payloadSchemaRef: "settlement.reconciled.v1",
          payload: settlementReconciledPayloadSchema.parse({
            settlementId: report.id,
            provider: report.provider,
            outletId: report.outletId,
            settledOn: bankLine.postedOn,
            grossIdr: report.grossIdr,
            feeIdr: report.feeIdr,
            netSettledIdr: report.netIdr,
          }),
        });
        await appendOutbox(tx, context, {
          id: createUlid(now.getTime()),
          event,
          destination: EVENT_DESTINATION,
          direction: null,
          peerId: null,
        });
        await recordAudit(
          tx,
          context,
          {
            id: createUlid(now.getTime()),
            tenantId,
            outletId: report.outletId,
            actorType: "user",
            actorId,
            deviceId: null,
            action: "payment.settlement_reconciled",
            objectType: "payment_settlement",
            objectId: report.id,
            reason: null,
            maskedChanges: {
              before: {},
              after: {
                bankStatementLineId: bankLine.id,
                provider: report.provider,
                netIdr: report.netIdr,
              },
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y",
            createdAt: now.toISOString(),
          },
          ["bankStatementLineId", "provider", "netIdr"],
        );
      }
      return settlementReconciledViewSchema.parse({
        bankStatementLineId: bankLine.id,
        settledOn: bankLine.postedOn,
        amountIdr: bankLine.amountIdr,
        settlements: reports.map((r) => ({
          settlementId: r.id,
          outletId: r.outletId,
          grossIdr: r.grossIdr,
          feeIdr: r.feeIdr,
          netIdr: r.netIdr,
        })),
      });
    }

    return idempotentPaymentAdminWrite(
      tx,
      context,
      actorId,
      key,
      "reconciliation.reconcile_settlements",
      { ...input, settlementIds },
      run,
    );
  });
}
