// Identity merge (legend-k2l; docs/design/ws08-member-loyalty.md M3; brief
// docs/briefs/290b-k2l-member-signin-identity.md; AUTH-07).
//
// A signed-in user U (the survivor) proves a WhatsApp number by reverse OTP
// (the link path of `identity-wa-inbound.service.ts`) that already belongs to
// another account V (the absorbed one). When V is only a WhatsApp account the
// two are one person, so V is folded into U in ONE transaction:
//
//   1. advisory locks on both user ids, in sorted order (no deadlock between
//      two merges, and no race with a concurrent link or sign-in);
//   2. refusal checks (below), each returned as a `refused` outcome, never
//      thrown, so the caller can keep its own cancel-and-audit path;
//   3. V's identity rows move to U;
//   4. V's member profiles move to U (`moveMemberProfiles`, a no-op until the
//      profile tables of legend-111j/290a exist);
//   5. V's sessions are deleted and V is banned (`banReason = 'merged'`), so a
//      stale cookie of V can never act again;
//   6. one append-only `identity_merges` row records who absorbed whom, which
//      identity rows moved and what happened to each profile.
//
// Refusals (design M3 rule 1 and 2):
// - `IDENTITY_MERGE_NEEDS_SUPPORT`: V holds any identity other than the number
//   just proven, a real (not `.invalid`) e-mail, any Better Auth `account` row,
//   any role assignment in any tenant, a `platform_admins` row, or is already
//   banned or merged. A WhatsApp-only account belongs to whoever controls the
//   number (D16); an account with an email or Google identity may belong to a
//   different person (recycled numbers), so support decides.
// - `WHATSAPP_ALREADY_ON_ACCOUNT`: U already holds a different WhatsApp number
//   (`user_identities_one_whatsapp_per_user`).
//
// The audit rows of a merge or a refusal are tenant-scoped (`audit_logs` has
// FORCE RLS), so the caller, which owns the tenant context, writes them from
// the returned outcome. This service only writes global tables. The global
// `identity_merges` row is itself the permanent trail of a success.
//
// AUTH-03: nothing is sent back to the WhatsApp number. `mergedReplyText` is
// the agreed wording for the day an outbound reply path exists.

import { and, eq, ne, sql } from "drizzle-orm";
import { maskEmail } from "@starter/shared/identity";
import type { db } from "../db";
import {
  account,
  platformAdmins,
  session,
  user,
  userIdentities,
} from "../db/schema";
import { identityMerges } from "../db/schema/identity-merge.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type MergeRefusalCode =
  "IDENTITY_MERGE_NEEDS_SUPPORT" | "WHATSAPP_ALREADY_ON_ACCOUNT";

export type MergeOutcome =
  | {
      kind: "merged";
      mergeId: string;
      survivorUserId: string;
      absorbedUserId: string;
      maskedSurvivorEmail: string | null;
    }
  | { kind: "refused"; code: MergeRefusalCode; reason: string };

/** One tenant's profile decision inside `identity_merges.profile_moves`. */
export type ProfileMove = {
  tenantId: string;
  profileId: string;
  action: string;
};

export type MergeInput = {
  survivorUserId: string;
  absorbedUserId: string;
  /** The WhatsApp identity row (owned by V) that was just proven. */
  whatsappIdentityId: string;
  trigger: "whatsapp_link";
  /** The signed-in user who proved the number; null when no user acted. */
  actorUserId: string | null;
  now: Date;
};

function refuse(code: MergeRefusalCode, reason: string): MergeOutcome {
  return { kind: "refused", code, reason };
}

/** The e-mail shown to the person: null for a `@wa.invalid` placeholder. */
function maskedSurvivorEmail(email: string | null | undefined): string | null {
  if (!email || email.toLowerCase().endsWith(".invalid")) return null;
  return maskEmail(email);
}

/**
 * Step 4 of design M3: move V's member profiles to U, tenant by tenant.
 *
 * TODO(legend-111j/290a): needs `customer_profiles`, the SECURITY DEFINER
 * `app.member_profiles_of_user(text)` (returns `(tenant_id, profile_id,
 * status)`), `recordMemberConsent` and `onWhatsAppVerified`. Rules per tenant
 * (design M3 step 5), each tenant under `withTenant` for that tenant:
 * - Only V has a profile: repoint `customer_profiles.user_id` to U.
 * - Both have one and U's is empty (no WhatsApp hash, so
 *   `pending_verification`, and no rows in `point_ledger`,
 *   `reward_redemptions`, `vouchers`, `orders`, `customer_visits`, `feedback`,
 *   `referrals`, `mission_progress`): close U's profile
 *   (`membership_status = 'closed'`, `user_id = NULL`, `merged_into_profile_id`
 *   = V's profile), repoint V's profile to U, and re-record U's latest consent
 *   decisions onto V's profile with `recordMemberConsent` (source
 *   `member_pwa`, same policy version).
 * - Anything else: refuse the whole merge with `IDENTITY_MERGE_NEEDS_SUPPORT`
 *   (this function will then need to return a refusal, not only moves).
 * The ledger never moves: it keys on `customer_profile_id`, which survives.
 */
export async function moveMemberProfiles(
  tx: Transaction,
  input: { survivorUserId: string; absorbedUserId: string; now: Date },
): Promise<ProfileMove[]> {
  // TODO(legend-111j/290a): implement with `tx` and `input` once
  // `customer_profiles` exists. No member profile exists before 290a, so
  // there is nothing to move yet.
  void tx;
  void input;
  return [];
}

export async function mergeAbsorbedIntoSurvivor(
  tx: Transaction,
  input: MergeInput,
): Promise<MergeOutcome> {
  const { survivorUserId, absorbedUserId } = input;
  if (survivorUserId === absorbedUserId)
    return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", "same_user");

  // Sorted order: two merges touching the same pair always lock the same way.
  for (const id of [survivorUserId, absorbedUserId].sort()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${"identity-merge:" + id}, 0))`,
    );
  }

  const [absorbed] = await tx
    .select({ id: user.id, email: user.email, banned: user.banned })
    .from(user)
    .where(eq(user.id, absorbedUserId))
    .for("update");
  const [survivor] = await tx
    .select({ id: user.id, email: user.email, banned: user.banned })
    .from(user)
    .where(eq(user.id, survivorUserId))
    .for("update");
  if (!absorbed || !survivor || absorbed.banned || survivor.banned)
    return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", "account_unavailable");

  const [alreadyMerged] = await tx
    .select({ id: identityMerges.id })
    .from(identityMerges)
    .where(eq(identityMerges.absorbedUserId, absorbedUserId));
  if (alreadyMerged)
    return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", "already_merged");

  // V must be WhatsApp-only: no identity other than the number just proven.
  const [otherIdentity] = await tx
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userId, absorbedUserId),
        ne(userIdentities.id, input.whatsappIdentityId),
      ),
    )
    .limit(1);
  if (otherIdentity)
    return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", "absorbed_has_identity");

  // Pre-k2l password accounts and Google users whose identity write failed hold
  // only a `whatsapp` row, so `user_identities` alone cannot prove V is
  // WhatsApp-only. A real e-mail or any Better Auth account row means V may
  // belong to a different person (recycled number): support decides (design M3
  // step 1).
  if (!absorbed.email.toLowerCase().endsWith(".invalid"))
    return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", "absorbed_has_real_email");
  const [absorbedAccount] = await tx
    .select({ id: account.id })
    .from(account)
    .where(eq(account.userId, absorbedUserId))
    .limit(1);
  if (absorbedAccount)
    return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", "absorbed_has_account");

  const [owned] = await tx
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.id, input.whatsappIdentityId),
        eq(userIdentities.userId, absorbedUserId),
        eq(userIdentities.type, "whatsapp"),
      ),
    );
  if (!owned) return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", "identity_moved");

  // `role_assignments` forces row level security per tenant, so a plain
  // SELECT would see no tenant. The SECURITY DEFINER function of migration
  // 0204 answers across tenants without exposing rows.
  const roleCheck = await tx.execute(
    sql`SELECT app.user_has_role_assignment(${absorbedUserId}) AS has_role`,
  );
  if (roleCheck.rows[0]?.has_role !== false)
    return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", "absorbed_has_role");

  const [adminRow] = await tx
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(eq(platformAdmins.userId, absorbedUserId))
    .limit(1);
  if (adminRow)
    return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", "absorbed_is_platform_admin");

  // U must not already hold a different WhatsApp number.
  const [survivorWhatsApp] = await tx
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userId, survivorUserId),
        eq(userIdentities.type, "whatsapp"),
      ),
    )
    .limit(1);
  if (survivorWhatsApp)
    return refuse("WHATSAPP_ALREADY_ON_ACCOUNT", "survivor_has_whatsapp");

  // All checks passed: fold V into U.
  const moved = await tx
    .update(userIdentities)
    .set({ userId: survivorUserId, isPrimary: false })
    .where(eq(userIdentities.userId, absorbedUserId))
    .returning({ id: userIdentities.id });

  const profileMoves = await moveMemberProfiles(tx, {
    survivorUserId,
    absorbedUserId,
    now: input.now,
  });

  await tx.delete(session).where(eq(session.userId, absorbedUserId));
  await tx
    .update(user)
    .set({ banned: true, banReason: "merged", banExpires: null })
    .where(eq(user.id, absorbedUserId));

  const [merge] = await tx
    .insert(identityMerges)
    .values({
      survivorUserId,
      absorbedUserId,
      trigger: input.trigger,
      identityIds: moved.map((row) => row.id),
      profileMoves,
      createdAt: input.now,
      createdBy: input.actorUserId,
    })
    .returning({ id: identityMerges.id });
  if (!merge) throw new Error("Identity merge could not be recorded");

  return {
    kind: "merged",
    mergeId: merge.id,
    survivorUserId,
    absorbedUserId,
    maskedSurvivorEmail: maskedSurvivorEmail(survivor.email),
  };
}

/**
 * The reply that names the account the number joined (design M3 rule 3: the
 * person sees the masked e-mail twice, in the PWA and here). Not sent today:
 * AUTH-03 forbids a reply and no outbound login path exists. Wire it when one
 * does. Pure so it can be tested and reused.
 */
export function mergedReplyText(maskedEmail: string | null): string {
  return maskedEmail
    ? `Nomor ini sudah tergabung ke akun ${maskedEmail}. Jika ini bukan Anda, hubungi dukungan.`
    : "Nomor ini sudah tergabung ke akun yang sedang masuk. Jika ini bukan Anda, hubungi dukungan.";
}
