# Architect review: late funds after write-off (legend-oan3p)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/writeoff-late-funds`, diff = `git diff origin/int/batch63` (plus untracked files). Design: `docs/briefs/sub-writeoff-late-funds.md`. Tier K (money, migration, access), effort xhigh. Read-only.

Check, with concrete failure scenarios only:

1. Money: no automatic reversal, no extra journal or money outbox event, no change to normal import effects of the late line; nobody paid more, outlet not harmed.
2. Concurrency: import vs approval consumer closing the same case (lock order, READ COMMITTED re-check after `FOR UPDATE` wait). Can a write-off and a late match both pass without a correction row? Can a correction row appear for a case that is not `resolved`?
3. Idempotency: re-import, replayed `approval.resolved`, duplicate resolve requests (idempotency key fingerprint).
4. Access: correction approval uses `reconciliation_case` policy (Owner/Finance, 1 level, distinct actor); fail closed; requester cannot self-approve; tenant + outlet isolation in SQL and RLS on the new table; 404 cross-tenant.
5. Migration 0606: inline FKs, RLS enforced (tenant + outlet), safe on populated DB, `db:generate` clean, journal/snapshot consistent.
6. Contract: `lateFunds` on case view correct for list and single views; fixtures/mock updated.
   Report findings ranked, file:line, each with a failure scenario. No style nits.
