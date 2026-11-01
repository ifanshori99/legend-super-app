// MFA verification for Super Admin support sessions (PRD §3 F4: Super Admin is
// MFA-only; TEN-04 requires a re-verified second factor before a support
// session opens).
//
// The request carries the six-digit TOTP code in `mfaCode`
// (platform/support-access.ts requestSupportAccessInputSchema). It is checked
// against the caller's first verified factor (identity-mfa.service), which also
// marks this session as MFA-verified (AUTH-05). No factor or a wrong code
// answers null, so the support session stays closed.

import type { Request } from "express";
import { verifyMfaCodeForUser } from "../services/identity-mfa.service";

/** When the second factor was verified in this request, or null. */
export async function verifiedMfaAt(req: Request): Promise<string | null> {
  const body: unknown = req.body;
  if (body === null || typeof body !== "object") return null;
  const code = (body as { mfaCode?: unknown }).mfaCode;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const auth = req.auth;
  if (!auth) return null;
  const result = await verifyMfaCodeForUser({
    userId: auth.user.id,
    sessionId: auth.session.id,
    code,
  });
  return result?.verifiedAt ?? null;
}
