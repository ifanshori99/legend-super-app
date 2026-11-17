// Legend identity routes under /api/auth (identity/endpoints.ts in the shared
// contract): second factors and the per-device session list.
//
// They share the prefix with Better Auth, so app.ts mounts this router BEFORE
// the Better Auth handler; every route here is explicit and authenticates with
// requireAuth. Tenant ids never appear in the path or body (TEN-02).
//
// The remaining identity endpoints (sign-in challenges, /api/auth/me, staff
// pins, approvals, roles) belong to sibling WS-01 beads and are not mounted
// here. Revoking a session ends it immediately for every route because Better
// Auth reads the same row on each request.

import { Router } from "express";
import {
  mfaEnrollSchema,
  mfaFactorParamsSchema,
  mfaRecoveryVerifySchema,
  mfaVerifySchema,
  sessionParamsSchema,
} from "@starter/shared/identity";
import { PlatformError } from "@starter/shared/platform";
import {
  getAuth,
  requireAuth,
  requireAuthAllowSharedDevice,
} from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  generateMfaRecoveryCodes,
  getMfaRecoveryStatus,
  verifyMfaRecoveryCode,
} from "../services/identity-mfa-recovery.service";
import {
  deleteMfaFactor,
  enrollMfaFactor,
  listMfaFactors,
  verifyMfaFactor,
} from "../services/identity-mfa.service";
import {
  finishPasskeyEnrollment,
  issuePasskeyChallenge,
  verifyPasskeyAssertion,
} from "../services/identity-passkey.service";
import { supportGrantedTenantIds } from "../services/platform-support.service";
import {
  extendCurrentSession,
  listOwnSessions,
  loadSessionRow,
  revokeOwnSession,
} from "../services/identity-session.service";

/** Product name shown in authenticator apps (PRD v1.7: Legend). */
const MFA_ISSUER = "Legend";

export const identityAuthRouter = Router();

/** When this session last verified a second factor, or null (AUTH-05 step-up). */
async function sessionMfaVerifiedAt(sessionId: string): Promise<Date | null> {
  const row = await loadSessionRow(sessionId);
  return row?.mfaVerifiedAt ?? null;
}

/** True once this session verified a second factor (AUTH-05 step-up). */
async function sessionMfaVerified(sessionId: string): Promise<boolean> {
  const row = await loadSessionRow(sessionId);
  return row !== null && row.mfaVerifiedAt !== null;
}

identityAuthRouter.get("/mfa/factors", requireAuth, async (req, res) => {
  res.json({ data: await listMfaFactors(getAuth(req).user.id) });
});

identityAuthRouter.post(
  "/mfa/factors",
  requireAuth,
  requireTrustedOrigin,
  jsonBody,
  async (req, res) => {
    const input = mfaEnrollSchema.parse(req.body);
    const auth = getAuth(req);
    const enrollment = await enrollMfaFactor({
      userId: auth.user.id,
      accountName: auth.user.email,
      type: input.type,
      issuer: MFA_ISSUER,
      sessionMfaVerifiedAt: await sessionMfaVerifiedAt(auth.session.id),
      sessionId: auth.session.id,
    });
    res.status(201).json({ data: enrollment });
  },
);

identityAuthRouter.post(
  "/mfa/verify",
  requireAuth,
  requireTrustedOrigin,
  jsonBody,
  async (req, res) => {
    const input = mfaVerifySchema.parse(req.body);
    const auth = getAuth(req);
    const base = {
      userId: auth.user.id,
      sessionId: auth.session.id,
      factorId: input.factorId,
    };
    // Exactly one of code | assertion | attestation (the schema guarantees it).
    const result =
      "assertion" in input
        ? await verifyPasskeyAssertion({ ...base, assertion: input.assertion })
        : "attestation" in input
          ? await finishPasskeyEnrollment({
              ...base,
              attestation: input.attestation,
            })
          : await verifyMfaFactor({ ...base, code: input.code });
    res.json({ data: result });
  },
);

// Passkey sign-in step 1: authentication options with a single-use challenge
// bound to this session. Step 2 is POST /mfa/verify with { factorId, assertion }.
identityAuthRouter.post(
  "/mfa/factors/:factorId/challenge",
  requireAuth,
  requireTrustedOrigin,
  async (req, res) => {
    const { factorId } = mfaFactorParamsSchema.parse(req.params);
    const auth = getAuth(req);
    const challenge = await issuePasskeyChallenge({
      userId: auth.user.id,
      sessionId: auth.session.id,
      factorId,
    });
    res.json({ data: challenge });
  },
);

identityAuthRouter.delete(
  "/mfa/factors/:factorId",
  requireAuth,
  requireTrustedOrigin,
  async (req, res) => {
    const { factorId } = mfaFactorParamsSchema.parse(req.params);
    const auth = getAuth(req);
    await deleteMfaFactor({
      userId: auth.user.id,
      factorId,
      sessionMfaVerified: await sessionMfaVerified(auth.session.id),
      sessionId: auth.session.id,
    });
    res.status(204).end();
  },
);

identityAuthRouter.get("/mfa/recovery-codes", requireAuth, async (req, res) => {
  res.json({
    data: await getMfaRecoveryStatus({ userId: getAuth(req).user.id }),
  });
});

identityAuthRouter.post(
  "/mfa/recovery-codes",
  requireAuth,
  requireTrustedOrigin,
  // No body (the contract defines none), like /sessions/current/activity.
  async (req, res) => {
    const auth = getAuth(req);
    const codes = await generateMfaRecoveryCodes({
      userId: auth.user.id,
      sessionId: auth.session.id,
      sessionMfaVerified: await sessionMfaVerified(auth.session.id),
    });
    res.status(201).json({ data: codes });
  },
);

identityAuthRouter.post(
  "/mfa/recovery",
  requireAuth,
  requireTrustedOrigin,
  jsonBody,
  async (req, res) => {
    const input = mfaRecoveryVerifySchema.parse(req.body);
    const auth = getAuth(req);
    const result = await verifyMfaRecoveryCode({
      userId: auth.user.id,
      sessionId: auth.session.id,
      code: input.code,
    });
    res.json({ data: result });
  },
);

identityAuthRouter.post(
  "/sessions/current/activity",
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  async (req, res) => {
    const auth = getAuth(req);
    await extendCurrentSession({
      sessionId: auth.session.id,
      userId: auth.user.id,
    });
    res.status(204).end();
  },
);

identityAuthRouter.get("/sessions", requireAuth, async (req, res) => {
  const auth = getAuth(req);
  // legend-xqkr7: a support (impersonated) session lists only sessions of
  // tenants where its super admin holds a live grant.
  const impersonatedBy = (
    auth.session as { impersonatedBy?: string | null } | undefined
  )?.impersonatedBy;
  res.json({
    data: await listOwnSessions({
      userId: auth.user.id,
      currentSessionId: auth.session.id,
      ...(impersonatedBy
        ? {
            onlyTenantIds: await supportGrantedTenantIds({
              adminUserId: impersonatedBy,
              targetUserId: auth.user.id,
            }),
          }
        : {}),
    }),
  });
});

identityAuthRouter.delete(
  "/sessions/:sessionId",
  requireAuth,
  requireTrustedOrigin,
  async (req, res) => {
    // legend-xqkr7: a support (impersonated) session is read-only here and
    // must not end other sessions of the user it impersonates.
    const auth = getAuth(req);
    if ((auth.session as { impersonatedBy?: string | null }).impersonatedBy)
      throw new PlatformError("SUPPORT_ACCESS_READ_ONLY");
    const { sessionId } = sessionParamsSchema.parse(req.params);
    await revokeOwnSession({ userId: auth.user.id, sessionId });
    res.status(204).end();
  },
);
