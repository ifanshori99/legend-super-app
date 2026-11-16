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
// - requireTenantStepUpMfa: a tenant action that moves money (payroll payout).
//   Needs a second factor verified recently in this session (re-verifying a
//   code or passkey refreshes `mfa_verified_at`). No password-only sign-in
//   rule and no platform session policy: a tenant approver may sign in by any
//   method, but must hold a factor.
//
// - requireTenantStepUpPassword: payout confirm, resolve and cash handover. Mount
//   AFTER jsonBody and requireTenantStepUpMfa. When `mfa_verified_at` may only
//   come from the first MFA enrollment (no code or passkey was ever checked in
//   this session), the body's `password` must be the account password. After
//   success it records the step-up of this request (`payoutStepUpOf`), the
//   precondition of a payout grant (legend-911).
//
// The first two use the same session policy: a guarded surface makes the session
// management, so it ends after 30 idle minutes (§3 F6 "Sesi & Perangkat").

import type { Request, RequestHandler } from "express";
import {
  AccessError,
  userRequiresMfa,
  type AppSurface,
} from "@starter/shared/access";
import { getAuth } from "./auth";
import { HttpError } from "../lib/http-error";
import {
  assertPayoutReauth,
  type PayoutReauthMethod,
} from "../services/payroll-payout-evidence";
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

/**
 * Proof that this request passed the payout step-up (legend-911). Kept in
 * process memory per request object, never on `req` itself and never in a
 * header or body, so nothing a client sends can fake it. Read through
 * `payoutStepUpOf`; the payout grant issuer refuses without it.
 */
export type PayoutStepUp = {
  readonly userId: string;
  readonly sessionId: string;
  readonly method: PayoutReauthMethod;
  readonly at: Date;
};
const payoutStepUps = new WeakMap<Request, PayoutStepUp>();

export function payoutStepUpOf(req: Request): PayoutStepUp | undefined {
  return payoutStepUps.get(req);
}

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
    if (row.authMethod !== "password")
      throw new AccessError("PERMISSION_DENIED");
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

/**
 * Step-up for tenant money actions (payroll payout config, approve, export,
 * confirm). No verified second factor is MFA_REQUIRED (403); a stamp older
 * than `maxAgeMinutes` or one in the future is REAUTH_REQUIRED (401). A
 * revoked or expired session never counts, even with a fresh stamp.
 */
export function requireTenantStepUpMfa(
  options: {
    readonly maxAgeMinutes?: number;
    readonly now?: Clock;
  } = {},
): RequestHandler {
  const maxAgeMs = (options.maxAgeMinutes ?? 15) * 60_000;
  const clock = options.now ?? (() => new Date());
  return async (req, _res, next) => {
    const auth = getAuth(req);
    const now = clock();
    const row = await loadSessionRow(auth.session.id);
    if (!row) throw unauthorized();
    const policy = sessionPolicy({
      row,
      management: false,
      mfaRequired: false,
      now,
    });
    if (policy.gate === "revoked" || policy.gate === "expired")
      throw unauthorized();
    if (row.mfaVerifiedAt === null) throw new AccessError("MFA_REQUIRED");
    const age = now.getTime() - row.mfaVerifiedAt.getTime();
    if (!(age >= 0 && age <= maxAgeMs))
      throw new AccessError("REAUTH_REQUIRED");
    next();
  };
}

/**
 * Password step-up for a payout money action (legend-658, L5). Reads
 * `req.body.password`, so mount it after `jsonBody`. A session that passed a
 * real second-factor challenge goes through without a password; one whose MFA
 * stamp comes from enrollment alone needs it (401 REAUTH_REQUIRED when absent,
 * 403 REAUTH_PASSWORD_INVALID when wrong). The route schema, not this
 * middleware, validates the rest of the body. `passwordOnly` never takes the
 * challenge shortcut: the password is always checked (legend-l2zru disown).
 */
export function requireTenantStepUpPassword(
  options: { readonly now?: Clock; readonly passwordOnly?: boolean } = {},
): RequestHandler {
  const clock = options.now ?? (() => new Date());
  return async (req, _res, next) => {
    const auth = getAuth(req);
    const body: unknown = req.body;
    const password =
      body !== null && typeof body === "object"
        ? (body as { password?: unknown }).password
        : undefined;
    const now = clock();
    const method = await assertPayoutReauth({
      userId: auth.user.id,
      sessionId: auth.session.id,
      password: typeof password === "string" ? password : undefined,
      now,
      passwordOnly: options.passwordOnly,
    });
    payoutStepUps.set(req, {
      userId: auth.user.id,
      sessionId: auth.session.id,
      method,
      at: now,
    });
    next();
  };
}
