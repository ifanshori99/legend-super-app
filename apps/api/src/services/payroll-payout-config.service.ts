// Payout configuration per legal entity (PT) (bead legend-wnkep.1; founder
// Q15-Q17; design docs/design/payroll-disbursement.md section 4.1 and 7.1).
//
// One row per PT: how net pay leaves the company. `duitku` can be stored but
// is not usable yet (the adapter is legend-wnkep.3), so it can never be
// enabled here. `manual_bank` needs the company bank account the transfer file
// debits and the file format. `enabled` is the per-PT switch (R15): a manual
// batch is created, submitted, approved and exported only while it is on.
//
// Trusted in-transaction writer. The route adds `payroll.payout.configure`
// and a fresh step-up MFA; this file adds the rule that the money path does
// not change under an open batch (409 PAYOUT_CONFIG_BUSY).

import { and, eq, inArray } from "drizzle-orm";
import { idr, type TenantId, type UserId } from "@starter/shared/core";
import {
  PAYOUT_DEFAULT_FEE_PER_TRANSFER_IDR,
  PAYOUT_DEFAULT_MAX_PER_TRANSFER_IDR,
  PAYOUT_MAX_PER_TRANSFER_CEILING_IDR,
  PAYOUT_BANK_FORMATS,
  type UpsertPayoutConfigInput,
} from "@starter/shared/validators/payroll-payout";
import type { PayrollPayoutConfigDto } from "@starter/shared/types";
import { bankAccounts } from "../db/schema/accounting-cash-bank.ts";
import {
  payrollDisbursementBatches,
  payrollPayoutConfigs,
} from "../db/schema/payroll-payout.ts";
import { tenantIntegrations } from "../db/schema/platform-integrations.ts";
import { legalEntities } from "../db/schema/platform-org.ts";
import type { Tx } from "./hris-access.ts";
import {
  payoutRefuse,
  recordPayoutAudit,
  type PayoutActor,
} from "./payroll-payout.service.ts";

type ConfigRow = typeof payrollPayoutConfigs.$inferSelect;

/** A change to the money path is refused while a batch of the PT is in these. */
const BUSY_BATCH_STATUSES = [
  "pending_approval",
  "approved",
  "sending",
  "exported",
  "halted",
] as const;

const UUID_FORMAT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDto(row: ConfigRow): PayrollPayoutConfigDto {
  return {
    id: row.id,
    legalEntityId: row.legalEntityId,
    method: row.method,
    integrationId: row.integrationId,
    manualSourceBankAccountId: row.manualSourceBankAccountId,
    manualBankFormat:
      row.manualBankFormat as PayrollPayoutConfigDto["manualBankFormat"],
    maxPerTransferIdr: row.maxPerTransferIdr,
    dailyCapIdr: row.dailyCapIdr,
    feePerTransferIdr: row.feePerTransferIdr,
    enabled: row.enabled,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** The PT's payout config, or null while none was saved. */
export async function getPayoutConfig(
  tx: Tx,
  tenantId: string,
  legalEntityId: string,
): Promise<PayrollPayoutConfigDto | null> {
  if (!UUID_FORMAT.test(legalEntityId)) return null;
  const [row] = await tx
    .select()
    .from(payrollPayoutConfigs)
    .where(
      and(
        eq(payrollPayoutConfigs.tenantId, tenantId as TenantId),
        eq(payrollPayoutConfigs.legalEntityId, legalEntityId),
      ),
    );
  return row ? toDto(row) : null;
}

const invalid = (code: string, message: string) =>
  payoutRefuse(422, code, message);

/**
 * Creates or replaces the payout config of one PT. Limits that are missing
 * get the founder defaults (max Rp50 juta per transfer, fee Rp5.000 borne by
 * the company). Changing the method, integration, source account or the
 * enabled switch while a batch of the PT waits, is exported or halted is
 * refused: the money path must not move under an open batch.
 */
export async function upsertPayoutConfig(
  tx: Tx,
  actor: PayoutActor,
  legalEntityId: string,
  input: Partial<UpsertPayoutConfigInput> &
    Pick<UpsertPayoutConfigInput, "method" | "manualSourceBankAccountId">,
): Promise<PayrollPayoutConfigDto> {
  const tenantId = actor.tenantId as TenantId;
  if (!UUID_FORMAT.test(legalEntityId))
    throw payoutRefuse(404, "LEGAL_ENTITY_NOT_FOUND", "PT tidak ditemukan.");
  const [entity] = await tx
    .select({ id: legalEntities.id })
    .from(legalEntities)
    .where(
      and(
        eq(legalEntities.tenantId, tenantId),
        eq(legalEntities.id, legalEntityId),
      ),
    );
  if (!entity)
    throw payoutRefuse(404, "LEGAL_ENTITY_NOT_FOUND", "PT tidak ditemukan.");

  const method = input.method;
  const integrationId = input.integrationId ?? null;
  const manualBankFormat = input.manualBankFormat ?? "generic_csv";
  const maxPerTransferIdr =
    input.maxPerTransferIdr ?? PAYOUT_DEFAULT_MAX_PER_TRANSFER_IDR;
  const dailyCapIdr = input.dailyCapIdr ?? null;
  const feePerTransferIdr =
    input.feePerTransferIdr ?? PAYOUT_DEFAULT_FEE_PER_TRANSFER_IDR;
  const enabled = input.enabled ?? false;

  if (method !== "duitku" && method !== "manual_bank")
    throw invalid("PAYOUT_CONFIG_INVALID", "Metode pembayaran tidak dikenal.");
  if ((method === "duitku") !== (integrationId !== null))
    throw invalid(
      "PAYOUT_CONFIG_INVALID",
      method === "duitku"
        ? "Metode Duitku butuh integrasi."
        : "Transfer manual tidak memakai integrasi.",
    );
  if (!(PAYOUT_BANK_FORMATS as readonly string[]).includes(manualBankFormat))
    throw invalid("PAYOUT_CONFIG_INVALID", "Format berkas bank tidak dikenal.");
  if (
    !Number.isSafeInteger(maxPerTransferIdr) ||
    maxPerTransferIdr <= 0 ||
    maxPerTransferIdr > PAYOUT_MAX_PER_TRANSFER_CEILING_IDR
  )
    throw invalid(
      "PAYOUT_CONFIG_INVALID",
      "Batas per transfer harus lebih dari 0 dan paling banyak Rp100 juta.",
    );
  if (
    dailyCapIdr !== null &&
    (!Number.isSafeInteger(dailyCapIdr) || dailyCapIdr <= 0)
  )
    throw invalid("PAYOUT_CONFIG_INVALID", "Batas harian harus lebih dari 0.");
  if (!Number.isSafeInteger(feePerTransferIdr) || feePerTransferIdr < 0)
    throw invalid(
      "PAYOUT_CONFIG_INVALID",
      "Biaya transfer tidak boleh negatif.",
    );
  // Duitku is stored but not usable in this slice: it can never be switched on.
  if (method === "duitku" && enabled)
    throw payoutRefuse(
      409,
      "PAYOUT_CHANNEL_NOT_AVAILABLE",
      "Pembayaran lewat Duitku belum tersedia, belum bisa diaktifkan.",
    );

  const [account] = await tx
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.tenantId, tenantId),
        eq(bankAccounts.legalEntityId, legalEntityId),
        eq(bankAccounts.id, input.manualSourceBankAccountId),
        eq(bankAccounts.isActive, true),
      ),
    );
  if (!account)
    throw invalid(
      "PAYOUT_SOURCE_ACCOUNT_INVALID",
      "Rekening sumber harus rekening bank aktif milik PT ini.",
    );

  // M1: the integration must be an active Duitku integration of this tenant
  // (read under RLS); a pointer to another tenant's row is refused.
  if (integrationId !== null) {
    const [integration] = await tx
      .select({ id: tenantIntegrations.id })
      .from(tenantIntegrations)
      .where(
        and(
          eq(tenantIntegrations.tenantId, tenantId),
          eq(tenantIntegrations.id, integrationId),
          eq(tenantIntegrations.provider, "duitku"),
          eq(tenantIntegrations.status, "active"),
        ),
      );
    if (!integration)
      throw invalid(
        "PAYOUT_INTEGRATION_INVALID",
        "Integrasi Duitku tidak ditemukan atau belum aktif untuk tenant ini.",
      );
  }

  const [existing] = await tx
    .select()
    .from(payrollPayoutConfigs)
    .where(
      and(
        eq(payrollPayoutConfigs.tenantId, tenantId),
        eq(payrollPayoutConfigs.legalEntityId, legalEntityId),
      ),
    )
    .for("update");

  if (
    existing &&
    (existing.method !== method ||
      existing.integrationId !== integrationId ||
      existing.manualSourceBankAccountId !== input.manualSourceBankAccountId ||
      existing.enabled !== enabled)
  ) {
    const [busy] = await tx
      .select({ id: payrollDisbursementBatches.id })
      .from(payrollDisbursementBatches)
      .where(
        and(
          eq(payrollDisbursementBatches.tenantId, tenantId),
          eq(payrollDisbursementBatches.legalEntityId, legalEntityId),
          inArray(payrollDisbursementBatches.status, [...BUSY_BATCH_STATUSES]),
        ),
      )
      .limit(1);
    if (busy)
      throw payoutRefuse(
        409,
        "PAYOUT_CONFIG_BUSY",
        "Ada batch pembayaran yang sedang berjalan untuk PT ini. Selesaikan atau batalkan dulu sebelum mengubah pengaturan.",
      );
  }

  const now = new Date();
  const values = {
    method,
    integrationId,
    manualSourceBankAccountId: input.manualSourceBankAccountId,
    manualBankFormat,
    maxPerTransferIdr: idr(maxPerTransferIdr),
    dailyCapIdr: dailyCapIdr === null ? null : idr(dailyCapIdr),
    feePerTransferIdr: idr(feePerTransferIdr),
    enabled,
    updatedBy: actor.userId as UserId,
    updatedAt: now,
  };
  const [saved] = existing
    ? await tx
        .update(payrollPayoutConfigs)
        .set(values)
        .where(
          and(
            eq(payrollPayoutConfigs.tenantId, tenantId),
            eq(payrollPayoutConfigs.id, existing.id),
          ),
        )
        .returning()
    : await tx
        .insert(payrollPayoutConfigs)
        .values({ tenantId, legalEntityId, ...values })
        .returning();
  if (!saved) throw new Error("Payout config was not saved");

  await recordPayoutAudit(tx, actor, {
    action: "payroll.payout_config.updated",
    objectType: "payroll_payout_config",
    objectId: saved.id,
    before: existing
      ? {
          method: existing.method,
          enabled: String(existing.enabled),
          bankFormat: existing.manualBankFormat,
        }
      : { method: null, enabled: null, bankFormat: null },
    after: { method, enabled: String(enabled), bankFormat: manualBankFormat },
  });
  return toDto(saved);
}
