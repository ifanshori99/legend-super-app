// WhatsApp login gate for the facility QR flow. PRD §3 F22 "Titik Masuk":
// booking requires a signed-in customer with a verified WhatsApp number so the
// ticket belongs to them (alur S langkah 2).
//
// The OTP endpoints belong to AUTH-02 (KirimDev + login_challenges, WS-01) and
// are not in the shared contract yet. Instead of pretending a number is
// verified against a real API, this module talks to a small port: mock mode
// verifies locally the way a fake MessagingProvider would, and every other
// environment fails with a typed error so the screen can say the endpoint is
// missing (follow-up bead). Swapping the mock for the real endpoint later only
// touches this file.
import { ApiError } from "@/lib/api/errors.ts";
import { API_MOCK } from "@/lib/api/mock-flag.ts";

/** A verified WhatsApp number is 10–13 digits starting with 08. */
const PHONE_PATTERN = /^08\d{8,11}$/;

export const OTP_LENGTH = 6;
const OTP_PATTERN = /^\d{6}$/;

/** `+62 812-3456 7890` / `0812 3456 7890` → `081234567890`. */
export function normalizePhone(input: string): string {
  const digits = input.replace(/[^\d+]/g, "");
  let local = digits;
  if (local.startsWith("+62")) local = `0${local.slice(3)}`;
  else if (local.startsWith("62")) local = `0${local.slice(2)}`;
  return local.replace(/\D/g, "");
}

export function isValidPhone(input: string): boolean {
  return PHONE_PATTERN.test(normalizePhone(input));
}

export function isValidOtp(input: string): boolean {
  return OTP_PATTERN.test(input);
}

/** Where the mock "sends" codes from; real mode returns null (not wired yet). */
function mockEndpointAvailable(): boolean {
  return API_MOCK;
}

/**
 * Sends the login code. Mock mode resolves immediately; real mode fails with
 * `NOT_IMPLEMENTED` so the gate can explain instead of leaving the guest on a
 * spinner.
 */
export async function requestWhatsAppCode(phone: string): Promise<void> {
  if (!isValidPhone(phone))
    throw new ApiError(422, "VALIDATION_ERROR", "Nomor WhatsApp tidak valid.", [
      { field: "phone", message: "Nomor WhatsApp tidak valid." },
    ]);
  if (!mockEndpointAvailable())
    throw new ApiError(
      501,
      "NOT_IMPLEMENTED",
      "Endpoint kode WhatsApp (AUTH-02) belum tersedia.",
    );
  await Promise.resolve();
}

/**
 * Verifies the code. The mock accepts any 6 digits, the same way a fake
 * messaging adapter cannot know the real code; the real endpoint replaces this
 * body without changing the screen.
 */
export async function verifyWhatsAppCode(
  phone: string,
  code: string,
): Promise<void> {
  if (!isValidPhone(phone) || !isValidOtp(code))
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Nomor atau kode verifikasi tidak valid.",
      isValidOtp(code)
        ? [{ field: "phone", message: "Nomor WhatsApp tidak valid." }]
        : [{ field: "code", message: "Kode terdiri dari 6 angka." }],
    );
  if (!mockEndpointAvailable())
    throw new ApiError(
      501,
      "NOT_IMPLEMENTED",
      "Endpoint verifikasi WhatsApp (AUTH-02) belum tersedia.",
    );
  await Promise.resolve();
}
