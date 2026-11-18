// Cash limit and anti-split for cash outs and petty cash top-ups (founder Q7,
// 13 Nov 2026; CTO decision "anti pecah"). Used by `createCashBankEntry`
// (cash_out) and `createPettyCashMovement` (topup).
//
// - The limit is per tenant (`finance_policies`, default Rp5.000.000). An entry
//   whose own amount is strictly above it needs approval.
// - Anti-split (founder Q18, 13 Nov 2026): the same creator, on the same
//   calendar day of the tenant, across ALL outlets (entries with no outlet
//   too), cannot stay under the limit by cutting one payment into pieces. The
//   day comes from the SERVER `created_at`, never the back-datable
//   `entry_date`. When this entry plus the creator's earlier cash outs and
//   top-ups of that day (not rejected: approved or pending) pass the limit,
//   THIS entry waits for approval, even if its own amount is below it.
//   Earlier entries stay as they are.
// - Parallel submits are serialized per (tenant, creator) by an advisory lock
//   taken before the sum, so simultaneous requests at different outlets cannot
//   all read an empty day.
// - No double count: an approved `petty_topup` is counted from its
//   `cash_bank_entries` row; the ledger row it produces (idempotency key
//   `pt/<entryId>`) is excluded. A direct top-up is counted from
//   `petty_cash_entries` through `app.cash_limit_direct_topups` (migration
//   0341): that table has outlet RLS, so a creator whose outlet scope is
//   narrower would not see the direct top-ups made at other outlets. Returns
//   (fund -> bank) never count.

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  DEFAULT_CASH_OUT_APPROVAL_LIMIT_IDR,
  type CashOutApprovalLimit,
} from "@starter/shared/accounting";
import {
  businessDateOf,
  DEFAULT_TIME_ZONE,
  type BusinessDayClock,
  type TenantId,
} from "@starter/shared/core";
import { financePolicies } from "../db/schema/accounting-ap-fa.ts";
import { cashBankEntries } from "../db/schema/accounting-cash-bank-entries.ts";
import {
  advisoryLock,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";

/**
 * Idempotency key prefix of the ledger row an approved `petty_topup` creates.
 * Client keys cannot contain "/" (`idempotencyKeySchema`), so a client can
 * neither hide a direct top-up from the anti-split sum nor collide with the
 * server-derived key.
 */
export const APPROVED_TOPUP_KEY_PREFIX = "pt/";

/**
 * The tenant's calendar day (founder Q18). The tenant has no time zone column,
 * so the day is the fixed Asia/Jakarta calendar day (midnight cutoff), never an
 * outlet's own clock: an outlet's zone or cutoff must not move an entry into
 * another group.
 */
const TENANT_DAY_CLOCK: BusinessDayClock = Object.freeze({
  timeZone: DEFAULT_TIME_ZONE,
  cutoff: "00:00",
});

/**
 * Every entry of one calendar day was created within this window of `now`
 * (a day is 24 h, plus zone offset and DST slack): rows older than it never
 * share a day with `now`.
 */
const WINDOW_MS = 48 * 60 * 60 * 1000;

/** The tenant's limit; no saved value means the default (never "no limit"). */
export async function readLimitIdr(
  tx: TenantTransaction,
  tenantId: TenantId,
): Promise<CashOutApprovalLimit> {
  const [row] = await tx
    .select({ limit: financePolicies.cashOutApprovalLimitIdr })
    .from(financePolicies)
    .where(eq(financePolicies.tenantId, tenantId))
    .limit(1);
  const saved = row?.limit ?? null;
  return saved === null
    ? { limitIdr: DEFAULT_CASH_OUT_APPROVAL_LIMIT_IDR, isDefault: true }
    : { limitIdr: saved, isDefault: false };
}

/**
 * True when the entry must wait for approval: its amount is above the limit,
 * or it takes the creator's total of the tenant's calendar day above it. Takes
 * the advisory lock of (tenant, creator) first, so call it inside the
 * transaction that inserts the entry and insert (or refuse) before returning
 * control to another request.
 */
export async function requiresApproval(
  tx: TenantTransaction,
  input: {
    tenantId: TenantId;
    actorId: string;
    amountIdr: number;
  },
): Promise<boolean> {
  return (await cashApprovalCheck(tx, input)).required;
}

/**
 * `requiresApproval` plus the creator's day total including this entry
 * (`dayTotalIdr`). The approval matrix tiers on that total, not on the
 * fragment, so a split cannot pick a lower tier (SO 1036 finding 5).
 */
export async function cashApprovalCheck(
  tx: TenantTransaction,
  input: {
    tenantId: TenantId;
    actorId: string;
    amountIdr: number;
  },
): Promise<{ required: boolean; dayTotalIdr: number }> {
  const { tenantId, actorId, amountIdr } = input;
  await advisoryLock(tx, `acc-cashlimit:${tenantId.toLowerCase()}:${actorId}`);
  const { limitIdr } = await readLimitIdr(tx, tenantId);

  // The DB clock, not the app clock: stored rows get `created_at DEFAULT now()`
  // (transaction start), so this entry's own day must come from the same clock.
  // An app/DB skew near midnight would otherwise put it in another day group
  // and let a split pass.
  const nowResult = await tx.execute(sql`SELECT now() AS now`);
  const now = new Date((nowResult.rows as { now: Date | string }[])[0]!.now);
  const today = businessDateOf(now, TENANT_DAY_CLOCK);
  const since = new Date(now.getTime() - WINDOW_MS);

  const documents = await tx
    .select({
      amountIdr: cashBankEntries.amountIdr,
      createdAt: cashBankEntries.createdAt,
    })
    .from(cashBankEntries)
    .where(
      and(
        eq(cashBankEntries.tenantId, tenantId),
        eq(cashBankEntries.createdBy, actorId),
        inArray(cashBankEntries.kind, ["cash_out", "petty_topup"]),
        inArray(cashBankEntries.status, ["pending_approval", "approved"]),
        gte(cashBankEntries.createdAt, since),
      ),
    );
  // The function is tenant-tied (app.require_tenant_id) and bypasses the outlet
  // RLS of petty_cash_entries on purpose; it excludes the `pt/` ledger rows.
  const topupResult = await tx.execute(
    sql`SELECT amount_idr, created_at FROM app.cash_limit_direct_topups(${actorId}, ${since.toISOString()}::timestamptz)`,
  );
  const topups = (
    topupResult.rows as { amount_idr: string | number; created_at: Date }[]
  ).map((row) => ({
    amountIdr: Number(row.amount_idr),
    createdAt: new Date(row.created_at),
  }));
  let total: number = amountIdr;
  for (const row of [...documents, ...topups])
    if (businessDateOf(row.createdAt, TENANT_DAY_CLOCK) === today)
      total += row.amountIdr;
  return {
    required: amountIdr > limitIdr || total > limitIdr,
    dayTotalIdr: total,
  };
}
