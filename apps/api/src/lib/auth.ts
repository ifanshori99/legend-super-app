import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { admin } from "better-auth/plugins";
import { createHmac } from "node:crypto";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import {
  ac,
  ADMIN_ROLES,
  DEFAULT_ROLE,
  roles,
} from "@starter/shared/permissions";
import { normalizeEmail } from "@starter/shared/identity";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { siteConfig } from "@starter/shared/site";
import { env } from "../config/env";
import { db } from "../db";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import type { SessionAuthMethod } from "../db/schema/session";
import {
  assertImpersonationAllowed,
  endImpersonationSessionsWithoutGrant,
  findImpersonationGrants,
  IMPERSONATION_SESSION_MAX_SECONDS,
  ImpersonationRefused,
  impersonationSessionEnd,
  isPlatformAdmin,
  platformTenantContext,
  recordImpersonationEnded,
  recordImpersonationStarted,
  type ImpersonationEndCause,
  type ImpersonationMatch,
} from "../services/platform-support.service";
import { contactDigestSecret, emailDigest } from "./identity-digest";
import {
  deleteSessionPushSubscriptionsForSession,
  deleteUserPushSubscriptions,
} from "../services/identity-session.service";
import { resolveHostname } from "../services/org-resolve.service";
import { sharedDeviceIdsFromToken } from "../services/shared-device.service";
import { logger } from "./logger";
import { sealSecret } from "./secrets";

const authLog = logger.child({ module: "better-auth" });

/*
 * Impersonation policy (TEN-04, legend-rzirp). Better Auth's admin plugin lets
 * any user with the `impersonate` permission act as anyone. Here it also needs
 * a support_access_grants row:
 *
 *   - the caller is an active platform admin with a grant that is active now
 *     in a tenant where the target holds a role (assertImpersonationAllowed);
 *   - the target is not the caller and not a platform admin;
 *   - an impersonated session cannot start another impersonation;
 *   - the session lasts at most IMPERSONATION_SESSION_MAX_SECONDS (60 min)
 *     and never outlives the grant behind it (legend-npkpz);
 *   - start and end write a sensitive audit row in each matched tenant.
 *
 * The check runs twice: hooks.before (gives a clean 403 before the endpoint
 * runs) and databaseHooks.session.create.before (the authoritative check on
 * the session row itself, whatever path created it). The start audit fails
 * closed (the session row is deleted); the end audit never blocks an exit.
 * MFA is not bypassed by a grant (legend-cg071).
 *
 * Admin plugin lockdown (legend-imdzn). The plugin also serves list-users,
 * set-user-password, set-role, update-user, remove-user, ban-user,
 * create-user and session revocation to any `admin` role, across every
 * tenant, with no grant, approval or audit, and a revoked platform admin
 * keeps `user.role = admin`. hooks.before therefore refuses every /admin/*
 * route (403 ADMIN_ENDPOINT_DISABLED) except the ones the product uses:
 *
 *   - impersonate-user: active platform_admins row checked first, then the
 *     grant policy above;
 *   - stop-impersonating: leaving is never blocked (the endpoint itself
 *     refuses a session that is not impersonated);
 *   - has-permission: server calls only (requirePermission calls
 *     auth.api.userHasPermission without a request); over HTTP it is refused.
 *
 * Better Auth 1.7 runs hooks.before for auth.api.* calls as well, so a server
 * call to another admin endpoint is refused too. The admin role in
 * @starter/shared/permissions keeps only `user: ["impersonate"]` to match.
 */
function refuse(error: unknown): never {
  if (error instanceof ImpersonationRefused)
    throw new APIError("FORBIDDEN", {
      code: error.code,
      message: error.message,
    });
  throw error;
}

/*
 * Better Auth endpoints that revoke every session of a user through
 * deleteUserSessions (internal-adapter.mjs:503-521): the session delete hook
 * also removes the user's orphan push subscriptions on these paths. The
 * /admin/* ones are refused by hooks.before (only impersonation is enabled);
 * listed so enabling one later cannot skip the sweep. /reset-password is not
 * here: revokeSessionsOnPasswordReset is off, so it never reaches
 * deleteUserSessions; emailAndPassword.onPasswordReset sweeps instead.
 */
const USER_WIDE_SESSION_REVOKE_PATHS = new Set([
  "/revoke-sessions",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
  "/admin/ban-user",
  "/admin/revoke-user-sessions",
  "/admin/remove-user",
  // A ban through update-user also ends every session of the user.
  "/admin/update-user",
]);

/*
 * Paths that end a session on purpose (legend-ofq4f, second opinion P2). The
 * session delete hook only deletes push subscriptions for these. Any other
 * endpoint (/list-sessions, /update-user, ...) that meets an expired cookie
 * makes Better Auth delete the dead session as a side effect; that is idle
 * cleanup and must keep the phone's panic alarm. /admin/* is matched by
 * prefix (see isExplicitSessionEnd).
 */
const EXPLICIT_SESSION_END_PATHS = new Set([
  "/sign-out",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
]);

function isExplicitSessionEnd(path: string | undefined): boolean {
  if (!path) return false;
  return EXPLICIT_SESSION_END_PATHS.has(path) || path.startsWith("/admin/");
}

function endCause(
  path: string | undefined,
  expiresAt: Date,
  now: Date,
): ImpersonationEndCause {
  if (path === "/admin/stop-impersonating") return "stopped";
  if (path === "/sign-out") return "signed_out";
  return expiresAt <= now ? "expired" : "revoked";
}

/*
 * Sign-in method on the session row (legend-k2l, design ws08 M2 "Sign-in
 * method gate"). The identity gate (middleware/identity.ts) only treats a
 * `password` session as a management session, so a WhatsApp, email-link or
 * Google session never reaches staff routes, whatever roles the user holds.
 *
 * The value is decided here, from the Better Auth endpoint that is minting the
 * session, never from client input (`input: false` on the field below):
 *
 *   - a password route (sign-in, sign-up, change and reset password) and
 *     impersonation (support keeps today's behaviour) -> `password`;
 *   - the OAuth callback (/callback/:id, /oauth2/callback/:providerId) and the
 *     idToken sign-in (/sign-in/social) -> `google`;
 *   - any other Better Auth endpoint -> `legacy` (customer rights only);
 *   - no endpoint context at all: the session came from our own
 *     `createCustomerSession` (WhatsApp, email link), which passes the method
 *     and the cross-device flag in the row; keep them, else `legacy`.
 *
 * Better Auth hands the hook `ctx = null` for internalAdapter calls made
 * outside an endpoint (with-hooks.ts `tryGetCurrentAuthEndpointContext`), which
 * is exactly the createCustomerSession case. Inside an endpoint
 * `authCrossDevice` is always false: only the email link can be opened on
 * another device, and that route runs outside Better Auth.
 */
const PASSWORD_SESSION_PATHS = new Set([
  "/sign-in/email",
  "/sign-up/email",
  "/change-password",
  "/reset-password",
  "/admin/impersonate-user",
]);

const SESSION_AUTH_METHODS: readonly SessionAuthMethod[] = [
  "password",
  "whatsapp",
  "email_magic_link",
  "google",
  "legacy",
];

/*
 * Tenant of a staff login (legend-488 item 5). Only the email/password sign-in
 * path, and only on a tenant host: the tenant comes from the Host header via
 * resolveHostname (never client input) and counts only when the user holds an
 * active role assignment there. Anything else (no host, unknown host, no
 * role, other sign-in path) leaves session.tenant_id NULL. `role_assignments`
 * forces row level security, so the read runs inside withTenant.
 */
async function staffLoginTenantId(
  path: string | undefined,
  host: string | null | undefined,
  userId: string,
): Promise<string | null> {
  if (path !== "/sign-in/email" || !host) return null;
  const resolution = await resolveHostname(host);
  if (!resolution.ok) return null;
  const { tenantId } = resolution;
  const now = new Date();
  const [assignment] = await withTenant(
    db,
    platformTenantContext(tenantId),
    (tx) =>
      tx
        .select({ id: schema.roleAssignments.id })
        .from(schema.roleAssignments)
        .where(
          and(
            eq(schema.roleAssignments.tenantId, tenantId),
            eq(schema.roleAssignments.userId, userId),
            lte(schema.roleAssignments.validFrom, now),
            or(
              isNull(schema.roleAssignments.validUntil),
              gt(schema.roleAssignments.validUntil, now),
            ),
          ),
        )
        .limit(1),
  );
  return assignment ? tenantId : null;
}

function sessionAuthMethodFor(
  path: string | undefined,
  passed: unknown,
): SessionAuthMethod {
  if (path === undefined)
    return SESSION_AUTH_METHODS.find((method) => method === passed) ?? "legacy";
  if (PASSWORD_SESSION_PATHS.has(path)) return "password";
  // legend-k2l review F6: `/sign-in/social` is the idToken sign-in (no
  // redirect, no callback). Google is the only social provider configured.
  if (
    path === "/sign-in/social" ||
    path.startsWith("/callback/") ||
    path.startsWith("/oauth2/callback")
  )
    return "google";
  return "legacy";
}

/*
 * Google sign-in (legend-k2l, AUTH-05). A Google account may only sign in to,
 * or link to, a user whose email Google verified, and never to a WhatsApp-only
 * placeholder user (`<number>@wa.invalid`, created by the WhatsApp login): an
 * attacker must not be able to take over a number by owning a lookalike
 * Google address. The google provider's `mapProfileToUser` (provider side:
 * the profile Google returned) and `databaseHooks.account.create.before` (the
 * row side: the matched user's own address) refuse it.
 *
 * `user.validateUserInfo` is deliberately NOT used: once it is configured,
 * Better Auth's `internalAdapter.createUser` demands an endpoint context and a
 * validation source from every caller, so our own trusted callers outside an
 * endpoint (the WhatsApp placeholder user, the email-link user) would fail with
 * "User validation requires an endpoint context". Both guards here run only on
 * the Google callback path, and `account.create.before` returns at once for any
 * other provider.
 */
function isInvalidEmail(email: unknown): boolean {
  return (
    typeof email !== "string" || email.trim().toLowerCase().endsWith(".invalid")
  );
}

/** Keyed digest of a Google `sub`; same secret family as the contact digests. */
function googleSubjectDigest(sub: string): string {
  return createHmac("sha256", contactDigestSecret())
    .update(`google\u0000${sub}`, "utf8")
    .digest("hex");
}

/**
 * Records the `google` and `email` identities of a user whose Google account
 * was just created or linked (AUTH-05). A value another user already owns is
 * logged and never moved: moving identities is the merge service's job.
 */
async function recordGoogleIdentities(account: {
  userId: string;
  accountId: string;
}): Promise<void> {
  const [row] = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, account.userId))
    .limit(1);
  const email = normalizeEmail(row?.email);
  const now = new Date();
  const googleHash = googleSubjectDigest(account.accountId);
  const candidates: {
    type: "google" | "email";
    valueHash: string;
    valueEncrypted: string | null;
    providerSubject: string | null;
  }[] = [
    {
      type: "google",
      valueHash: googleHash,
      valueEncrypted: null,
      providerSubject: account.accountId,
    },
  ];
  if (email !== null && !isInvalidEmail(email)) {
    const emailHash = await emailDigest(email);
    candidates.push({
      type: "email",
      valueHash: emailHash,
      valueEncrypted: sealSecret(email, `user_identity:email:${emailHash}`),
      providerSubject: null,
    });
  }
  for (const candidate of candidates) {
    const inserted = await db
      .insert(schema.userIdentities)
      .values({ userId: account.userId, verifiedAt: now, ...candidate })
      .onConflictDoNothing()
      .returning({ id: schema.userIdentities.id });
    if (inserted.length > 0) continue;
    const [owner] = await db
      .select({ userId: schema.userIdentities.userId })
      .from(schema.userIdentities)
      .where(
        and(
          eq(schema.userIdentities.type, candidate.type),
          eq(schema.userIdentities.valueHash, candidate.valueHash),
        ),
      )
      .limit(1);
    if (owner && owner.userId !== account.userId)
      authLog.warn(
        { type: candidate.type, userId: account.userId },
        "legend-k2l: identity already belongs to another user; not moved",
      );
  }
}

// Set by app.ts from Express's req.ip on every request (see TRUST_PROXY).
export const CLIENT_IP_HEADER = "x-starter-client-ip";

export const auth = betterAuth({
  appName: siteConfig.name,
  // The API's public origin. Better Auth serves /api/auth/* from here and sets
  // the session cookie for this host (or COOKIE_DOMAIN in production).
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  // The web app lives on another origin. Better Auth rejects cookie-carrying
  // mutations from any origin not listed here.
  trustedOrigins: env.trustedOrigins,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!ctx.path.startsWith("/admin/")) return;
      if (ctx.path === "/admin/stop-impersonating") return;
      if (ctx.path === "/admin/has-permission" && !ctx.request) return;
      if (ctx.path !== "/admin/impersonate-user")
        throw new APIError("FORBIDDEN", {
          code: "ADMIN_ENDPOINT_DISABLED",
          message: "This admin endpoint is not available.",
        });
      const current = await getSessionFromCtx(ctx);
      // No session: the endpoint answers 401 itself.
      if (!current) return;
      if (current.session.impersonatedBy)
        throw new APIError("FORBIDDEN", {
          code: "IMPERSONATION_NOT_ALLOWED",
          message: "An impersonated session cannot impersonate another user.",
        });
      // Registry first, whatever the body: a revoked admin keeps user.role.
      if (!(await isPlatformAdmin(current.user.id)))
        throw new APIError("FORBIDDEN", {
          code: "SUPPORT_ACCESS_REQUIRED",
          message:
            "Only a platform admin with an active support access can impersonate.",
        });
      const targetUserId = (ctx.body as { userId?: unknown } | undefined)
        ?.userId;
      // A missing userId is left to the endpoint's own 400. Any other value
      // is checked the way the endpoint will read it: its schema coerces
      // userId with z.coerce.string(), so ["<id>"] reaches it as "<id>".
      if (targetUserId === undefined || targetUserId === null) return;
      try {
        await assertImpersonationAllowed({
          adminUserId: current.user.id,
          targetUserId: String(targetUserId),
          now: new Date(),
        });
      } catch (error) {
        refuse(error);
      }
    }),
    // The grant is the source of truth for a support session (TEN-04): a
    // session row that outlived its grant (cleanup failed, or the grant simply
    // lapsed) must not answer GET /api/auth/get-session as the tenant user.
    // The session is already loaded here, so a normal session costs nothing
    // extra. Only the HTTP route: server-side auth.api.getSession calls (the
    // impersonation guard reads the session that way) keep the raw answer.
    after: createAuthMiddleware(async (ctx) => {
      // legend-ofq4f (second opinion P1-1): Better Auth's revoke-other-sessions
      // only deletes the other sessions that are still alive, so the session
      // delete hook never runs when there is none (or only expired ones) and
      // orphan push subscriptions would stay. After a successful revoke, sweep
      // every push row of the user except the caller's own session. The
      // caller's session is the one sensitiveSessionMiddleware loaded before
      // the handler (it is merged into the same ctx.context object the after
      // hook receives, dispatch.mjs createInternalContext/runAfterHooks), so
      // it is the current session, never one that was just revoked.
      if (ctx.path === "/revoke-other-sessions") {
        const returned = ctx.context.returned as
          { status?: boolean } | Error | null | undefined;
        if (
          !returned ||
          returned instanceof Error ||
          (returned as { status?: boolean }).status !== true
        )
          return;
        const current = ctx.context.session as
          | { session?: { id?: string }; user?: { id?: string } }
          | null
          | undefined;
        const currentId = current?.session?.id;
        const userId = current?.user?.id;
        if (!currentId || !userId) {
          // An alarm too many beats one lost: skip the sweep.
          authLog.warn(
            "revoke-other-sessions: current session unknown, push sweep skipped",
          );
          return;
        }
        // A failure throws: the revoke fails instead of leaving an alarm on
        // a phone whose session was revoked.
        await deleteUserPushSubscriptions(userId, currentId);
        return;
      }
      if (ctx.path !== "/get-session" || !ctx.request) return;
      const returned = ctx.context.returned as
        | {
            session?: { id?: string; impersonatedBy?: string | null };
            user?: { id?: string };
          }
        | null
        | undefined;
      const impersonatedBy = returned?.session?.impersonatedBy;
      const targetUserId = returned?.user?.id;
      if (!impersonatedBy || !targetUserId) return;
      let covered = false;
      try {
        covered =
          (await isPlatformAdmin(impersonatedBy)) &&
          (
            await findImpersonationGrants({
              adminUserId: impersonatedBy,
              targetUserId,
              now: new Date(),
            })
          ).length > 0;
      } catch (error) {
        // Fail closed: when the grant cannot be read, no session is shown.
        authLog.error({ err: error }, "failed to read support grant");
      }
      if (covered) return;
      const sessionId = returned?.session?.id;
      // A failed cleanup must not change the answer: the session reads as
      // absent and the next request tries again.
      await endImpersonationSessionsWithoutGrant({
        adminUserId: impersonatedBy,
        ...(sessionId ? { sessionId } : {}),
      }).catch((error: unknown) =>
        authLog.error(
          { err: error, sessionId },
          "failed to end a support session without grant",
        ),
      );
      return ctx.json(null);
    }),
  },
  databaseHooks: {
    account: {
      create: {
        before: async (account) => {
          if (account.providerId !== "google") return;
          const [row] = await db
            .select({
              email: schema.user.email,
              emailVerified: schema.user.emailVerified,
            })
            .from(schema.user)
            .where(eq(schema.user.id, account.userId))
            .limit(1);
          // Never link a Google account to a WhatsApp-only placeholder user.
          if (!row || isInvalidEmail(row.email))
            throw new APIError("FORBIDDEN", {
              code: "google_email_not_usable",
              message: "Google cannot be linked to this account.",
            });
          // Pre-registration takeover: a self-signed-up password account that
          // never verified its email may be an attacker who pre-registered the
          // victim's address. Linking the victim's Google account would hand
          // the attacker's password a verified account, so refuse while the
          // email is unverified and a credential (password) account exists.
          //
          // Exception: a user holding a role assignment in any tenant is staff
          // an owner provisioned, so the owner already bound the account to
          // its person (design ws08 M2: staff may use member sign-in
          // methods). Fail-closed: anything but an explicit `true` refuses.
          // `role_assignments` forces row level security per tenant, so the
          // SECURITY DEFINER function of migration 0204 answers across tenants.
          if (!row.emailVerified) {
            const [credential] = await db
              .select({ id: schema.account.id })
              .from(schema.account)
              .where(
                and(
                  eq(schema.account.userId, account.userId),
                  eq(schema.account.providerId, "credential"),
                ),
              )
              .limit(1);
            if (credential) {
              const roleCheck = await db.execute(
                sql`SELECT app.user_has_role_assignment(${account.userId}) AS has_role`,
              );
              if (roleCheck.rows[0]?.has_role !== true)
                throw new APIError("FORBIDDEN", {
                  code: "google_email_not_usable",
                  message: "Google cannot be linked to this account.",
                });
            }
          }
        },
        after: async (account) => {
          if (account.providerId !== "google") return;
          try {
            await recordGoogleIdentities(account);
          } catch (error) {
            // A missing identity row is repairable; failing here would turn a
            // finished Google sign-in into a 500 and retries never reach this
            // hook again (the account row exists).
            authLog.error(
              { err: error, userId: account.userId },
              "legend-k2l: failed to record google identities",
            );
          }
        },
      },
    },
    session: {
      create: {
        before: async (session, ctx) => {
          // legend-k2l: the method is decided here (see sessionAuthMethodFor).
          const authMethod = sessionAuthMethodFor(
            ctx?.path,
            (session as { authMethod?: unknown }).authMethod,
          );
          const authCrossDevice =
            ctx?.path === undefined &&
            (session as { authCrossDevice?: unknown }).authCrossDevice === true;
          // legend-sq1ux: a sign-in carrying the token of an active shared
          // device marks the new session at once (requireAuth never sees the
          // sign-in request). [] for any other token or none.
          const sharedDeviceIds = await sharedDeviceIdsFromToken(
            ctx?.headers?.get(DEVICE_TOKEN_HEADER),
          );
          const adminUserId = session.impersonatedBy;
          if (typeof adminUserId !== "string" || !adminUserId) {
            const tenantId = await staffLoginTenantId(
              ctx?.path,
              ctx?.headers?.get("host"),
              session.userId,
            );
            return {
              data: {
                ...session,
                authMethod,
                authCrossDevice,
                sharedDeviceIds,
                ...(tenantId ? { tenantId } : {}),
              },
            };
          }
          const now = new Date();
          let matches: ImpersonationMatch[];
          try {
            matches = await assertImpersonationAllowed({
              adminUserId,
              targetUserId: session.userId,
              now,
            });
          } catch (error) {
            refuse(error);
          }
          return {
            data: {
              ...session,
              authMethod,
              authCrossDevice,
              sharedDeviceIds,
              expiresAt: impersonationSessionEnd({
                requested: session.expiresAt,
                matches,
                now,
              }),
            },
          };
        },
        after: async (session) => {
          const adminUserId = session.impersonatedBy;
          if (typeof adminUserId !== "string" || !adminUserId) return;
          const now = new Date();
          try {
            const matches = await assertImpersonationAllowed({
              adminUserId,
              targetUserId: session.userId,
              now,
            });
            await recordImpersonationStarted({
              adminUserId,
              targetUserId: session.userId,
              sessionId: session.id,
              sessionExpiresAt: session.expiresAt,
              matches,
              now,
            });
          } catch (error) {
            // Fail closed: no start audit, no session. A failed delete is
            // logged and the original refusal still propagates.
            try {
              await db
                .delete(schema.session)
                .where(eq(schema.session.id, session.id));
            } catch (deleteError) {
              authLog.error(
                { err: deleteError, sessionId: session.id },
                "failed to delete an unaudited impersonation session",
              );
            }
            refuse(error);
          }
        },
      },
      delete: {
        // legend-ofq4f (second opinion P1-1, P2): an explicit end of a session
        // deletes its web push subscriptions even if the session already
        // expired (the DB trigger spares expired sessions so idle cleanup
        // keeps panic alarms). Only the paths in EXPLICIT_SESSION_END_PATHS
        // (and /admin/*) count; the `/get-session` expiry cleanup, any other
        // endpoint that meets a dead cookie, and calls without an endpoint
        // (our own SQL/services) keep them. A failure throws: the revoke fails
        // instead of leaving an alarm on a signed-out phone. Whole-user revokes
        // also sweep orphan rows; revoke-other-sessions sweeps in hooks.after
        // because this hook does not run when no other live session exists.
        before: async (session, ctx) => {
          const path = ctx?.path;
          if (!isExplicitSessionEnd(path)) return;
          await deleteSessionPushSubscriptionsForSession(session.id);
          if (path && USER_WIDE_SESSION_REVOKE_PATHS.has(path))
            await deleteUserPushSubscriptions(session.userId, null);
        },
        after: async (session, ctx) => {
          const adminUserId = session.impersonatedBy;
          if (typeof adminUserId !== "string" || !adminUserId) return;
          const now = new Date();
          try {
            await recordImpersonationEnded({
              adminUserId,
              targetUserId: session.userId,
              sessionId: session.id,
              sessionCreatedAt: session.createdAt,
              cause: endCause(ctx?.path, session.expiresAt, now),
              now,
            });
          } catch (error) {
            // Never block an exit; the failure is logged for follow-up.
            authLog.error(
              { err: error, sessionId: session.id },
              "failed to audit impersonation end",
            );
          }
        },
      },
    },
  },
  // Google sign-in (legend-k2l, AUTH-05): only when both credentials are set.
  // `prompt: select_account` lets a shared phone pick the right Google account.
  // Accounts link by email only for Google (a trusted provider), and the guards
  // above refuse an unverified or `.invalid` address on the Google path only.
  ...(env.googleEnabled
    ? {
        socialProviders: {
          google: {
            clientId: env.GOOGLE_CLIENT_ID as string,
            clientSecret: env.GOOGLE_CLIENT_SECRET as string,
            prompt: "select_account" as const,
            // Runs only inside the Google callback, so it never touches
            // internal callers (see the guard comment above).
            mapProfileToUser: (profile: {
              email?: string | null;
              email_verified?: boolean;
            }) => {
              if (
                profile.email_verified !== true ||
                isInvalidEmail(profile.email)
              )
                throw new APIError("FORBIDDEN", {
                  code: "google_email_not_usable",
                  message: "Google did not return a verified email address.",
                });
              return {};
            },
          },
        },
      }
    : {}),
  account: {
    accountLinking: { enabled: true, trustedProviders: ["google"] },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    // Add an email provider before enabling verification or password recovery.
    requireEmailVerification: false,
    // legend-ofq4f (second opinion P1-1): a password reset by token has no
    // current session, so every push subscription of the user goes, orphans
    // included (no session row needs to exist for this to run). The password
    // is already changed here: a failed sweep is logged as an error and does
    // not fail the reset (that would strand the user with a spent token).
    onPasswordReset: async ({ user }) => {
      try {
        await deleteUserPushSubscriptions(user.id, null);
      } catch (error) {
        authLog.error(
          { err: error, userId: user.id },
          "legend-ofq4f: failed to delete push subscriptions after password reset",
        );
      }
    },
  },
  rateLimit: {
    // Better Auth only turns its limiter on by itself when NODE_ENV is
    // production, so a server started without it would accept unlimited
    // sign-in attempts. Keep it on everywhere except the API tests.
    enabled: !env.isTest,
    // The web server reads every visitor's session during SSR, all from its
    // own IP. Don't let that shared address exhaust a per-IP bucket; sign-in,
    // sign-up, and password routes keep their strict per-client limits.
    customRules: { "/get-session": false },
  },
  session: {
    // PRD v1.7 §3 F6 "Sesi & Perangkat": a customer session lasts 90 days.
    // Management sessions are cut to 30 idle minutes by the identity gate
    // (middleware/identity.ts), which rewrites expires_at on activity.
    expiresIn: 90 * 24 * 60 * 60,
    // Better Auth slides the expiry only after updateAge; setting it equal to
    // the lifetime keeps a customer session at its 90-day end.
    updateAge: 90 * 24 * 60 * 60,
    // With updateAge equal to the lifetime Better Auth would only refresh a
    // session in the very millisecond it expires, and a client that drops the
    // dont_remember cookie could use that to push an impersonated session
    // 90 days out (legend-rzirp review). Nothing else relies on the refresh.
    disableSessionRefresh: true,
    // legend-k2l: how the session was opened. `input: false` so the client can
    // never choose it; the session create hook sets it and the drizzle adapter
    // only writes fields declared here.
    additionalFields: {
      authMethod: {
        type: "string",
        required: false,
        input: false,
        defaultValue: "legacy",
      },
      authCrossDevice: {
        type: "boolean",
        required: false,
        input: false,
        defaultValue: false,
      },
      // legend-488 item 5: tenant of a staff login on a tenant host. Set only
      // by the session create hook (staffLoginTenantId); NULL otherwise.
      tenantId: {
        type: "string",
        required: false,
        input: false,
      },
      // legend-f586w, legend-jqurl: devices (devices.shared_mode) this session
      // was used on while shared-device mode applied (newest 8); empty
      // otherwise. Written by the session create hook (sign-in with a shared
      // device token, legend-sq1ux), the early stamp in requireAuth,
      // requireActingStaffOnSharedDevice and POST /staff-pins/pos-session.
      sharedDeviceIds: {
        type: "string[]",
        required: false,
        input: false,
      },
    },
  },
  advanced: {
    cookiePrefix: siteConfig.id,
    // PRD §6: every id is a UUID, and org rows store the acting user's id next
    // to uuid tenant/brand/outlet ids. Better Auth's default id is a
    // 32-character random string, so generate UUIDs. A function (not the
    // "uuid" preset) is required: with the preset, a Postgres text id column
    // counts as "supports UUIDs" and Better Auth skips generation entirely.
    database: { generateId: () => crypto.randomUUID() },
    // Rate limits and session IPs use the address Express resolved, never a
    // client-supplied X-Forwarded-For.
    ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    // Production: share the cookie between app.example.com and
    // api.example.com so the web server can read the session during SSR.
    ...(env.COOKIE_DOMAIN
      ? {
          crossSubDomainCookies: { enabled: true, domain: env.COOKIE_DOMAIN },
        }
      : {}),
  },
  logger: {
    level: env.isProduction ? "warn" : "info",
    log: (level, message, ...args) => {
      const [first] = args;
      const fields = first instanceof Error ? { err: first } : { args };
      if (level === "error") authLog.error(fields, message);
      else if (level === "warn") authLog.warn(fields, message);
      else if (level === "debug") authLog.debug(fields, message);
      else authLog.info(fields, message);
    },
  },
  plugins: [
    // Roles come from the access control in @starter/shared/permissions. New
    // accounts get DEFAULT_ROLE; `role` is not accepted from signup input, so
    // nobody can grant themselves one. Use pnpm role:set to promote an account.
    admin({
      ac,
      roles,
      defaultRole: DEFAULT_ROLE,
      adminRoles: ADMIN_ROLES,
      impersonationSessionDuration: IMPERSONATION_SESSION_MAX_SECONDS,
    }),
  ],
});

export type AuthSession = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>;
