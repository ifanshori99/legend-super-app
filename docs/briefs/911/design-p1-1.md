# 911 P1-1: one-time payout step grant (final design)

Status: architect decision, 16 Nov 2026. Scope: finding P1-1 of the second opinion on 905 (any reader of `session` can act as two approvers). Also answers whether legend-r86qa can reuse the grant.

## 1. Decisions

D1. **The authority is a separate database login, not `legend_app`.** A new NOLOGIN group `legend_payout_grantor` may only EXECUTE `app.payout_grant_issue(...)`. A LOGIN member `legend_grant_<16 hex>` is provisioned by `provision-roles` (same pattern as the maintenance login `legend_maint_*`, migration 0187). The API reaches it through its own small pool (`PAYOUT_GRANTOR_DATABASE_URL`). `legend_app` cannot issue a grant, cannot read the grant hash and cannot write the grant table. The secret that `legend_app` lacks is the grantor login password. That password is held only in the runtime environment and is sent as a SCRAM verifier, like the other logins.
  Why not an HMAC key: no pgcrypto in this database; key material would have to be copied into a table and passed in SQL text (logs). A login is the boring, proven pattern in this repo.

D2. **The grant replaces `(p_actor, p_session)` in every trusted step function.** The new signatures take `p_grant text`. The function reads the actor and session from the consumed grant row. `legend_app` can no longer name an actor or a session at all. `app.payout_assert_actor` stays and runs on the grant's actor/session (live session, MFA at most 15 minutes old, permission).

D3. **Grant = 32 random bytes, only its SHA-256 stored.** The secret is built from `uuid_send(gen_random_uuid())` twice (244 random bits, core PostgreSQL only). The grant expires after **2 minutes**. It is bound to: tenant, actor, session, kind (action), step, batch, item set hash, evidence key, ref id (operation, claim, closure or posting), target id (GL account for a posting source), detail (reserved for r86qa outcome). It is used once.

D4. **Issued inside the service, right before the trusted call, after the request's step-up.** At that point the step and the operation are known, so the grant binds the exact operation and step (no normalisation drift between route and SQL). The issuer object exists only when `requireTenantStepUpPassword` succeeded in the same request. The secret never leaves the API process (not returned to the browser, not logged).

D5. **Atomic consume**: one `UPDATE ... WHERE secret_sha256 = $h AND consumed_at IS NULL AND expires_at > clock_timestamp() AND <every binding column IS NOT DISTINCT FROM the argument> RETURNING`. A concurrent second consumer re-checks `consumed_at` after the row lock and gets zero rows. A rollback of the step leaves the grant unconsumed; it then expires unused (only the API holds the secret).

D6. **Same-actor rule** stays where it is (proposer, requester, resolver checks). Those checks now compare against the grant actor, and every stored proposer column is now written from a grant actor. Step two additionally requires that the step-one attestation carries a grant (`PAYOUT-71`). This limits payment: a proposal without a grant must be proposed again.

D7. **Structural backstop on attestations**: new `grant_id` column, composite FK to the grant (tenant, id, kind, step, actor, session), UNIQUE `(tenant_id, grant_id)`, and `CHECK (grant_id IS NOT NULL OR attested_at < app.payout_grants_since())`. No attestation after the cutover can exist without a matching grant, even if a later function forgets.

D8. **Grant table ownership**: owned by the migrator like every other table (repo pattern of 0644 attestations), not by `legend_payout`. What matters is privileges: `legend_app` has nothing except column SELECT on non-secret columns (recon). `legend_payout` has SELECT, INSERT, UPDATE (consumed_at, consumed_txid). Tenant RLS is forced (`app.enforce_tenant_rls`).

D9. **Missing grantor configuration fails closed for payout only.** When `PAYOUT_GRANTOR_DATABASE_URL` is unset outside development/test, the app boots, and every trusted payout step answers 503 `PAYOUT_STEP_GRANT_UNAVAILABLE` (no payment can be recorded). The single-VM deploy check requires the variable.

D10. **legend-r86qa reuses the same grant.** `app.payout_grant_consume` is generic. r86qa adds kinds `resolve` (steps `propose`/`approve`, `detail` = outcome `failed|not_sent|succeeded`, so an approval for `failed` cannot be spent on `succeeded`) and, if retry stays a human money step, `retry` (step `record`, ref = source batch). r86qa extends the kind/step CHECKs and the issue matrix in its own migration; no table change (the `detail` column exists for it).

## 2. Residual risk (report to CTO)

- An attacker who has SQL as `legend_app` AND a valid cookie of their own can still re-point session rows (identity tables are writable by `legend_app`) and drive the API as another user, including the step-up. The grant does not close that; it is an identity-integrity issue for the whole app. Proposed follow-up bead: bind session token to user (or make `session.user_id`/`token` immutable plus tamper audit).
- A leak of `PAYOUT_GRANTOR_DATABASE_URL` lets the holder mint grants for finance users that have a live session with fresh MFA. Same blast radius as before the fix, but now it needs a runtime secret, not readable rows.
- The secret is a SQL parameter on the `legend_app` connection. PostgreSQL does not log parameters by default (`log_parameter_max_length_on_error = 0`); `SqlLogger` logs only the parameter count. Keep both that way. The secret is short-lived and bound to one step anyway.
- The payout transaction must stay READ COMMITTED: the grant is committed on another connection after the payout transaction started. Under REPEATABLE READ the consume would not see it. The happy-path test covers this.

## 3. Migration shape

Numbering: take the **next free numbers after the other 911 migrations** (P1-2, P2-3, r86qa). File B copies the final bodies of the trusted functions once, including those fixes. Expected names (numbers are placeholders): `06NN_payout_step_grants.sql` (A) and `06NN+1_payout_trusted_steps_grant.sql` (B). Hand-written SQL, then update `apps/api/drizzle/meta` snapshot and journal like 905 did. Pre-gate rule: FKs of the new table inside `CREATE TABLE`.

### A. `06NN_payout_step_grants.sql`

1. Group role, copy of 0187 style:
   `CREATE ROLE legend_payout_grantor NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION` (raise if it exists with unsafe attributes); `GRANT USAGE ON SCHEMA app TO legend_payout_grantor`.
2. Table:
   ```sql
   CREATE TABLE "payroll_payout_grants" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
     "tenant_id" uuid NOT NULL,
     "secret_sha256" varchar(64) NOT NULL,
     "kind" varchar(16) NOT NULL,
     "step" varchar(8) NOT NULL,
     "batch_id" uuid,
     "item_set_hash" varchar(64),
     "evidence_key" varchar(500),
     "ref_id" uuid,
     "target_id" uuid,
     "detail" varchar(64),
     "actor" text NOT NULL,
     "session_id" text NOT NULL,
     "step_up_method" varchar(16) NOT NULL,
     "assertion" jsonb NOT NULL,
     "issued_at" timestamptz NOT NULL,
     "expires_at" timestamptz NOT NULL,
     "consumed_at" timestamptz,
     "consumed_txid" bigint,
     CONSTRAINT "payroll_payout_grants_tenant_id_key" UNIQUE ("tenant_id","id"),
     CONSTRAINT "payroll_payout_grants_secret_key" UNIQUE ("secret_sha256"),
     CONSTRAINT "payroll_payout_grants_attest_key" UNIQUE ("tenant_id","id","kind","step","actor","session_id"),
     CONSTRAINT "payroll_payout_grants_kind_check" CHECK (kind IN ('correction','overpaid','return','closure','posting_source')),
     CONSTRAINT "payroll_payout_grants_step_check" CHECK (step IN ('propose','approve','record','confirm')),
     CONSTRAINT "payroll_payout_grants_method_check" CHECK (step_up_method IN ('password','mfa_challenge')),
     CONSTRAINT "payroll_payout_grants_expiry_check" CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '2 minutes'),
     CONSTRAINT "payroll_payout_grants_consumed_check" CHECK ((consumed_at IS NULL) = (consumed_txid IS NULL)),
     CONSTRAINT "payroll_payout_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
     CONSTRAINT "payroll_payout_grants_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payroll_disbursement_batches"("tenant_id","id")
   );
   ```
   Index `(tenant_id, batch_id)`. `SELECT app.enforce_tenant_rls('public.payroll_payout_grants'::regclass);`
   Update guard trigger (BEFORE UPDATE): only `current_user = 'legend_payout'`, only `consumed_at`/`consumed_txid` from NULL to a value, every other column unchanged (same style as `payroll_payout_proof_closures_guard`). No DELETE grant to anyone.
3. Privileges:
   `REVOKE ALL ON TABLE public.payroll_payout_grants FROM PUBLIC, legend_app;`
   `GRANT SELECT (id, tenant_id, kind, step, batch_id, item_set_hash, evidence_key, ref_id, target_id, detail, actor, session_id, step_up_method, issued_at, expires_at, consumed_at, consumed_txid) ON public.payroll_payout_grants TO legend_app;` (no `secret_sha256`, no `assertion`)
   `GRANT SELECT, INSERT ON public.payroll_payout_grants TO legend_payout; GRANT UPDATE (consumed_at, consumed_txid) ON public.payroll_payout_grants TO legend_payout;`
4. `app.payout_grants_since()`: baked IMMUTABLE timestamp, same `DO $$ EXECUTE format(...)` as `app.payout_trusted_since()` in 0644. EXECUTE to legend_app, legend_payout.
5. Attestations: `ALTER TABLE payroll_payout_attestations ADD COLUMN grant_id uuid;` plus FK `(tenant_id, grant_id, kind, step, actor, session_id) REFERENCES payroll_payout_grants (tenant_id, id, kind, step, actor, session_id)`, UNIQUE `(tenant_id, grant_id)`. (The CHECK comes at the end of B.)
6. `app.payout_grant_issue(p_kind text, p_step text, p_batch uuid, p_item_ids uuid[], p_key varchar, p_ref uuid, p_target uuid, p_detail varchar, p_actor text, p_session text, p_method text) RETURNS text`, SECURITY DEFINER, `SET search_path = pg_catalog, pg_temp`, owner `legend_payout`:
   - tenant = `app.require_tenant_id()` (the grantor transaction sets `app.tenant_id`);
   - (kind, step) must be in the matrix: correction {propose, approve}; overpaid {propose, record}; return {propose, confirm}; closure {propose, approve}; posting_source {record}; else `PAYOUT-72` (22023);
   - `v_assertion := app.payout_assert_actor(v_tenant, p_actor, p_session, 'payroll.disburse.approve')` (codes 39 to 42 unchanged);
   - batch, when given, exists in the tenant;
   - `v_secret := encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex')`; insert with `secret_sha256 = encode(sha256(decode(v_secret,'hex')),'hex')`, `item_set_hash = app.payout_item_set_hash(p_item_ids)` (NULL for an empty set), `issued_at = clock_timestamp()`, `expires_at = issued_at + interval '2 minutes'`; return `v_secret`.
   - `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO legend_payout_grantor;` (never to legend_app).
7. `app.payout_grant_consume(p_tenant uuid, p_grant text, p_kind text, p_step text, p_batch uuid, p_item_ids uuid[], p_key varchar, p_ref uuid, p_target uuid, p_detail varchar) RETURNS TABLE (grant_id uuid, actor text, session_id text, assertion jsonb)`, owner `legend_payout`, no EXECUTE for anyone else:
   - `p_grant !~ '^[0-9a-f]{64}$'` or tenant not in force: `PAYOUT-70` (42501);
   - the single UPDATE of D5 (`consumed_at = clock_timestamp()`, `consumed_txid = txid_current()`), zero rows: `PAYOUT-70: no valid payout grant for this step` (42501).
8. Ownership dance of 0644 (grant SET, CREATE on schema, `ALTER FUNCTION ... OWNER TO legend_payout`, revoke both).

### B. `06NN+1_payout_trusted_steps_grant.sql`

1. `DROP FUNCTION` the old signatures (their grants go with them):
   - `app.payout_correction_propose(uuid, uuid[], varchar, text, text, text)`
   - `app.payout_correction_approve(uuid, varchar, text, text)`
   - `app.payout_overpaid_propose(uuid, uuid[], varchar, text, text, text)`
   - `app.payout_overpaid_record(uuid, varchar, uuid, text, text)`
   - `app.payout_return_propose(uuid, uuid[], varchar, text, text, text)`
   - `app.payout_return_confirm(uuid, varchar, text, text)`
   - `app.payout_proof_closure_propose(varchar, text, text, text)`
   - `app.payout_proof_closure_approve(uuid, text, text)`
   - `app.payout_posting_record_source(uuid, uuid, uuid, text, text)`
   - internal `app.payout_attest(uuid, text, uuid, text, uuid, uuid[], varchar, uuid, text, text, jsonb)`
2. Create the new ones (bodies = latest bodies after P1-2/P2-3, with only these edits: consume first, then `payout_assert_actor` on the grant's actor/session, `p_actor` becomes `v_actor` everywhere, attestation through `payout_attest` with the grant id):

   | New signature | Grant binding (kind, step, batch, items, key, ref, target) |
   |---|---|
   | `payout_correction_propose(p_batch uuid, p_item_ids uuid[], p_key varchar, p_note text, p_grant text) RETURNS uuid` | correction, propose, p_batch, p_item_ids, p_key, NULL, NULL |
   | `payout_correction_approve(p_operation uuid, p_key varchar, p_grant text) RETURNS integer` | correction, approve, batch of op, items of op, p_key, p_operation, NULL |
   | `payout_overpaid_propose(p_batch uuid, p_item_ids uuid[], p_key varchar, p_note text, p_grant text) RETURNS uuid` | overpaid, propose, p_batch, p_item_ids, p_key, NULL, NULL |
   | `payout_overpaid_record(p_item uuid, p_key varchar, p_posting uuid, p_grant text) RETURNS void` | overpaid, record, batch of item, {p_item}, p_key, p_posting, NULL |
   | `payout_return_propose(p_batch uuid, p_item_ids uuid[], p_key varchar, p_note text, p_grant text) RETURNS uuid` | return, propose, p_batch, p_item_ids, p_key, NULL, NULL |
   | `payout_return_confirm(p_claim uuid, p_key varchar, p_grant text) RETURNS integer` | return, confirm, batch of claim, items of claim, p_key, p_claim, NULL |
   | `payout_proof_closure_propose(p_key varchar, p_note text, p_grant text) RETURNS uuid` | closure, propose, stuck.batch_id, {}, p_key, NULL, NULL |
   | `payout_proof_closure_approve(p_closure uuid, p_grant text) RETURNS boolean` | closure, approve, stuck.batch_id, {}, closure key, p_closure, NULL |
   | `payout_posting_record_source(p_batch uuid, p_posting uuid, p_gl_account uuid, p_grant text) RETURNS void` | posting_source, record, p_batch, {}, NULL, p_posting, p_gl_account |
   | internal `payout_attest(p_tenant uuid, p_kind text, p_operation uuid, p_step text, p_batch uuid, p_item_ids uuid[], p_key varchar, p_binding uuid, p_grant uuid, p_assertion jsonb) RETURNS void` | reads actor/session from the grant row; sets `grant_id`; ON CONFLICT replacement of 'propose' also replaces `grant_id` |

   `detail` is NULL for all nine. Closure functions and the posting source now write their attestation through `payout_attest` (one writer). Step-two functions (correction approve, overpaid record, return confirm, closure approve) refuse when the step-one attestation of the operation has `grant_id IS NULL`: `PAYOUT-71` (23514).
   An idempotent early return (closure already proposed / already closed) happens after the consume: the grant is spent, nothing else changes.
3. `REVOKE ALL ... FROM PUBLIC` and `GRANT EXECUTE ... TO legend_app` on the nine public ones; nothing on `payout_attest`.
4. Last: `ALTER TABLE payroll_payout_attestations ADD CONSTRAINT payroll_payout_attestations_grant_check CHECK (grant_id IS NOT NULL OR attested_at < app.payout_grants_since());`
5. Ownership dance.

## 4. TypeScript

New and changed files, in order:

1. `apps/api/src/db/schema/payroll-payout.ts`: `payrollPayoutGrants` table; `grantId` on `payrollPayoutAttestations`.
2. `apps/api/src/config/env.ts`: `PAYOUT_GRANTOR_DATABASE_URL: postgresUrl.optional()`.
3. `apps/api/src/db/role.ts`: `createGrantorPool(url, options, { fallbackRole })` with `UNSAFE_GRANTOR_ROLE_SQL` (session_user matches `^legend_grant_[a-f0-9]{16}$`, member of `legend_payout_grantor`, not member of `legend_app`, no privileged attribute, owns no RLS table). Fallback (only when the env var is unset and `NODE_ENV` is development or test): a separate pool on `DATABASE_URL` with `max: 2`, and each issue transaction runs `SET LOCAL ROLE legend_payout_grantor` first. Never share the app pool (a payout transaction holds one connection while it issues).
4. `apps/api/src/db/grantor.ts` (new): lazy grantor pool (`max: 2`), closed in `server.ts` shutdown like `pool`.
5. `apps/api/src/services/payroll-payout-evidence.ts`: `assertPayoutReauth` returns `"mfa_challenge" | "password"` (the branch it passed).
6. `apps/api/src/middleware/identity.ts`: `requireTenantStepUpPassword` stores `{ userId, sessionId, method, at }` in a module `WeakMap<Request, PayoutStepUp>` after success. Export `payoutStepUpOf(req)`.
7. `apps/api/src/services/payroll-payout-grant.service.ts` (new):
   ```ts
   export type PayoutGrantBinding = {
     kind: "correction" | "overpaid" | "return" | "closure" | "posting_source";
     step: "propose" | "approve" | "record" | "confirm";
     batchId: string | null; itemIds: readonly string[]; evidenceKey: string | null;
     refId: string | null; targetId: string | null; detail?: string | null;
   };
   export type PayoutGrantIssuer = { issue(binding: PayoutGrantBinding): Promise<string> };
   export function payoutGrantIssuerOf(req: Request): PayoutGrantIssuer;
   ```
   `issue` refuses (401 `REAUTH_REQUIRED`) when no step-up record exists for `req`, when it belongs to another user or session than `getAuth(req)`, or when it is older than `PAYOUT_STEP_UP_MAX_AGE_MINUTES`. It answers 503 `PAYOUT_STEP_GRANT_UNAVAILABLE` when no grantor pool is configured. Otherwise, one short transaction on the grantor pool: `set_config('app.tenant_id', tenant, true)`, `SELECT app.payout_grant_issue(...)`, COMMIT. It returns the secret. Never log the binding together with the secret; never put the secret in an error.
8. `apps/api/src/services/payroll-payout.service.ts`: `PayoutActor` gets `readonly grants?: PayoutGrantIssuer`. Replace `payoutTrustedSessionId(actor)` with `payoutTrustedGrant(actor, binding): Promise<string>` (401 `PAYOUT_SESSION_REQUIRED` when there is no issuer, same as today without a session). Remove `payoutTrustedSessionId` once unused.
9. Call sites: issue right before each SQL call, with the exact values passed to SQL:
   - `payroll-payout-correction.service.ts`: `callCorrectionPropose` (step one, `refId: null`) and `callCorrectionApprove` (step two, `refId: operationId`, `itemIds` = the locked rows, `batchId: batch.id`). Drop `actor.userId` and session from the SQL.
   - `payroll-payout-overpaid-route.service.ts:250` (propose), `payroll-payout-overpaid.service.ts:365` (record, one grant per item).
   - `payroll-payout-manual.service.ts:1360` (return propose), `:1372` (return confirm, `refId: claimId`).
   - `payroll-payout-proof-closure.service.ts:215` / `:245` (load `batch_id` of the stuck row for the binding).
   - `payroll-payout-source.service.ts:169`.
   - `payroll-payout-proof-binding.service.ts:231` (`payout_bind_proof`) is not a money step and keeps no grant (P2-3 handles its batch check).
10. Routes: `actorOf(req)` adds `grants: payoutGrantIssuerOf(req)` in `payroll-payout-correction.routes.ts`, `payroll-payout-overpaid.routes.ts`, `payroll-payout-return.routes.ts`, `payroll-payout-proof-closure.routes.ts`, `payroll-payout.routes.ts` (posting source route). All five already mount `stepUp` and `passwordStepUp`; keep that order.
11. Recon: `payroll-payout-recon.service.ts`. Load the grant columns (column SELECT) for the attestations of the batch. For each attestation with `attested_at >= payout_grants_since()`: flag `grant_missing` when there is no `grant_id` or no grant row. Flag `grant_mismatch` when the grant is not consumed, `consumed_at > expires_at`, or any of actor, session, kind, step, batch or evidence key differs, or `consumed_txid <> attestation.txid`. Attestations before the boundary are skipped like `trusted_since`.
12. Provisioning: `apps/api/src/db/provision-roles.ts` (`GRANTOR_LOGIN`, `provisionGrantor`, `auditGrantor`: member only of `legend_payout_grantor`, no table/sequence rights, no default privileges, EXECUTE only `app.payout_grant_issue(text, text, uuid, uuid[], varchar, uuid, uuid, varchar, text, text, text)`), `apps/api/src/provision-roles.ts`, `deploy/single-vm/provision-roles.sh`, `deploy/single-vm/runtime.env.example`, `deploy/single-vm/compose.yaml`, `deploy/single-vm/check-compose-env.mjs`, `.env.example` (key name only), `docs/deployment.md`.
13. Tests helpers: `apps/api/src/test/payroll-payout-fixtures.ts` gains `testGrantIssuer(actor)` (owner connection, `SET LOCAL ROLE legend_payout_grantor`, real COMMIT), and actor helpers attach it. Update the direct SQL calls in `payroll-payout-905-followups.test.ts`, `payroll-payout-905-posting-source.test.ts`, `payroll-payout-881-guard.test.ts`, `data-import-registry.test.ts`, and the 911 tests already in the worktree, to the new signatures.

## 5. Test cases

New file `apps/api/src/test/payroll-payout-911-grants.test.ts`. The adversarial cases run as `SET LOCAL ROLE legend_app` with a real COMMIT, never as owner, with no trigger disabled. Cases 1 to 3 must fail on tip `5eeaa683d` (fail-first proof).

1. `[911-grant-forged-sessions-refused]` (the scenario from the finding): failed item resolved by two people, valid PDF and binding, two real finance users with live, fresh MFA sessions. As `legend_app`, call correction propose and approve, then return propose and confirm, with a made-up 64-hex grant. Expect `PAYOUT-70` each time. Item status, proposals, attestations, postings and journals are unchanged.
2. `[911-old-signatures-gone]`: `to_regprocedure(...)` is NULL for the nine old `(…, text, text)` signatures.
3. `[911-app-cannot-issue]`: `legend_app` runs `app.payout_grant_issue(...)`: 42501, and no grant row is created.
4. `[911-app-cannot-read-or-write-grants]`: `SELECT secret_sha256` / `assertion` gives 42501. INSERT, UPDATE and DELETE give 42501. `SELECT id, actor, consumed_at` works (recon). `app.payout_grant_consume` and `app.payout_attest` give 42501.
5. `[911-grant-replay-refused]`: a grant spent by propose; the same secret on a second call gives `PAYOUT-70`.
6. `[911-grant-expired-refused]`: a grant past `expires_at` (fixture: superuser moves `issued_at`/`expires_at` back) gives `PAYOUT-70`, and the grant stays unconsumed.
7. `[911-grant-binding-matrix]`: one valid grant each, spent with another kind, step, batch, item set, evidence key, ref, target, or tenant in force. Every case gives `PAYOUT-70`, and the grant stays unconsumed.
8. `[911-grant-same-actor-refused]`: the proposer gets a valid approve grant. Approve gives `PAYOUT-64`, nothing moves, and the grant stays unconsumed (rollback).
9. `[911-grant-concurrent-consume]`: two connections spend one grant at once. Exactly one succeeds; the other gets `PAYOUT-70`.
10. `[911-issue-checks-actor]`: issue with a revoked session, with MFA older than 15 minutes, with no `payroll.disburse.approve`, or with a banned user. Each gives codes 40/41/42/39, and no grant row is created.
11. `[911-grant-happy-path]` (through the service and the real issuer, READ COMMITTED): two people correct an item. Both attestations have `grant_id`; each grant is consumed with `consumed_txid = attestations.txid`; the journal is posted once.
12. `[911-attestation-needs-grant]`: as `legend_payout` (structural test), insert an attestation after the cutover with `grant_id` NULL. Expect 23514.
13. `[911-step-two-needs-granted-step-one]`: a step-one attestation from before the boundary (fixture) followed by a granted approve gives `PAYOUT-71`, and nothing moves.
14. `[911-issuer-requires-step-up]` (route level): with a stale challenge and no password, the response is 401 `REAUTH_REQUIRED` and the grant count does not change. Calling `payoutGrantIssuerOf` on a request without a step-up record also refuses.
15. `[911-grantor-pool-guard]`: `createGrantorPool` refuses a `legend_app` login and a superuser.
16. `[911-recon-grant]` in `payroll-payout-905-recon.test.ts`: a clean granted operation gives zero flags. Then a superuser fixture changes `grant.actor` (FK triggers disabled for the fixture only): `grant_mismatch`, and the slip is held.
17. `tests/db-role-provisioning.test.mjs`: the grantor login audit passes. It fails when the login holds any table right or EXECUTE on another function.
18. For all four kinds and the posting source, the existing 905 happy-path tests stay green on the new signatures.

## 6. Founder gate (via CTO)

Production needs a new runtime secret, `PAYOUT_GRANTOR_DATABASE_URL`, and one `provision-roles` run with it before payout money steps work again. Until then, correction, overpaid, return, proof closure and posting source are refused with 503. No money moves without the grant.
