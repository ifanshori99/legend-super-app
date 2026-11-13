// Cash limit and anti-split for cash outs and petty cash top-ups (founder Q7,
// 13 Nov 2026; CTO decision "anti pecah"). Used by `createCashBankEntry`
// (cash_out) and `createPettyCashMovement` (topup).
//
// - The limit is per tenant (`finance_policies`, default Rp5.000.000). An entry
//   whose own amount is strictly above it needs approval.
// - Anti-split: the same creator, at the same outlet, on the same business day
//   (outlet time zone, from the SERVER `created_at`, never the back-datable
//   `entry_date`; no outlet = its own group on the default Asia/Jakarta clock)
//   cannot stay under the limit by cutting one payment into pieces. When this
//   entry plus the creator's earlier cash outs and top-ups of that group (not
//   rejected: approved or pending) pass the limit, THIS entry waits for
//   approval, even if its own amount is below it. Earlier entries stay as they
//   are.
// - Parallel submits are serialized per (tenant, creator, outlet) by an
//   advisory lock taken before the sum, so three simultaneous requests cannot
//   all read an empty day.
// - No double count: an approved `petty_topup` is counted from its
//   `cash_bank_entries` row; the ledger row it produces (idempotency key
//   `pt/<entryId>`) is excluded. A direct top-up is counted from
//   `petty_cash_entries`. Returns (fund -> bank) never count.

import { and, eq, gte, inArray, notLike, sql } from "drizzle-orm";
import {
  DEFAULT_CASH_OUT_APPROVAL_LIMIT_IDR,
  type CashOutApprovalLimit,
} from "@starter/shared/accounting";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  type BusinessDayClock,
  type OutletId,
  type TenantId,
} from "@starter/shared/core";
import { financePolicies } from "../db/schema/accounting-ap-fa.ts";
import {
  cashBankEntries,
  pettyCashEntries,
} from "../db/schema/accounting-cash-bank-entries.ts";
import {
  advisoryLock,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";
import { loadOutletClock } from "./inventory-ops.shared.ts";

/**
 * Idempotency key prefix of the ledger row an approved `petty_topup` creates.
 * Client keys cannot contain "/" (`idempotencyKeySchema`), so a client can
 * neither hide a direct top-up from the anti-split sum nor collide with the
 * server-derived key.
 */
export const APPROVED_TOPUP_KEY_PREFIX = "pt/";

/**
 * Every entry of one business day was created within this window of `now`
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
 * or it takes the creator's group total of the business day above it. Takes the
 * advisory lock of (tenant, creator, outlet) first, so call it inside the
 * transaction that inserts the entry and insert (or refuse) before returning
 * control to another request.
 */
export async function requiresApproval(
  tx: TenantTransaction,
  input: {
    tenantId: TenantId;
    actorId: string;
    /** null = a cash out with no outlet tag (its own group). */
    outletId: OutletId | null;
    amountIdr: number;
    now: Date;
  },
): Promise<boolean> {
  const { tenantId, actorId, outletId, amountIdr, now } = input;
  await advisoryLock(
    tx,
    `acc-cashlimit:${tenantId.toLowerCase()}:${actorId}:${outletId?.toLowerCase() ?? "none"}`,
  );
  const { limitIdr } = await readLimitIdr(tx, tenantId);
  if (amountIdr > limitIdr) return true;

  const clock: BusinessDayClock = outletId
    ? await loadOutletClock(tx, outletId)
    : DEFAULT_BUSINESS_DAY_CLOCK;
  const today = businessDateOf(now, clock);
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
        outletId === null
          ? sql`${cashBankEntries.outletId} IS NULL`
          : eq(cashBankEntries.outletId, outletId),
        gte(cashBankEntries.createdAt, since),
      ),
    );
  const topups =
    outletId === null
      ? []
      : await tx
          .select({
            amountIdr: pettyCashEntries.amountIdr,
            createdAt: pettyCashEntries.createdAt,
          })
          .from(pettyCashEntries)
          .where(
            and(
              eq(pettyCashEntries.tenantId, tenantId),
              eq(pettyCashEntries.createdBy, actorId),
              eq(pettyCashEntries.outletId, outletId),
              eq(pettyCashEntries.kind, "topup"),
              notLike(
                pettyCashEntries.idempotencyKey,
                `${APPROVED_TOPUP_KEY_PREFIX}%`,
              ),
              gte(pettyCashEntries.createdAt, since),
            ),
          );
  let total: number = amountIdr;
  for (const row of [...documents, ...topups])
    if (businessDateOf(row.createdAt, clock) === today) total += row.amountIdr;
  return total > limitIdr;
}
