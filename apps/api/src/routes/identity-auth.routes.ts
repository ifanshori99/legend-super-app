// WhatsApp reverse-OTP sign-in routes (PRD v1.7 §3 F6, flow §4 C; AUTH-01).
//
// These live under `/api/auth/*` because that is where the identity contract
// puts them (`@starter/shared/identity` endpoints), but they are NOT Better Auth
// endpoints: they need the Legend tenant context (the tenant's own WhatsApp
// number), the Legend error envelope and the same `{ data }` shapes the typed
// web client parses. app.ts mounts this router before Better Auth's catch-all.
//
// Public on purpose — a guest asking for a code has no session yet. What
// protects the flow is the challenge itself: 40 bits of code, five minutes,
// single use, and a browser-binding cookie only the asking browser holds
// (AUTH-01). Cross-site calls are refused by requireTrustedOrigin, and the
// AUTH-04 limits are enforced in the service.

import { Router } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.ts";
import { PlatformError } from "@starter/shared/platform";
import {
  createMagicLinkChallengeSchema,
  createWhatsAppLoginChallengeSchema,
  LOGIN_CODE_TTL_MINUTES,
  loginChallengeParamsSchema,
  magicLinkVerifyBodySchema,
  MAGIC_LINK_TTL_MINUTES,
} from "@starter/shared/identity";
import { env } from "../config/env";
import { whatsAppWebhookSecretsOf } from "../lib/whatsapp-webhook-secrets";
import { jsonBody } from "../middleware/body";
import { noStore } from "../middleware/no-store";
import { requireTrustedOrigin } from "../middleware/origin";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { setCustomerSessionCookie } from "../lib/identity-session";
import {
  ensureBindingNonce,
  readBindingNonce,
  setBindingCookie,
} from "../lib/login-binding";
import {
  requestEmailMagicLink,
  verifyEmailMagicLink,
} from "../services/identity-email-login.service";
import {
  cancelWhatsAppChallenge,
  confirmWhatsAppChallenge,
  issueWhatsAppChallenge,
  pollWhatsAppChallenge,
} from "../services/identity-login.service";

/** Mounted at /api/auth/login-challenges. */
export const loginChallengeRouter = Router();

// Responses carry the login code and the session: never cacheable.
loginChallengeRouter.use(noStore, requireTrustedOrigin);

// The binding cookie outlives the code by a minute so a slow round trip still
// collects its session; the challenge itself still expires after five.
const BINDING_COOKIE_SECONDS = (LOGIN_CODE_TTL_MINUTES + 1) * 60;
// legend-k2l: the email link lives longer than a WhatsApp code, and the cookie
// must still be there when the same browser clicks it (same-device detection).
const EMAIL_BINDING_COOKIE_SECONDS = (MAGIC_LINK_TTL_MINUTES + 1) * 60;

/**
 * legend-k2l: where the emailed link points. The requesting page's own origin
 * when it is a trusted one (a tenant on its own domain gets its own page),
 * otherwise WEB_URL. The Origin header is only ever used as a pick from
 * `env.trustedOrigins`, never echoed as-is.
 */
function emailLinkOrigin(origin: string | undefined): string {
  if (origin && env.trustedOrigins.includes(origin)) return origin;
  return new URL(env.WEB_URL).origin;
}

/**
 * Mobile deep link / desktop QR: issues the code and binds it to this browser.
 * `returnTo` stays in the browser — the challenge DTO is strict and has no
 * field for it.
 */
loginChallengeRouter.post(
  "/whatsapp",
  requireTenantContext,
  jsonBody,
  async (req, res) => {
    // The contract's body is `{ returnTo? }` and nothing else: returnTo stays
    // in the browser and is never stored server-side.
    createWhatsAppLoginChallengeSchema.parse(req.body);
    const signedIn = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
      query: { disableCookieCache: true },
    });
    // Belt and braces behind guardImpersonatedAuthRoutes: a support session
    // must never link a WhatsApp number to the user it impersonates.
    if (signedIn?.session.impersonatedBy)
      throw new PlatformError("SUPPORT_ACCESS_READ_ONLY");
    const nonce = ensureBindingNonce(req);
    const issued = await issueWhatsAppChallenge(
      getTenantContext(req),
      {
        bindingNonce: nonce,
        link: signedIn
          ? { userId: signedIn.user.id, sessionId: signedIn.session.id }
          : null,
        // Always required (legend-lnbtp): the client value is ignored so a
        // caller cannot skip the masked-number confirmation.
        requireConfirm: true,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      },
      // createApp's test override, else KIRIM_WEBHOOK_SECRET (legend-lgfru).
      { webhookSecrets: whatsAppWebhookSecretsOf(req) },
    );
    setBindingCookie(res, nonce, BINDING_COOKIE_SECONDS);
    res.status(201).json({ data: issued });
  },
);

/** The asking browser polls; the session appears once the message lands. */
loginChallengeRouter.get("/:challengeId", async (req, res) => {
  const { challengeId } = loginChallengeParamsSchema.parse(req.params);
  const signedIn = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
    query: { disableCookieCache: true },
  });
  const polled = await pollWhatsAppChallenge(challengeId, {
    link: signedIn
      ? { userId: signedIn.user.id, sessionId: signedIn.session.id }
      : null,
    bindingNonce: readBindingNonce(req),
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  });
  if (polled.session) {
    // The polling browser is the one that gets the session cookie, and only
    // once: the challenge claimed it above (AUTH-01).
    setCustomerSessionCookie(res, polled.session);
  }
  res.json({ data: polled.view });
});

/** Card w8dfz.1: the same browser confirms the masked number it was shown. */
loginChallengeRouter.post("/:challengeId/confirm", async (req, res) => {
  const { challengeId } = loginChallengeParamsSchema.parse(req.params);
  await confirmWhatsAppChallenge(challengeId, readBindingNonce(req));
  res.status(204).end();
});

/** "Bukan saya": cancel from the same browser. */
loginChallengeRouter.post("/:challengeId/cancel", async (req, res) => {
  const { challengeId } = loginChallengeParamsSchema.parse(req.params);
  await cancelWhatsAppChallenge(challengeId, readBindingNonce(req));
  res.status(204).end();
});

/**
 * legend-k2l: asks for a sign-in link by email. The answer is the same for a
 * known and an unknown address. `returnTo` stays in the browser (the link page
 * restores it), like the WhatsApp route.
 */
loginChallengeRouter.post(
  "/email",
  requireTenantContext,
  jsonBody,
  async (req, res) => {
    const body = createMagicLinkChallengeSchema.parse(req.body);
    const nonce = ensureBindingNonce(req);
    const requested = await requestEmailMagicLink(getTenantContext(req), {
      email: body.email,
      bindingNonce: nonce,
      linkOrigin: emailLinkOrigin(req.get("origin")),
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    setBindingCookie(res, nonce, EMAIL_BINDING_COOKIE_SECONDS);
    res.status(201).json({ data: requested });
  },
);

/**
 * legend-k2l: the link page posts the token from its URL fragment. The session
 * cookie is set in the browser that opened the link, which need not be the
 * one that asked (`crossDevice` says so).
 */
loginChallengeRouter.post(
  "/email/verify",
  requireTenantContext,
  jsonBody,
  async (req, res) => {
    const { token } = magicLinkVerifyBodySchema.parse(req.body);
    const verified = await verifyEmailMagicLink(getTenantContext(req), {
      token,
      bindingNonce: readBindingNonce(req),
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    setCustomerSessionCookie(res, verified.session);
    res.status(200).json({ data: verified.view });
  },
);
