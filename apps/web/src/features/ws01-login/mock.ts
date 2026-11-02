// Mock handlers for the sign-in screens: the identity fixtures from
// @starter/shared/identity make every /masuk page work with
// VITE_API_MOCK=true, before the real endpoints exist (docs/frontend.md
// "Mock mode", PRD §3 "Prinsip Pengembangan Paralel").
//
// The mock plays the KirimDev webhook for the WhatsApp reverse OTP: the guest
// "sends" the message by waiting, and the challenge completes on the second
// poll from this browser (AUTH-01, AUTH-03 — no reply is sent). It also plays
// the email link and the Google round trip. The facility journey registers the
// same two login endpoints for its own gate; this file loads after it
// (features/facility < features/ws01-login), so these handlers win.
//
// Scenario notes: `?mock=empty` on GET /api/auth/me answers 401 (signed out),
// which is the link-WhatsApp prompt's empty state; `?mock=error|offline` fail
// every call like the rest of the runtime; `failNext(...)` injects a specific
// API failure (e.g. CHALLENGE_BROWSER_MISMATCH, RATE_LIMITED) for the error
// states the contract defines.
import {
  cafeLegendIdentityFixtures as idFx,
  cancelLoginChallenge,
  completeMagicLink,
  CUSTOMER_SESSION_DAYS,
  currentAuthViewSchema,
  DAY_MS,
  formatLoginCode,
  getCurrentAuth,
  getLoginChallenge,
  loginChallengeExpiry,
  loginChallengeSchema,
  MAGIC_LINK_TTL_MINUTES,
  MINUTE_MS,
  requestMagicLink,
  requestWhatsAppLoginChallenge,
  sessionSchema,
  startGoogleLogin,
  whatsAppLoginDeepLink,
  type CurrentAuthView,
  type LoginChallenge,
  type Session,
} from "@starter/shared/identity";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";

/** The identity customer (Sari): a verified WhatsApp number. */
const customerUser = idFx.usersByKey.sari;
const customerSession = idFx.sessions.find(
  (session) => session.kind === "customer",
);

if (!customerSession)
  throw new Error("Identity fixtures must include one customer session.");

type MockChallenge = {
  challenge: LoginChallenge;
  polls: number;
  /** AUTH-01 single use: the session is handed to this browser once. */
  claimed: boolean;
};
const challenges = createMockStore<Map<string, MockChallenge>>(() => new Map());

/** Which account the mock browser is signed in as; "fixture" = the fixture view. */
type MockAuth = "fixture" | "customer";
const auth = createMockStore<MockAuth>(() => "fixture");

function saveChallenge(entry: MockChallenge): void {
  challenges.set(new Map(challenges.get()).set(entry.challenge.id, entry));
}

/** A fresh session for the customer who just signed in (90 days, §3 F3). */
function newCustomerSession(at: Date): Session {
  return sessionSchema.parse({
    id: crypto.randomUUID(),
    userId: customerUser.id,
    tenantId: idFx.tenantId,
    kind: "customer",
    deviceLabel: "Browser ini",
    createdAt: at.toISOString(),
    lastSeenAt: at.toISOString(),
    expiresAt: new Date(
      at.getTime() + CUSTOMER_SESSION_DAYS * DAY_MS,
    ).toISOString(),
    revokedAt: null,
    mfaVerifiedAt: null,
  });
}

function customerAuthView(session: Session): CurrentAuthView {
  return currentAuthViewSchema.parse({
    user: customerUser,
    identities: idFx.identities.filter(
      (identity) => identity.userId === customerUser.id,
    ),
    mfaFactors: [],
    session,
    mfaRequired: false,
    mfaEnrollmentRequired: false,
    whatsAppVerified: true,
  });
}

// ------------------------------------------------------------ WhatsApp code

/** The wa.me link the guest taps (or scans on a desktop). */
function demoDeepLink(): string {
  return whatsAppLoginDeepLink({
    numberDigits: idFx.login.number,
    code: idFx.login.demoCode,
    keyword: idFx.login.keyword,
  });
}

/** How many polls the mock browser makes before the "message" lands. */
const POLLS_TO_COMPLETE = 2;

registerMock(requestWhatsAppLoginChallenge, () => {
  const createdAt = new Date();
  const challenge = loginChallengeSchema.parse({
    id: crypto.randomUUID(),
    tenantId: idFx.tenantId,
    brandId: idFx.brandId,
    channel: "whatsapp_inbound",
    status: "pending",
    expiresAt: loginChallengeExpiry(
      "whatsapp_inbound",
      createdAt,
    ).toISOString(),
    completedAt: null,
    matchedUserId: null,
    createdAt: createdAt.toISOString(),
  });
  saveChallenge({ challenge, polls: 0, claimed: false });
  return {
    data: {
      challenge,
      // The fixture's example code (PRD §3 F3: "MASUK LEGEND K7Q4-M2XD").
      code: idFx.login.demoCode,
      codeFormatted: formatLoginCode(idFx.login.demoCode),
      whatsAppDeepLink: demoDeepLink(),
    },
  };
});

registerMock(getLoginChallenge, ({ params }) => {
  const entry = challenges.get().get(params.challengeId);
  if (!entry)
    throw new ApiError(404, "NOT_FOUND", "Permintaan masuk tidak ditemukan.");
  const now = new Date();
  let { challenge } = entry;
  const polls = entry.polls + 1;
  if (challenge.status === "pending") {
    if (now.getTime() >= Date.parse(challenge.expiresAt))
      challenge = { ...challenge, status: "expired" };
    else if (polls >= POLLS_TO_COMPLETE)
      challenge = loginChallengeSchema.parse({
        ...challenge,
        status: "completed",
        completedAt: now.toISOString(),
        matchedUserId: customerUser.id,
      });
  }
  // AUTH-01: a completed challenge hands out its session exactly once; a
  // second poll from the same browser finds the code already spent.
  const session =
    challenge.status === "completed" && !entry.claimed
      ? newCustomerSession(now)
      : null;
  saveChallenge({
    challenge,
    polls,
    claimed: entry.claimed || session !== null,
  });
  if (session) auth.set("customer");
  return {
    data: {
      challenge,
      session,
      mfaRequired: false,
      mfaEnrollmentRequired: false,
    },
  };
});

registerMock(cancelLoginChallenge, ({ params }) => {
  const entry = challenges.get().get(params.challengeId);
  if (!entry || entry.challenge.status !== "pending") return;
  saveChallenge({
    ...entry,
    challenge: { ...entry.challenge, status: "cancelled" },
  });
});

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

// ------------------------------------------------------------- identity view

registerMock(getCurrentAuth, ({ scenario }) => {
  // `empty`: no session in this browser — the link prompt's signed-out state.
  if (scenario === "empty")
    throw new ApiError(401, "UNAUTHORIZED", "Belum masuk.");
  if (auth.get() === "customer")
    return { data: customerAuthView(newCustomerSession(new Date())) };
  return { data: idFx.currentAuth };
});
