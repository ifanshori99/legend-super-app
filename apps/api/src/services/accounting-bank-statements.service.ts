// Bank statement import (bead legend-fnxl.3, WS-07; PRD v1.7 §3.19 "Impor
// mutasi bank (CSV)", ACC-04). Contract: `importBankStatement` in
// `@starter/shared/accounting` endpoints.
//
// - Entity-level work: tenant scope only (outlet RLS on cash_deposits would
//   hide deposits from an outlet-scoped caller and turn an ambiguous hit into
//   a wrong automatic match).
// - Idempotent per key (`accounting_command_idempotency`); a re-upload of the
//   same file under a new key adds no line: lines are inserted with
//   ON CONFLICT (tenant, bank account, dedupe_key) DO NOTHING and counted as
//   duplicates.
// - The whole file is refused when one row is unreadable
//   (accounting-bank-csv.ts); nothing is half imported.
// - After the insert, automatic matching runs over every unmatched line of
//   the account (not only this file), under the entity lock, so documents
//   booked after an earlier import still match.
// - The mapping used is saved on the account (tenant data) for the next file.

import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type {
  BankStatementImport,
  importBankStatementInputSchema,
} from "@starter/shared/accounting";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  CoreError,
  createUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { z } from "zod";
import { db } from "../db";
import {
  bankAccounts,
  bankStatementImports,
  type BankStatementImportRow,
} from "../db/schema/accounting-cash-bank.ts";
import { withTenant } from "../db/tenant.ts";
import {
  assertTenantScope,
  idempotentCommand,
} from "./accounting-ap-fa-shared.ts";
import { parseStatementCsv } from "./accounting-bank-csv.ts";
import {
  autoMatchBankAccount,
  entityLock,
} from "./accounting-bank-matching.ts";
import { loadBankAccount } from "./accounting-cash-bank-shared.ts";
import { loadMatchingPolicy } from "./accounting-finance-policy.service.ts";
import { recordAudit } from "./core-audit.ts";

type ImportInput = z.infer<typeof importBankStatementInputSchema>;

const IMPORT_AUDIT_SAFE_FIELDS = [
  "bankAccountId",
  "lineCount",
  "duplicateCount",
  "autoMatchedCount",
] as const;

/** Insert at most this many lines per statement (bind-parameter budget). */
const INSERT_CHUNK = 500;

export function bankStatementImportDto(
  row: BankStatementImportRow,
): BankStatementImport {
  return {
    id: row.id,
    tenantId: row.tenantId,
    bankAccountId: row.bankAccountId,
    fileName: row.fileName,
    importedBy: row.importedBy,
    importedAt: row.importedAt.toISOString(),
    lineCount: row.lineCount,
    duplicateCount: row.duplicateCount,
    autoMatchedCount: row.autoMatchedCount,
    postedFrom: row.postedFrom,
    postedTo: row.postedTo,
  } as BankStatementImport;
}

export async function importBankStatement(
  context: ScopedTenantContext,
  bankAccountId: string,
  input: ImportInput,
  actorId: string,
): Promise<BankStatementImport> {
  assertTenantScope(context);
  const tenantId = context.tenant.tenantId;
  // Parse before any write: an unreadable file never takes a lock.
  const parsed = parseStatementCsv(input.csv, input.mapping);
  const policy = await loadMatchingPolicy(context);
  const fileSha256 = createHash("sha256")
    .update(input.csv, "utf8")
    .digest("hex");
  return withTenant(db, context, async (tx) =>
    idempotentCommand(
      tx,
      context,
      {
        key: input.idempotencyKey,
        operation: "bank_statement.import",
        // The CSV is fingerprinted by hash: same key + same file replays.
        request: {
          bankAccountId,
          fileName: input.fileName,
          fileSha256,
          mapping: input.mapping,
        },
      },
      async () => {
        const account = await loadBankAccount(tx, tenantId, bankAccountId);
        if (!account.isActive)
          throw new CoreError(
            "VALIDATION_ERROR",
            "Rekening bank ini tidak aktif.",
          );
        await entityLock(tx, tenantId, account.legalEntityId);
        const importId = randomUUID();
        // Header first (FK target), counts filled in below.
        await tx.insert(bankStatementImports).values({
          id: importId,
          tenantId,
          bankAccountId,
          fileName: input.fileName,
          fileSha256,
          importedBy: actorId,
          lineCount: 0,
          duplicateCount: 0,
          autoMatchedCount: 0,
        });
        let inserted = 0;
        const dates: string[] = [];
        for (let start = 0; start < parsed.length; start += INSERT_CHUNK) {
          const chunk = parsed.slice(start, start + INSERT_CHUNK);
          const values = sql.join(
            chunk.map(
              (line) =>
                sql`(${tenantId}, ${bankAccountId}, ${importId}, ${line.postedOn}::date,
                  ${line.amountIdr}, ${line.description}, ${line.externalRef}, ${line.dedupeKey})`,
            ),
            sql`, `,
          );
          const result = await tx.execute(sql`
            INSERT INTO bank_statement_lines
              (tenant_id, bank_account_id, import_id, posted_on, amount_idr,
               description, external_ref, dedupe_key)
            VALUES ${values}
            ON CONFLICT (tenant_id, bank_account_id, dedupe_key) DO NOTHING
            RETURNING posted_on::text AS posted_on`);
          const rows = (result as unknown as { rows: { posted_on: string }[] })
            .rows;
          inserted += rows.length;
          for (const row of rows) dates.push(row.posted_on);
        }
        const { byImport } = await autoMatchBankAccount(
          tx,
          context,
          account,
          policy,
          actorId,
        );
        dates.sort();
        const [row] = await tx
          .update(bankStatementImports)
          .set({
            lineCount: inserted,
            duplicateCount: parsed.length - inserted,
            autoMatchedCount: byImport.get(importId) ?? 0,
            postedFrom: dates[0] ?? null,
            postedTo: dates.at(-1) ?? null,
          })
          .where(eq(bankStatementImports.id, importId))
          .returning();
        await tx
          .update(bankAccounts)
          .set({ csvMapping: input.mapping, updatedAt: new Date() })
          .where(eq(bankAccounts.id, bankAccountId));
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
            action: "accounting.bank_statement.imported",
            objectType: "bank_statement_import",
            objectId: importId,
            reason: null,
            maskedChanges: {
              before: null,
              after: maskAuditChanges(
                {
                  bankAccountId,
                  lineCount: row.lineCount,
                  duplicateCount: row.duplicateCount,
                  autoMatchedCount: row.autoMatchedCount,
                },
                IMPORT_AUDIT_SAFE_FIELDS,
              ),
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y",
            createdAt: new Date().toISOString(),
          },
          IMPORT_AUDIT_SAFE_FIELDS,
        );
        return bankStatementImportDto(row);
      },
    ),
  );
}
