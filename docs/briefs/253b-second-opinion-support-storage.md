# 253b Second opinion (Codex): support session lifetime + storage access

Not committed. Read-only review, effort high (auth tier K).

## Target
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/support-storage-access`, branch `ws/support-storage-access`, base `0fecec89` (`ws/access-perm-backfill`). Review `git diff 0fecec89..HEAD`.

## Cards
1. `legend-w1due`: an impersonated (Better Auth admin) session must die when its support grant ends or lapses.
   - `services/platform-support.service.ts`: `endImpersonationSessionsWithoutGrant` (deletes sessions of the admin that no live grant covers, audits `support_access.impersonation_ended` cause `grant_ended`); called after `endSupportAccess` commits.
   - `middleware/support-session.ts`: on `SUPPORT_ACCESS_REQUIRED`, the guard deletes the current session when no other live grant covers its user, then refuses.
   - Tests: `test/impersonation-grant.test.ts` describe `legend-w1due`.
2. `legend-tiie`: real `resolveRequest` for storage routes from tenant membership + outlet permissions (`services/core-storage-access.ts`, `test/core-storage-access.test.ts`). Router still unmounted (no S3 provider configured).

## Questions to answer
- Can any path still act in a tenant through an impersonated session after the grant ends (routes outside `requireAuth`, `/api/auth/*` allowlist, KDS realtime, MCP, workers)?
- c9kbk independence (`hasIndependentOwnerStanding`): can an Owner assignment made by an in-flight support request (guard passed before the grant ended, write committed after) count as independent? Is it worth closing, and where?
- Session deletion races: concurrent requests, audit double-write, Better Auth cookie cache.
- Storage: is the permission map per purpose right (esp. receipt read, selfie read by its owner)? Can a caller reach an outlet outside their scope, or another tenant's object id?

## Already found by the architect review (do not re-report; challenge the fix)
- Fixed in b800ae30: in-flight Owner assignment just after grant end counted as independent; now a 5-minute grace after each window in `hasIndependentOwnerStanding`. Is 5 minutes enough, and is "decide by actor via audit row" worth doing instead?
- Fixed: cleanup skipped expired rows (`gt(session.expiresAt, now)`).
- Open, Low: stop-impersonating racing the cleanup can write two `impersonation_ended` rows.
- Open, Low: refused request whose session survives (grant in another tenant) scans every tenant each time.
- Open, Medium (storage, router unmounted): receipt reviewers read every receipt at the outlet; objects carry no owner/source.

## Report
Findings with file:line, severity, concrete failure scenario. No edits.
