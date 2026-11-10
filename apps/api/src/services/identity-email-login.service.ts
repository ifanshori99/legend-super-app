// Email magic-link sign-in (legend-k2l; PRD v1.7 §3 F6 "Email magic link",
// AUTH-01; docs/briefs/290b-k2l-member-signin-identity.md).
//
// Two steps, both public (a guest has no session yet):
//
// 1. `requestEmailMagicLink`: stores a `login_challenges` row of channel
//    `email_magic_link` and mails the link. The 43-char token is 32 random
//    bytes; only its keyed digest (`magicLinkTokenDigest`) is stored, in
//    `code_hash`. The address is sealed in `email_encrypted` (AAD =
//    `login_challenge:email:<id>`) because the token cannot carry it and
//    `matched_user_id` must stay null until the link is verified. The answer
//    is identical for known and unknown addresses (no enumeration): nothing in
//    this step looks the address up.
// 2. `verifyEmailMagicLink`: the page opened by the link posts the token (it
//    travels in the URL fragment, so it never reaches a server log). The
//    account is resolved or created first, one transaction then locks the
//    challenge row and consumes it, and the session is issued only after that
//    commit, so a token works once (see the function comment).
//
// Browser binding for this channel is deliberately not a gate (machines.ts
// `assertChallengeCompletable`): the mail app may open the link in another
// browser. It is a signal instead: `crossDevice` is stored on the session
// (design ws08 M2) so such a session cannot start a WhatsApp link without a
// fresh proof, and the staff gate never accepts it (authMethod is not
// `password`).
//
// Account resolution order: the `email` row of `user_identities` (keyed
// digest), then a Better Auth user with that lowercased address, then a new
// account (`emailVerified`, name = local part). An address ending `.invalid` is
// never mailed and never resolved: that domain is the reserved WhatsApp
// placeholder (`<digest>@wa.invalid`), not a mailbox.

import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  IdentityError,
  MAGIC_LINK_TTL_MINUTES,
  MINUTE_MS,
  normalizeEmail,
  type MagicLinkRequested,
  type MagicLinkVerified,
} from "@starter/shared/identity";
import {
  CoreError,
  userIdSchema,
  type TenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { siteConfig } from "@starter/shared/site";
import { db } from "../db";
import {
  account as accountTable,
  loginChallenges,
  tenants,
  user,
  userIdentities,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { auth } from "../lib/auth";
import { getEmailSender } from "../lib/email-sender";
import { HttpError } from "../lib/http-error";
import {
  emailDigest,
  clientIpDigest,
  magicLinkTokenDigest,
} from "../lib/identity-digest";
import {
  createCustomerSession,
  type IssuedSession,
} from "../lib/identity-session";
import { logger } from "../lib/logger";
import { bindingDigestOf } from "../lib/login-binding";
import { openSecret, sealSecret } from "../lib/secrets";

const emailLoginLog = logger.child({ module: "identity-email-login" });

/** Contract: a magic link lives 15 minutes (`MAGIC_LINK_TTL_MINUTES`). */
const MAGIC_LINK_TTL = MAGIC_LINK_TTL_MINUTES * MINUTE_MS;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type EmailLoginDeps = {
  /** Test clock; production uses the wall clock. */
  readonly now?: Date;
};

/** The reserved placeholder domain is never a mailbox (RFC 2606). */
function isReservedAddress(email: string): boolean {
  return email.endsWith(".invalid");
}

function challengeEmailAad(challengeId: string): string {
  return `login_challenge:email:${challengeId}`;
}

/** A tenant that is not active cannot hand out sessions (fail closed). */
async function assertTenantActive(
  tx: Transaction,
  tenantId: string,
): Promise<void> {
  const rows = await tx
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (rows[0]?.status !== "active")
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Tenant ini sedang tidak aktif.",
    );
}

function mailBody(link: string): { text: string; html: string } {
  const minutes = MAGIC_LINK_TTL_MINUTES;
  const text = [
    `Buka tautan ini untuk masuk ke ${siteConfig.name}:`,
    "",
    link,
    "",
    `Tautan berlaku ${minutes} menit dan hanya bisa dipakai sekali.`,
    "Jika bukan Anda yang meminta, abaikan email ini.",
  ].join("\n");
  const html = [
    `<p>Buka tautan ini untuk masuk ke ${siteConfig.name}:</p>`,
    `<p><a href="${link}">Masuk sekarang</a></p>`,
    `<p>Tautan berlaku ${minutes} menit dan hanya bisa dipakai sekali.</p>`,
    "<p>Jika bukan Anda yang meminta, abaikan email ini.</p>",
  ].join("\n");
  return { text, html };
}

/**
 * Stores the challenge and mails the link. `linkOrigin` is chosen by the route
 * (a trusted request origin or WEB_URL); the token goes in the fragment.
 *
 * Throws `EMAIL_NOT_CONFIGURED` before writing anything when this deployment
 * cannot send email. A send failure afterwards cancels the challenge and still
 * answers the same, so the response never says whether a mail was possible for
 * this address.
 */
export async function requestEmailMagicLink(
  tenant: TenantContext,
  request: {
    email: string;
    bindingNonce: string;
    linkOrigin: string;
    ip: string | null;
    userAgent: string | null;
  },
  deps: EmailLoginDeps = {},
): Promise<MagicLinkRequested> {
  const email = normalizeEmail(request.email);
  if (email === null || isReservedAddress(email))
    throw new HttpError(422, "VALIDATION_ERROR", "Check the supplied fields.");
  const sender = getEmailSender();
  if (sender === null) throw new IdentityError("EMAIL_NOT_CONFIGURED");

  const context = establishScopedTenantContext(tenant, { kind: "tenant" });
  const now = deps.now ?? new Date();
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL);

  await withTenant(db, context, async (tx) => {
    await assertTenantActive(tx, tenant.tenantId);
    await tx.insert(loginChallenges).values({
      id,
      tenantId: tenant.tenantId,
      brandId: tenant.brandId,
      channel: "email_magic_link",
      codeHash: magicLinkTokenDigest(token),
      browserBindingHash: bindingDigestOf(request.bindingNonce),
      emailEncrypted: sealSecret(email, challengeEmailAad(id)),
      status: "pending",
      expiresAt,
      ipHash: request.ip ? clientIpDigest(request.ip) : null,
      userAgent: request.userAgent?.slice(0, 255) ?? null,
      createdAt: now,
    });
  });

  const link = `${request.linkOrigin}/masuk/email#token=${token}`;
  try {
    await sender.send({
      to: email,
      subject: `Tautan masuk ${siteConfig.name}`,
      ...mailBody(link),
    });
  } catch (error) {
    // The token was never delivered: close the challenge so it cannot linger.
    // Only the error class is logged, never the address, link or provider body.
    emailLoginLog.error(
      {
        challengeId: id,
        error: error instanceof Error ? error.name : "unknown",
      },
      "magic link email could not be sent",
    );
    await db
      .update(loginChallenges)
      .set({ status: "cancelled" })
      .where(eq(loginChallenges.id, id))
      .catch(() => undefined);
  }
  return { sent: true, expiresAt: expiresAt.toISOString() };
}

type Resolved = { userId: string; created: boolean };

/** PostgreSQL unique violation, directly or wrapped by a driver cause chain. */
function uniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

async function resolveAccount(
  email: string,
  digest: string,
): Promise<Resolved> {
  const [identity] = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.type, "email"),
        eq(userIdentities.valueHash, digest),
      ),
    )
    .limit(1);
  if (identity) return { userId: identity.userId, created: false };

  const context = await auth.$context;
  const existing = await context.internalAdapter.findUserByEmail(email);
  if (existing?.user) return { userId: existing.user.id, created: false };

  try {
    const created = await context.internalAdapter.createUser(
      {
        email,
        name: email.split("@")[0] ?? email,
        emailVerified: true,
      },
      // Not a Better Auth sign-in route: provisioned by a verified mailbox.
      { method: "email-magic-link" },
    );
    return { userId: created.id, created: true };
  } catch (error) {
    // A racing verification created the same address first: use that account.
    const winner = await context.internalAdapter.findUserByEmail(email);
    if (winner?.user && uniqueViolation(error))
      return { userId: winner.user.id, created: false };
    throw error;
  }
}

type VerifyOutcome =
  | {
      kind: "consumed";
      userId: string;
      crossDevice: boolean;
      challengeId: string;
    }
  | { kind: "expired" }
  | { kind: "already_linked" }
  | { kind: "refused" };

/**
 * Completes a magic link: one use. Every refusal that could reveal something
 * (unknown token, other tenant, used, banned account) is the same
 * `CHALLENGE_NOT_PENDING`; only an expired token says so.
 *
 * Order matters, because Better Auth writes (`createUser`,
 * `createCustomerSession`) run on its own connection, outside our transaction,
 * and a rollback cannot undo them (legend-k2l review F5):
 *
 * 1. Read the challenge without a lock; only a still-valid token gets this far.
 *    Resolve or create the account now. That write is idempotent by address and
 *    harmless if the transaction below then refuses (the mailbox is proven, the
 *    account simply exists).
 * 2. One transaction locks the challenge, runs every refusal and consumes the
 *    token (`completed`, `matchedUserId`, `completedAt`). Nothing outside the
 *    transaction has been written for this token except the account.
 * 3. After commit, issue the session and record `sessionId`. A rollback can no
 *    longer leave a pending token next to a live session. If the session cannot
 *    be created the token stays consumed: the user asks for a new link.
 */
export async function verifyEmailMagicLink(
  tenant: TenantContext,
  request: {
    token: string;
    /** The binding nonce this browser holds, if any. */
    bindingNonce: string | null;
    ip: string | null;
    userAgent: string | null;
  },
  deps: EmailLoginDeps = {},
): Promise<{ session: IssuedSession; view: MagicLinkVerified }> {
  const context = establishScopedTenantContext(tenant, { kind: "tenant" });
  const now = deps.now ?? new Date();
  const codeHash = magicLinkTokenDigest(request.token);

  // Step 1: validity read and account resolution, before the transaction.
  const pre = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(loginChallenges)
      .where(
        and(
          eq(loginChallenges.channel, "email_magic_link"),
          eq(loginChallenges.codeHash, codeHash),
        ),
      )
      .limit(1);
    if (
      !row ||
      row.tenantId !== tenant.tenantId ||
      row.status !== "pending" ||
      row.emailEncrypted === null ||
      now.getTime() >= row.expiresAt.getTime()
    )
      return null;
    await assertTenantActive(tx, tenant.tenantId);
    const email = normalizeEmail(
      openSecret(row.emailEncrypted, challengeEmailAad(row.id)),
    );
    if (email === null || isReservedAddress(email)) return null;
    return { email, digest: await emailDigest(email) };
  });
  const resolved = pre
    ? { ...pre, account: await resolveAccount(pre.email, pre.digest) }
    : null;

  // Step 2: lock, refuse or consume.
  const outcome = await withTenant(
    db,
    context,
    async (tx): Promise<VerifyOutcome> => {
      const [row] = await tx
        .select()
        .from(loginChallenges)
        .where(
          and(
            eq(loginChallenges.channel, "email_magic_link"),
            eq(loginChallenges.codeHash, codeHash),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !row ||
        row.tenantId !== tenant.tenantId ||
        row.status !== "pending" ||
        row.emailEncrypted === null
      )
        return { kind: "refused" };
      await assertTenantActive(tx, tenant.tenantId);
      if (now.getTime() >= row.expiresAt.getTime()) {
        await tx
          .update(loginChallenges)
          .set({ status: "expired" })
          .where(eq(loginChallenges.id, row.id));
        return { kind: "expired" };
      }

      const cancel = async (): Promise<VerifyOutcome> => {
        await tx
          .update(loginChallenges)
          .set({ status: "cancelled" })
          .where(eq(loginChallenges.id, row.id));
        return { kind: "refused" };
      };
      // Valid now but not before the read above: cannot happen (a token only
      // gets less valid), so fail closed.
      if (resolved === null) return cancel();
      const { email, digest, account } = resolved;

      const [owner] = await tx
        .select({ banned: user.banned, emailVerified: user.emailVerified })
        .from(user)
        .where(eq(user.id, account.userId))
        .limit(1);
      if (!owner || owner.banned) return cancel();

      // Pre-registration takeover guard: an unverified user with a password
      // that signed itself up may be an attacker who pre-registered the
      // victim's address and never proved the mailbox. Signing the mailbox
      // owner in (and marking it verified) would hand them an account whose
      // password the squatter knows. Refuse; the challenge stays consumed and
      // emailVerified is never set for such a user.
      //
      // Exception: a user holding a role assignment in any tenant is staff an
      // owner provisioned, so the owner already bound the account to its
      // person (design ws08 M2: staff may use member sign-in methods). The
      // check is fail-closed: anything but an explicit `false` still refuses.
      // `role_assignments` forces row level security per tenant, so the
      // SECURITY DEFINER function of migration 0204 answers across tenants.
      if (!owner.emailVerified) {
        const [credential] = await tx
          .select({ id: accountTable.id })
          .from(accountTable)
          .where(
            and(
              eq(accountTable.userId, account.userId),
              eq(accountTable.providerId, "credential"),
            ),
          )
          .limit(1);
        if (credential) {
          const roleCheck = await tx.execute(
            sql`SELECT app.user_has_role_assignment(${account.userId}) AS has_role`,
          );
          if (roleCheck.rows[0]?.has_role !== true) {
            await cancel();
            return { kind: "already_linked" };
          }
        }
      }

      // The link proves the mailbox: mark the address verified.
      await tx
        .update(user)
        .set({ emailVerified: true })
        .where(eq(user.id, account.userId));
      const inserted = await tx
        .insert(userIdentities)
        .values({
          userId: account.userId,
          type: "email",
          valueHash: digest,
          valueEncrypted: sealSecret(email, `user_identity:email:${digest}`),
          verifiedAt: now,
          isPrimary: account.created,
        })
        .onConflictDoNothing()
        .returning({ id: userIdentities.id });
      if (inserted.length === 0) {
        // The address already belongs to an identity row; it must be this
        // account's, otherwise refuse instead of moving it.
        const [current] = await tx
          .select({ userId: userIdentities.userId })
          .from(userIdentities)
          .where(
            and(
              eq(userIdentities.type, "email"),
              eq(userIdentities.valueHash, digest),
            ),
          )
          .limit(1);
        if (current?.userId !== account.userId) return cancel();
      }

      const bound =
        request.bindingNonce !== null &&
        bindingDigestOf(request.bindingNonce) === row.browserBindingHash;
      const crossDevice = !bound;
      await tx
        .update(loginChallenges)
        .set({
          status: "completed",
          matchedUserId: account.userId,
          completedAt: now,
        })
        .where(eq(loginChallenges.id, row.id));
      return {
        kind: "consumed",
        userId: account.userId,
        crossDevice,
        challengeId: row.id,
      };
    },
  );

  if (outcome.kind === "expired") throw new IdentityError("CHALLENGE_EXPIRED");
  if (outcome.kind === "already_linked")
    throw new IdentityError("IDENTITY_ALREADY_LINKED");
  if (outcome.kind === "refused")
    throw new IdentityError("CHALLENGE_NOT_PENDING");

  // Step 3: the token is consumed and committed; now the session.
  let session: IssuedSession;
  try {
    session = await createCustomerSession({
      userId: outcome.userId,
      ipAddress: request.ip,
      userAgent: request.userAgent,
      now,
      authMethod: "email_magic_link",
      crossDevice: outcome.crossDevice,
    });
  } catch (error) {
    // The token stays consumed on purpose: the user asks for a new link.
    emailLoginLog.error(
      {
        challengeId: outcome.challengeId,
        error: error instanceof Error ? error.name : "unknown",
      },
      "magic link consumed but session could not be created",
    );
    throw error;
  }
  try {
    await withTenant(db, context, async (tx) => {
      await tx
        .update(loginChallenges)
        .set({ sessionId: session.id, sessionIssuedAt: now })
        .where(eq(loginChallenges.id, outcome.challengeId));
    });
  } catch (error) {
    // The session is live and valid; only the audit link is missing.
    emailLoginLog.error(
      {
        challengeId: outcome.challengeId,
        error: error instanceof Error ? error.name : "unknown",
      },
      "magic link session issued but challenge could not record it",
    );
  }
  return {
    session,
    view: {
      userId: userIdSchema.parse(outcome.userId),
      crossDevice: outcome.crossDevice,
    },
  };
}
