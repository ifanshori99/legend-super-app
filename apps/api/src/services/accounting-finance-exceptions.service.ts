// Finance exceptions list (bead legend-4oclu; brief
// docs/briefs/662-finance-exceptions-contract.md). Read-only: five kinds of
// rows finance must look at, each from its own source table and each listed
// exactly once. Every query filters `tenant_id` from the session context and
// the caller's outlet reach; no payload or bank data leaves this file.
//
// - `summary` is counted over every matching row; `items` is the newest
//   MAX_ITEMS of them, so a cut list never changes the totals.
// - Edge rows are dated in their outlet's time zone (orders: their business
//   date). A payout posting has no outlet and is dated in Asia/Jakarta.
// - The payout kind is tenant-wide, so it is shown only to a caller without
//   an outlet limit and never when an outlet filter is asked for.

import { sql, type SQL } from "drizzle-orm";
import {
  CoreError,
  assertTrustedScopedContext,
  outletIdsForQuery,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type {
  FinanceExceptionItemDto,
  FinanceExceptionSummaryDto,
  FinanceExceptionsDto,
} from "@starter/shared/types";
import {
  FINANCE_EXCEPTIONS_MAX_ITEMS,
  type FinanceExceptionKind,
  type FinanceExceptionsQuery,
} from "@starter/shared/validators/finance-exceptions";
import { db } from "../db";
import { withTenant } from "../db/tenant.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";

type Row = Record<string, unknown>;
const rowsOf = (result: unknown): Row[] =>
  (result as { rows: Row[] }).rows ?? [];

const PAYOUT_TIME_ZONE = "Asia/Jakarta";
const MAX_ITEMS = FINANCE_EXCEPTIONS_MAX_ITEMS;

type Collected = {
  kind: FinanceExceptionKind;
  count: number;
  knownAmountCount: number;
  amountIdr: number;
  items: FinanceExceptionItemDto[];
};

const emptyResult = (): FinanceExceptionsDto => ({
  summary: [],
  items: [],
  truncated: false,
});

/** Outlet ids to filter on (null = every outlet), or "none" if out of scope. */
function reachOf(
  context: ScopedTenantContext,
  outletId: string | undefined,
): readonly string[] | null | "none" {
  try {
    const filter = outletIdsForQuery(
      context.outletScope,
      outletId ? [outletId] : undefined,
    );
    if (filter.kind === "all") return null;
    return filter.outletIds.length === 0 ? "none" : filter.outletIds;
  } catch (error) {
    if (error instanceof CoreError && error.code === "OUTLET_OUT_OF_SCOPE")
      return "none";
    throw error;
  }
}

const outletClause = (column: SQL, reach: readonly string[] | null): SQL =>
  reach === null
    ? sql`TRUE`
    : sql`${column} IN (${sql.join(
        reach.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`;

const num = (value: unknown): number => Number(value ?? 0);
const iso = (value: unknown): string => new Date(value as string).toISOString();

type Source = {
  from: SQL;
  where: SQL;
  at: SQL;
  outlet: SQL;
  ref: SQL;
  amount: SQL;
  detail: SQL;
};

type Executor = { execute: (query: SQL) => Promise<unknown> };

const toItem = (
  kind: FinanceExceptionKind,
  refType: string,
  row: Row,
): FinanceExceptionItemDto => ({
  kind,
  outletId: (row.outlet_id as string | null) ?? null,
  occurredAt: iso(row.occurred_at),
  refType,
  refId: String(row.ref_id),
  amountIdr:
    row.amount === null || row.amount === undefined ? null : num(row.amount),
  detail: (row.detail as string | null) ?? null,
});

/** Full count and sum of `source`, plus its newest MAX_ITEMS + 1 rows. */
async function collectSql(
  tx: Executor,
  kind: FinanceExceptionKind,
  refType: string,
  source: Source,
): Promise<Collected> {
  const [totals] = rowsOf(
    await tx.execute(
      sql`SELECT count(*)::int AS count, count(${source.amount})::int AS known_amount_count,
                 coalesce(sum(${source.amount}), 0)::bigint AS amount
            FROM ${source.from} WHERE ${source.where}`,
    ),
  );
  const rows = rowsOf(
    await tx.execute(
      sql`SELECT ${source.at} AS occurred_at, ${source.ref} AS ref_id,
                 ${source.amount} AS amount, ${source.detail} AS detail,
                 ${source.outlet} AS outlet_id
            FROM ${source.from} WHERE ${source.where}
           ORDER BY ${source.at} DESC, ${source.ref} DESC
           LIMIT ${MAX_ITEMS + 1}`,
    ),
  );
  return {
    kind,
    count: num(totals?.count),
    knownAmountCount: num(totals?.known_amount_count),
    amountIdr: num(totals?.amount),
    items: rows.map((row) => toItem(kind, refType, row)),
  };
}

type Scope = {
  tenantId: string;
  from: string;
  to: string;
  reach: readonly string[] | null;
};

/** Edge orders with tax but no tax snapshot; membership comes from the join. */
function taxUnsnapshotted(tx: Executor, scope: Scope) {
  return collectSql(tx, "edge_tax_unsnapshotted", "order", {
    from: sql`edge_order_ingests i
                JOIN orders ord ON ord.tenant_id = i.tenant_id AND ord.id = i.order_id`,
    where: sql`i.tenant_id = ${scope.tenantId}::uuid
      AND i.state = 'ingested'
      AND ord.tax_idr > 0
      AND NOT EXISTS (
        SELECT 1 FROM tax_snapshots t
         WHERE t.tenant_id = i.tenant_id AND t.source_type = 'order'
           AND t.source_id = ord.id)
      AND ord.business_date BETWEEN ${scope.from}::date AND ${scope.to}::date
      AND ${outletClause(sql`i.outlet_id`, scope.reach)}`,
    at: sql`i.created_at`,
    outlet: sql`i.outlet_id`,
    ref: sql`i.order_id::text`,
    amount: sql`ord.tax_idr`,
    detail: sql`i.tax_flag`,
  });
}

/** Receipt skips; the amount is the order total when the order exists. */
function receiptSkipped(tx: Executor, scope: Scope) {
  return collectSql(tx, "edge_receipt_skipped", "receipt_skip", {
    from: sql`edge_receipt_skips s
                JOIN outlets o ON o.tenant_id = s.tenant_id AND o.id = s.outlet_id
                LEFT JOIN orders ord ON ord.tenant_id = s.tenant_id AND ord.id = s.order_id`,
    where: sql`s.tenant_id = ${scope.tenantId}::uuid
      AND (s.created_at AT TIME ZONE o.timezone)::date
          BETWEEN ${scope.from}::date AND ${scope.to}::date
      AND ${outletClause(sql`s.outlet_id`, scope.reach)}`,
    at: sql`s.created_at`,
    outlet: sql`s.outlet_id`,
    ref: sql`s.order_id::text || ':' || s.receipt_number || ':' || s.reason`,
    amount: sql`ord.total_idr`,
    detail: sql`NULL::text`,
  });
}

function linkDeadLetters(tx: Executor, scope: Scope) {
  return collectSql(tx, "edge_link_dead_letter", "link_event", {
    from: sql`edge_link_dead_letters d
                JOIN outlets o ON o.tenant_id = d.tenant_id AND o.id = d.outlet_id`,
    where: sql`d.tenant_id = ${scope.tenantId}::uuid
      AND (d.created_at AT TIME ZONE o.timezone)::date
          BETWEEN ${scope.from}::date AND ${scope.to}::date
      AND ${outletClause(sql`d.outlet_id`, scope.reach)}`,
    at: sql`d.created_at`,
    outlet: sql`d.outlet_id`,
    ref: sql`d.event_id::text`,
    amount: sql`NULL::bigint`,
    detail: sql`NULL::text`,
  });
}

/**
 * Parked unsupported voids. The order id sits in the event payload as a ULID,
 * so the totals are looked up in TypeScript (ulidToUuid) from the tenant's own
 * orders; an id that is not a ULID or not found gives a null amount.
 */
async function voidUnsupported(tx: Executor, scope: Scope): Promise<Collected> {
  const parked = rowsOf(
    await tx.execute(
      sql`SELECT p.idempotency_key AS ref_id, p.outlet_id, p.last_failed_at AS occurred_at,
                 p.payload ->> 'orderId' AS order_ulid
            FROM auto_journal_parked p
            JOIN outlets o ON o.tenant_id = p.tenant_id AND o.id = p.outlet_id
           WHERE p.tenant_id = ${scope.tenantId}::uuid
             AND p.error_code = 'AUTO_JOURNAL_VOID_UNSUPPORTED'
             AND (p.last_failed_at AT TIME ZONE o.timezone)::date
                 BETWEEN ${scope.from}::date AND ${scope.to}::date
             AND ${outletClause(sql`p.outlet_id`, scope.reach)}
           ORDER BY p.last_failed_at DESC, p.idempotency_key DESC`,
    ),
  );
  const orderIds = new Map<string, string>();
  for (const row of parked) {
    const ulid = row.order_ulid;
    if (typeof ulid !== "string") continue;
    try {
      orderIds.set(ulid, ulidToUuid(ulid));
    } catch {
      // Not a ULID: no order to find.
    }
  }
  const totals = new Map<string, number>();
  if (orderIds.size > 0) {
    const found = rowsOf(
      await tx.execute(
        sql`SELECT id::text AS id, total_idr FROM orders
             WHERE tenant_id = ${scope.tenantId}::uuid
               AND id IN (${sql.join(
                 [...new Set(orderIds.values())].map((id) => sql`${id}::uuid`),
                 sql`, `,
               )})`,
      ),
    );
    for (const row of found) totals.set(String(row.id), num(row.total_idr));
  }
  const items = parked.map((row) => {
    const uuid =
      typeof row.order_ulid === "string"
        ? orderIds.get(row.order_ulid)
        : undefined;
    return toItem("edge_void_unsupported", "auto_journal", {
      ...row,
      amount: uuid === undefined ? null : (totals.get(uuid) ?? null),
    });
  });
  return {
    kind: "edge_void_unsupported",
    count: items.length,
    knownAmountCount: items.filter((item) => item.amountIdr !== null).length,
    amountIdr: items.reduce((sum, item) => sum + (item.amountIdr ?? 0), 0),
    items,
  };
}

/** Whole-rupiah fee of a posting; an unreadable or tampered value is null. */
function postingFee(
  tenantId: string,
  row: { id: string; total_encrypted: Buffer; pii_key_version: number },
): number | null {
  try {
    const total = JSON.parse(
      openPayrollValue(
        row.total_encrypted,
        {
          tenantId,
          table: "payroll_payout_gl_postings",
          rowId: row.id,
          field: "total",
        },
        row.pii_key_version,
      ),
    ) as { feeIdr?: unknown };
    const fee = Number(total.feeIdr);
    return Number.isSafeInteger(fee) && fee >= 0 ? fee : null;
  } catch {
    return null;
  }
}

/** Postings whose bank fee was skipped; tenant-wide, with the batch id as detail. */
async function payoutFeeNotPosted(
  tx: Executor,
  scope: Scope,
): Promise<Collected> {
  const rows = rowsOf(
    await tx.execute(
      sql`SELECT id::text AS id, batch_id::text AS batch_id, posted_at AS occurred_at,
                 total_encrypted, pii_key_version
            FROM payroll_payout_gl_postings
           WHERE tenant_id = ${scope.tenantId}::uuid
             AND fee_posted = false
             AND (posted_at AT TIME ZONE ${PAYOUT_TIME_ZONE})::date
                 BETWEEN ${scope.from}::date AND ${scope.to}::date
           ORDER BY posted_at DESC, id DESC`,
    ),
  );
  const items = rows.map((row) =>
    toItem("payout_fee_not_posted", "payout_posting", {
      occurred_at: row.occurred_at,
      ref_id: row.id,
      outlet_id: null,
      detail: row.batch_id,
      amount: postingFee(scope.tenantId, {
        id: String(row.id),
        total_encrypted: row.total_encrypted as Buffer,
        pii_key_version: num(row.pii_key_version),
      }),
    }),
  );
  return {
    kind: "payout_fee_not_posted",
    count: items.length,
    knownAmountCount: items.filter((item) => item.amountIdr !== null).length,
    amountIdr: items.reduce((sum, item) => sum + (item.amountIdr ?? 0), 0),
    items,
  };
}

/**
 * The exceptions of the window for the caller's outlets. Read-only. A tenant
 * wide caller also sees the outlet-less payout kind (unless it filters by an
 * outlet); an outlet outside the caller's reach shows nothing.
 */
export async function listFinanceExceptions(
  context: ScopedTenantContext,
  query: FinanceExceptionsQuery,
): Promise<FinanceExceptionsDto> {
  assertTrustedScopedContext(context);
  const reach = reachOf(context, query.outletId);
  if (reach === "none") return emptyResult();
  const scope: Scope = {
    tenantId: context.tenant.tenantId,
    from: query.from,
    to: query.to,
    reach,
  };
  const wants = (kind: FinanceExceptionKind) =>
    query.kind === undefined || query.kind === kind;
  const includePayout =
    wants("payout_fee_not_posted") &&
    context.outletScope.kind === "tenant" &&
    query.outletId === undefined;

  const collected = await withTenant(db, context, async (tx) => {
    const parts: Collected[] = [];
    if (wants("edge_tax_unsnapshotted"))
      parts.push(await taxUnsnapshotted(tx, scope));
    if (wants("edge_void_unsupported"))
      parts.push(await voidUnsupported(tx, scope));
    if (wants("edge_receipt_skipped"))
      parts.push(await receiptSkipped(tx, scope));
    if (wants("edge_link_dead_letter"))
      parts.push(await linkDeadLetters(tx, scope));
    if (includePayout) parts.push(await payoutFeeNotPosted(tx, scope));
    return parts;
  });

  const summary: FinanceExceptionSummaryDto[] = collected
    .filter((part) => part.count > 0)
    .map(({ kind, count, knownAmountCount, amountIdr }) => ({
      kind,
      count,
      knownAmountCount,
      amountIdr,
    }));
  const total = collected.reduce((sum, part) => sum + part.count, 0);
  const items = collected
    .flatMap((part) => part.items)
    .sort(
      (a, b) =>
        Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
        (a.refId < b.refId ? 1 : a.refId > b.refId ? -1 : 0),
    )
    .slice(0, MAX_ITEMS);
  return { summary, items, truncated: total > MAX_ITEMS };
}
