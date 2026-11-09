import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { admin } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import {
  ac,
  ADMIN_ROLES,
  DEFAULT_ROLE,
  roles,
} from "@starter/shared/permissions";
import { siteConfig } from "@starter/shared/site";
import { env } from "../config/env";
import { db } from "../db";
import * as schema from "../db/schema";
import {
  assertImpersonationAllowed,
  IMPERSONATION_SESSION_MAX_SECONDS,
  ImpersonationRefused,
  recordImpersonationEnded,
  recordImpersonationStarted,
  type ImpersonationEndCause,
} from "../services/platform-support.service";
import { logger } from "./logger";

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
 *   - the session lasts at most IMPERSONATION_SESSION_MAX_SECONDS (60 min);
 *   - start and end write a sensitive audit row in each matched tenant.
 *
 * The check runs twice: hooks.before (HTTP route, gives a clean 403) and
 * databaseHooks.session.create.before (also covers server-side
 * auth.api.impersonateUser, which skips hooks.before). The start audit fails
 * closed (the session row is deleted); the end audit never blocks an exit.
 * MFA is not bypassed by a grant (legend-cg071).
 */
function refuse(error: unknown): never {
  if (error instanceof ImpersonationRefused)
    throw new APIError("FORBIDDEN", {
      code: error.code,
      message: error.message,
    });
  throw error;
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
      if (ctx.path !== "/admin/impersonate-user") return;
      const current = await getSessionFromCtx(ctx);
      // No session: the endpoint answers 401 itself.
      if (!current) return;
      if (current.session.impersonatedBy)
        throw new APIError("FORBIDDEN", {
          code: "IMPERSONATION_NOT_ALLOWED",
          message: "An impersonated session cannot impersonate another user.",
        });
      const targetUserId = (ctx.body as { userId?: unknown } | undefined)
        ?.userId;
      // Let the endpoint's own body validation reject a malformed request.
      if (typeof targetUserId !== "string") return;
      try {
        await assertImpersonationAllowed({
          adminUserId: current.user.id,
          targetUserId,
          now: new Date(),
        });
      } catch (error) {
        refuse(error);
      }
    }),
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const adminUserId = session.impersonatedBy;
          if (typeof adminUserId !== "string" || !adminUserId) return;
          const now = new Date();
          try {
            await assertImpersonationAllowed({
              adminUserId,
              targetUserId: session.userId,
              now,
            });
          } catch (error) {
            refuse(error);
          }
          const cap = new Date(
            now.getTime() + IMPERSONATION_SESSION_MAX_SECONDS * 1000,
          );
          return {
            data: {
              ...session,
              expiresAt: session.expiresAt < cap ? session.expiresAt : cap,
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
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    // Add an email provider before enabling verification or password recovery.
    requireEmailVerification: false,
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
