import type { Request, RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { PlatformError } from "@starter/shared/platform";
import { auth } from "../lib/auth";
import { logger } from "../lib/logger";
import { setRequestSupport } from "../lib/request-context";
import {
  assertSupportAccess,
  endImpersonationSessionsWithoutGrant,
} from "../services/platform-support.service";
import { findTenantContext } from "./tenant";

/*
 * Support session guard (TEN-04, legend-cg071).
 *
 * A "support session" on a request is a Better Auth admin impersonation: the
 * session carries `impersonatedBy` (the platform admin's user id) and acts as
 * a tenant user. Without this guard that session would hold the tenant user's
 * full permissions. Policy, for impersonated sessions only:
 *
 *   1. Tenant resolved, no active support_access_grants row for
 *      (tenant, impersonatedBy): 403 SUPPORT_ACCESS_REQUIRED, every method.
 *   2. Grant is read_only and the method is not GET/HEAD/OPTIONS:
 *      403 SUPPORT_ACCESS_READ_ONLY.
 *   3. Grant is read_write: pass.
 *   4. No tenant resolved: fail closed, every method is 403
 *      SUPPORT_ACCESS_READ_ONLY unless the path is in the allowlist.
 *   5. Normal sessions are untouched and cost no extra query.
 *   6. Every method on /api/auth/* is refused (see
 *      guardImpersonatedAuthRoutes) unless the path is in the allowlist
 *      (session read, exits, idle keep-alive).
 *   7. Lasting credentials (CREDENTIAL_PATHS: MCP authorization, device
 *      enrolment and tokens, staff PINs, web push subscriptions) are refused
 *      even with read_write:
 *      support never mints or changes a way to act as someone later.
 *   8. A session refused under rule 1 whose user no live grant of the admin
 *      covers any more is deleted (legend-w1due): the session dies with its
 *      grant instead of lingering until its own expiry. endSupportAccess
 *      does the same eagerly when a grant is ended early.
 *   9. GET /api/auth/get-session is allowlisted (rule 6), so this guard does
 *      not read the session there; the Better Auth hooks.after in lib/auth.ts
 *      answers null for an impersonated session no live grant covers (and
 *      tries to end it), so a leftover row never reads as the tenant user.
 * 10. This guard runs before the body is read, so for a mutation it is only a
 *     fast refusal. The check that decides is in withTenant
 *     (db/tenant.ts lockSupportGrantForMutation, legend-hqjde): inside the
 *     mutation's own transaction it locks the grant row FOR SHARE and
 *     re-checks active, unexpired, read_write and same tenant. The revoke
 *     locks the same row FOR UPDATE, so no support write commits after a
 *     revoke answered 200, even when the request was held mid-body.
 *
 * Errors are thrown as PlatformError so the error handler shapes the reply.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Paths an impersonated session may always call, whatever the grant: read its
// own session, leave, and the idle keep-alive. Exact match after stripping the
// query string and trailing slash.
export const IMPERSONATION_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/get-session",
  "/api/auth/sign-out",
  "/api/auth/admin/stop-impersonating",
  "/api/auth/sessions/current/activity",
]);

// Routes that mint or change a lasting credential. Refused under an
// impersonated session even with a read_write grant.
const CREDENTIAL_PATHS: ReadonlyArray<{ method: string; path: RegExp }> = [
  // MCP: authorize a client to act as the user, register and approve clients.
  { method: "POST", path: /^\/api\/ai\/mcp\/authorize$/ },
  { method: "POST", path: /^\/api\/ai\/mcp-clients$/ },
  { method: "POST", path: /^\/api\/ai\/mcp-clients\/[^/]+\/approve$/ },
  // Devices: enrol a device and issue its token.
  { method: "POST", path: /^\/api\/devices$/ },
  { method: "POST", path: /^\/api\/devices\/[^/]+\/token$/ },
  // Edge nodes: creation returns a link credential, rotation issues a new one.
  { method: "POST", path: /^\/api\/edge-nodes$/ },
  { method: "POST", path: /^\/api\/edge-nodes\/[^/]+\/rotate-credential$/ },
  // Staff PIN set or reset.
  { method: "PUT", path: /^\/api\/staff-pins\/[^/]+\/[^/]+$/ },
  // Web push: the subscription row belongs to the user, not the session, so
  // it would keep sending the tenant user's notifications to the support
  // browser after the session and grant end (legend-8bvin).
  { method: "POST", path: /^\/api\/notifications\/push-subscriptions$/ },
  // Removing one of the user's alarm devices (legend-gchkf): an impersonating
  // support session must not switch off the user's panic alarms.
  { method: "DELETE", path: /^\/api\/identity\/push-devices\/[^/]+$/ },
];

/**
 * Request path without query string and trailing slash, lower-cased with
 * repeated slashes collapsed: Express routing is case-insensitive, so
 * `/api/Devices` reaches the same handler as `/api/devices` and must match
 * the same rule.
 */
function pathOf(req: Request): string {
  return (req.originalUrl.split("?")[0] ?? "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export type SupportSessionView = {
  impersonatedBy: string;
  accessMode: "read_only" | "read_write";
  expiresAt: string;
};

type ActiveGrant = NonNullable<Awaited<ReturnType<typeof assertSupportAccess>>>;

// Per request: the grant behind the impersonated session, or null when none
// is active. Set by the guard on success, filled lazily by supportSessionOf.
const grants = new WeakMap<Request, Promise<ActiveGrant | null>>();

/** The admin id when this request's session is an impersonation, else null. */
function impersonatorOf(req: Request): string | null {
  const session = req.auth?.session as
    { impersonatedBy?: string | null } | undefined;
  return session?.impersonatedBy || null;
}

/**
 * The support session behind this request, or null for a normal session, a
 * request with no resolved tenant, or an impersonation with no active grant.
 * Cached per request. Mount after requireAuth.
 */
export async function supportSessionOf(
  req: Request,
): Promise<SupportSessionView | null> {
  const impersonatedBy = impersonatorOf(req);
  if (!impersonatedBy) return null;
  let pending = grants.get(req);
  if (!pending) {
    const tenant = findTenantContext(req);
    pending = tenant
      ? assertSupportAccess({
          tenantId: tenant.tenantId,
          actorUserId: impersonatedBy,
          dataClass: "personal",
          intent: "read",
        }).catch((error: unknown) => {
          if (error instanceof PlatformError) return null;
          throw error;
        })
      : Promise.resolve(null);
    grants.set(req, pending);
  }
  const grant = await pending;
  return grant
    ? {
        impersonatedBy,
        accessMode: grant.accessMode,
        expiresAt: grant.expiresAt,
      }
    : null;
}

/**
 * Applies the policy above to an authenticated request. Called by requireAuth
 * right after it sets req.auth, so every cookie router is covered at once.
 */
export async function enforceSupportSession(req: Request): Promise<void> {
  const impersonatedBy = impersonatorOf(req);
  if (!impersonatedBy) return;
  const path = pathOf(req);
  if (
    CREDENTIAL_PATHS.some((c) => c.method === req.method && c.path.test(path))
  )
    throw new PlatformError("SUPPORT_ACCESS_READ_ONLY");
  const safe = SAFE_METHODS.has(req.method);
  const tenant = findTenantContext(req);
  if (!tenant) {
    if (!IMPERSONATION_ALLOWED_PATHS.has(path))
      throw new PlatformError("SUPPORT_ACCESS_READ_ONLY");
    return;
  }
  let grant: ActiveGrant | null;
  try {
    grant = await assertSupportAccess({
      tenantId: tenant.tenantId,
      actorUserId: impersonatedBy,
      dataClass: "personal",
      intent: safe ? "read" : "write",
    });
  } catch (error) {
    // legend-w1due: no live grant for this tenant. When no other live grant
    // of the admin covers this user either, the session itself dies here
    // (deleted and audited as grant_ended) instead of lingering until its
    // own expiry. The refusal still answers this request.
    if (
      error instanceof PlatformError &&
      error.code === "SUPPORT_ACCESS_REQUIRED" &&
      req.auth?.session.id
    )
      // A failed cleanup must not change the answer: the refusal stands and
      // the next request tries again.
      await endImpersonationSessionsWithoutGrant({
        adminUserId: impersonatedBy,
        sessionId: req.auth.session.id,
      }).catch((cleanupError: unknown) =>
        logger.error(
          { err: cleanupError, sessionId: req.auth?.session.id },
          "failed to end a support session without grant",
        ),
      );
    throw error;
  }
  // Only cache a pass: a write passes only with read_write, so that grant is
  // valid for reads too. A rejection must not poison supportSessionOf.
  grants.set(req, Promise.resolve(grant));
  // Tell the audit writer who is really acting (legend-6yfhc): recordAudit
  // swaps the impersonated tenant user for the admin on this tenant's rows.
  if (grant && req.auth?.user)
    setRequestSupport({
      tenantId: tenant.tenantId,
      grantId: grant.id,
      impersonatorUserId: impersonatedBy,
      impersonatedUserId: req.auth.user.id,
      accessMode: grant.accessMode,
      reason: grant.reason,
      mutation: !safe,
    });
}

/**
 * Rule 6 for everything under /api/auth, mounted before the login-challenge
 * router, identityAuthRouter and Better Auth (none of which run requireAuth).
 * Reads headers only (never the body). The session is looked up only when the
 * path is not allowlisted and the request carries credentials, so sign-in and
 * anonymous traffic cost nothing extra.
 */
export const guardImpersonatedAuthRoutes: RequestHandler = async (
  req,
  _res,
  next,
) => {
  if (IMPERSONATION_ALLOWED_PATHS.has(pathOf(req))) return next();
  if (!req.headers.cookie && !req.headers.authorization) return next();
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
    query: { disableCookieCache: true },
  });
  if (session?.session.impersonatedBy)
    throw new PlatformError("SUPPORT_ACCESS_READ_ONLY");
  next();
};
