# w8dfz.1 brief: masked number + "Bukan saya" before session use (API only)

Worktree: .worktrees/w8dfz1, branch ws/w8dfz1-wa-masked. Test (fixed, do not edit): apps/api/src/test/identity-wa-masked-login.test.ts.

## Findings
- Poll (`pollWhatsAppChallenge`, apps/api/src/services/identity-login.service.ts ~495) issues the session on first completed poll. Cancel (`cancelWhatsAppChallenge` ~671) only flips `pending`.
- Challenge stores only keyed digest `expectedSenderHash`; no masked value exists. View schema `loginChallengeViewSchema` in packages/shared/src/identity/schemas.ts ~427; endpoints packages/shared/src/identity/endpoints.ts ~111; routes apps/api/src/routes/identity-auth.routes.ts (create ~95, cancel ~136).

## Design (opt-in, old flow unchanged)
- Create body: optional `requireConfirm: boolean` (default false). Old flow and existing tests unchanged.
- Migration `apps/api/drizzle/0274_wa_login_confirm.sql` + `_journal.json` (next idx after 242): `login_challenges` add `sender_masked text`, `confirm_required boolean not null default false`, `confirmed_at timestamptz`.
- When inbound message matches the challenge, store `sender_masked` (e.g. `+62 812-****-7890`: keep country code and last 4 digits, never the full number). Find the match code (inbound service) and set it in the same update that completes the challenge.
- Poll, challenge completed + `confirm_required` + `confirmed_at` null: return view with `senderMasked` and `awaitingConfirmation: true`, `session: null`, no cookie, no claim. Add both fields (optional) to the shared view schema.
- `POST /:challengeId/confirm` (new endpoint in shared endpoints + route): bound browser only (same assertBinding), sets `confirmed_at` if completed and not cancelled and session not issued; idempotent; audit `login_challenge.confirmed`. Next poll issues session as today.
- Cancel ("Bukan saya"): also valid for status completed with `confirm_required` and `session_issued_at` null: set status `cancelled` (keep matchedUserId for audit), idempotent 204, audit as today. After cancel, poll returns cancelled, no session; confirm after cancel does nothing and issues no session.
- Cancel/confirm for other browser: 403 as today.

## Do not
- Do not touch the web UI, reset-PIN files, or existing identity tests (add only the new test file already written).
- No typecheck/test runs by implementer except the single test file: `LEGEND_TEST_FILES="src/test/identity-wa-masked-login.test.ts" heavy pnpm test`.
