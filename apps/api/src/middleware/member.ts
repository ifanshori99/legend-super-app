// Member authorization (legend-111j, docs/design/ws08-member-loyalty.md §M4).
// Mount after tenantContext, requireAuth and (for mutations)
// requireTrustedOrigin. Loads the caller's own profile by (tenant, session
// user) and installs a `MemberScope`; no route reads a profile id from the
// path, query or body.
//
// - default: the profile must be `active`, else 403 MEMBERSHIP_NOT_ACTIVE;
// - allow "pending": `pending_verification` and `suspended` pass too;
// - allow "signup": the profile may be missing (customerProfileId null).
// No profile, or a `closed` one, is 404 CUSTOMER_NOT_FOUND (except "signup"
// without a profile).

import type { Request, RequestHandler } from "express";
import { crmErrorMessages } from "@starter/shared/crm";
import { db } from "../db/index.ts";
import {
  memberTenantContext,
  withMemberScope,
  type MemberScope,
} from "../db/member-scope.ts";
import { HttpError } from "../lib/http-error.ts";
import { findProfileByUser } from "../services/member-profile.service.ts";
import { getAuth } from "./auth.ts";
import { getTenantContext } from "./tenant.ts";

export type MemberAllow = "signup" | "pending";

const scopes = new WeakMap<Request, MemberScope>();

/** The member scope installed by `requireMember`. */
export function getMemberScope(req: Request): MemberScope {
  const scope = scopes.get(req);
  if (!scope) throw new Error("getMemberScope() used without requireMember");
  return scope;
}

/** Tenant-wide scope without a profile, for member routes with no profile need. */
export function memberAnonymousScope(req: Request): MemberScope {
  const tenantId = getTenantContext(req).tenantId;
  return {
    context: memberTenantContext(tenantId),
    tenantId,
    userId: getAuth(req).user.id,
    customerProfileId: null,
    status: null,
  };
}

export function requireMember(
  options: { allow?: MemberAllow } = {},
): RequestHandler {
  const { allow } = options;
  return async (req, _res, next) => {
    const base = memberAnonymousScope(req);
    const profile = await withMemberScope(db, base, (tx) =>
      findProfileByUser(tx, base.tenantId, base.userId),
    );
    if (!profile || profile.membershipStatus === "closed") {
      if (allow === "signup" && !profile) {
        scopes.set(req, base);
        return next();
      }
      throw new HttpError(
        404,
        "CUSTOMER_NOT_FOUND",
        crmErrorMessages.CUSTOMER_NOT_FOUND,
      );
    }
    const status = profile.membershipStatus;
    const allowed =
      status === "active" ||
      (allow === "pending" &&
        (status === "pending_verification" || status === "suspended")) ||
      allow === "signup";
    if (!allowed)
      throw new HttpError(
        403,
        "MEMBERSHIP_NOT_ACTIVE",
        crmErrorMessages.MEMBERSHIP_NOT_ACTIVE,
      );
    scopes.set(req, { ...base, customerProfileId: profile.id, status });
    next();
  };
}
