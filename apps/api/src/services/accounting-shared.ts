// Shared plumbing for the accounting services (WS-07 core, bead legend-kwxj).
// Row shapes follow the Drizzle schema; wire shapes are parsed from
// `@starter/shared/accounting`, never redefined here.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LegalEntityId } from "@starter/shared/accounting";
import { createUlid, type UserId } from "@starter/shared/core";
import type { ScopedTenantContext } from "@starter/shared/core";
import type * as schema from "../db/schema";
import { legalEntities, outlets } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";

export type Database = NodePgDatabase<typeof schema>;
export type TenantTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/** PostgreSQL unique violation, directly or wrapped by drizzle's cause chain. */
export function uniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

/** The journal fact a posting request asks for; hashed into its fingerprint. */
export type JournalFingerprintInput = {
  readonly legalEntityId: string;
  readonly outletId: string | null;
  readonly entryDate: string;
  readonly sourceType: string;
  readonly sourceId: string | null;
  readonly description: string;
  readonly lines: readonly {
    readonly accountId: string;
    readonly debitIdr: number;
    readonly creditIdr: number;
    readonly outletId: string | null;
    readonly costCenter: string | null;
  }[];
  /** Original business date of a late adjustment; null for a normal entry. */
  readonly lateAdjustmentFrom?: string | null;
};

/**
 * sha256 of the canonical posting request. The idempotency key is bound to this
 * value: a retry must present the same business fact, otherwise the request is
 * refused with IDEMPOTENCY_KEY_REUSED instead of returning a foreign entry.
 */
export function journalRequestFingerprint(
  input: JournalFingerprintInput,
): string {
  const fields: unknown[] = [
    input.legalEntityId.toLowerCase(),
    input.outletId?.toLowerCase() ?? null,
    input.entryDate,
    input.sourceType,
    input.sourceId?.toLowerCase() ?? null,
    input.description,
    input.lines.map((line) => [
      line.accountId.toLowerCase(),
      line.debitIdr,
      line.creditIdr,
      line.outletId?.toLowerCase() ?? null,
      line.costCenter ?? null,
    ]),
  ];
  // Only a late adjustment adds a field, so every existing fingerprint (and so
  // every stored idempotency binding) stays unchanged.
  if (input.lateAdjustmentFrom) fields.push(["late", input.lateAdjustmentFrom]);
  const canonical = JSON.stringify(fields);
  return createHash("sha256").update(canonical).digest("hex");
}

/** A legal entity of this tenant; RLS already hides other tenants' rows. */
export async function requireLegalEntity(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: LegalEntityId | string,
): Promise<void> {
  const [row] = await tx
    .select({ id: legalEntities.id })
    .from(legalEntities)
    .where(
      and(
        eq(legalEntities.tenantId, tenantId),
        eq(legalEntities.id, legalEntityId),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Legal entity not found.");
}

/** An outlet of this tenant (the composite FK also rejects another tenant). */
export async function requireOutlet(
  tx: TenantTransaction,
  tenantId: string,
  outletId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
}

/** Field names an accounting audit row may keep unmasked (default-deny). */
const AUDIT_SAFE_FIELDS = [
  "code",
  "type",
  "reportGroup",
  "isActive",
  "parentCode",
  "role",
  "glCode",
  "count",
  "carryDeductedIdr",
  "entryDate",
  "sourceType",
  "reversalEntryId",
  "version",
  // legend-xysyi: counts and a flag, never a tax id.
  "lineTaxIds",
  "taxpayerIncluded",
  // legend-b8y6l: "sole_owner" marks a sole Owner's self-approval.
  "selfApproval",
  // card 1263: ids and codes of the batches a close override acknowledged.
  "sourceId",
  "errorCode",
] as const;

/** Writes one append-only audit row inside the caller's transaction. */
export async function auditAccountingChange(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: {
    /** Null records a system decision (actorType "system"). */
    actorId: UserId | null;
    action: string;
    objectType: string;
    objectId: string | null;
    outletId?: string | null;
    reason?: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId ?? null,
      actorType: input.actorId === null ? "system" : "user",
      actorId: input.actorId,
      deviceId: null,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      reason: input.reason ?? null,
      maskedChanges: { before: input.before, after: input.after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: new Date().toISOString(),
    },
    AUDIT_SAFE_FIELDS,
  );
}
