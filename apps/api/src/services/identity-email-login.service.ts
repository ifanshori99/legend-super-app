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
  type ScopedTenantContext,
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
import { getEmailSender, resolveTenantEmailFrom } from "../lib/email-sender";
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
import { takeEmailLinkSlot } from "../lib/email-link-throttle";
import {
  recordLoginAudit,
  type LoginAuditAction,
  type LoginAuditDetails,
} from "./identity-wa-audit.ts";

const emailLoginLog = logger.child({ module: "identity-email-login" });

/** Contract: a magic link lives 15 minutes (`MAGIC_LINK_TTL_MINUTES`). */
const MAGIC_LINK_TTL = MAGIC_LINK_TTL_MINUTES * MINUTE_MS;

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type EmailLoginDeps = {
  /** Test clock; production uses the wall clock. */
  readonly now?: Date;
};

/** The reserved placeholder domain is never a mailbox (RFC 2606). */
export function isReservedAddress(email: string): boolean {
  return email.endsWith(".invalid");
}

export function challengeEmailAad(challengeId: string): string {
  return `login_challenge:email:${challengeId}`;
}

/** A tenant that is not active cannot hand out sessions (fail closed). */
export async function assertTenantActive(
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

/**
 * One `audit_logs` row for the email channel, on the caller's transaction so it
 * commits with the state change it describes. Details carry only the channel,
 * status and cause: never the address, the token or the link.
 */
export async function auditEmailLogin(
  tx: Transaction,
  context: ScopedTenantContext,
  input: {
    action: LoginAuditAction;
    challengeId: string | null;
    actorUserId?: string | null;
    details: Omit<LoginAuditDetails, "channel">;
    now: Date;
    ip: string | null;
  },
): Promise<void> {
  await recordLoginAudit(tx, context, {
    action: input.action,
    challengeId: input.challengeId,
    actorUserId: input.actorUserId ?? null,
    details: { channel: "email_magic_link", ...input.details },
    now: input.now,
    ipHash: input.ip ? clientIpDigest(input.ip) : null,
  });
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
  const from = await resolveTenantEmailFrom(tenant.tenantId);
  if (sender === null || from === null)
    throw new IdentityError("EMAIL_NOT_CONFIGURED");

  const context = establishScopedTenantContext(tenant, { kind: "tenant" });
  const now = deps.now ?? new Date();
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL);

  // Per-address limit. Over it: no challenge, no mail, and the same answer as a
  // success, so the response never says whether the address is throttled or
  // registered. The key is the keyed digest, never the address.
  const slot = takeEmailLinkSlot(
    `${tenant.tenantId}\u0000${await emailDigest(email)}`,
    now.getTime(),
  );
  if (!slot.allowed) {
    if (slot.firstRefusal)
      await withTenant(db, context, (tx) =>
        auditEmailLogin(tx, context, {
          action: "login_challenge.rate_limited",
          challengeId: null,
          details: { cause: "email_throttled" },
          now,
          ip: request.ip,
        }),
      ).catch((error: unknown) =>
        emailLoginLog.error(
          { error: error instanceof Error ? error.name : "unknown" },
          "magic link throttle could not be audited",
        ),
      );
    return { sent: true, expiresAt: expiresAt.toISOString() };
  }

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
    await auditEmailLogin(tx, context, {
      action: "login_challenge.created",
      challengeId: id,
      details: { status: "pending", expiresAt: expiresAt.toISOString() },
      now,
      ip: request.ip,
    });
  });

  const link = `${request.linkOrigin}/masuk/email#token=${token}`;
  try {
    await sender.send({
      from,
      to: email,
      subject: `Tautan masuk ${siteConfig.name}`,
      ...mailBody(link),
    });
  } catch (error) {
    // The token was never delivered: close the challenge so it cannot linger.
    // The sender's error message carries only the SMTP error code (EAUTH,
    // ETIMEDOUT, ...), never the address, link, password or server reply
    // (lib/email-sender.ts), so it is safe to log and names the cause.
    emailLoginLog.error(
      {
        challengeId: id,
        error: error instanceof Error ? error.message : "unknown",
      },
      "magic link email could not be sent",
    );
    await withTenant(db, context, async (tx) => {
      await tx
        .update(loginChallenges)
        .set({ status: "cancelled" })
        .where(eq(loginChallenges.id, id));
      await auditEmailLogin(tx, context, {
        action: "login_challenge.cancelled",
        challengeId: id,
        details: { status: "cancelled", cause: "email_send_failed" },
        now,
        ip: request.ip,
      });
    }).catch(() => undefined);
  }
  return { sent: true, expiresAt: expiresAt.toISOString() };
}

/**
 * Marks the address of `userId` verified and records its `email` identity row.
 * Shared by the magic-link sign-in and the first-admin invitation accept
 * (legend-fy5y). Returns `identity_conflict` when the address digest already
 * belongs to another user; the caller then refuses and writes nothing more.
 */
export async function markEmailVerifiedWithIdentity(
  tx: Transaction,
  input: {
    userId: string;
    email: string;
    digest: string;
    isPrimary: boolean;
    now: Date;
  },
): Promise<"ok" | "identity_conflict"> {
  const inserted = await tx
    .insert(userIdentities)
    .values({
      userId: input.userId,
      type: "email",
      valueHash: input.digest,
      valueEncrypted: sealSecret(
        input.email,
        `user_identity:email:${input.digest}`,
      ),
      verifiedAt: input.now,
      isPrimary: input.isPrimary,
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
          eq(userIdentities.valueHash, input.digest),
        ),
      )
      .limit(1);
    if (current?.userId !== input.userId) return "identity_conflict";
  }
  // Only after the identity is settled: a conflict leaves emailVerified false.
  await tx
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, input.userId));
  return "ok";
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
      row.linkUserId !== null ||
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
        // A first-admin invitation token (link_user_id set) never signs in.
        row.linkUserId !== null ||
        row.emailEncrypted === null
      )
        return { kind: "refused" };
      await assertTenantActive(tx, tenant.tenantId);
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
          ip: request.ip,
        });
        return { kind: "expired" };
      }

      const cancel = async (
        cause: string,
        action: LoginAuditAction = "login_challenge.cancelled",
      ): Promise<VerifyOutcome> => {
        await tx
          .update(loginChallenges)
          .set({ status: "cancelled" })
          .where(eq(loginChallenges.id, row.id));
        await auditEmailLogin(tx, context, {
          action,
          challengeId: row.id,
          details: { status: "cancelled", cause },
          now,
          ip: request.ip,
        });
        return { kind: "refused" };
      };
      // Valid now but not before the read above: cannot happen (a token only
      // gets less valid), so fail closed.
      if (resolved === null) return cancel("resolution_missing");
      const { email, digest, account } = resolved;

      const [owner] = await tx
        .select({ banned: user.banned, emailVerified: user.emailVerified })
        .from(user)
        .where(eq(user.id, account.userId))
        .limit(1);
      if (!owner || owner.banned) return cancel("account_refused");

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
            await cancel("already_linked", "login_challenge.rejected");
            return { kind: "already_linked" };
          }
        }
      }

      // The link proves the mailbox: mark the address verified.
      const marked = await markEmailVerifiedWithIdentity(tx, {
        userId: account.userId,
        email,
        digest,
        isPrimary: account.created,
        now,
      });
      if (marked === "identity_conflict") return cancel("identity_conflict");

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
      await auditEmailLogin(tx, context, {
        action: "login_challenge.completed",
        challengeId: row.id,
        actorUserId: account.userId,
        details: {
          status: "completed",
          matchedUserId: account.userId,
        },
        now,
        ip: request.ip,
      });
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
    await withTenant(db, context, (tx) =>
      auditEmailLogin(tx, context, {
        action: "login_challenge.claim_failed",
        challengeId: outcome.challengeId,
        actorUserId: outcome.userId,
        details: {
          status: "completed",
          matchedUserId: outcome.userId,
          cause: "session_not_created",
        },
        now,
        ip: request.ip,
      }),
    ).catch(() => undefined);
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
      await auditEmailLogin(tx, context, {
        action: "login_challenge.claimed",
        challengeId: outcome.challengeId,
        actorUserId: outcome.userId,
        details: { status: "completed", matchedUserId: outcome.userId },
        now,
        ip: request.ip,
      });
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
