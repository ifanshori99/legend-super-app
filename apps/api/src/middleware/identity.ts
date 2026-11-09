// AUTH-05 step-up middleware (PRD v1.7 §3 F6/F7). Mount after requireAuth.
//
// - requireIdentitySurface: back office / dashboard / MCP APIs. Checks the
//   session (revoked, expired, idle) and the second factor through the RBAC
//   engine port. Without a wired resolver it denies (fail closed), so the
//   integrator passes `resolveAccessFacts` when mounting the surface.
// - requireSessionMfa: the platform panel (Super Admin is MFA-required, §3 F4).
//   Needs a second factor verified in this session; no RBAC assignment exists
//   for platform roles (§6 B role_assignments are tenant rows), so the factor
//   check is the gate itself.
//
// Both use the same session policy: a guarded surface makes the session
// management, so it ends after 30 idle minutes (§3 F6 "Sesi & Perangkat").

import type { RequestHandler } from "express";
import {
  AccessError,
  userRequiresMfa,
  type AppSurface,
} from "@starter/shared/access";
import { getAuth } from "./auth";
import { HttpError } from "../lib/http-error";
import {
  assertSurfaceFacts,
  denySurfaceAccessFacts,
  hasActiveAssignment,
  type SurfaceAccessFactsResolver,
} from "../services/identity-access.service";
import {
  loadSessionRow,
  sessionPolicy,
  touchSession,
} from "../services/identity-session.service";

type Clock = () => Date;

function unauthorized(): HttpError {
  return new HttpError(401, "UNAUTHORIZED", "Sesi berakhir. Masuk lagi.");
}

export function requireIdentitySurface(
  surface: AppSurface,
  options: {
    readonly resolveAccessFacts?: SurfaceAccessFactsResolver;
    readonly now?: Clock;
  } = {},
): RequestHandler {
  const resolveFacts = options.resolveAccessFacts ?? denySurfaceAccessFacts;
  const clock = options.now ?? (() => new Date());
  return async (req, _res, next) => {
    const auth = getAuth(req);
    const now = clock();
    const row = await loadSessionRow(auth.session.id);
    if (!row) throw unauthorized();

    const facts = await resolveFacts({
      userId: auth.user.id,
      tenantId: row.tenantId,
      now,
    });
    // legend-k2l (design ws08 M2 "Sign-in method gate"): only a password
    // session may be management. A WhatsApp, magic-link or Google session
    // (or a pre-k2l `legacy` one) with a staff role stays a customer session,
    // so a stolen phone number or mailbox never opens the back office.
    const management =
      row.authMethod === "password" &&
      (row.kind === "management" ||
        (facts !== null && hasActiveAssignment(facts, now)));
    const mfaRequired =
      facts !== null && userRequiresMfa(facts.principal, facts.roles, now);
    const policy = sessionPolicy({ row, management, mfaRequired, now });
    if (policy.gate === "revoked" || policy.gate === "expired")
      throw unauthorized();
    // No role resolver, no guarded surface (deny by default).
    if (facts === null) throw new AccessError("PERMISSION_DENIED");
    if (policy.gate === "mfa_required") throw new AccessError("MFA_REQUIRED");

    assertSurfaceFacts({
      facts,
      surface,
      mfaVerified: row.mfaVerifiedAt !== null,
      now,
    });
    await touchSession({ row, management, now });
    next();
  };
}

export function requireSessionMfa(
  options: { readonly now?: Clock } = {},
): RequestHandler {
  const clock = options.now ?? (() => new Date());
  return async (req, _res, next) => {
    const auth = getAuth(req);
    const now = clock();
    const row = await loadSessionRow(auth.session.id);
    if (!row) throw unauthorized();
    // legend-k2l (ws08 M2 sign-in method gate): only a password sign-in can
    // reach a platform surface. An email inbox, a Google account or a WhatsApp
    // code plus a second factor must never stand in for the staff password.
    if (row.authMethod !== "password") throw new AccessError("PERMISSION_DENIED");
    // A platform session is management by definition (§3 F6 30-minute idle).
    const policy = sessionPolicy({
      row,
      management: true,
      mfaRequired: true,
      now,
    });
    if (policy.gate === "revoked" || policy.gate === "expired")
      throw unauthorized();
    if (row.mfaVerifiedAt === null) throw new AccessError("MFA_REQUIRED");
    await touchSession({ row, management: true, now });
    next();
  };
}
