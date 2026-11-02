// Mock handlers for the sign-in screens: the identity fixtures from
// @starter/shared/identity make every /masuk page work with
// VITE_API_MOCK=true, before the real endpoints exist (docs/frontend.md
// "Mock mode", PRD §3 "Prinsip Pengembangan Paralel").
//
// The WhatsApp reverse OTP and the customer GET /api/auth/me live in
// lib/mock/handlers/customer-auth.ts and login-challenge.ts, shared with the
// facility gate so one route has one registered mock (bead legend-jzud). This
// file keeps the email link and Google round trip and imports those modules for
// their registrations.
//
// Scenario notes: `?mock=empty` on GET /api/auth/me answers 401 (signed out),
// which is the link-WhatsApp prompt's empty state; `?mock=error|offline` fail
// every call like the rest of the runtime; `failNext(...)` injects a specific
// API failure (e.g. CHALLENGE_BROWSER_MISMATCH, RATE_LIMITED) for the error
// states the contract defines.
import {
  completeMagicLink,
  MAGIC_LINK_TTL_MINUTES,
  MINUTE_MS,
  requestMagicLink,
  startGoogleLogin,
} from "@starter/shared/identity";
import "../../lib/mock/handlers/customer-auth.ts";
import "../../lib/mock/handlers/login-challenge.ts";
import {
  auth,
  newCustomerSession,
} from "../../lib/mock/handlers/customer-auth.ts";
import { registerMock } from "../../lib/mock/registry.ts";

// --------------------------------------------------------------- email link

registerMock(requestMagicLink, () => {
  const now = new Date();
  return {
    data: {
      sent: true as const,
      expiresAt: new Date(
        now.getTime() + MAGIC_LINK_TTL_MINUTES * MINUTE_MS,
      ).toISOString(),
    },
  };
});

registerMock(completeMagicLink, () => {
  auth.set("customer");
  return {
    data: {
      session: newCustomerSession(new Date()),
      mfaRequired: false,
      mfaEnrollmentRequired: false,
    },
  };
});

// -------------------------------------------------------------------- Google

registerMock(startGoogleLogin, () => {
  const state = crypto.randomUUID().replaceAll("-", "");
  return {
    data: {
      // Shaped like the provider's authorize URL; mock mode never opens it.
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?client_id=legend-mock&redirect_uri=${encodeURIComponent(
        "/api/auth/google/callback",
      )}&response_type=code&scope=openid%20email%20profile&state=${state}`,
    },
  };
});
