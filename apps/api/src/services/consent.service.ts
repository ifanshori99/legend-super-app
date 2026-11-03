// Versioned consents (PRD v1.7 §2 privacy "persetujuan terpisah dan berversi
// untuk keanggotaan loyalty, pesan pemasaran, dan pemakaian data oleh AI",
// §6 B `consents`, LOY-04).
//
// Append-only: a grant and a withdrawal are both new rows; nothing is updated
// or deleted. The current consent per (subject, purpose) is the row with the
// highest `seq` ("latest wins"). Writers of one (subject, purpose) serialise on
// an advisory lock so two racing requests cannot both read the same "latest".
//
// Rules:
// - repeating the current decision for the same policy version is idempotent
//   (the existing row is returned, nothing is appended);
// - a withdrawal needs an existing grant (otherwise 409 NOTHING_TO_WITHDRAW);
// - consent never travels between tenants: every query is tenant-filtered on
//   top of RLS.

import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  consentRecordSchema,
  type ConsentRecord,
  type ListConsentsQuery,
  type RecordConsentInput,
} from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { consents } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { isStaffConsentSourceAllowed } from "@starter/shared/crm";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";

type Row = typeof consents.$inferSelect;

function toRecord(row: Row): ConsentRecord {
  return consentRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    subjectId: row.subjectId,
    purpose: row.purpose,
    policyVersion: row.policyVersion,
    decision: row.decision,
    source: row.source,
    recordedBy: row.recordedBy,
    recordedAt: row.recordedAt.toISOString(),
  });
}

function assertTenantWide(context: ScopedTenantContext): void {
  if (context.outletScope.kind !== "tenant")
    throw new AccessError(
      "PERMISSION_DENIED",
      "Your account cannot perform this action in this tenant.",
    );
}

/**
 * `latest`: the current consent per purpose (at most 3 rows) via the highest
 * seq. `history`: every event, newest first, cursor-paged on seq.
 */
export async function listConsents(
  context: ScopedTenantContext,
  query: ListConsentsQuery,
): Promise<{
  data: ConsentRecord[];
  meta: { limit: number; nextCursor: string | null };
}> {
  assertTenantWide(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    if (query.view === "latest") {
      const rows = await tx
        .selectDistinctOn([consents.purpose])
        .from(consents)
        .where(
          and(
            eq(consents.tenantId, tenantId),
            eq(consents.subjectId, query.subjectId),
          ),
        )
        .orderBy(consents.purpose, desc(consents.seq));
      return {
        data: rows.map(toRecord),
        meta: { limit: query.limit, nextCursor: null },
      };
    }
    let before: number | undefined;
    if (query.cursor) {
      try {
        const [seq] = decodeCursor(query.cursor);
        if (typeof seq === "number") before = seq;
      } catch {
        // fall through to the validation error below
      }
      if (before === undefined)
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
    }
    const rows = await tx
      .select()
      .from(consents)
      .where(
        and(
          eq(consents.tenantId, tenantId),
          eq(consents.subjectId, query.subjectId),
          ...(before === undefined ? [] : [lt(consents.seq, before)]),
        ),
      )
      .orderBy(desc(consents.seq))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toRecord),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last ? encodeCursor([last.seq]) : null,
      },
    };
  });
}

export async function recordConsent(
  context: ScopedTenantContext,
  input: RecordConsentInput,
  actorUserId: string,
): Promise<ConsentRecord> {
  // legend-ovi8 / LOY-04: this back-office path is staff-only; member_pwa and
  // website consents come from the customer's own session, never from staff.
  if (!isStaffConsentSourceAllowed(input.source))
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Staff can only record consent from the cashier or an import.",
    );
  // Opus review: cashier/outlet_manager hold crm.consent.record (coordinator
  // decision) and work outlet-scoped. A consent is a tenant-wide customer fact,
  // so an outlet-scoped member may record one, but only as witnessed at the
  // counter; bulk `import` stays tenant-wide.
  if (context.outletScope.kind !== "tenant" && input.source !== "cashier")
    assertTenantWide(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`consents:${tenantId}:${input.subjectId}:${input.purpose}`}, 0))`,
    );
    const [current] = await tx
      .select()
      .from(consents)
      .where(
        and(
          eq(consents.tenantId, tenantId),
          eq(consents.subjectId, input.subjectId),
          eq(consents.purpose, input.purpose),
        ),
      )
      .orderBy(desc(consents.seq))
      .limit(1);

    if (
      current &&
      current.decision === input.decision &&
      current.policyVersion === input.policyVersion
    )
      return toRecord(current);
    if (input.decision === "withdrawn" && current?.decision !== "granted")
      throw new HttpError(
        409,
        "NOTHING_TO_WITHDRAW",
        "There is no active consent to withdraw.",
      );

    const [row] = await tx
      .insert(consents)
      .values({
        id: randomUUID(),
        tenantId,
        subjectId: input.subjectId,
        purpose: input.purpose,
        policyVersion: input.policyVersion,
        decision: input.decision,
        source: input.source,
        recordedBy: actorUserId,
      })
      .returning();
    if (!row) throw new Error("Consent was not recorded");

    await recordAudit(
      tx,
      context,
      {
        id: createUlid(),
        tenantId,
        // An outlet-scoped recorder (cashier, legend-ovi8) audits under the
        // first outlet it reaches; tenant-wide audits need tenant scope.
        outletId:
          context.outletScope.kind === "tenant"
            ? null
            : [...context.outletScope.outletIds].sort()[0],
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action:
          input.decision === "granted"
            ? "consent.granted"
            : "consent.withdrawn",
        objectType: "consent",
        objectId: row.id,
        reason: null,
        maskedChanges: {
          before: current
            ? {
                decision: current.decision,
                policyVersion: current.policyVersion,
              }
            : null,
          after: {
            purpose: row.purpose,
            decision: row.decision,
            policyVersion: row.policyVersion,
            source: row.source,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: new Date().toISOString(),
      },
      ["purpose", "decision", "policyVersion", "source"],
    );
    return toRecord(row);
  });
}
