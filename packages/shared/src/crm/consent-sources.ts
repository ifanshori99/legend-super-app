// Who may record which consent source (PRD v1.7 §2 privacy, LOY-04).
// `member_pwa` and `website` mean the customer acted in their own session, so a
// staff member (back-office session with `crm.consent.record`) must never be
// able to claim them. Staff may record only what they witnessed at the counter
// (`cashier`) or a reviewed bulk load (`import`).

import { z } from "../core/index.ts";
import { consentSourceSchema } from "./loyalty.ts";

export const STAFF_CONSENT_SOURCES = ["cashier", "import"] as const;
export type StaffConsentSource = (typeof STAFF_CONSENT_SOURCES)[number];

export const staffConsentSourceSchema = z.enum(STAFF_CONSENT_SOURCES);

export function isStaffConsentSourceAllowed(
  source: unknown,
): source is StaffConsentSource {
  return (
    consentSourceSchema.safeParse(source).success &&
    (STAFF_CONSENT_SOURCES as readonly string[]).includes(source as string)
  );
}
