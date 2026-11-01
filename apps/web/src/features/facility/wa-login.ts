// WhatsApp login gate for the facility QR flow. PRD §3 F22 "Titik Masuk":
// booking requires a signed-in customer with a verified WhatsApp number so the
// ticket belongs to them (alur S langkah 2).
//
// The flow is the identity contract's reverse OTP (@starter/shared/identity,
// AUTH-01/AUTH-03): the browser asks for a challenge, shows the 8-symbol code
// and a wa.me deep link (QR on desktop), the guest sends the filled-in message,
// and this browser polls the challenge until the session appears. The system
// never sends a WhatsApp message, the code is shown once and is never stored
// here, and the challenge is bound to this browser by the API's cookie.
import {
  cancelLoginChallenge,
  getLoginChallenge,
  requestWhatsAppLoginChallenge,
} from "@starter/shared/identity";
import { callEndpoint } from "@/lib/api/endpoint.ts";

export async function startWhatsAppLogin(returnTo?: string) {
  const response = await callEndpoint(requestWhatsAppLoginChallenge, {
    body: returnTo ? { returnTo } : {},
  });
  return response.data;
}

export async function fetchLoginChallenge(
  challengeId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getLoginChallenge,
    { params: { challengeId } },
    { signal },
  );
  return response.data;
}

export async function cancelWhatsAppLogin(challengeId: string) {
  await callEndpoint(cancelLoginChallenge, { params: { challengeId } });
}
