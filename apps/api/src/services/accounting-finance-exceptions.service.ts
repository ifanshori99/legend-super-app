// Finance exceptions list (bead legend-4oclu; brief
// docs/briefs/662-finance-exceptions-contract.md). Read-only: six kinds of
// rows finance must look at, each from its own source table and each listed
// exactly once. Every query filters `tenant_id` from the session context and
// the caller's outlet reach; no payload or bank data leaves this file.
//
// - `summary` is counted over every matching row; `items` is the newest
//   MAX_ITEMS of them, so a cut list never changes the totals.
// - Edge rows are dated in their outlet's time zone (orders: their business
//   date). A payout posting has no outlet and is dated in Asia/Jakarta.
// - `receipt_pending_stale` is not dated by the window: it lists every parked
//   auto-journal still waiting for its receipt a day after its first failure.
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
  FinanceExceptionReceiptPendingDto,
  FinanceExceptionSummaryDto,
  FinanceExceptionsDto,
} from "@starter/shared/types";
import {
  FINANCE_EXCEPTIONS_MAX_ITEMS,
  RECEIPT_PENDING_STALE_AFTER_HOURS,
  type FinanceExceptionKind,
  type FinanceExceptionsQuery,
} from "@starter/shared/validators/finance-exceptions";
import { db } from "../db";
import { withTenant } from "../db/tenant.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import { EVENT_DESTINATION } from "./payment-support.ts";

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OutboxState = FinanceExceptionReceiptPendingDto["outboxState"];
/** Worst state wins when an intent has more than one payment.paid row. */
const OUTBOX_RANK: Record<OutboxState, number> = {
  delivered: 0,
  missing: 1,
  pending: 2,
  dead_lettered: 3,
};

/**
 * Parked auto-journals waiting for a receipt (AUTO_JOURNAL_RECEIPT_PENDING)
 * for more than a day since their first failure (legend-z13t). Not dated by
 * the window. Each row carries its order, its payment intent and the state of
 * that intent's payment.paid outbox row (what the sweep waits for). The amount
 * is the payment intent's amount_idr, falling back to the order total when the
 * intent is not found (per tenant and outlet of the parked row). The order
 * id sits in the payload as a ULID, so orders are looked up like
 * voidUnsupported does. Read-only.
 */
async function receiptPendingStale(
  tx: Executor,
  scope: Scope,
): Promise<Collected> {
  const parked = rowsOf(
    await tx.execute(
      sql`SELECT p.idempotency_key AS ref_id, p.outlet_id, p.first_failed_at AS occurred_at,
                 p.event_name, p.payload ->> 'refundId' AS refund_id,
                 p.payload ->> 'orderId' AS order_ulid,
                 coalesce(p.payload ->> 'paymentIntentId', p.payload ->> 'intentId') AS payload_intent
            FROM auto_journal_parked p
           WHERE p.tenant_id = ${scope.tenantId}::uuid
             AND p.error_code = 'AUTO_JOURNAL_RECEIPT_PENDING'
             AND p.first_failed_at < now() - make_interval(hours => ${RECEIPT_PENDING_STALE_AFTER_HOURS}::int)
             AND ${outletClause(sql`p.outlet_id`, scope.reach)}
           ORDER BY p.first_failed_at DESC, p.idempotency_key DESC`,
    ),
  );
  const orderUuids = new Map<string, string>();
  for (const row of parked) {
    const ulid = row.order_ulid;
    if (typeof ulid !== "string") continue;
    try {
      orderUuids.set(ulid, ulidToUuid(ulid));
    } catch {
      // Not a ULID: no order to find.
    }
  }
  const orders = new Map<string, { total: number; intentId: string | null }>();
  if (orderUuids.size > 0) {
    const found = rowsOf(
      await tx.execute(
        sql`SELECT id::text AS id, outlet_id::text AS outlet_id, total_idr,
                   payment_intent_id::text AS intent_id
              FROM orders
             WHERE tenant_id = ${scope.tenantId}::uuid
               AND outlet_id IN (${sql.join(
                 [...new Set(parked.map((row) => String(row.outlet_id)))].map(
                   (id) => sql`${id}::uuid`,
                 ),
                 sql`, `,
               )})
               AND id IN (${sql.join(
                 [...new Set(orderUuids.values())].map(
                   (id) => sql`${id}::uuid`,
                 ),
                 sql`, `,
               )})`,
      ),
    );
    for (const row of found)
      orders.set(`${String(row.outlet_id)}:${String(row.id)}`, {
        total: num(row.total_idr),
        intentId: (row.intent_id as string | null) ?? null,
      });
  }
  // A POS sale pays through pos_order_tenders (orders.payment_intent_id is
  // null for POS); an order may carry several intents (replaced QR, split).
  // Only captured tenders count: the journal waits for those alone.
  const tenderIntents = new Map<string, string[]>();
  if (orderUuids.size > 0) {
    const tenders = rowsOf(
      await tx.execute(
        sql`SELECT order_id::text AS order_id, outlet_id::text AS outlet_id,
                   payment_intent_id::text AS intent_id
              FROM pos_order_tenders
             WHERE tenant_id = ${scope.tenantId}::uuid
               AND outlet_id IN (${sql.join(
                 [...new Set(parked.map((row) => String(row.outlet_id)))].map(
                   (id) => sql`${id}::uuid`,
                 ),
                 sql`, `,
               )})
               AND order_id IN (${sql.join(
                 [...new Set(orderUuids.values())].map(
                   (id) => sql`${id}::uuid`,
                 ),
                 sql`, `,
               )})
               AND payment_intent_id IS NOT NULL
               AND status = 'captured'
             ORDER BY requested_at, id`,
      ),
    );
    for (const row of tenders) {
      const key = `${String(row.outlet_id)}:${String(row.order_id)}`;
      const list = tenderIntents.get(key) ?? [];
      list.push(String(row.intent_id).toLowerCase());
      tenderIntents.set(key, list);
    }
  }
  // Mirror sessionDepositAt's receipt graph without its locks or posting
  // checks. A reused DP can connect this sale to receipts on an older session.
  // Keep the sale bound in SQL so credit uses after it (even by a microsecond)
  // cannot make an unrelated receipt appear in this read-only report.
  const depositIntents = new Map<string, string[]>();
  if (orderUuids.size > 0) {
    const deposits = rowsOf(
      await tx.execute(sql`
        WITH RECURSIVE scoped_orders AS (
          SELECT o.id, o.tenant_id, o.outlet_id, o.table_session_id, o.deposit_applied_idr,
                 CASE WHEN EXISTS (SELECT 1 FROM pos_orders sp
                         WHERE sp.tenant_id = o.tenant_id AND sp.order_id = o.id)
                      THEN (SELECT sp.completed_at FROM pos_orders sp
                         WHERE sp.tenant_id = o.tenant_id AND sp.order_id = o.id)
                      WHEN o.channel IN ('qr', 'facility') AND o.payment_mode = 'pay_first'
                      THEN o.fired_at END AS sale_at
            FROM orders o
           WHERE o.tenant_id = ${scope.tenantId}::uuid
             AND ${outletClause(sql`o.outlet_id`, [
               ...new Set(parked.map((row) => String(row.outlet_id))),
             ])}
             AND o.id IN (${sql.join(
               [...new Set(orderUuids.values())].map((id) => sql`${id}::uuid`),
               sql`, `,
             )})
        ), sources AS (
          SELECT o.id AS order_id, o.outlet_id, a.table_session_id AS session_id,
                 a.payment_intent_id AS intent_id
            FROM scoped_orders o
            JOIN reservation_deposit_allocations a
              ON a.tenant_id = o.tenant_id AND a.outlet_id = o.outlet_id
           WHERE o.deposit_applied_idr > 0
          UNION
          SELECT o.id, o.outlet_id, u.table_session_id, r.payment_intent_id
            FROM scoped_orders o
            JOIN reservation_customer_credit_uses u
              ON u.tenant_id = o.tenant_id AND u.outlet_id = o.outlet_id
            JOIN reservation_deposit_remainders r
              ON r.tenant_id = u.tenant_id AND r.outlet_id = u.outlet_id
             AND r.id = u.remainder_id
           WHERE o.deposit_applied_idr > 0 AND u.created_at < o.sale_at
        ), connected(order_id, outlet_id, node) AS (
          SELECT o.id, o.outlet_id, 's:' || o.table_session_id::text
            FROM scoped_orders o
           WHERE o.deposit_applied_idr > 0 AND o.table_session_id IS NOT NULL
             AND o.sale_at IS NOT NULL
          UNION
          SELECT c.order_id, c.outlet_id,
                 CASE WHEN c.node = 's:' || s.session_id::text
                      THEN 'i:' || s.intent_id::text
                      ELSE 's:' || s.session_id::text END
            FROM connected c
            JOIN sources s ON s.order_id = c.order_id AND s.outlet_id = c.outlet_id
             AND (c.node = 's:' || s.session_id::text OR c.node = 'i:' || s.intent_id::text)
        )
        SELECT c.order_id::text AS order_id, c.outlet_id::text AS outlet_id,
               substring(c.node from 3) AS intent_id, NULL::text AS refund_id
          FROM connected c WHERE left(c.node, 1) = 'i'
        UNION
        SELECT d.order_id::text, d.outlet_id::text, d.payment_intent_id::text,
               d.pos_refund_id::text
          FROM scoped_orders o
          JOIN pos_deposit_refunds d ON d.tenant_id = o.tenant_id
           AND d.outlet_id = o.outlet_id AND d.order_id = o.id
        ORDER BY order_id, outlet_id, intent_id, refund_id
      `),
    );
    for (const row of deposits) {
      const key = `${String(row.outlet_id)}:${String(row.order_id)}:${row.refund_id ?? "sale"}`;
      const list = depositIntents.get(key) ?? [];
      list.push(String(row.intent_id).toLowerCase());
      depositIntents.set(key, list);
    }
  }
  const resolved = parked.map((row) => {
    const orderUuid =
      typeof row.order_ulid === "string"
        ? orderUuids.get(row.order_ulid)
        : undefined;
    const order =
      orderUuid === undefined
        ? undefined
        : orders.get(`${String(row.outlet_id)}:${orderUuid}`);
    const payloadIntent =
      typeof row.payload_intent === "string" && UUID.test(row.payload_intent)
        ? row.payload_intent.toLowerCase()
        : null;
    // A parked event that names its intent waits for that intent only; other
    // tenders of the order must not take its place.
    const fromTenders =
      payloadIntent === null && orderUuid !== undefined
        ? (tenderIntents.get(`${String(row.outlet_id)}:${orderUuid}`) ?? [])
        : [];
    const depositSource =
      row.event_name === "order.paid"
        ? "sale"
        : typeof row.refund_id === "string" && UUID.test(row.refund_id)
          ? row.refund_id.toLowerCase()
          : null;
    const fromDeposits =
      payloadIntent === null &&
      orderUuid !== undefined &&
      depositSource !== null
        ? (depositIntents.get(
            `${String(row.outlet_id)}:${orderUuid}:${depositSource}`,
          ) ?? [])
        : [];
    const candidates = [
      ...new Set(
        (payloadIntent === null
          ? [
              order?.intentId?.toLowerCase() ?? null,
              ...fromTenders,
              ...fromDeposits,
            ]
          : [payloadIntent]
        ).filter((id): id is string => id !== null),
      ),
    ];
    return {
      row,
      orderId: orderUuid ?? null,
      total: order?.total ?? null,
      candidates,
      contributionCandidates: new Set([...fromTenders, ...fromDeposits]),
    };
  });
  const states = new Map<string, OutboxState>();
  const intentAmounts = new Map<string, number>();
  const intentIds = [...new Set(resolved.flatMap((entry) => entry.candidates))];
  if (intentIds.length > 0) {
    const outletIds = [...new Set(parked.map((row) => String(row.outlet_id)))];
    const intents = rowsOf(
      await tx.execute(
        sql`SELECT id::text AS id, outlet_id::text AS outlet_id, amount_idr
              FROM payment_intents
             WHERE tenant_id = ${scope.tenantId}::uuid
               AND outlet_id IN (${sql.join(
                 outletIds.map((id) => sql`${id}::uuid`),
                 sql`, `,
               )})
               AND id IN (${sql.join(
                 intentIds.map((id) => sql`${id}::uuid`),
                 sql`, `,
               )})`,
      ),
    );
    for (const row of intents)
      intentAmounts.set(
        `${String(row.outlet_id)}:${String(row.id)}`,
        num(row.amount_idr),
      );
    const outbox = rowsOf(
      await tx.execute(
        sql`SELECT aggregate_id::text AS intent_id, outlet_id::text AS outlet_id,
                   status, dead_lettered_at
              FROM domain_event_outbox
             WHERE tenant_id = ${scope.tenantId}::uuid
               AND outlet_id IN (${sql.join(
                 [...new Set(parked.map((row) => String(row.outlet_id)))].map(
                   (id) => sql`${id}::uuid`,
                 ),
                 sql`, `,
               )})
               AND destination = ${EVENT_DESTINATION}
               AND aggregate_type = 'payment'
               AND event ->> 'name' = 'payment.paid'
               AND aggregate_id IN (${sql.join(
                 intentIds.map((id) => sql`${id}::uuid`),
                 sql`, `,
               )})`,
      ),
    );
    for (const row of outbox) {
      const state: OutboxState =
        row.dead_lettered_at !== null && row.dead_lettered_at !== undefined
          ? "dead_lettered"
          : row.status === "delivered"
            ? "delivered"
            : "pending";
      const key = `${String(row.outlet_id)}:${String(row.intent_id)}`;
      const seen = states.get(key);
      if (seen === undefined || OUTBOX_RANK[state] > OUTBOX_RANK[seen])
        states.set(key, state);
    }
  }
  const items = resolved.map(
    ({ row, orderId, total, candidates, contributionCandidates }) => {
      // One item per parked sale: show the intent whose outbox row matters most
      // (dead_lettered, then pending, then missing, then delivered); ties keep
      // the candidate order (order, tenders, DP; a payload intent stands alone).
      let intentId: string | null = null;
      let outboxState: OutboxState = "missing";
      for (const candidate of candidates) {
        const state =
          states.get(`${String(row.outlet_id)}:${candidate}`) ?? "missing";
        if (
          intentId === null ||
          OUTBOX_RANK[state] > OUTBOX_RANK[outboxState]
        ) {
          intentId = candidate;
          outboxState = state;
        }
      }
      // An intent from a tender or DP source is one share of a split payment: the
      // sale is worth the order total. A payload or embedded intent keeps its
      // own amount.
      const intentAmount =
        intentId && !contributionCandidates.has(intentId)
          ? intentAmounts.get(`${String(row.outlet_id)}:${intentId}`)
          : undefined;
      return {
        ...toItem("receipt_pending_stale", "auto_journal", {
          ...row,
          amount: intentAmount ?? total,
        }),
        receiptPending: {
          orderId,
          intentId,
          outboxState,
        } satisfies FinanceExceptionReceiptPendingDto,
      };
    },
  );
  return {
    kind: "receipt_pending_stale",
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
    if (wants("receipt_pending_stale"))
      parts.push(await receiptPendingStale(tx, scope));
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
