// Second-factor lockout numbers shared by TOTP factors and recovery codes.

/** §3 F6 locks a device pin after five misses; the second factor matches it. */
export const MAX_MFA_ATTEMPTS = 5;
export const MFA_LOCK_MINUTES = 15;
