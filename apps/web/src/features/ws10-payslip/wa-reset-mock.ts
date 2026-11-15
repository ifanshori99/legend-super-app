// Mock handlers for resetting the payslip PIN with a WhatsApp message sent to
// the service (`VITE_API_MOCK=true`). Picked up by the `*-mock.ts` glob in
// lib/mock/transport.ts, so no other file registers them.
//
// Scenario: `?waScenario=` of the page URL, else
// `localStorage['legend.mock.waScenario']`, else `verify`.
//   verify            default; the message "lands" on the second status poll
//   pending           the message never lands
//   expire            the code lives a few seconds, then reads `expired`
//   no-wa             409, no verified WhatsApp number (marker identity_missing)
//   needs-update      409, verified number cannot be used (marker identity_needs_update)
//   too-new           409, number linked under 3 days (marker identity_too_new)
//   unavailable-plain 409 without a marker (the API does not tell the two apart)
//   rate-limited      429 on start, no wait given ("Coba lagi nanti")
//   rate-limited-wait 429 on start with retryAfterSeconds (countdown)
//   unavailable       503 on start
//   proof-invalid     verifies fine, then the PIN save answers 403
import { ApiError } from "../../lib/api/errors.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { payslipMockStore } from "./mock.ts";
import {
  cancelMyPayslipPinResetWa,
  getMyPayslipPinResetWa,
  startMyPayslipPinResetWa,
  submitMyPayslipPinResetWaPin,
} from "./wa-reset-api.ts";
import type { WaResetStatus } from "./wa-reset-api.ts";

export const WA_RESET_SCENARIOS = [
  "verify",
  "pending",
  "expire",
  "no-wa",
  "needs-update",
  "too-new",
  "unavailable-plain",
  "rate-limited",
  "rate-limited-wait",
  "unavailable",
  "proof-invalid",
] as const;
export type WaResetScenario = (typeof WA_RESET_SCENARIOS)[number];

export const WA_RESET_SCENARIO_STORAGE_KEY = "legend.mock.waScenario";

const CODE = "K7Q4-M2XD";
/** Illustrative service number from the mockup; the real one comes from the API. */
const SERVICE_NUMBER = "6281200004250";
const SENDER_HINT = "4821";
const TTL_MS = 5 * 60_000;
const EXPIRE_TTL_MS = 4_000;
const GRANT_MS = 10 * 60_000;
/** Polls before the mock message lands (same as the login mock). */
const POLLS_TO_VERIFY = 2;

type MockChallenge = {
  scenario: WaResetScenario;
  expiresAt: string;
  polls: number;
  status: WaResetStatus;
  verifiedAt: number | null;
  /** The PIN save already done, by idempotency key. */
  saved: Record<string, string>;
};

const challenges = createMockStore<Map<string, MockChallenge>>(() => new Map());

function save(id: string, entry: MockChallenge) {
  challenges.set(new Map(challenges.get()).set(id, entry));
}

function isScenario(value: string | null): value is WaResetScenario {
  return (
    value !== null && (WA_RESET_SCENARIOS as readonly string[]).includes(value)
  );
}

type BrowserScope = {
  window?: { location?: { search?: string } };
  localStorage?: { getItem(key: string): string | null };
};

/** The scenario to play, read at call time so a test can switch it. */
export function currentWaScenario(): WaResetScenario {
  const scope = globalThis as unknown as BrowserScope;
  const fromUrl = new URLSearchParams(scope.window?.location?.search ?? "").get(
    "waScenario",
  );
  if (isScenario(fromUrl)) return fromUrl;
  let stored: string | null = null;
  try {
    stored = scope.localStorage?.getItem(WA_RESET_SCENARIO_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  return isScenario(stored) ? stored : "verify";
}

const UNAVAILABLE_MESSAGE =
  "Nomor WhatsApp belum bisa dipakai untuk mengatur ulang PIN. Hubungi HR atau atasan di outlet.";

/** Wait the `rate-limited-wait` scenario reports (mm:ss on screen). */
export const RATE_LIMIT_WAIT_SECONDS = 754;

function unavailable(
  marker?: "identity_missing" | "identity_too_new" | "identity_needs_update",
) {
  return new ApiError(
    409,
    "PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE",
    UNAVAILABLE_MESSAGE,
    marker ? [{ field: "whatsapp", message: marker }] : undefined,
  );
}

const notFound = () =>
  new ApiError(404, "NOT_FOUND", "Permintaan atur ulang PIN tidak ditemukan.");

const proofInvalid = () =>
  new ApiError(
    403,
    "PAYSLIP_PIN_RESET_PROOF_INVALID",
    "Bukti WhatsApp tidak valid. Mulai lagi dari awal.",
  );

registerMock(startMyPayslipPinResetWa, () => {
  const scenario = currentWaScenario();
  if (scenario === "no-wa") throw unavailable("identity_missing");
  if (scenario === "needs-update") throw unavailable("identity_needs_update");
  if (scenario === "too-new") throw unavailable("identity_too_new");
  if (scenario === "unavailable-plain") throw unavailable();
  if (scenario === "rate-limited")
    throw new ApiError(
      429,
      "RATE_LIMITED",
      "Terlalu banyak permintaan. Coba lagi dalam 1 jam atau hubungi HR.",
    );
  if (scenario === "rate-limited-wait")
    throw new ApiError(
      429,
      "RATE_LIMITED",
      "Terlalu banyak permintaan. Coba lagi nanti atau hubungi HR.",
      undefined,
      { retryAfterSeconds: RATE_LIMIT_WAIT_SECONDS },
    );
  if (scenario === "unavailable")
    throw new ApiError(
      503,
      "SERVICE_UNAVAILABLE",
      "Layanan WhatsApp belum tersedia.",
    );
  if (payslipMockStore.get().pin === null)
    throw new ApiError(
      409,
      "PAYSLIP_PIN_NOT_SET",
      "PIN slip gaji belum dibuat.",
    );

  const challengeId = newIdempotencyKey();
  const expiresAt = new Date(
    Date.now() + (scenario === "expire" ? EXPIRE_TTL_MS : TTL_MS),
  ).toISOString();
  save(challengeId, {
    scenario,
    expiresAt,
    polls: 0,
    status: "pending",
    verifiedAt: null,
    saved: {},
  });
  return {
    data: {
      challengeId,
      code: CODE,
      waLink: `https://wa.me/${SERVICE_NUMBER}?text=${encodeURIComponent(`RESET PIN ${CODE}`)}`,
      senderHint: SENDER_HINT,
      expiresAt,
    },
  };
});

registerMock(getMyPayslipPinResetWa, ({ params }) => {
  const entry = challenges.get().get(params.challengeId);
  if (!entry) throw notFound();
  const now = Date.now();
  const polls = entry.polls + 1;
  let { status, verifiedAt } = entry;
  if (status === "pending") {
    if (now >= Date.parse(entry.expiresAt)) status = "expired";
    else if (entry.scenario !== "pending" && entry.scenario !== "expire") {
      if (polls >= POLLS_TO_VERIFY) {
        status = "verified";
        verifiedAt = now;
      }
    }
  }
  save(params.challengeId, { ...entry, polls, status, verifiedAt });
  return {
    data: {
      status,
      expiresAt: entry.expiresAt,
      grantExpiresAt:
        status === "verified" && verifiedAt !== null
          ? new Date(verifiedAt + GRANT_MS).toISOString()
          : null,
    },
  };
});

registerMock(submitMyPayslipPinResetWaPin, ({ params, body }) => {
  const entry = challenges.get().get(params.challengeId);
  if (!entry) throw notFound();
  // A retry with the same key answers like the first call.
  if (entry.saved[body.idempotencyKey] === body.pin)
    return { data: { status: "active" as const, lockedUntil: null } };
  if (entry.scenario === "proof-invalid" || entry.status !== "verified")
    throw proofInvalid();
  if (entry.verifiedAt === null || Date.now() >= entry.verifiedAt + GRANT_MS)
    throw proofInvalid();

  payslipMockStore.set({
    ...payslipMockStore.get(),
    pin: body.pin,
    pinAttempts: 0,
    pinLockedUntil: null,
  });
  save(params.challengeId, {
    ...entry,
    status: "used",
    saved: { ...entry.saved, [body.idempotencyKey]: body.pin },
  });
  return { data: { status: "active" as const, lockedUntil: null } };
});

registerMock(cancelMyPayslipPinResetWa, ({ params }) => {
  const entry = challenges.get().get(params.challengeId);
  if (!entry) throw notFound();
  if (entry.status === "pending" || entry.status === "verified")
    save(params.challengeId, { ...entry, status: "cancelled" });
});
