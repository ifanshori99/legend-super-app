// Who may decide a read_write support access request (legend-8r77t): the
// tenant Owner only, with a verified second factor, never from an impersonated
// (support) session. Pure so the root node:test suite can load it. The API
// decides again (403 IMPERSONATION_NOT_ALLOWED / MFA_REQUIRED).

export const SUPPORT_DECISION_PERMISSION = "org.support_access.approve";

export type DecisionBlockReason =
  "impersonating" | "mfa_required" | "not_owner";

export type SupportDecisionGuard = {
  canDecide: boolean;
  reason: DecisionBlockReason | null;
};

type AccessLike = {
  readonly authenticated: boolean;
  readonly permissions: readonly string[];
  readonly mfaRequired: boolean;
  readonly mfaVerified: boolean;
  readonly supportSession?: object | null;
};

/** Fails closed: no access means not an owner. Impersonation wins over the rest. */
export function evaluateSupportDecisionGuard(
  access: AccessLike | null | undefined,
  impersonatedBy?: string | null,
): SupportDecisionGuard {
  if (!access || !access.authenticated)
    return { canDecide: false, reason: "not_owner" };
  if (impersonatedBy || access.supportSession)
    return { canDecide: false, reason: "impersonating" };
  if (!access.permissions.includes(SUPPORT_DECISION_PERMISSION))
    return { canDecide: false, reason: "not_owner" };
  if (!access.mfaVerified) return { canDecide: false, reason: "mfa_required" };
  return { canDecide: true, reason: null };
}
