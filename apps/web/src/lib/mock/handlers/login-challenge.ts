// The WhatsApp reverse OTP mock (AUTH-01/AUTH-03): the guest "sends" the
// message by waiting, and the challenge completes on the second poll from this
// browser. One implementation serves both entry points — the /masuk screens
// (ws01-login) and the facility gate (facility) — imported by each feature so
// the browser and the Node suites register it exactly once (bead legend-jzud;
// previously both features registered it and glob order decided the winner).
import {
  cafeLegendIdentityFixtures as idFx,
  cancelLoginChallenge,
  confirmLoginChallenge,
  formatLoginCode,
  getLoginChallenge,
  loginChallengeExpiry,
  loginChallengeSchema,
  requestWhatsAppLoginChallenge,
  whatsAppLoginDeepLink,
  type LoginChallenge,
} from "@starter/shared/identity";
import { ApiError } from "../../api/errors.ts";
import { registerMock } from "../registry.ts";
import { createMockStore } from "../store.ts";
import { auth, newCustomerSession } from "./customer-auth.ts";
import { newIdempotencyKey } from "../../idempotency.ts";

type MockChallenge = {
  challenge: LoginChallenge;
  polls: number;
  /** AUTH-01 single use: the session is handed to this browser once. */
  claimed: boolean;
  /** Card kmndq: the person must tap "Ya, masuk" before a session exists. */
  requireConfirm: boolean;
  /** The person tapped "Ya, masuk"; the session may now be claimed. */
  confirmed: boolean;
};
const challenges = createMockStore<Map<string, MockChallenge>>(() => new Map());

function saveChallenge(entry: MockChallenge): void {
  challenges.set(new Map(challenges.get()).set(entry.challenge.id, entry));
}

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

/** The masked sender the API shows while a challenge awaits confirmation. */
const MOCK_SENDER_MASKED = "+62 812-****-7890";

registerMock(requestWhatsAppLoginChallenge, ({ body }) => {
  const createdAt = new Date();
  const challenge = loginChallengeSchema.parse({
    id: newIdempotencyKey(),
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
  saveChallenge({
    challenge,
    polls: 0,
    claimed: false,
    confirmed: false,
    requireConfirm: body.requireConfirm === true,
  });
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
    // With requireConfirm the message still completes the challenge (as the
    // API does) but no session exists until the person confirms.
    else if (polls >= POLLS_TO_COMPLETE)
      challenge = loginChallengeSchema.parse({
        ...challenge,
        status: "completed",
        completedAt: now.toISOString(),
        matchedUserId: idFx.usersByKey.sari.id,
      });
  }
  // AUTH-01: a completed challenge hands out its session exactly once; a
  // second poll from the same browser finds the code already spent. With
  // requireConfirm the session waits for the confirm tap.
  const session =
    challenge.status === "completed" &&
    !entry.claimed &&
    (!entry.requireConfirm || entry.confirmed)
      ? newCustomerSession(now)
      : null;
  saveChallenge({
    ...entry,
    challenge,
    polls,
    claimed: entry.claimed || session !== null,
  });
  if (session) auth.set("customer");
  // Real API shape while awaiting: status "completed", session null,
  // awaitingConfirmation true and the masked sender.
  const awaiting =
    entry.requireConfirm &&
    !entry.confirmed &&
    challenge.status === "completed";
  return {
    data: {
      challenge,
      session,
      mfaRequired: false,
      mfaEnrollmentRequired: false,
      ...(awaiting
        ? { senderMasked: MOCK_SENDER_MASKED, awaitingConfirmation: true }
        : {}),
    },
  };
});

registerMock(cancelLoginChallenge, ({ params }) => {
  const entry = challenges.get().get(params.challengeId);
  if (!entry) return;
  const { challenge } = entry;
  // Pending, or completed but still awaiting the confirm tap (no session yet).
  const awaiting =
    challenge.status === "completed" &&
    entry.requireConfirm &&
    !entry.confirmed;
  if (challenge.status !== "pending" && !awaiting) return;
  saveChallenge({
    ...entry,
    challenge: {
      ...entry.challenge,
      status: "cancelled",
      completedAt: null,
      matchedUserId: null,
    },
  });
});

registerMock(confirmLoginChallenge, ({ params }) => {
  const entry = challenges.get().get(params.challengeId);
  if (!entry)
    throw new ApiError(404, "NOT_FOUND", "Permintaan masuk tidak ditemukan.");
  const { challenge } = entry;
  // Only a completed challenge that asked for confirmation can be confirmed;
  // a pending one (message not landed yet) is refused.
  if (
    challenge.status !== "completed" ||
    !entry.requireConfirm
  )
    throw new ApiError(
      409,
      "CHALLENGE_NOT_PENDING",
      "Permintaan masuk ini sudah tidak aktif.",
    );
  // Idempotent: a second tap on an already confirmed challenge is a no-op.
  if (entry.confirmed) return;
  if (Date.now() >= Date.parse(challenge.expiresAt))
    throw new ApiError(410, "CHALLENGE_EXPIRED", "Kode sudah kedaluwarsa.");
  // The session is handed out on the NEXT poll, once (AUTH-01).
  saveChallenge({ ...entry, confirmed: true });
});
