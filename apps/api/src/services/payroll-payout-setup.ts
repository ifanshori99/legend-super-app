// Accounting setup a manual payout needs before money moves (bead legend-8codi;
// brief docs/briefs/661-payroll-payout-hardening.md). Approve and the one-time
// bank file download fail closed (409) while the `bank_charges` mapping or the
// source bank account is unusable, so a fee is never silently dropped after
// the money left. Confirming a bank result is not gated: the money is gone, a
// skipped fee is recorded (`fee_posted = false`) and re-posted later.
//
// Kept apart from payroll-payout.service.ts and payroll-payout-gl.service.ts so
// both can use it without an import cycle. Reads only; nothing here logs an
// amount or an account number.

import { and, eq, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { TenantId } from "@starter/shared/core";
import { isModuleEnabled } from "@starter/shared/platform";
import { bankAccounts } from "../db/schema/accounting-cash-bank.ts";
import {
  accountMappings,
  chartOfAccounts,
  journalEntries,
  journalLines,
  tenants,
} from "../db/schema/index.ts";
import { payrollPayoutConfigs } from "../db/schema/payroll-payout.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./hris-access.ts";

const childAccounts = alias(chartOfAccounts, "payout_child_accounts");

export async function accountingEnabled(
  tx: Tx,
  tenantId: TenantId,
): Promise<boolean> {
  const [row] = await tx
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return isModuleEnabled(row?.featureFlags ?? null, "accounting");
}

/**
 * `accountingEnabled` read once under a share lock on the tenants row. The
 * package toggle (`setTenantPackage`) locks that row FOR UPDATE, so a cash
 * outflow that decides on this value (1102 check, entity refusal, the
 * `accountingOnAtEmit` flag) cannot see the toggle flip between two reads
 * inside its own transaction (legend-kt8em). Call after `entityLock`.
 */
export async function accountingEnabledShared(
  tx: Tx,
  tenantId: TenantId,
): Promise<boolean> {
  const [row] = await tx
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .for("share");
  return isModuleEnabled(row?.featureFlags ?? null, "accounting");
}

/**
 * The `bank_charges` mapping is ready only while the mapped GL account exists
 * in the same tenant and legal entity, is active and is postable (no child
 * accounts, so not a header). Approve, export, fee re-post and overpaid all
 * refuse on `false`; settle defers the fee (`fee_posted = false`) instead.
 */
export async function bankChargesMapped(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ accountId: accountMappings.accountId })
    .from(accountMappings)
    .innerJoin(
      chartOfAccounts,
      and(
        eq(chartOfAccounts.tenantId, accountMappings.tenantId),
        eq(chartOfAccounts.id, accountMappings.accountId),
      ),
    )
    .where(
      and(
        eq(accountMappings.tenantId, tenantId),
        eq(accountMappings.legalEntityId, legalEntityId),
        eq(accountMappings.role, "bank_charges"),
        eq(chartOfAccounts.legalEntityId, legalEntityId),
        eq(chartOfAccounts.isActive, true),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(childAccounts)
            .where(
              and(
                eq(childAccounts.tenantId, tenantId),
                eq(childAccounts.parentId, chartOfAccounts.id),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The GL account exists in the same tenant and legal entity, is active and is
 * postable (no child accounts, so not a header). The source bank account only
 * counts as usable while its GL account is too: a journal that credits an
 * inactive or header account would fail late, after the money has moved.
 */
export async function glAccountPostable(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  glAccountId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.legalEntityId, legalEntityId),
        eq(chartOfAccounts.id, glAccountId),
        eq(chartOfAccounts.isActive, true),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(childAccounts)
            .where(
              and(
                eq(childAccounts.tenantId, tenantId),
                eq(childAccounts.parentId, chartOfAccounts.id),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export const PAYOUT_SOURCE_ACCOUNT_MISSING = {
  code: "PAYOUT_SOURCE_ACCOUNT_MISSING",
  message:
    "Rekening bank sumber pembayaran gaji tidak ditemukan atau sudah dinonaktifkan. Pilih rekening sumber yang aktif di pengaturan, lalu coba lagi.",
} as const;

/**
 * The one rule for the payout source account (bead legend-s7roi): the GL
 * account of the configured source bank account, and only while that bank
 * account exists in the same tenant and legal entity and is active. Every path
 * (approve, export, settle, fee re-post, overpaid) resolves it here. Fails
 * closed with 409 `PAYOUT_SOURCE_ACCOUNT_MISSING`; `optional` answers null
 * instead, for callers that can go on without the account.
 */
export async function activeSourceGlAccount(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  options: { optional: true },
): Promise<string | null>;
export async function activeSourceGlAccount(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  options?: { optional?: false },
): Promise<string>;
export async function activeSourceGlAccount(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  options?: { optional?: boolean },
): Promise<string | null>;
export async function activeSourceGlAccount(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  options: { optional?: boolean } = {},
): Promise<string | null> {
  const [row] = await tx
    .select({ glAccountId: bankAccounts.glAccountId })
    .from(payrollPayoutConfigs)
    .innerJoin(
      bankAccounts,
      and(
        eq(bankAccounts.tenantId, payrollPayoutConfigs.tenantId),
        eq(bankAccounts.legalEntityId, payrollPayoutConfigs.legalEntityId),
        eq(bankAccounts.id, payrollPayoutConfigs.manualSourceBankAccountId),
        eq(bankAccounts.isActive, true),
      ),
    )
    .where(
      and(
        eq(payrollPayoutConfigs.tenantId, tenantId),
        eq(payrollPayoutConfigs.legalEntityId, legalEntityId),
      ),
    )
    .limit(1)
    .for("share", { of: bankAccounts });
  if (
    row &&
    (await glAccountPostable(tx, tenantId, legalEntityId, row.glAccountId))
  )
    return row.glAccountId;
  if (options.optional) return null;
  throw new HttpError(
    409,
    PAYOUT_SOURCE_ACCOUNT_MISSING.code,
    PAYOUT_SOURCE_ACCOUNT_MISSING.message,
  );
}

/**
 * A journal may credit a GL account only while it belongs to an active bank
 * account of the same tenant and legal entity. Used for accounts that did not
 * come from the config (the account a batch was settled from): that bank
 * account may have been deactivated since. 409 `PAYOUT_SOURCE_ACCOUNT_MISSING`
 * otherwise.
 */
export async function assertActiveBankGlAccount(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  glAccountId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.tenantId, tenantId),
        eq(bankAccounts.legalEntityId, legalEntityId),
        eq(bankAccounts.glAccountId, glAccountId),
        eq(bankAccounts.isActive, true),
      ),
    )
    .limit(1)
    .for("share", { of: bankAccounts });
  if (row) return;
  throw new HttpError(
    409,
    PAYOUT_SOURCE_ACCOUNT_MISSING.code,
    PAYOUT_SOURCE_ACCOUNT_MISSING.message,
  );
}

/**
 * The GL account of the bank account frozen on a batch (bead legend-hkh57), and
 * only while that bank account is active in the same tenant and legal entity.
 * It never falls back to the config: an old batch keeps its own account.
 * 409 `PAYOUT_SOURCE_ACCOUNT_MISSING` otherwise; `optional` answers null.
 */
export async function frozenSourceGlAccount(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  bankAccountId: string,
  options: { optional?: boolean } = {},
): Promise<string | null> {
  const [row] = await tx
    .select({ glAccountId: bankAccounts.glAccountId })
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.tenantId, tenantId),
        eq(bankAccounts.legalEntityId, legalEntityId),
        eq(bankAccounts.id, bankAccountId),
        eq(bankAccounts.isActive, true),
      ),
    )
    .limit(1)
    .for("share", { of: bankAccounts });
  if (
    row &&
    (await glAccountPostable(tx, tenantId, legalEntityId, row.glAccountId))
  )
    return row.glAccountId;
  if (options.optional) return null;
  throw new HttpError(
    409,
    PAYOUT_SOURCE_ACCOUNT_MISSING.code,
    PAYOUT_SOURCE_ACCOUNT_MISSING.message,
  );
}

/** The configured source bank account id of a legal entity (null: no config). */
export async function configuredSourceBankAccountId(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: payrollPayoutConfigs.manualSourceBankAccountId })
    .from(payrollPayoutConfigs)
    .where(
      and(
        eq(payrollPayoutConfigs.tenantId, tenantId),
        eq(payrollPayoutConfigs.legalEntityId, legalEntityId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** The configured source bank account exists and is active. */
export async function sourceAccountUsable(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
): Promise<boolean> {
  return (
    (await activeSourceGlAccount(tx, tenantId, legalEntityId, {
      optional: true,
    })) !== null
  );
}

export const PAYOUT_BANK_CHARGES_MAPPING_MISSING = {
  code: "PAYOUT_BANK_CHARGES_MAPPING_MISSING",
  message:
    "Akun biaya bank belum dipetakan di pengaturan akuntansi, jadi biaya transfer tidak bisa dijurnal. Petakan dulu, lalu coba lagi.",
} as const;

/**
 * Refuses 409 while accounting is on and the payout cannot be journaled in
 * full: the source bank account is unusable, or `bank_charges` is unmapped.
 * With accounting off nothing is journaled, so nothing is required.
 */
export async function assertManualPayoutSetup(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
): Promise<void> {
  if (!(await accountingEnabled(tx, tenantId))) return;
  if (!(await sourceAccountUsable(tx, tenantId, legalEntityId)))
    throw new HttpError(
      409,
      PAYOUT_SOURCE_ACCOUNT_MISSING.code,
      PAYOUT_SOURCE_ACCOUNT_MISSING.message,
    );
  if (!(await bankChargesMapped(tx, tenantId, legalEntityId)))
    throw new HttpError(
      409,
      PAYOUT_BANK_CHARGES_MAPPING_MISSING.code,
      PAYOUT_BANK_CHARGES_MAPPING_MISSING.message,
    );
}

/**
 * The account the settle journal of a batch credited (the `bank` role it was
 * posted with). A return must give back to that account even when the config
 * has pointed at another bank account since.
 */
export async function settledSourceAccount(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  journalKey: string,
): Promise<string> {
  const [row] = await tx
    .select({ accountId: journalLines.accountId })
    .from(journalEntries)
    .innerJoin(
      journalLines,
      and(
        eq(journalLines.tenantId, journalEntries.tenantId),
        eq(journalLines.entryId, journalEntries.id),
      ),
    )
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.legalEntityId, legalEntityId),
        eq(journalEntries.idempotencyKey, journalKey),
        sql`${journalLines.creditIdr} > 0`,
      ),
    )
    .limit(1);
  if (!row)
    throw new HttpError(
      409,
      "PAYOUT_SETTLE_JOURNAL_MISSING",
      "Jurnal pembayaran batch ini tidak ditemukan, jurnal lanjutan tidak diposting.",
    );
  return row.accountId;
}
