// First-admin invitation (legend-fy5y; design: tenant.created -> notification
// `tenant_invitation` -> email).
//
// Two steps, neither issues a session:
//
// 1. `issueInvitationLink`: called by the email delivery step at SEND time. It
//    stores a `login_challenges` row (channel `email_magic_link`, `link_user_id`
//    = the invited admin) and returns the one-time link. Only the keyed digest
//    of the token is stored; the link is never written to `notifications.body`.
//    `link_user_id` already means "the account this challenge attaches the
//    proven identifier to" (WhatsApp link flow), so no new column is needed.
// 2. `acceptInvitationLink`: the `/undangan` page posts the token and tenant
//    id from the URL fragment. It only marks the email verified. A new tenant
//    has no verified domain yet, so this is a platform-level call with no
//    tenant context from the request; the sign-in verify path
//    (`verifyEmailMagicLink`) refuses every row with `link_user_id` set.
//
// The accept is stricter than sign-in: it has NO role-assignment exception to
// the pre-registration takeover guard, because the invited admin always holds
// a role assignment and that would defeat the guard.

import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import {
  IdentityError,
  INVITATION_LINK_TTL_MINUTES,
  INVITATION_LINKS_PER_DAY,
  MINUTE_MS,
  normalizeEmail,
  type InvitationAcceptBody,
} from "@starter/shared/identity";
import { type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db";
import {
  account as accountTable,
  loginChallenges,
  roleAssignments,
  roles,
  tenants,
  user,
  userIdentities,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { emailDigest, magicLinkTokenDigest } from "../lib/identity-digest";
import { bindingDigestOf } from "../lib/login-binding";
import { openSecret, sealSecret } from "../lib/secrets";
import {
  auditEmailLogin,
  challengeEmailAad,
  isReservedAddress,
  markEmailVerifiedWithIdentity,
  type Transaction,
} from "./identity-email-login.service.ts";

const INVITATION_LINK_TTL = INVITATION_LINK_TTL_MINUTES * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const INVITATION_ROLE_TEMPLATE = "tenant_admin";

/** The user holds an open tenant-wide tenant_admin assignment in this tenant. */
async function hasOpenTenantAdminAssignment(
  tx: Transaction,
  tenantId: string,
  userId: string,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .innerJoin(
      roles,
      and(
        eq(roles.tenantId, roleAssignments.tenantId),
        eq(roles.id, roleAssignments.roleId),
      ),
    )
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        eq(roleAssignments.userId, userId),
        eq(roles.templateKey, INVITATION_ROLE_TEMPLATE),
        eq(roleAssignments.scopeType, "tenant"),
        isNull(roleAssignments.validUntil),
        sql`${roleAssignments.validFrom} <= ${now}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Mints the invitation link for `userId` in one transaction, or returns null
 * (fail closed) when the user is not an eligible invitee or the durable
 * 24-hour cap is reached. Each call cancels the user's earlier pending
 * invitation links, so only the newest one works.
 */
export async function issueInvitationLink(
  context: ScopedTenantContext,
  input: { userId: string; origin: string; now?: Date },
): Promise<string | null> {
  const now = input.now ?? new Date();
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    // Lock the user row: concurrent mints for one user run one after another,
    // so the count below cannot be raced past the cap.
    const [owner] = await tx
      .select({ email: user.email, banned: user.banned })
      .from(user)
      .where(eq(user.id, input.userId))
      .for("update")
      .limit(1);
    if (!owner || owner.banned === true) return null;
    const email = normalizeEmail(owner.email);
    if (email === null || isReservedAddress(email)) return null;
    if (!(await hasOpenTenantAdminAssignment(tx, tenantId, input.userId, now)))
      return null;

    const since = new Date(now.getTime() - DAY_MS);
    const recent = await tx
      .select({ id: loginChallenges.id })
      .from(loginChallenges)
      .where(
        and(
          eq(loginChallenges.channel, "email_magic_link"),
          eq(loginChallenges.linkUserId, input.userId),
          gt(loginChallenges.createdAt, since),
        ),
      );
    if (recent.length >= INVITATION_LINKS_PER_DAY) {
      await auditEmailLogin(tx, context, {
        action: "login_challenge.rate_limited",
        challengeId: null,
        details: { cause: "invitation_throttled" },
        now,
        ip: null,
      });
      return null;
    }

    // No cancel-on-mint: a retried send whose first response was lost must not
    // kill the delivered link. Open links are bounded by the per-day cap and
    // the TTL; accepting one cancels the rest (see acceptInvitationLink).

    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + INVITATION_LINK_TTL);
    await tx.insert(loginChallenges).values({
      id,
      tenantId,
      brandId: null,
      channel: "email_magic_link",
      codeHash: magicLinkTokenDigest(token),
      // No browser asked for this link: the binding is a random nonce nobody
      // holds, and the accept never reads it.
      browserBindingHash: bindingDigestOf(
        randomBytes(32).toString("base64url"),
      ),
      emailEncrypted: sealSecret(email, challengeEmailAad(id)),
      linkUserId: input.userId,
      status: "pending",
      expiresAt,
      createdAt: now,
    });
    await auditEmailLogin(tx, context, {
      action: "login_challenge.created",
      challengeId: id,
      details: {
        status: "pending",
        expiresAt: expiresAt.toISOString(),
        cause: "tenant_invitation",
      },
      now,
      ip: null,
    });
    return `${input.origin}/undangan#token=${token}&tenant=${tenantId}`;
  });
}

/**
 * Accepts an invitation link: marks the invited admin's email verified. No
 * session is issued. Every refusal is `CHALLENGE_NOT_PENDING`; only an expired
 * token says so (`CHALLENGE_EXPIRED`) and leaves the email unverified.
 *
 * The tenant id comes from the URL fragment, which is client input. It is safe
 * because the row must match BOTH the tenant and the token digest: a wrong id
 * finds nothing, and the id is never used for anything but that lookup.
 */
export async function acceptInvitationLink(
  input: InvitationAcceptBody,
  deps: { now?: Date } = {},
): Promise<void> {
  const now = deps.now ?? new Date();
  const tenantId = input.tenantId;
  const context = establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "link_token" }),
    { kind: "tenant" },
  );
  const codeHash = magicLinkTokenDigest(input.token);

  const outcome = await withTenant(
    db,
    context,
    async (tx): Promise<"completed" | "expired" | "refused"> => {
      const [row] = await tx
        .select()
        .from(loginChallenges)
        .where(
          and(
            eq(loginChallenges.channel, "email_magic_link"),
            eq(loginChallenges.codeHash, codeHash),
            eq(loginChallenges.tenantId, tenantId),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !row ||
        row.tenantId !== tenantId ||
        row.status !== "pending" ||
        row.linkUserId === null ||
        row.emailEncrypted === null
      )
        return "refused";
      const linkUserId = row.linkUserId;
      // An inactive tenant is a refusal like any other (no distinct answer).
      const [tenantRow] = await tx
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (tenantRow?.status !== "active") return "refused";

      if (now.getTime() >= row.expiresAt.getTime()) {
        await tx
          .update(loginChallenges)
          .set({ status: "expired" })
          .where(eq(loginChallenges.id, row.id));
        await auditEmailLogin(tx, context, {
          action: "login_challenge.expired",
          challengeId: row.id,
          details: { status: "expired", cause: "ttl_elapsed" },
          now,
          ip: null,
        });
        return "expired";
      }

      // Takeover guards: cancel and refuse, nothing is marked verified.
      const cancel = async (cause: string): Promise<"refused"> => {
        await tx
          .update(loginChallenges)
          .set({ status: "cancelled" })
          .where(eq(loginChallenges.id, row.id));
        await auditEmailLogin(tx, context, {
          action: "login_challenge.rejected",
          challengeId: row.id,
          details: { status: "cancelled", cause },
          now,
          ip: null,
        });
        return "refused";
      };

      const [owner] = await tx
        .select({
          email: user.email,
          banned: user.banned,
          emailVerified: user.emailVerified,
        })
        .from(user)
        .where(eq(user.id, linkUserId))
        .limit(1);
      // (a) missing or banned account.
      if (!owner || owner.banned === true) return cancel("account_refused");
      // (b) the address changed since the link was minted.
      const sealed = normalizeEmail(
        openSecret(row.emailEncrypted, challengeEmailAad(row.id)),
      );
      const current = normalizeEmail(owner.email);
      if (
        sealed === null ||
        current === null ||
        sealed !== current ||
        isReservedAddress(sealed)
      )
        return cancel("email_changed");
      // (c) pre-registration takeover guard, with no role-assignment
      // exception: an unverified account with a password may belong to a
      // squatter who knows it.
      if (!owner.emailVerified) {
        const [credential] = await tx
          .select({ id: accountTable.id })
          .from(accountTable)
          .where(
            and(
              eq(accountTable.userId, linkUserId),
              eq(accountTable.providerId, "credential"),
            ),
          )
          .limit(1);
        if (credential) return cancel("already_linked");
      }
      // (d) an email identity for this address owned by another user.
      const digest = await emailDigest(sealed);
      const [identity] = await tx
        .select({ userId: userIdentities.userId })
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.type, "email"),
            eq(userIdentities.valueHash, digest),
          ),
        )
        .limit(1);
      if (identity && identity.userId !== linkUserId)
        return cancel("identity_conflict");

      const marked = await markEmailVerifiedWithIdentity(tx, {
        userId: linkUserId,
        email: sealed,
        digest,
        isPrimary: false,
        now,
      });
      if (marked === "identity_conflict") return cancel("identity_conflict");
      await tx
        .update(loginChallenges)
        .set({
          status: "completed",
          matchedUserId: linkUserId,
          completedAt: now,
        })
        .where(eq(loginChallenges.id, row.id));
      // The invitation is used: any other pending link of this user dies too.
      await tx
        .update(loginChallenges)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(loginChallenges.channel, "email_magic_link"),
            eq(loginChallenges.linkUserId, linkUserId),
            eq(loginChallenges.status, "pending"),
            ne(loginChallenges.id, row.id),
          ),
        );
      await auditEmailLogin(tx, context, {
        action: "login_challenge.completed",
        challengeId: row.id,
        actorUserId: linkUserId,
        details: { status: "completed", matchedUserId: linkUserId },
        now,
        ip: null,
      });
      return "completed";
    },
  );

  if (outcome === "expired") throw new IdentityError("CHALLENGE_EXPIRED");
  if (outcome === "refused") throw new IdentityError("CHALLENGE_NOT_PENDING");
}
