// legend 1147: a cash role (cash_on_hand, petty_cash, bank) may only be mapped
// onto an account that has no journal lines yet. Journals carry a snapshot of
// the role map they were posted under; if the owner moved a cash role onto an
// account that already held other money, the reversal of an old journal would
// raise the general-ledger balance of that account and show cash that was never
// received. Only a change counts: a role that keeps its stored account (re-PUT
// or re-import of the same mapping) passes, so an existing setup stays editable.
// The caller holds the chart lock of the entity, so the lines read here cannot
// be mapped by a concurrent writer.

import { and, eq, inArray } from "drizzle-orm";
import {
  CASH_POSTING_ROLES,
  type PostingAccountRole,
} from "@starter/shared/accounting";
import { chartOfAccounts, journalLines } from "../db/schema";
import { HttpError } from "../lib/http-error";
import type { TenantTransaction } from "./accounting-shared";

export const CASH_MAPPING_ACCOUNT_HAS_HISTORY =
  "CASH_MAPPING_ACCOUNT_HAS_HISTORY";

type RoleAccount = { role: PostingAccountRole; accountId: string };
type RoleAccountInput = { role: string; accountId: string };

const isCashRole = (role: string): boolean =>
  (CASH_POSTING_ROLES as readonly string[]).includes(role);

/**
 * Messages (without the error code) of the cash-role candidates that change their account onto an account
 * with journal lines (empty = fine).
 */
export async function cashMappingHistoryConflicts(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  candidates: readonly RoleAccountInput[],
  currentMappings: readonly RoleAccountInput[],
): Promise<string[]> {
  const current = new Map(currentMappings.map((m) => [m.role, m.accountId]));
  const changed = candidates.filter(
    (candidate) =>
      isCashRole(candidate.role) &&
      current.get(candidate.role) !== candidate.accountId,
  );
  if (changed.length === 0) return [];
  const accountIds = [...new Set(changed.map((c) => c.accountId))];
  const withLines = await tx
    .selectDistinct({ accountId: journalLines.accountId })
    .from(journalLines)
    .where(
      and(
        eq(journalLines.tenantId, tenantId),
        inArray(journalLines.accountId, accountIds),
      ),
    );
  if (withLines.length === 0) return [];
  const hasHistory = new Set(withLines.map((row) => row.accountId));
  const codes = await tx
    .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.legalEntityId, legalEntityId),
        inArray(chartOfAccounts.id, [...hasHistory]),
      ),
    );
  const codeOf = new Map(codes.map((row) => [row.id, row.code]));
  return changed
    .filter((candidate) => hasHistory.has(candidate.accountId))
    .map(
      (candidate) =>
        `Role ${candidate.role} cannot move to account ${codeOf.get(candidate.accountId) ?? candidate.accountId}, which already has journal lines; map the role to a new account`,
    );
}

/** Throws 409 CASH_MAPPING_ACCOUNT_HAS_HISTORY when a cash role would move onto an account with journal lines. */
export async function assertCashMappingTargetsHaveNoHistory(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  candidates: readonly RoleAccount[],
  currentMappings: readonly RoleAccountInput[],
): Promise<void> {
  const conflicts = await cashMappingHistoryConflicts(
    tx,
    tenantId,
    legalEntityId,
    candidates,
    currentMappings,
  );
  if (conflicts.length > 0)
    throw new HttpError(
      409,
      CASH_MAPPING_ACCOUNT_HAS_HISTORY,
      conflicts.join("; "),
    );
}
