// MFA verification for Super Admin support sessions (PRD §3 F4: Super Admin is
// MFA-only; TEN-04 requires a re-verified second factor before a support
// session opens).
//
// The stored TOTP/passkey factors (`mfa_factors`, PRD §6 B) belong to the WS-01
// identity bead, which has not landed yet. Until it does there is no verifier,
// so this fails closed: a support session cannot be opened and no tenant
// personal/financial data is reachable through the platform panel. Replace the
// body with a real TOTP check and return the verified instant — never a
// constant.

import type { Request } from "express";

/** When the second factor was verified in this request, or null. */
export async function verifiedMfaAt(req: Request): Promise<string | null> {
  // The request carries the TOTP code today; there is no factor to check it
  // against yet. Keep the parameter so the real verifier is a body change.
  void req;
  return null;
}
