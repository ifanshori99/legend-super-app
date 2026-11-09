import type { NextFunction, Request, RequestHandler } from "express";
import { PlatformError } from "@starter/shared/platform";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import { recordImpersonatedPlatformDenial } from "../services/platform-access-audit.service";
import { isPlatformAdmin } from "../services/platform-support.service";
import { getAuth, requireAuth } from "./auth";
import { findTenantContext } from "./tenant";

// Only the fixed platform shape names a tenant: /api/platform/tenants/<uuid>.
const PATH_TENANT =
  /^\/api\/platform\/tenants\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/;
const MAX_ROUTE_LENGTH = 256;
// A stored route keeps ids and plain route words only. Any other segment
// (an unmatched path can carry free text such as an email) becomes "*".
const ROUTE_SEGMENT =
  /^(?:[a-z][a-z0-9_-]{0,39}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
// One row per (session, tenant, code, method) per window, so a looping
// impersonated client cannot fill a tenant's audit log (kept 2 years).
const DENIAL_WINDOW_MS = 60_000;
const MAX_TRACKED_DENIALS = 10_000;
const recentDenials = new Map<string, number>();

function impersonatorOf(req: Request): string | null {
  const session = req.auth?.session as
    { impersonatedBy?: string | null } | undefined;
  return session?.impersonatedBy || null;
}

/** Path without query string or trailing slash, lower-cased, slashes collapsed. */
function normalisedPath(req: Request): string {
  return (req.originalUrl.split("?")[0] ?? "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * The tenant a refused platform request is recorded against: the tenant named
 * by /api/platform/tenants/<uuid>, else the tenant the request resolved to.
 * The service still writes only when that tenant is tied to the session.
 */
function denialTenantOf(req: Request, path: string): string | null {
  return (
    PATH_TENANT.exec(path)?.[1] ?? findTenantContext(req)?.tenantId ?? null
  );
}

/** True when this denial was already recorded inside the current window. */
function recentlyRecorded(key: string, now: number): boolean {
  const last = recentDenials.get(key);
  if (last !== undefined && now - last < DENIAL_WINDOW_MS) return true;
  if (recentDenials.size >= MAX_TRACKED_DENIALS) recentDenials.clear();
  recentDenials.set(key, now);
  return false;
}

/**
 * Records a platform request refused because its session is an impersonation
 * (platform.access.denied). Never changes the refusal: a failed audit write is
 * logged and the original 403 still goes out.
 */
async function auditImpersonatedDenial(
  req: Request,
  impersonatedBy: string,
  code: string,
): Promise<void> {
  const path = normalisedPath(req);
  const route = path
    .split("/")
    .map((segment) =>
      segment === "" || ROUTE_SEGMENT.test(segment) ? segment : "*",
    )
    .join("/")
    .slice(0, MAX_ROUTE_LENGTH);
  const impersonatedUserId = req.auth?.user.id;
  const sessionId = req.auth?.session.id;
  const tenantId = denialTenantOf(req, path);
  const fields = {
    impersonatedBy,
    impersonatedUserId,
    code,
    method: req.method,
    route,
  };
  if (!impersonatedUserId || !tenantId) {
    logger.warn(fields, "platform.access.denied without a tenant to audit");
    return;
  }
  const key = [sessionId, tenantId, code, req.method].join("|");
  if (recentlyRecorded(key, Date.now())) return;
  try {
    const written = await recordImpersonatedPlatformDenial({
      tenantId,
      impersonatedUserId,
      impersonatedBy,
      code,
      method: req.method,
      route,
    });
    if (!written)
      logger.warn(
        { ...fields, tenantId },
        "platform.access.denied for a tenant not tied to the session",
      );
  } catch (error) {
    // Let the next refusal try again instead of skipping it for the window.
    recentDenials.delete(key);
    logger.error(
      { ...fields, tenantId, err: error },
      "platform.access.denied audit write failed",
    );
  }
}

/**
 * requireAuth for platform routers. The support session guard inside
 * requireAuth refuses an impersonated session (403 SUPPORT_ACCESS_*) before
 * any platform middleware runs; this wrapper records that refusal, then
 * rethrows it unchanged.
 */
export const requirePlatformAuth: RequestHandler = async (req, res, next) => {
  let passed = false;
  const markPassed: NextFunction = (error?: unknown) => {
    if (error !== undefined) throw error;
    passed = true;
  };
  try {
    await requireAuth(req, res, markPassed);
  } catch (error) {
    const impersonatedBy = impersonatorOf(req);
    const refused =
      (error instanceof PlatformError || error instanceof HttpError) &&
      error.status === 403;
    if (impersonatedBy && refused)
      await auditImpersonatedDenial(req, impersonatedBy, error.code);
    throw error;
  }
  if (passed) next();
};

/**
 * Platform access is tied to the revocable registry, never a global auth role.
 * An impersonated session (the target user's identity, acted by an admin) is
 * never a platform admin, even when the target user is one; that refusal is
 * recorded as platform.access.denied.
 */
export const requirePlatformAdmin: RequestHandler = async (req, _res, next) => {
  const auth = getAuth(req);
  const impersonatedBy = impersonatorOf(req);
  if (impersonatedBy || !(await isPlatformAdmin(auth.user.id))) {
    if (impersonatedBy)
      await auditImpersonatedDenial(req, impersonatedBy, "FORBIDDEN");
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Your account cannot perform this action.",
    );
  }
  next();
};
