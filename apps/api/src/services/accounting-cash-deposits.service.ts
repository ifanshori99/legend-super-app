// Cash deposits and undeposited-cash alerts (bead legend-fnxl.5, WS-07; PRD
// v1.7 §3.19 Kas & Bank, ACC-05). Contract: `@starter/shared/accounting`
// banking.ts, endpoints `listCashDeposits` / `createCashDeposit` /
// `listUndepositedCashAlerts`.
//
// - A deposit is outlet-owned: `cash_deposits` has the outlet RLS policy
//   (TEN-03), so an outlet-scoped caller reads and writes its own outlets
//   only. The outlet's legal entity must be the bank account's.
// - Recording takes the entity lock first (docs/DECISIONS.md "WS-07"), is
//   idempotent per key and then runs `autoMatchBankAccount`, so a deposit
//   recorded after its statement was imported still finds its line.
//   Posting the deposit journal is out of scope (legend-9pz9).
// - Collections are not a table: per (outlet, business date) the closed
//   `pos_shifts` give cash sales - cash refunds - petty cash out, floored at
//   0. Deposits of every status count. The alert is computed on read with the
//   shared `undepositedCashAlerts` and the tenant's `cashDepositPolicy`.

import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  createCashDepositInputSchema,
  undepositedCashAlerts,
  type CashCollection,
  type CashDeposit,
  type UndepositedCashAlert,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  businessDateSchema,
  CoreError,
  decodeCursor,
  encodeCursor,
  idr,
  outletIdSchema,
  outletIdsForQuery,
  uuidSchema,
  type CursorPage,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import { cashDeposits } from "../db/schema/accounting-cash-bank.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertOutletReach,
  auditApFa,
  idempotentCommand,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";
import {
  autoMatchBankAccount,
  entityLock,
} from "./accounting-bank-matching.ts";
import {
  cashDepositDto,
  loadBankAccount,
  notFound,
} from "./accounting-cash-bank-shared.ts";
import {
  loadCashDepositPolicy,
  loadMatchingPolicy,
} from "./accounting-finance-policy.service.ts";
import { requireLegalEntity } from "./accounting-shared.ts";

type Row = Record<string, unknown>;
const rowsOf = (result: unknown): Row[] =>
  (result as { rows: Row[] }).rows ?? [];

export type CashDepositListQuery = {
  legalEntityId: string;
  outletId?: string;
  from: string;
  to: string;
  cursor?: string;
  limit: number;
};

/** Outlet ids the caller may see: filter for SQL, or null for "all". */
function outletFilter(
  context: ScopedTenantContext,
  outletId: string | undefined,
): readonly string[] | null {
  const filter = outletIdsForQuery(
    context.outletScope,
    outletId ? [outletId] : undefined,
  );
  return filter.kind === "all" ? null : filter.outletIds;
}

const outletIn = (column: SQL, ids: readonly string[]) =>
  ids.length === 0
    ? sql`FALSE`
    : sql`${column} IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`;

/**
 * Deposits of one legal entity whose local deposit date (outlet time zone)
 * is in [from, to], newest first, keyset-paged on (deposited_at, id).
 */
export async function listCashDeposits(
  context: ScopedTenantContext,
  query: CashDepositListQuery,
): Promise<CursorPage<CashDeposit>> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, query.legalEntityId);
    const reach = outletFilter(context, query.outletId);
    const filters: SQL[] = [
      eq(cashDeposits.tenantId, tenantId),
      eq(cashDeposits.legalEntityId, query.legalEntityId),
      sql`(${cashDeposits.depositedAt} AT TIME ZONE ${outlets.timezone})::date
            BETWEEN ${query.from}::date AND ${query.to}::date`,
    ];
    if (reach) filters.push(outletIn(sql`${cashDeposits.outletId}`, reach));
    if (query.cursor) {
      let keys: ReturnType<typeof decodeCursor>;
      try {
        keys = decodeCursor(query.cursor);
      } catch {
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      }
      const at = typeof keys[0] === "string" ? keys[0] : "";
      const id = uuidSchema.safeParse(keys[1]);
      if (Number.isNaN(Date.parse(at)) || !id.success)
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        sql`(${cashDeposits.depositedAt}, ${cashDeposits.id}) < (${at}::timestamptz, ${id.data}::uuid)`,
      );
    }
    const rows = await tx
      .select({ deposit: cashDeposits })
      .from(cashDeposits)
      .innerJoin(
        outlets,
        and(
          eq(outlets.tenantId, cashDeposits.tenantId),
          eq(outlets.id, cashDeposits.outletId),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(cashDeposits.depositedAt), desc(cashDeposits.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(({ deposit }) => cashDepositDto(deposit)),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([
                last.deposit.depositedAt.toISOString(),
                last.deposit.id,
              ])
            : null,
      },
    };
  });
}

/**
 * Records a deposit (contract `createCashDeposit`); idempotent per key,
 * audited, then auto-matched against the account's statement lines.
 */
export async function createCashDeposit(
  context: ScopedTenantContext,
  rawInput: unknown,
  actorId: UserId,
): Promise<CashDeposit> {
  const input = createCashDepositInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertOutletReach(context, input.outletId);
  // The loader opens its own transaction: read the policy before ours.
  const matchingPolicy = await loadMatchingPolicy(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const [outlet] = await tx
      .select({ legalEntityId: outlets.legalEntityId })
      .from(outlets)
      .where(
        and(eq(outlets.tenantId, tenantId), eq(outlets.id, input.outletId)),
      )
      .limit(1);
    if (!outlet) throw notFound("Outlet");
    return idempotentCommand(
      tx,
      context,
      {
        key: input.idempotencyKey,
        operation: "cash_deposit.record",
        request: input,
      },
      async () => {
        // Entity lock and account checks after the replay check, same order
        // as import and unmatch: a replay never trips on a later change.
        const bankAccount = await loadBankAccount(
          tx,
          tenantId,
          input.bankAccountId,
        );
        if (outlet.legalEntityId !== bankAccount.legalEntityId)
          throw new CoreError(
            "VALIDATION_ERROR",
            "Outlet dan rekening bank harus milik badan usaha yang sama.",
          );
        if (!bankAccount.isActive)
          throw new CoreError(
            "VALIDATION_ERROR",
            "Rekening bank ini tidak aktif.",
          );
        await entityLock(tx, tenantId, bankAccount.legalEntityId);
        const [created] = await tx
          .insert(cashDeposits)
          .values({
            tenantId,
            legalEntityId: bankAccount.legalEntityId,
            outletId: input.outletId,
            bankAccountId: bankAccount.id,
            amountIdr: input.amountIdr,
            coversFrom: input.coversFrom,
            coversTo: input.coversTo,
            depositedAt: new Date(input.depositedAt),
            depositedBy: actorId,
            slipReference: input.slipReference,
          })
          .returning();
        if (!created) throw new Error("Cash deposit insert returned no row.");
        await auditApFa(tx, context, {
          actorId,
          action: "accounting.cash_deposit.recorded",
          objectType: "cash_deposit",
          objectId: created.id,
          outletId: created.outletId,
          before: null,
          after: {
            status: created.status,
            amountIdr: created.amountIdr,
          },
        });
        await autoMatchBankAccount(
          tx,
          context,
          bankAccount,
          matchingPolicy,
          actorId,
        );
        const [current] = await tx
          .select()
          .from(cashDeposits)
          .where(
            and(
              eq(cashDeposits.tenantId, tenantId),
              eq(cashDeposits.id, created.id),
            ),
          )
          .limit(1);
        return cashDepositDto(current ?? created);
      },
    );
  });
}

/** Closed-shift cash per (outlet, business date), see header. */
async function loadCollections(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  asOf: string,
  reach: readonly string[] | null,
): Promise<CashCollection[]> {
  const rows = rowsOf(
    await tx.execute(sql`
      SELECT s.outlet_id, s.business_date::text AS business_date,
             GREATEST(SUM(s.cash_sales_idr - s.cash_refunds_idr - s.cash_out_idr + s.variance_idr), 0)::text AS cash
      FROM pos_shifts s
      JOIN outlets o ON o.tenant_id = s.tenant_id AND o.id = s.outlet_id
      WHERE s.tenant_id = ${tenantId}
        AND o.legal_entity_id = ${legalEntityId}
        AND s.status = 'closed'
        AND s.business_date <= ${asOf}::date
        ${reach ? sql`AND ${outletIn(sql`s.outlet_id`, reach)}` : sql``}
      GROUP BY s.outlet_id, s.business_date`),
  );
  return rows.map((row) => ({
    outletId: outletIdSchema.parse(row.outlet_id),
    businessDate: businessDateSchema.parse(row.business_date),
    cashIdr: idr(Number(row.cash)),
  }));
}

/** Deposits of the entity (every status) made on or before `asOf`. */
async function loadDepositTotals(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  asOf: string,
  reach: readonly string[] | null,
) {
  const rows = rowsOf(
    await tx.execute(sql`
      SELECT d.outlet_id, d.amount_idr::text AS amount
      FROM cash_deposits d
      JOIN outlets o ON o.tenant_id = d.tenant_id AND o.id = d.outlet_id
      WHERE d.tenant_id = ${tenantId}
        AND d.legal_entity_id = ${legalEntityId}
        AND (d.deposited_at AT TIME ZONE o.timezone)::date <= ${asOf}::date
        ${reach ? sql`AND ${outletIn(sql`d.outlet_id`, reach)}` : sql``}`),
  );
  return rows.map((row) => ({
    outletId: outletIdSchema.parse(row.outlet_id),
    amountIdr: Number(row.amount),
  }));
}

/**
 * ACC-05 warnings: business dates whose cash is still undeposited after the
 * tenant's `maxDaysUndeposited`, for the outlets the caller reaches.
 */
export async function listUndepositedCashAlerts(
  context: ScopedTenantContext,
  query: { legalEntityId: string; outletId?: string; asOf: string },
): Promise<UndepositedCashAlert[]> {
  assertTrustedScopedContext(context);
  // The loader opens its own transaction: read the policy before ours.
  const policy = await loadCashDepositPolicy(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, query.legalEntityId);
    const reach = outletFilter(context, query.outletId);
    const [collections, deposits] = await Promise.all([
      loadCollections(tx, tenantId, query.legalEntityId, query.asOf, reach),
      loadDepositTotals(tx, tenantId, query.legalEntityId, query.asOf, reach),
    ]);
    return undepositedCashAlerts(collections, deposits, query.asOf, policy);
  });
}
