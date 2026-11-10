// Identity merge (legend-k2l; docs/design/ws08-member-loyalty.md M3; brief
// docs/briefs/290b-k2l-member-signin-identity.md; AUTH-07).
//
// A signed-in user U proves a WhatsApp number by reverse OTP (the link path of
// `identity-wa-inbound.service.ts`) that already belongs to another account V.
// When V is only a WhatsApp account the two are one person and fold into ONE
// account in ONE transaction. The OLDER account survives (`planIdentityMerge`
// of the identity contract: createdAt, tie: smaller id), the other is
// absorbed. The caller picks the direction and passes it as
// `survivorUserId` / `absorbedUserId`; V is the owner of the proven number
// (`whatsappIdentityId`), U is the other one.
//
//   1. advisory locks on both user ids, in sorted order (no deadlock between
//      two merges, and no race with a concurrent link or sign-in);
//   2. refusal checks (below), each returned as a `refused` outcome, never
//      thrown, so the caller can keep its own cancel-and-audit path. The member
//      profile decision is part of them and is made BEFORE any write;
//   3. the absorbed account's identities move to the survivor. When the
//      absorbed account is U, its Better Auth `account` rows (Google) follow
//      and the survivor takes over U's e-mail, verified flag and name (U gets
//      a unique `merged+<id>@merged.invalid` e-mail first: e-mail is unique);
//   4. the absorbed account's member profiles move per tenant
//      (`moveMemberProfiles`);
//   5. the absorbed account's sessions are deleted and it is banned
//      (`banReason = 'merged'`), so a stale cookie can never act again;
//   6. one append-only `identity_merges` row records who absorbed whom, which
//      identity rows moved and what happened to each profile.
//
// Refusals (design M3 rule 1 and 2):
// - `IDENTITY_MERGE_NEEDS_SUPPORT`: V holds any identity other than the number
//   just proven, a real (not `.invalid`) e-mail, any Better Auth `account` row,
//   any role assignment in any tenant, a `platform_admins` row, or is already
//   banned or merged (both directions). A WhatsApp-only account belongs to
//   whoever controls the number (D16); an account with an email or Google
//   identity may belong to a different person (recycled numbers), so support
//   decides. When U is the absorbed one it must also have no role assignment,
//   no `platform_admins` row and no password (`credential`) account. A member
//   profile conflict (`profile_conflict`, see `moveMemberProfiles`) refuses
//   too.
// - `WHATSAPP_ALREADY_ON_ACCOUNT`: U already holds a different WhatsApp number
//   (`user_identities_one_whatsapp_per_user`).
//
// The audit rows of a merge or a refusal are tenant-scoped (`audit_logs` has
// FORCE RLS), so the caller, which owns the tenant context, writes them from
// the returned outcome. This service only writes global tables, plus the member
// profile rows of the tenants involved (each under that tenant's
// `app.tenant_id`). The global `identity_merges` row is itself the permanent
// trail of a success.
//
// AUTH-03: nothing is sent back to the WhatsApp number. `mergedReplyText` is
// the agreed wording for the day an outbound reply path exists.

import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { maskEmail } from "@starter/shared/identity";
import type { db } from "../db";
import {
  account,
  consents,
  loginChallenges,
  platformAdmins,
  session,
  user,
  userIdentities,
} from "../db/schema";
import { customerProfiles } from "../db/schema/crm-member.ts";
import { identityMerges } from "../db/schema/identity-merge.ts";
import { memberTenantContext, withProfileLock } from "../db/member-scope.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordMemberConsentInTx } from "./consent.service.ts";

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
  /**
   * `profileId` is the profile this action touches: the one repointed
   * (`moved_to_survivor`) or the one closed (`closed_into_survivor` closes the
   * absorbed account's, `survivor_closed_into_absorbed` the survivor's).
   */
  action:
    | "moved_to_survivor"
    | "closed_into_survivor"
    | "survivor_closed_into_absorbed";
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
 * Runs `run` with `app.tenant_id` (and the all-outlets scope of a tenant-wide
 * context) set to `tenantId`, then restores the caller's values. Member
 * profile tables force row level security per tenant, and one merge touches
 * several tenants inside the caller's single transaction: a separate
 * transaction per tenant could not roll back together with the identity rows.
 * No restore after an error: the transaction is aborted and rolls back anyway.
 */
async function inTenant<T>(
  tx: Transaction,
  tenantId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = await tx.execute(
    sql`SELECT current_setting('app.tenant_id', true) AS tenant_id, current_setting('app.outlet_ids', true) AS outlet_ids`,
  );
  const tenantBefore = String(previous.rows[0]?.tenant_id ?? "");
  const outletsBefore = String(previous.rows[0]?.outlet_ids ?? "");
  await tx.execute(
    sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.outlet_ids', '*', true)`,
  );
  const result = await run();
  await tx.execute(
    sql`SELECT set_config('app.tenant_id', ${tenantBefore}, true), set_config('app.outlet_ids', ${outletsBefore}, true)`,
  );
  return result;
}

type ProfileRef = { tenantId: string; profileId: string; status: string };

/** The user's member profiles of every tenant (design M3: SECURITY DEFINER lookup). */
async function profilesOfUser(
  tx: Transaction,
  userId: string,
): Promise<ProfileRef[]> {
  const result = await tx.execute(
    sql`SELECT tenant_id, profile_id, status FROM app.member_profiles_of_user(${userId})`,
  );
  return result.rows.map((row) => ({
    tenantId: String(row.tenant_id),
    profileId: String(row.profile_id),
    status: String(row.status),
  }));
}

/**
 * Tables the design names that carry member rows but have no schema yet, so
 * their profile column is not known. If one exists the profile cannot be
 * proven empty and the merge is refused (fail closed); whoever adds the table
 * must teach `profileIsEmpty` its column.
 */
const UNMAPPED_PROFILE_TABLES = ["feedback", "referrals"] as const;

/**
 * True when no table holds a row for the profile: nothing in any table that
 * points at a profile through `customer_profile_id` (point_ledger,
 * reward_redemptions, vouchers, orders, customer_visits, mission_progress, and
 * any later one), and none of the `UNMAPPED_PROFILE_TABLES` exists (fail
 * closed). Runs under the profile's tenant (`inTenant`).
 */
async function profileHasNoRows(
  tx: Transaction,
  profileId: string,
): Promise<boolean> {
  for (const table of UNMAPPED_PROFILE_TABLES) {
    const exists = await tx.execute(
      sql`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`,
    );
    if (exists.rows[0]?.present !== false) return false;
  }
  const referencing = await tx.execute(
    sql`SELECT c.relname AS name
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND a.attname = 'customer_profile_id'
           AND c.relkind IN ('r', 'p') AND NOT a.attisdropped`,
  );
  for (const row of referencing.rows) {
    const name = String(row.name);
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) return false;
    const found = await tx.execute(
      sql`SELECT EXISTS (SELECT 1 FROM public.${sql.identifier(name)} WHERE customer_profile_id = ${profileId}) AS present`,
    );
    if (found.rows[0]?.present !== false) return false;
  }
  return true;
}

/**
 * True when the absorbed profile can be closed without losing anything: no
 * WhatsApp hash, still `pending_verification`, and no row anywhere
 * (`profileHasNoRows`). Runs under the profile's tenant (`inTenant`).
 */
async function profileIsEmpty(
  tx: Transaction,
  profileId: string,
): Promise<boolean> {
  const [profile] = await tx
    .select({
      status: customerProfiles.membershipStatus,
      whatsappHash: customerProfiles.whatsappHash,
    })
    .from(customerProfiles)
    .where(eq(customerProfiles.id, profileId));
  if (
    !profile ||
    profile.status !== "pending_verification" ||
    profile.whatsappHash !== null
  )
    return false;
  return profileHasNoRows(tx, profileId);
}

/**
 * True when the survivor's profile can be closed without losing anything: no
 * row anywhere (`profileHasNoRows`) and no consent decision. Unlike the
 * absorbed profile, its WhatsApp hash and status do not matter: the survivor
 * holds the number (or its owner just proved it), so an active profile with a
 * hash is the usual case. Runs under the profile's tenant (`inTenant`).
 */
async function survivorProfileIsEmpty(
  tx: Transaction,
  tenantId: string,
  profileId: string,
): Promise<boolean> {
  // A suspension is a moderation decision: closing the profile would drop it.
  const [profile] = await tx
    .select({ status: customerProfiles.membershipStatus })
    .from(customerProfiles)
    .where(eq(customerProfiles.id, profileId));
  if (!profile || profile.status === "suspended" || profile.status === "closed")
    return false;
  const [consent] = await tx
    .select({ seq: consents.seq })
    .from(consents)
    .where(
      and(eq(consents.tenantId, tenantId), eq(consents.subjectId, profileId)),
    )
    .limit(1);
  if (consent) return false;
  return profileHasNoRows(tx, profileId);
}

/**
 * Re-records the absorbed profile's latest consent decision of each purpose on
 * the survivor's profile (source `member_pwa`, same policy version). A grant
 * whose policy version is no longer the active one is skipped (the survivor
 * must consent again: nothing is granted by assumption), a withdrawal the
 * survivor has nothing to withdraw is skipped, and a decision the survivor
 * already superseded with a newer one is left alone.
 */
async function carryConsents(
  tx: Transaction,
  input: {
    tenantId: string;
    absorbedProfileId: string;
    survivorProfileId: string;
    survivorUserId: string;
    now: Date;
  },
): Promise<void> {
  const latest = await tx
    .selectDistinctOn([consents.purpose])
    .from(consents)
    .where(
      and(
        eq(consents.tenantId, input.tenantId),
        eq(consents.subjectId, input.absorbedProfileId),
      ),
    )
    .orderBy(consents.purpose, desc(consents.seq));
  const scope = {
    context: memberTenantContext(input.tenantId),
    tenantId: input.tenantId,
    userId: input.survivorUserId,
    customerProfileId: input.survivorProfileId,
    status: null,
  };
  for (const decision of latest) {
    const [current] = await tx
      .select({ recordedAt: consents.recordedAt })
      .from(consents)
      .where(
        and(
          eq(consents.tenantId, input.tenantId),
          eq(consents.subjectId, input.survivorProfileId),
          eq(consents.purpose, decision.purpose),
        ),
      )
      .orderBy(desc(consents.seq))
      .limit(1);
    if (current && current.recordedAt >= decision.recordedAt) continue;
    try {
      await recordMemberConsentInTx(
        tx,
        scope,
        {
          purpose: decision.purpose as "loyalty" | "marketing" | "ai",
          granted: decision.decision === "granted",
          policyVersion: decision.policyVersion,
        },
        input.now,
      );
    } catch (error) {
      if (
        error instanceof HttpError &&
        (error.code === "CONSENT_POLICY_OUTDATED" ||
          error.code === "NOTHING_TO_WITHDRAW")
      )
        continue;
      throw error;
    }
  }
}

/**
 * Step 4 of design M3: move the absorbed account's member profiles to the
 * survivor, tenant by tenant, each under that tenant's `app.tenant_id`. The
 * decision of EVERY tenant is made first and nothing is written when any of
 * them conflicts, so a refusal leaves no partial move behind. Per tenant,
 * A = absorbed account, S = survivor:
 * - only A has a profile: `customer_profiles.user_id` is repointed to S;
 * - only S has one: nothing to do;
 * - both have one and A's is empty (`profileIsEmpty`): A's profile is closed
 *   (`membership_status = 'closed'`, `user_id = NULL`, `merged_into_profile_id`
 *   = S's profile) and A's latest consent decisions are re-recorded on S's
 *   profile (`carryConsents`);
 * - both have one, A's has content and S's is truly empty
 *   (`survivorProfileIsEmpty`: no row anywhere, no consent; hash and status do
 *   not count): S's profile is closed (`membership_status = 'closed'`,
 *   `user_id = NULL`, `merged_into_profile_id` = A's profile) and A's profile
 *   is repointed to S, so the history follows the account that stays. Action
 *   `survivor_closed_into_absorbed`;
 * - anything else (both have content, or S's profile is closed): `refused`
 *   (`profile_conflict`), the caller refuses the whole merge with
 *   `IDENTITY_MERGE_NEEDS_SUPPORT`.
 * The point ledger is append-only and keys on `customer_profile_id`, which
 * survives every case: no ledger row is ever written, updated or deleted here.
 */
export async function moveMemberProfiles(
  tx: Transaction,
  input: { survivorUserId: string; absorbedUserId: string; now: Date },
): Promise<
  { kind: "moved"; moves: ProfileMove[] } | { kind: "refused"; reason: string }
> {
  const absorbedProfiles = await profilesOfUser(tx, input.absorbedUserId);
  if (absorbedProfiles.length === 0) return { kind: "moved", moves: [] };
  const survivorProfiles = new Map(
    (await profilesOfUser(tx, input.survivorUserId)).map((p) => [
      p.tenantId,
      p,
    ]),
  );

  const plan: (ProfileMove & {
    survivorProfileId: string | null;
    absorbedProfileId?: string;
  })[] = [];
  for (const absorbed of absorbedProfiles) {
    const survivorProfile = survivorProfiles.get(absorbed.tenantId) ?? null;
    // A closed survivor profile cannot take consent or history (review F2).
    if (survivorProfile !== null && survivorProfile.status === "closed")
      return { kind: "refused", reason: "profile_conflict" };
    const survivorProfileId = survivorProfile?.profileId ?? null;
    if (survivorProfileId === null) {
      plan.push({
        tenantId: absorbed.tenantId,
        profileId: absorbed.profileId,
        action: "moved_to_survivor",
        survivorProfileId,
      });
      continue;
    }
    const empty = await inTenant(tx, absorbed.tenantId, () =>
      profileIsEmpty(tx, absorbed.profileId),
    );
    if (empty) {
      plan.push({
        tenantId: absorbed.tenantId,
        profileId: absorbed.profileId,
        action: "closed_into_survivor",
        survivorProfileId,
      });
      continue;
    }
    const survivorEmpty = await inTenant(tx, absorbed.tenantId, () =>
      survivorProfileIsEmpty(tx, absorbed.tenantId, survivorProfileId),
    );
    if (!survivorEmpty) return { kind: "refused", reason: "profile_conflict" };
    plan.push({
      tenantId: absorbed.tenantId,
      profileId: survivorProfileId,
      action: "survivor_closed_into_absorbed",
      survivorProfileId,
      absorbedProfileId: absorbed.profileId,
    });
  }

  for (const step of plan) {
    await inTenant(tx, step.tenantId, async () => {
      if (step.survivorProfileId === null) {
        await withProfileLock(tx, step.tenantId, step.profileId);
        await tx
          .update(customerProfiles)
          .set({ userId: input.survivorUserId, updatedAt: input.now })
          .where(eq(customerProfiles.id, step.profileId));
        return;
      }
      if (
        step.action === "survivor_closed_into_absorbed" &&
        step.absorbedProfileId
      ) {
        await withProfileLock(tx, step.tenantId, step.survivorProfileId);
        await withProfileLock(tx, step.tenantId, step.absorbedProfileId);
        // Close first, then repoint: the one-profile-per-user index never sees
        // two live profiles of the survivor. The closed row leaves the
        // WhatsApp-number unique index too, before onWhatsAppVerified runs.
        await tx
          .update(customerProfiles)
          .set({
            membershipStatus: "closed",
            userId: null,
            mergedIntoProfileId: step.absorbedProfileId,
            updatedAt: input.now,
          })
          .where(eq(customerProfiles.id, step.survivorProfileId));
        await tx
          .update(customerProfiles)
          .set({ userId: input.survivorUserId, updatedAt: input.now })
          .where(eq(customerProfiles.id, step.absorbedProfileId));
        return;
      }
      await withProfileLock(tx, step.tenantId, step.survivorProfileId);
      await withProfileLock(tx, step.tenantId, step.profileId);
      await tx
        .update(customerProfiles)
        .set({
          membershipStatus: "closed",
          userId: null,
          mergedIntoProfileId: step.survivorProfileId,
          updatedAt: input.now,
        })
        .where(eq(customerProfiles.id, step.profileId));
      await carryConsents(tx, {
        tenantId: step.tenantId,
        absorbedProfileId: step.profileId,
        survivorProfileId: step.survivorProfileId,
        survivorUserId: input.survivorUserId,
        now: input.now,
      });
    });
  }
  return {
    kind: "moved",
    moves: plan.map(({ tenantId, profileId, action }) => ({
      tenantId,
      profileId,
      action,
    })),
  };
}

/** Role assignment or platform admin: a cross-tenant fact support must judge. */
async function privilegeReason(
  tx: Transaction,
  userId: string,
): Promise<"has_role" | "is_platform_admin" | null> {
  // `role_assignments` forces row level security per tenant, so a plain
  // SELECT would see no tenant. The SECURITY DEFINER function of migration
  // 0204 answers across tenants without exposing rows.
  const roleCheck = await tx.execute(
    sql`SELECT app.user_has_role_assignment(${userId}) AS has_role`,
  );
  if (roleCheck.rows[0]?.has_role !== false) return "has_role";
  const [adminRow] = await tx
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(eq(platformAdmins.userId, userId))
    .limit(1);
  return adminRow ? "is_platform_admin" : null;
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
    .select({
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
      banned: user.banned,
    })
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

  // The proven number belongs to V, which is one of the two accounts; the
  // other one is U, the signed-in account that proved it.
  const [proven] = await tx
    .select({
      id: userIdentities.id,
      userId: userIdentities.userId,
      isPrimary: userIdentities.isPrimary,
    })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.id, input.whatsappIdentityId),
        eq(userIdentities.type, "whatsapp"),
      ),
    );
  if (
    !proven ||
    (proven.userId !== absorbedUserId && proven.userId !== survivorUserId)
  )
    return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", "identity_moved");
  const holderId = proven.userId;
  const absorbedIsHolder = holderId === absorbedUserId;
  const holder = absorbedIsHolder ? absorbed : survivor;
  const holderRole = absorbedIsHolder ? "absorbed" : "survivor";

  // V must be WhatsApp-only (both directions): no identity other than the
  // number just proven.
  const [otherIdentity] = await tx
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userId, holderId),
        ne(userIdentities.id, input.whatsappIdentityId),
      ),
    )
    .limit(1);
  if (otherIdentity)
    return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", `${holderRole}_has_identity`);

  // Pre-k2l password accounts and Google users whose identity write failed hold
  // only a `whatsapp` row, so `user_identities` alone cannot prove V is
  // WhatsApp-only. A real e-mail or any Better Auth account row means V may
  // belong to a different person (recycled number): support decides (design M3
  // step 1).
  if (!holder.email.toLowerCase().endsWith(".invalid"))
    return refuse(
      "IDENTITY_MERGE_NEEDS_SUPPORT",
      `${holderRole}_has_real_email`,
    );
  const [holderAccount] = await tx
    .select({ id: account.id })
    .from(account)
    .where(eq(account.userId, holderId))
    .limit(1);
  if (holderAccount)
    return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", `${holderRole}_has_account`);
  const holderPrivilege = await privilegeReason(tx, holderId);
  if (holderPrivilege)
    return refuse(
      "IDENTITY_MERGE_NEEDS_SUPPORT",
      `${holderRole}_${holderPrivilege}`,
    );

  const signedInId = absorbedIsHolder ? survivorUserId : absorbedUserId;
  // A WhatsApp-only holder never has a second number, so for the signed-in
  // account U this is the one-number-per-account rule.
  const [signedInWhatsApp] = await tx
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userId, signedInId),
        eq(userIdentities.type, "whatsapp"),
      ),
    )
    .limit(1);
  if (signedInWhatsApp)
    return refuse(
      "WHATSAPP_ALREADY_ON_ACCOUNT",
      absorbedIsHolder ? "survivor_has_whatsapp" : "absorbed_has_whatsapp",
    );

  if (!absorbedIsHolder) {
    // U is absorbed: it may have a real e-mail and Google, but no role, no
    // platform admin row and no password (a password is a credential only the
    // person holds; folding it into a WhatsApp account is support's call).
    const privilege = await privilegeReason(tx, absorbedUserId);
    if (privilege)
      return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", `absorbed_${privilege}`);
    const [credential] = await tx
      .select({ id: account.id })
      .from(account)
      .where(
        and(
          eq(account.userId, absorbedUserId),
          eq(account.providerId, "credential"),
        ),
      )
      .limit(1);
    if (credential)
      return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", "absorbed_has_credential");
  }

  // The profile decision comes before the first identity, session or ban
  // write: a refusal here leaves nothing behind (the caller cancels the
  // challenge in the same transaction and cannot roll back).
  const profiles = await moveMemberProfiles(tx, {
    survivorUserId,
    absorbedUserId,
    now: input.now,
  });
  if (profiles.kind === "refused")
    return refuse("IDENTITY_MERGE_NEEDS_SUPPORT", profiles.reason);

  // All checks passed: fold the absorbed account into the survivor.
  const moved = await tx
    .update(userIdentities)
    .set({
      userId: survivorUserId,
      // V's number is the survivor's primary identity when V survives; otherwise
      // keep U's flags only when the survivor has no primary one.
      isPrimary: absorbedIsHolder
        ? false
        : sql`${userIdentities.isPrimary} AND ${!proven.isPrimary}`,
    })
    .where(eq(userIdentities.userId, absorbedUserId))
    .returning({ id: userIdentities.id });

  let survivorEmail = survivor.email;
  if (!absorbedIsHolder) {
    await tx
      .update(account)
      .set({ userId: survivorUserId })
      .where(eq(account.userId, absorbedUserId));
    // E-mail is unique: free it on U before V takes it over.
    await tx
      .update(user)
      .set({ email: `merged+${absorbedUserId}@merged.invalid` })
      .where(eq(user.id, absorbedUserId));
    await tx
      .update(user)
      .set({
        email: absorbed.email,
        emailVerified: absorbed.emailVerified,
        name: absorbed.name,
      })
      .where(eq(user.id, survivorUserId));
    survivorEmail = absorbed.email;
  }

  await tx.delete(session).where(eq(session.userId, absorbedUserId));
  if (!absorbedIsHolder) {
    // Review F1: V survives with U's email, Google login, profiles and points.
    // A session V held before (an earlier owner of a recycled number) must not
    // read that data: only the session the poll hands out after the merge is
    // valid. Completed but unclaimed WhatsApp challenges of V are cancelled for
    // the same reason. `login_challenges` is global (no row level security), so
    // the update reaches every tenant's rows.
    await tx.delete(session).where(eq(session.userId, survivorUserId));
    await tx
      .update(loginChallenges)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(loginChallenges.matchedUserId, survivorUserId),
          eq(loginChallenges.status, "completed"),
          isNull(loginChallenges.sessionIssuedAt),
        ),
      );
  }
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
      profileMoves: profiles.moves,
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
    maskedSurvivorEmail: maskedSurvivorEmail(survivorEmail),
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
