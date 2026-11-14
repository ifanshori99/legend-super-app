// Pure form logic of the Pengaturan PT tab: draft <-> config, field checks and
// the PUT body. Checks only explain the form; the server stays the judge.
import type { MessageKey } from "@starter/shared/i18n";
import type { PayrollPayoutConfigDto } from "@starter/shared/types";
import {
  PAYOUT_DEFAULT_FEE_PER_TRANSFER_IDR,
  PAYOUT_DEFAULT_MAX_PER_TRANSFER_IDR,
  PAYOUT_MAX_PER_TRANSFER_CEILING_IDR,
  type PayoutMethod,
  type UpsertPayoutConfigInput,
} from "@starter/shared/validators/payroll-payout";

export type SourceAccount = {
  id: string;
  label: string;
  maskedNumber: string;
  active: boolean;
};

/** Text fields hold digits only; the form shows them with thousand dots. */
export type SettingsDraft = {
  method: PayoutMethod;
  sourceId: string;
  maxPerTransfer: string;
  dailyCap: string;
  fee: string;
  enabled: boolean;
};

export type SettingsProblems = Partial<
  Record<
    "method" | "source" | "maxPerTransfer" | "dailyCap" | "fee",
    MessageKey
  >
>;

export function draftFromConfig(
  config: PayrollPayoutConfigDto | null,
): SettingsDraft {
  return {
    method: config?.method ?? "manual_bank",
    sourceId: config?.manualSourceBankAccountId ?? "",
    maxPerTransfer: String(
      config?.maxPerTransferIdr ?? PAYOUT_DEFAULT_MAX_PER_TRANSFER_IDR,
    ),
    dailyCap: config?.dailyCapIdr == null ? "" : String(config.dailyCapIdr),
    fee: String(
      config?.feePerTransferIdr ?? PAYOUT_DEFAULT_FEE_PER_TRANSFER_IDR,
    ),
    enabled: config?.enabled ?? false,
  };
}

/** Keeps digits only, so "Rp 50.000.000" typed or pasted still reads 50000000. */
export function digitsOnly(text: string): string {
  return text.replace(/\D/g, "").slice(0, 12);
}

/** Whole rupiah from a digits-only field; null when empty. */
export function parseIdr(text: string): number | null {
  if (text === "") return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

export function draftsEqual(a: SettingsDraft, b: SettingsDraft): boolean {
  return (
    a.method === b.method &&
    a.sourceId === b.sourceId &&
    a.enabled === b.enabled &&
    parseIdr(a.maxPerTransfer) === parseIdr(b.maxPerTransfer) &&
    parseIdr(a.dailyCap) === parseIdr(b.dailyCap) &&
    parseIdr(a.fee) === parseIdr(b.fee)
  );
}

/** The saved source is unusable: missing from the list or marked not active. */
export function savedSourceInactive(
  config: PayrollPayoutConfigDto | null,
  accounts: readonly SourceAccount[] | null,
): boolean {
  // Unknown list (loading or failed) never counts as "inactive".
  if (!config || accounts === null) return false;
  const saved = accounts.find(
    (account) => account.id === config.manualSourceBankAccountId,
  );
  return !saved || !saved.active;
}

export function validateDraft(
  draft: SettingsDraft,
  accounts: readonly SourceAccount[] | null,
): SettingsProblems {
  const problems: SettingsProblems = {};
  if (draft.method !== "manual_bank")
    problems.method = "payrollPayoutSettings.method.chooseManual";
  if (draft.sourceId === "")
    problems.source = "payrollPayoutSettings.source.required";
  else if (
    accounts !== null &&
    !accounts.find((a) => a.id === draft.sourceId)?.active
  )
    problems.source = "payrollPayoutSettings.source.inactiveError";
  const max = parseIdr(draft.maxPerTransfer);
  if (max === null || max <= 0 || max > PAYOUT_MAX_PER_TRANSFER_CEILING_IDR)
    problems.maxPerTransfer = "payrollPayoutSettings.limits.perTransferInvalid";
  const daily = parseIdr(draft.dailyCap);
  if (draft.dailyCap !== "" && (daily === null || daily <= 0))
    problems.dailyCap = "payrollPayoutSettings.limits.dailyInvalid";
  if (parseIdr(draft.fee) === null)
    problems.fee = "payrollPayoutSettings.limits.feeInvalid";
  return problems;
}

/**
 * PUT body. Duitku is never sent: it is not available, so only a valid
 * manual_bank draft reaches here. The bank file format keeps its saved value.
 */
export function buildInput(
  draft: SettingsDraft,
  config: PayrollPayoutConfigDto | null,
): UpsertPayoutConfigInput {
  return {
    method: "manual_bank",
    integrationId: null,
    manualSourceBankAccountId: draft.sourceId,
    manualBankFormat: config?.manualBankFormat ?? "generic_csv",
    maxPerTransferIdr: parseIdr(draft.maxPerTransfer) ?? 0,
    dailyCapIdr: parseIdr(draft.dailyCap),
    feePerTransferIdr: parseIdr(draft.fee) ?? 0,
    enabled: draft.enabled,
  };
}
