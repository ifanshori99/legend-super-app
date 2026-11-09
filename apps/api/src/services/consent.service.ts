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
import { and, desc, eq, lt, lte, sql } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  consentRecordSchema,
  type ConsentRecord,
  type ListConsentsQuery,
  type RecordConsentInput,
} from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { consents, user } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  isStaffConsentSourceAllowed,
  customerConsentSchema,
  type ConsentPolicyVersion,
  type ConsentPurpose,
  type CustomerConsent,
} from "@starter/shared/crm";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
// legend-111j
import {
  setMemberProfileGuc,
  withMemberScope,
  withProfileLock,
  type MemberScope,
} from "../db/member-scope.ts";
import {
  consentPolicyVersions,
  customerProfiles,
} from "../db/schema/crm-member.ts";
import {
  findProfileByUser,
  verifiedWhatsAppOfUser,
} from "./member-profile.service.ts";

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

// ------------------------------------------------- member PWA consents
// legend-111j (design §M7). The member records their own consent; the profile
// comes from the session scope, never from the request.

type MemberTx = Parameters<Parameters<typeof withMemberScope>[2]>[0];

export type MemberConsentInput = {
  purpose: ConsentPurpose;
  granted: boolean;
  policyVersion: string;
};

/** The active policy version per purpose: the latest `published_at <= now`. */
export async function activeConsentPolicies(
  tx: MemberTx,
  tenantId: string,
  now: Date,
): Promise<ConsentPolicyVersion[]> {
  const rows = await tx
    .selectDistinctOn([consentPolicyVersions.purpose])
    .from(consentPolicyVersions)
    .where(
      and(
        eq(consentPolicyVersions.tenantId, tenantId as TenantId),
        lte(consentPolicyVersions.publishedAt, now),
      ),
    )
    .orderBy(
      consentPolicyVersions.purpose,
      desc(consentPolicyVersions.publishedAt),
    );
  return rows.map((row) => ({
    purpose: row.purpose as ConsentPurpose,
    version: row.version,
    publishedAt: row.publishedAt.toISOString(),
  }));
}

/** Maps a consent row to the contract shape; a withdrawal carries its grant's time. */
async function toMemberConsent(
  tx: MemberTx,
  row: Row,
): Promise<CustomerConsent> {
  let grantedAt = row.recordedAt;
  let withdrawnAt: Date | null = null;
  if (row.decision === "withdrawn") {
    withdrawnAt = row.recordedAt;
    const [grant] = await tx
      .select({ recordedAt: consents.recordedAt })
      .from(consents)
      .where(
        and(
          eq(consents.tenantId, row.tenantId),
          eq(consents.subjectId, row.subjectId),
          eq(consents.purpose, row.purpose),
          eq(consents.decision, "granted"),
          lt(consents.seq, row.seq),
        ),
      )
      .orderBy(desc(consents.seq))
      .limit(1);
    if (grant && grant.recordedAt <= row.recordedAt)
      grantedAt = grant.recordedAt;
  }
  return customerConsentSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    customerProfileId: row.subjectId,
    purpose: row.purpose,
    policyVersion: row.policyVersion,
    grantedAt: grantedAt.toISOString(),
    withdrawnAt: withdrawnAt?.toISOString() ?? null,
    source: row.source,
  });
}

/** Creates the member's profile at signup (loyalty granted, no profile yet). */
async function createMemberProfile(
  tx: MemberTx,
  scope: MemberScope,
  now: Date,
) {
  // One signup at a time per (tenant, user): the unique index would otherwise
  // abort the second of two racing requests.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`member-signup:${scope.tenantId}:${scope.userId}`}, 0))`,
  );
  const existing = await findProfileByUser(tx, scope.tenantId, scope.userId);
  if (existing) return existing;
  const whatsapp = await verifiedWhatsAppOfUser(tx, scope.userId);
  const [account] = await tx
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, scope.userId))
    .limit(1);
  const name = account?.name.trim().slice(0, 120) || "Member";
  const id = randomUUID();
  // The GUC must name the new row before it is inserted (member_self policy).
  await setMemberProfileGuc(tx, id);
  const [created] = await tx
    .insert(customerProfiles)
    .values({
      id,
      tenantId: scope.tenantId as TenantId,
      userId: scope.userId,
      name,
      whatsappHash: whatsapp?.hash ?? null,
      whatsappVerifiedAt: whatsapp?.verifiedAt ?? null,
      membershipStatus: whatsapp ? "active" : "pending_verification",
      referralCode: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!created) throw new Error("Member profile was not created");
  return created;
}

/**
 * Same advisory lock, idempotency and audit as the staff `recordConsent`, with
 * source `member_pwa`. The caller already holds `withMemberScope`; 290b's
 * merge reuses this form inside its own transaction.
 */
export async function recordMemberConsentInTx(
  tx: MemberTx,
  scope: MemberScope,
  input: MemberConsentInput,
  now: Date,
): Promise<CustomerConsent> {
  const tenantId = scope.tenantId;
  const decision = input.granted ? "granted" : "withdrawn";

  let profile;
  if (scope.customerProfileId === null) {
    if (!(input.purpose === "loyalty" && input.granted))
      throw new HttpError(
        404,
        "CUSTOMER_NOT_FOUND",
        "Pelanggan tidak ditemukan.",
      );
    profile = await createMemberProfile(tx, scope, now);
  } else {
    profile = await withProfileLock(tx, tenantId, scope.customerProfileId);
  }
  if (profile.membershipStatus === "closed" || profile.userId !== scope.userId)
    throw new HttpError(
      404,
      "CUSTOMER_NOT_FOUND",
      "Pelanggan tidak ditemukan.",
    );
  const subjectId = profile.id;

  if (input.granted) {
    const active = (await activeConsentPolicies(tx, tenantId, now)).find(
      (policy) => policy.purpose === input.purpose,
    );
    if (!active || active.version !== input.policyVersion)
      throw new HttpError(
        409,
        "CONSENT_POLICY_OUTDATED",
        "Versi kebijakan sudah diperbarui. Muat ulang lalu setujui versi terbaru.",
      );
  }

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`consents:${tenantId}:${subjectId}:${input.purpose}`}, 0))`,
  );
  const [current] = await tx
    .select()
    .from(consents)
    .where(
      and(
        eq(consents.tenantId, tenantId),
        eq(consents.subjectId, subjectId),
        eq(consents.purpose, input.purpose),
      ),
    )
    .orderBy(desc(consents.seq))
    .limit(1);
  if (
    current &&
    current.decision === decision &&
    current.policyVersion === input.policyVersion
  )
    return toMemberConsent(tx, current);
  if (!input.granted && current?.decision !== "granted")
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
      subjectId,
      purpose: input.purpose,
      policyVersion: input.policyVersion,
      decision,
      source: "member_pwa",
      recordedBy: scope.userId,
      recordedAt: now,
    })
    .returning();
  if (!row) throw new Error("Consent was not recorded");

  // Keep the profile in step: marketing flag, and the loyalty status.
  const patch: Partial<typeof customerProfiles.$inferInsert> = {};
  if (input.purpose === "marketing") patch.marketingOptIn = input.granted;
  if (input.purpose === "loyalty") {
    if (!input.granted) {
      patch.membershipStatus = "suspended";
    } else if (profile.membershipStatus !== "active") {
      const whatsapp = profile.whatsappVerifiedAt
        ? null
        : await verifiedWhatsAppOfUser(tx, scope.userId);
      if (whatsapp) {
        patch.whatsappHash = whatsapp.hash;
        patch.whatsappVerifiedAt = whatsapp.verifiedAt;
      }
      patch.membershipStatus =
        profile.whatsappVerifiedAt || whatsapp
          ? "active"
          : "pending_verification";
    }
  }
  if (Object.keys(patch).length > 0)
    await tx
      .update(customerProfiles)
      .set({ ...patch, updatedAt: now })
      .where(
        and(
          eq(customerProfiles.tenantId, tenantId as TenantId),
          eq(customerProfiles.id, subjectId),
        ),
      );

  await recordAudit(
    tx,
    scope.context,
    {
      id: createUlid(),
      tenantId,
      outletId: null,
      actorType: "user",
      actorId: scope.userId,
      deviceId: null,
      action: input.granted ? "consent.granted" : "consent.withdrawn",
      objectType: "consent",
      objectId: row.id,
      reason: null,
      maskedChanges: {
        before: current
          ? { decision: current.decision, policyVersion: current.policyVersion }
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
      createdAt: now.toISOString(),
    },
    ["purpose", "decision", "policyVersion", "source"],
  );
  return toMemberConsent(tx, row);
}

/** Opens the member scope, then records the consent (signup creates the profile). */
export async function recordMemberConsent(
  scope: MemberScope,
  input: MemberConsentInput,
  now: Date = new Date(),
): Promise<CustomerConsent> {
  return withMemberScope(db, scope, (tx) =>
    recordMemberConsentInTx(tx, scope, input, now),
  );
}
