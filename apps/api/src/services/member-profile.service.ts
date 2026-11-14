// Member profile reads and identity sync (legend-111j, design §M4 and §M7).
// Member services take the profile from the session (`MemberScope`), never from
// a path, query or body. Callers run inside `withMemberScope`.

import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  customerProfileSchema,
  type CustomerProfile,
} from "@starter/shared/crm";
import type { TenantId } from "@starter/shared/core";
import type { CustomerProfileRow } from "../db/member-scope";
import type * as schema from "../db/schema";
import { consents, userIdentities } from "../db/schema";
import { customerProfiles } from "../db/schema/crm-member";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function findProfileByUser(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<CustomerProfileRow | null> {
  const [row] = await tx
    .select()
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.tenantId, tenantId as TenantId),
        eq(customerProfiles.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Lookup only, never creates: a guest booking links to an existing member
 * profile (has a user, not closed/suspended/merged) of the same tenant whose
 * WhatsApp hash matches. An unverified number must not mint a phantom profile
 * that would collide with the real owner's unique (tenant, whatsapp_hash).
 */
export async function findLinkableProfileIdByWhatsAppHash(
  tx: Tx,
  tenantId: string,
  whatsappHash: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: customerProfiles.id })
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.tenantId, tenantId as TenantId),
        eq(customerProfiles.whatsappHash, whatsappHash),
        notInArray(customerProfiles.membershipStatus, ["closed", "suspended"]),
        isNull(customerProfiles.mergedIntoProfileId),
        isNotNull(customerProfiles.userId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** The user's verified WhatsApp identity (global table), if any. */
export async function verifiedWhatsAppOfUser(
  tx: Tx,
  userId: string,
): Promise<{ hash: string; verifiedAt: Date } | null> {
  const [row] = await tx
    .select({
      hash: userIdentities.valueHash,
      verifiedAt: userIdentities.verifiedAt,
    })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userId, userId),
        eq(userIdentities.type, "whatsapp"),
        isNotNull(userIdentities.verifiedAt),
      ),
    )
    .limit(1);
  return row?.verifiedAt
    ? { hash: row.hash, verifiedAt: row.verifiedAt }
    : null;
}

/**
 * True when the latest loyalty consent row (highest seq) recorded at or before
 * `at` is a grant. The earn consumer asks this at `paidAt`.
 */
export async function loyaltyConsentActive(
  tx: Tx,
  tenantId: string,
  profileId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const [row] = await tx
    .select({ decision: consents.decision })
    .from(consents)
    .where(
      and(
        eq(consents.tenantId, tenantId),
        eq(consents.subjectId, profileId),
        eq(consents.purpose, "loyalty"),
        lte(consents.recordedAt, at),
      ),
    )
    .orderBy(desc(consents.seq))
    .limit(1);
  return row?.decision === "granted";
}

/**
 * A WhatsApp number of this user was verified (or kept after a merge): store
 * the digest on the user's profiles visible in this transaction's tenant and
 * move `pending_verification` to `active` when the loyalty consent is active.
 * Called by the identity module (k2l) after a link and after a merge.
 */
export async function onWhatsAppVerified(
  tx: Tx,
  userId: string,
  whatsappHash: string,
): Promise<void> {
  const verifiedAt = new Date();
  const profiles = await tx
    .select()
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.userId, userId),
        sql`${customerProfiles.tenantId} = current_setting('app.tenant_id', true)::uuid`,
      ),
    )
    .for("update");
  for (const profile of profiles) {
    if (profile.membershipStatus === "closed") continue;
    const activate =
      profile.membershipStatus === "pending_verification" &&
      (await loyaltyConsentActive(tx, profile.tenantId, profile.id));
    await tx
      .update(customerProfiles)
      .set({
        whatsappHash,
        whatsappVerifiedAt: profile.whatsappVerifiedAt ?? verifiedAt,
        ...(activate ? { membershipStatus: "active" as const } : {}),
        updatedAt: verifiedAt,
      })
      .where(
        and(
          eq(customerProfiles.tenantId, profile.tenantId),
          eq(customerProfiles.id, profile.id),
        ),
      );
  }
}

/** Contract shape. Routes strip the hash. */
export function toCustomerProfileDto(row: CustomerProfileRow): CustomerProfile {
  return customerProfileSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    whatsappHash: row.whatsappHash,
    name: row.name,
    birthMonthDay: row.birthMonthDay,
    tierId: row.tierId,
    pointsBalance: row.pointsBalance,
    lifetimeSpendIdr: row.lifetimeSpendIdr,
    visitsCount: row.visitsCount,
    firstVisitAt: row.firstVisitAt?.toISOString() ?? null,
    lastVisitAt: row.lastVisitAt?.toISOString() ?? null,
    marketingOptIn: row.marketingOptIn,
    referralCode: row.referralCode,
    membershipStatus: row.membershipStatus,
    whatsappVerifiedAt: row.whatsappVerifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}
