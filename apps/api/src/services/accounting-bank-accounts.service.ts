// Bank accounts (bead legend-fnxl.2, WS-07; PRD v1.7 §3.19 Kas & Bank, §6 F
// `bank_accounts`). Contract: `@starter/shared/accounting` banking.ts,
// endpoints `listBankAccounts` / `createBankAccount`.
//
// - Entity-level data (no outlet): tenant scope only (assertTenantScope). A
//   foreign tenant's legal entity is "not found" (RLS hides it).
// - The account number is sealed (AAD = tenant + row + field + key version),
//   indexed by a tenant-separated HMAC so one number exists once per legal
//   entity, and only its last 4 digits stay in clear for the mask. It never
//   appears in a response or an audit row.
// - The GL account must belong to the entity, be active and be postable (no
//   child accounts).
// - A duplicate number answers 409 CONFLICT, never a 500: the service checks
//   under the entity lock and also maps a unique-key race (23505).

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  AccountingError,
  createBankAccountInputSchema,
  type BankAccount,
} from "@starter/shared/accounting";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  assertTrustedScopedContext,
  CoreError,
  createUlid,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import { chartOfAccounts } from "../db/schema/accounting.ts";
import { bankAccounts } from "../db/schema/accounting-cash-bank.ts";
import { withTenant } from "../db/tenant.ts";
import {
  BLIND_INDEX_ACTIVE_VERSION,
  blindIndexAt,
  blindIndexCandidates,
} from "../lib/blind-index.ts";
import { sealSecret } from "../lib/secrets.ts";
import {
  assertTenantScope,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";
import { entityLock } from "./accounting-bank-matching.ts";
import { bankAccountDto, notFound } from "./accounting-cash-bank-shared.ts";
import { requireLegalEntity } from "./accounting-shared.ts";
import { recordAudit } from "./core-audit.ts";

/** Audit fields kept unmasked (default-deny; sensitive keys stay redacted). */
const AUDIT_SAFE_FIELDS = ["legalEntityId", "bank", "isActive"] as const;

/** Key version of the sealed account number (AAD suffix, column value). */
const ACCOUNT_NUMBER_KEY_VERSION = 1;

const DUPLICATE_NUMBER = () =>
  new CoreError(
    "CONFLICT",
    "Nomor rekening ini sudah terdaftar di badan usaha ini.",
  );

/** The GL account must be of this entity, active and a leaf (postable). */
async function assertPostableGlAccount(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  glAccountId: string,
): Promise<void> {
  const [account] = await tx
    .select({
      legalEntityId: chartOfAccounts.legalEntityId,
      isActive: chartOfAccounts.isActive,
    })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.id, glAccountId),
      ),
    )
    .limit(1);
  if (!account) throw notFound("Akun");
  if (account.legalEntityId !== legalEntityId)
    throw new AccountingError("ACCOUNT_ENTITY_MISMATCH");
  if (!account.isActive) throw new AccountingError("ACCOUNT_INACTIVE");
  const [child] = await tx
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.parentId, glAccountId),
      ),
    )
    .limit(1);
  if (child) throw new AccountingError("ACCOUNT_NOT_POSTABLE");
}

/** True when `error` (or its cause) is a PostgreSQL unique violation. */
function isUniqueViolation(error: unknown): boolean {
  for (
    let current: unknown = error;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  )
    if ((current as { code?: unknown }).code === "23505") return true;
  return false;
}

/** Bank accounts of one legal entity (masked numbers only). */
export async function listBankAccounts(
  context: ScopedTenantContext,
  legalEntityId: string,
): Promise<BankAccount[]> {
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, legalEntityId);
    const rows = await tx
      .select()
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.tenantId, tenantId),
          eq(bankAccounts.legalEntityId, legalEntityId),
        ),
      )
      .orderBy(
        asc(bankAccounts.bank),
        asc(bankAccounts.accountName),
        asc(bankAccounts.id),
      );
    return rows.map(bankAccountDto);
  });
}

/** Registers a bank account (contract `createBankAccount`); audited. */
export async function createBankAccount(
  context: ScopedTenantContext,
  rawInput: unknown,
  actorId: UserId,
): Promise<BankAccount> {
  const input = createBankAccountInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  try {
    return await withTenant(db, context, async (tx) => {
      const tenantId = context.tenant.tenantId;
      await requireLegalEntity(tx, tenantId, input.legalEntityId);
      await entityLock(tx, tenantId, input.legalEntityId);
      await assertPostableGlAccount(
        tx,
        tenantId,
        input.legalEntityId,
        input.glAccountId,
      );

      const tenantLower = tenantId.toLowerCase();
      const purpose = `bank:account_number:${tenantLower}`;
      // Written under the active version; the duplicate check reads both so a
      // number registered under the other version is still refused (legend-baxdx).
      const hmac = blindIndexAt(
        BLIND_INDEX_ACTIVE_VERSION,
        input.accountNumber,
        purpose,
      );
      const digests = blindIndexCandidates(input.accountNumber, purpose).map(
        (candidate) => candidate.digest,
      );
      const [taken] = await tx
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(
          and(
            eq(bankAccounts.tenantId, tenantId),
            eq(bankAccounts.legalEntityId, input.legalEntityId),
            inArray(bankAccounts.accountNumberHmac, digests),
          ),
        )
        .limit(1);
      if (taken) throw DUPLICATE_NUMBER();

      const id = randomUUID();
      const aad = `bank:bank_accounts:${tenantLower}:${id.toLowerCase()}:account_number:k${ACCOUNT_NUMBER_KEY_VERSION}`;
      const [row] = await tx
        .insert(bankAccounts)
        .values({
          id,
          tenantId,
          legalEntityId: input.legalEntityId,
          bank: input.bank,
          accountName: input.accountName,
          accountNumberEncrypted: Buffer.from(
            sealSecret(input.accountNumber, aad),
            "base64",
          ),
          accountNumberHmac: hmac,
          accountNumberHmacVersion: BLIND_INDEX_ACTIVE_VERSION,
          accountNumberLast4: input.accountNumber.slice(-4),
          accountNumberKeyVersion: ACCOUNT_NUMBER_KEY_VERSION,
          glAccountId: input.glAccountId,
          createdBy: actorId,
        })
        .returning();
      if (!row) throw new Error("Bank account insert returned no row.");
      // No account number (nor its last digits) in the audit row. Names and
      // account-like keys are redacted by the default-deny masking; the
      // caller masks first because the audit schema refuses raw sensitive keys.
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(),
          tenantId,
          outletId: null,
          actorType: "user",
          actorId,
          deviceId: null,
          action: "accounting.bank_account.created",
          objectType: "bank_account",
          objectId: row.id,
          reason: null,
          maskedChanges: {
            before: null,
            after: maskAuditChanges(
              {
                legalEntityId: row.legalEntityId,
                bank: row.bank,
                accountName: row.accountName,
                glAccountId: row.glAccountId,
                isActive: row.isActive,
              },
              AUDIT_SAFE_FIELDS,
            ),
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: new Date().toISOString(),
        },
        AUDIT_SAFE_FIELDS,
      );
      return bankAccountDto(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw DUPLICATE_NUMBER();
    throw error;
  }
}
