// Second-factor lockout numbers shared by TOTP factors and recovery codes.

/** §3 F6 locks a device pin after five misses; the second factor matches it. */
export const MAX_MFA_ATTEMPTS = 5;
export const MFA_LOCK_MINUTES = 15;

/** PRD is silent; a pending factor cannot be finished after this window. */
export const MFA_ENROLLMENT_TTL_MINUTES = 15;
/** PRD is silent; a passkey sign-in challenge is valid this long (legend-jemg). */
export const MFA_PASSKEY_CHALLENGE_TTL_MINUTES = 5;

/** PRD is silent; five known authenticators is enough for one person. */
export const MAX_VERIFIED_FACTORS = 5;
