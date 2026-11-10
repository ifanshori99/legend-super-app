# Sub-brief: legend-omp4 — staff MFA recovery codes

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/omp4-mfa-recovery` (branch `ws/omp4-mfa-recovery`).
Out of scope (never edit): `apps/api/src/edge/`, staff PIN, accounting, `apps/web`. Do not commit; the engineer commits.
Existing TOTP code to build on (do not rewrite): `apps/api/src/services/identity-mfa.service.ts`, `apps/api/src/routes/identity.routes.ts`, `apps/api/src/db/schema/identity-mfa.ts`, `apps/api/src/lib/secrets.ts` (`blindIndex`), contract in `packages/shared/src/identity/{inputs,schemas,endpoints}.ts`.

## Rules (shared by every piece)

- Set: 10 codes. Code = 10 chars from Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (50 bits, `crypto.randomInt`), shown as `XXXXX-XXXXX`.
- Normalize before hashing: strip whitespace and `-`, uppercase. Wire input accepts `^[0-9A-Za-z]{5}-?[0-9A-Za-z]{5}$` after trim.
- Store only `blindIndex(normalized, "mfa-recovery-code:" + userId)` (HMAC-SHA256 hex, keyed). Never store or log the plaintext.
- Generate/regenerate (`POST /api/auth/mfa/recovery-codes`): requires the session already MFA-verified (`AccessError("MFA_REQUIRED")` otherwise) AND ≥1 verified factor (`CoreError("CONFLICT", ...)` otherwise). One transaction: delete the user's existing set (cascades codes), insert new set + 10 code rows. Response returns the plaintext codes once. Regenerate invalidates every old code.
- Status (`GET /api/auth/mfa/recovery-codes`): `{ remaining, generatedAt|null }`, never codes.
- Consume (`POST /api/auth/mfa/recovery`, body `{ code }`): requires auth session; user must have ≥1 verified factor and a set, else 401 `MFA_RECOVERY_CODE_INVALID` (same as a wrong code, no oracle). Transaction with the set row `SELECT … FOR UPDATE`. Locked (`locked_until > now`) → `CoreError("RATE_LIMITED", "Terlalu banyak kode salah. Coba lagi dalam 15 menit.")`. Match = unused row with that hash: set `used_at = now`, reset set `failed_attempts=0, locked_until=null`, set `session.mfa_verified_at = now` scoped by session id AND user id. Miss/used → `failed_attempts+1`; at `MAX_MFA_ATTEMPTS` (5) set `locked_until = now + MFA_LOCK_MINUTES` (15) and answer RATE_LIMITED, else 401 `MFA_RECOVERY_CODE_INVALID` "Kode cadangan salah atau sudah dipakai.". Counter must commit even on failure (return outcome from tx, throw after, like `verifyMfaFactor`). Response `{ verifiedAt, remaining }`.
- Deleting the user's last verified factor (`deleteMfaFactor`) also deletes the recovery set (a code must never satisfy MFA with no factor).
- Audit (append-only `audit_logs` via `recordAudit` from `services/core-audit.ts`): actions `mfa_recovery_codes.generated` (after: `{ count, regenerated }`), `mfa_recovery_code.used` (after: `{ remaining }`), `mfa_recovery_code.rejected` (after: `{ cause: "invalid" | "locked" }`), `mfa_recovery_codes.revoked` (after: `{ cause: "last_factor_deleted" }`). objectType `mfa_recovery_code_set`, objectId set id, actorType `user`, actorId user id, retentionClass `audit_2y`, safeFields = exactly those `after` keys. Tenant = the caller's `session.tenant_id`; context built like `challengeContext` in `services/identity-login.service.ts:161` (`establishScopedTenantContext(establishTenantContext({tenantId, brandId:null, source:"session"}), {kind:"tenant"})`), written in its own `withTenant` transaction AFTER the state transaction commits (rejections must be audited even though their tx returns an error). Session without tenant: no audit row, `logger` info line only (same precedent as login rejections with no tenant). Never put the code or hash in audit or logs.

## Pieces (files do not overlap)

### P1 contract (implementer A)
`packages/shared/src/identity/inputs.ts`: `MFA_RECOVERY_CODE_INPUT_PATTERN`, `mfaRecoveryVerifySchema = clientInputSchema({ code })` + type `MfaRecoveryVerifyInput`.
`packages/shared/src/identity/schemas.ts`: `MFA_RECOVERY_CODE_COUNT = 10`, `MFA_RECOVERY_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/`, `mfaRecoveryCodesSchema = strictObject({ codes: array(regex).length(10), generatedAt })`, `mfaRecoveryStatusSchema = strictObject({ remaining: int 0..10, generatedAt: iso nullable })`, `mfaRecoveryVerificationResultSchema = strictObject({ verifiedAt, remaining })`, with types `MfaRecoveryCodes`, `MfaRecoveryStatus`, `MfaRecoveryVerificationResult`.
`packages/shared/src/identity/endpoints.ts`: `getMfaRecoveryStatus` (GET `/api/auth/mfa/recovery-codes`), `generateMfaRecoveryCodes` (POST same, no body), `verifyMfaRecoveryCode` (POST `/api/auth/mfa/recovery`, body `mfaRecoveryVerifySchema`), after `deleteMfaFactor`.

### P2 schema + migration (implementer A, after P1)
`apps/api/src/db/schema/identity-mfa.ts`: `mfaRecoveryCodeSets` (`mfa_recovery_code_sets`: id uuid pk, user_id uuid not null UNIQUE, failed_attempts int default 0, locked_until timestamptz, created_at timestamptz default now) and `mfaRecoveryCodes` (`mfa_recovery_codes`: id uuid pk, set_id uuid not null FK → sets.id ON DELETE CASCADE, code_hash varchar(64) not null, used_at timestamptz, created_at; unique (set_id, code_hash)). Global tables, no tenant RLS (same as mfa_factors), no FK to user (see mfa_factors comment).
Migration: run `pnpm --filter @starter/api db:generate`, then rename the produced `0217_*.sql` → `0239_mfa_recovery_codes.sql` and `meta/0217_snapshot.json` → `meta/0239_snapshot.json`; in `meta/_journal.json` set that entry to `idx: 239, when: 1794320000000, tag: "0239_mfa_recovery_codes"`. The FK must be inline in the CREATE TABLE (edit the SQL so no separate ALTER TABLE … ADD CONSTRAINT). Re-run `db:generate`: must report no changes. Grants: copy whatever mfa_factors' migration (`apps/api/drizzle/0014_fine_quicksilver.sql`) and later grant migrations do for global identity tables so the non-superuser runtime role can read/write them (grep `mfa_factors` across `apps/api/drizzle/*.sql` and `apps/api/src/db/provision-roles.ts`).

### P3 service + routes (implementer B)
New `apps/api/src/lib/mfa-recovery-code.ts`: `generateRecoveryCode()`, `normalizeRecoveryCode(input)`, `recoveryCodeHash(userId, normalized)` + unit test `apps/api/src/lib/mfa-recovery-code.test.ts`.
New `apps/api/src/services/identity-mfa-recovery.service.ts`: `getMfaRecoveryStatus({userId})`, `generateMfaRecoveryCodes({userId, sessionId, sessionMfaVerified, now?})`, `verifyMfaRecoveryCode({userId, sessionId, code, now?})`, `revokeMfaRecoveryCodes(tx, {userId})` (for deleteMfaFactor), audit helper per rules.
Edit `apps/api/src/routes/identity.routes.ts` (3 routes, `requireAuth` + `requireTrustedOrigin` + `jsonBody` on POSTs, like `/mfa/verify`) and `deleteMfaFactor` in `identity-mfa.service.ts` (revoke set when no verified factor remains, same tx or immediately after).
Imports from P1/P2 use the names above exactly.

### P4 tests (test-writer, fail-first)
New `apps/api/src/test/identity-mfa-recovery-api.test.ts`, style of `apps/api/src/test/identity-mfa-api.test.ts` (supertest + `createApp`, `signUp`, `agent`, `originHeader`, real TOTP enroll→verify via `totpCode` from `lib/totp.ts`). One `it` per criterion: generate (10 codes, pattern, requires MFA-verified session, 409 without factor, status shows remaining 10 and never codes, DB has no plaintext), single-use (code works once on a fresh session that is not MFA-verified, second use 401, session marked verified, remaining decrements, works with lowercase/no dash), regenerate (old codes 401, new work), rate limit (5 wrong → RATE_LIMITED 429 and even a valid code is refused while locked; counter persists), audit (rows with the four actions on the session tenant when session has tenant_id; no code/hash in `event` jsonb), last factor deleted → codes refused. Read the existing suite first for how sessions get a tenant (set `session.tenant_id` via pool if needed).

## Review fixes (architect, round 1)

### F-code (implementer)
1. `deleteMfaFactor` (`apps/api/src/services/identity-mfa.service.ts`): take the same per-user advisory lock generate uses (`mfa-recovery:<userId>`) as the FIRST statement of its transaction, so generate-vs-delete and two parallel last-factor deletes serialize and the set is always revoked when no verified factor remains.
2. `auditRecoveryEvent` (`identity-mfa-recovery.service.ts`): wrap the post-commit audit write in try/catch; on failure `logger.warn` with only `{ userId, action }` (pattern: `auditRateLimited` in `services/identity-login.service.ts`). Same for the deleteMfaFactor revoke audit. A failed audit must never turn a committed generate into a 500.
3. Consume: the session update adds `isNull(session.revokedAt)` and `.returning({ id })`; no row → return an error from inside the tx so it rolls back (code NOT spent), answer 401 `UNAUTHENTICATED`-style HttpError (reuse whatever requireAuth answers for a dead session).
4. Move `MAX_MFA_ATTEMPTS` + `MFA_LOCK_MINUTES` into new `apps/api/src/lib/mfa-policy.ts`; both services import from there; `identity-mfa.service.ts` re-exports them for existing importers. No more cross-import of constants.

### F-test (test-writer) — append to `apps/api/src/test/identity-mfa-recovery-api.test.ts`
- Same valid code sent twice in parallel (`Promise.all`) → exactly one 200, one 401; remaining drops by 1.
- Six wrong codes in parallel → at least one 429, set row `failed_attempts >= 5` and `locked_until` set.
- Two verified factors, delete both in parallel → recovery set gone afterwards.
