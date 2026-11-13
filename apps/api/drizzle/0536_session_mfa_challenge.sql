-- Payout step-up (bead legend-658 card f5n9y, L5; design payroll-disbursement
-- 9 "MFA step-up"). `session.mfa_verified_at` is also stamped when a user
-- finishes the FIRST enrollment of a factor, which proves nothing about who is
-- holding the session. `mfa_challenge_verified_at` is stamped only when a code,
-- recovery code or passkey assertion is checked against an ALREADY verified
-- factor. A money action (payout confirm, resolve, cash handover) asks for the
-- account password again while this column is still NULL.
-- Nullable, no backfill: every live session starts "not challenged", so the
-- worst case is one extra password prompt, never a skipped one.
ALTER TABLE "session" ADD COLUMN "mfa_challenge_verified_at" timestamp with time zone;
