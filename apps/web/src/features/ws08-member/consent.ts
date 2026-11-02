import type { ConsentPurpose, CustomerConsent } from "@starter/shared/crm";

/**
 * Policy version the API should record with a new consent. The contract keeps
 * consent rows versioned but exposes no "current version" read, so the member
 * PWA reuses the version of the customer's latest row for that purpose. PRD
 * silent on the number; a brand-new member falls back to the launch catalog
 * version until the API exposes it (follow-up: member policy-version read).
 */
export const FALLBACK_POLICY_VERSION = "2026-01";

export function policyVersionFor(
  consents: readonly CustomerConsent[],
  purpose: ConsentPurpose,
): string {
  const rows = consents.filter((consent) => consent.purpose === purpose);
  return rows.at(-1)?.policyVersion ?? FALLBACK_POLICY_VERSION;
}

/** The granted, not withdrawn consent for a purpose, if any. */
export function activeConsentFor(
  consents: readonly CustomerConsent[],
  purpose: ConsentPurpose,
): CustomerConsent | undefined {
  return consents.find(
    (consent) => consent.purpose === purpose && consent.withdrawnAt === null,
  );
}

export const CONSENT_PURPOSES = ["loyalty", "marketing", "ai"] as const;
