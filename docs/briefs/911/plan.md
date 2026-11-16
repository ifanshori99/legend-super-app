# 911 plan (engineer split)

Context: scratchpad `brief-911.md` (CTO decisions), `docs/briefs/911/design-p1-1.md` (final P1-1 design, follow it exactly), findings `so-findings.md`. Money rule: when in doubt choose the rule that limits payment. Temp migration numbers (merge train renumbers):

| No    | File                                  | Owner       | Content                                                                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0652  | `0652_payout_911_closure_bind.sql`    | I1          | P1-2: closure triggers (0647:103-117) also fire on `UPDATE OF evidence_key` and guard checks NEW key; P2-3: `payout_bind_proof` (0645:~102) requires `f.batch_id = p_batch` and same legal entity                                                                                                                       |
| 0653  | `0653_payout_step_grants.sql`         | I3          | design section 3.A                                                                                                                                                                                                                                                                                                      |
| 0654  | `0654_payout_trusted_steps_grant.sql` | I4          | design section 3.B + P1-2 (propose replace of evidence_key on an open proposal is FORBIDDEN: raise, must withdraw/cancel and propose anew; both correction 0648:~352 and overpaid ~657) + P2-3 (`payout_assert_proof` 0648:~118 requires same batch and legal entity). Bodies copied from latest (0648/0649/0647/0646). |
| 0655+ |                                       | I6 (wave 2) | izza4 settle trusted fn, r86qa resolve trusted fn (kind `resolve`), revoke leftovers                                                                                                                                                                                                                                    |

Rules for all editors: edit ONLY your files; do NOT touch `apps/api/drizzle/meta/*` (parent regenerates snapshot/journal); do NOT commit; do NOT run tests unless told (parent runs heavy). FKs of new tables inside `CREATE TABLE`. Hand-written SQL must apply as non-superuser migrator (copy ownership dance of 0644).

Interfaces fixed by design (TS): `payroll-payout-grant.service.ts` exports `PayoutGrantBinding`, `PayoutGrantIssuer { issue(binding): Promise<string> }`, `payoutGrantIssuerOf(req)`; `payroll-payout.service.ts` exports `payoutTrustedGrant(actor, binding)`; fixtures export `testGrantIssuer(actor)` returning a `PayoutGrantIssuer`.

Owners (wave 1):

- I1: 0652 SQL only.
- I2: `apps/api/src/services/payroll-payout-recon.service.ts`: P2-4 (binding_duplicate must ignore superseded/cancelled proposal-evidence bindings, K1 stays unusable elsewhere) and P2-3 (compare upload batch of evidence record with op batch). Not the grant recon item yet.
- I3: 0653 SQL + design section 4 items 1-7, 12 (schema, env, role.ts, grantor.ts, grant.service, evidence.ts reauth, identity middleware, server.ts shutdown, provision-roles, deploy files, .env.example, docs/deployment.md, tests/db-role-provisioning.test.mjs update).
- I4: 0654 SQL only.
- I5: design section 4 items 8-10, 13 (call sites, routes, fixtures `testGrantIssuer`, update existing tests for new signatures: payroll-payout-905-followups, 905-posting-source, 881-guard, data-import-registry, 911 tests already present). Not `payroll-payout-manual.service.ts` lines about settle/resolve (I6).
- test-writer A: `payroll-payout-911-grants.test.ts` (design section 5 cases 1-14,16 minus recon-flag part, 12, 15 as far as I3 interface allows).
- test-writer B: fix premises of `payroll-payout-911-closure-swap.test.ts`.
