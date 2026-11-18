# Design: key rotation re-seal for ChatGPT tokens and push subscriptions (legend-rj284)

Status: design, 17 Nov 2026. Owner: architect (xhigh, keys and access). Read-only
design; no product code changed. Base: `origin/milestone/m1` 1b0fd2a9e plus the
995 branch `ghostex/995-refund-voucher-hardening-kecil` 892f58a11 (legend-h1da5
leftover). Tier K (keys/access): every card gets one architect review; one Codex
second opinion for the whole "key rotation" area before the release gate.

## 1. Problem in one paragraph

The weekly `sealed-secret-reseal` job moves every `sealSecret` column to the active
data key so an old key can retire. Two sealed stores are still outside it
(`apps/api/src/worker/sealed-secret-reseal.job.ts:8-11`, `:116-122`):
`ai_chatgpt_connections.tokens_encrypted` / `pending_encrypted`, and
`push_subscriptions.subscription_ciphertext`. Until both move, no old data key can
retire: retiring it would silently disconnect every tenant's ChatGPT connection
and drop every saved push subscription.

### Correction to the card's premise

The card says `SealedSecretColumn` cannot do a per-user AAD. It can: `extra`
selects any column for the AAD builder, and `mfa_factors` already uses
`extra: ["user_id"]` (`sealed-secret-reseal.job.ts:123-131`). The real push gap is
different: `push_subscriptions.key_version` (`v<N>`, written next to the
ciphertext, `lib/push-subscription.ts:46-62`) is a second column the registry
cannot update. The ChatGPT gap is real and is about concurrency, not AAD.

## 2. Facts the design rests on

ChatGPT (`apps/api/src/services/ai-chatgpt.service.ts`):

- One row per tenant (`db/schema/ai-chatgpt.ts:53`), two sealed text columns, no
  key version column. AAD `ai_chatgpt:<tenantId>:<rowId>:<pending|tokens>` (`:60`).
- Per-tenant advisory lock `pg_advisory_xact_lock(hashtextextended('ai_chatgpt:<tenant>', 0))`
  (`:75-79`), then `read(tx, tenant, true)` = `SELECT ... FOR UPDATE` (`:86`).
- Operations are leased: start (`:395`), poll claim (`:484-492`) and refresh claim
  (`:745-755`) set `operation_id` + `operation_lease_until = now + 2*AI_TIMEOUT_MS + 10s`
  (`:64`) under the lock, call OpenAI outside any transaction, then save.
- Saves are compare-and-set on the ciphertext: poll save
  `operationWhere AND pending_encrypted = <read value>` (`:544-549`, no lock),
  refresh save `operationWhere AND tokens_encrypted = <read value>` (`:827-839`,
  under the lock). A save that misses the CAS stores nothing and returns `null`
  (`:873`).
- Business impact of a missed save: OpenAI has already rotated the refresh token
  (refresh) or consumed the device code (poll). The new tokens are gone, the stored
  old refresh token no longer works, and the tenant's Tanya AI stops on ChatGPT
  until the owner reconnects; `null` credentials also read as "auth" to the
  gateway, which falls back to the tenant's own paid API key where one is set.
  **A re-seal must never change a ciphertext an operation has read.**
- `credentialVersion = sha256(tokens_encrypted)` (`:51`) fences
  `invalidateChatgptConnection` (`:665-679`). It is issued per request
  (`ai-provider-config.service.ts:641-659`), not cached.
- `updated_at` is the AI answer cache key (`chatgptConnectionVersionOf`, `:884-896`
  -> `ai-provider-config.service.ts:780` -> `ai-gateway.service.ts:1008`). Claim and
  release keep it unchanged on purpose.
- `pending_encrypted` is only cleared by a later poll, invalidate, disconnect or a
  new start (`:381`, `:470`, `:536`); an abandoned device code stays forever.
- No triggers; FORCE RLS per tenant; `legend_app` has table UPDATE (`drizzle/0315`,
  `0001_tenant_rls.sql:35-49`).

Push (`apps/api/src/lib/push-subscription.ts`, `services/notification-center.ts`):

- `subscription_ciphertext` holds sealed JSON `{endpoint, keys}`; AAD
  `push-subscription:<tenantId>:<userId>` (`:36-37`); `key_version` = `v<envelope byte>`.
- `key_version` is written by the subscribe upsert (`notification-center.ts:509`)
  and checked only for presence (`:409`); nothing reads it for decisions.
- Writers: subscribe upsert `ON CONFLICT ... DO UPDATE SET subscription_ciphertext, key_version`
  (`:509`), unsubscribe (`:555`), 410 cleanup (`web-push-provider.ts:252`),
  `last_success_at` (`:300`), session/device delete functions (0369-0371).
  Readers open at send time (`web-push-provider.ts:149`, `notification-adapters.ts:1641`);
  no copy of the ciphertext lives in job payloads or caches.
- `id` plain uuid; FORCE RLS per tenant; no UPDATE trigger; table-level GRANT.

Job (`sealed-secret-reseal.job.ts`, with 995 applied):

- Stale = envelope version byte < active, read in SQL (`staleSql`, `:390`).
- Per batch: `SELECT ... FOR UPDATE OF t SKIP LOCKED`, reseal each row with the
  first AAD that opens it, `UPDATE ... WHERE <col> = <read value>` (CAS, `:537`);
  cursor in `sealed_secret_reseal_state` (generic text keys, no CHECK, `0434`).
- `remaining` counts every stale row (locked or not); retirement needs
  `remaining == 0` including `frozen` and `aborted == false` (`:12-14`, `:44-46`).
- 995 adds `AbortSignal.any([timeout, job.signal])` and locked-row tests in the
  same file.

## 3. Options

### Option A: everything in the generic registry

Three registry entries. New `SealedSecretColumn` fields: `versionLabel` (push) and
`busyWhere` (static SQL: rows skipped this pass but still counted in `remaining`)
for the ChatGPT lease. The row lock from `FOR UPDATE SKIP LOCKED` plus CAS replaces
the advisory lock.

- For: one code path, one report.
- Against: the lease protocol (what "busy" means, which columns must stay
  untouched, `updated_at` as cache key) is copied as SQL strings into the worker,
  far from the service that owns it. The next change to claim/save in
  `ai-chatgpt.service.ts` will not see the reseal rule. The AAD is rebuilt from
  `id::text` instead of the service's own `aad(row)`. Two entries for one row means
  two UPDATEs and two locks per tenant.

### Option B (recommended): push in the registry, ChatGPT owned by its service

- Push: one registry entry plus a small `versionLabel` field.
- ChatGPT: `resealChatgptConnectionAny(tx, tenantId, active)` in
  `ai-chatgpt.service.ts`, using the service's own lock key, `read()`, `aad()` and
  CAS shape. The job calls it through a new `SEALED_SERVICE_SWEEPS` hook, per tenant,
  and still counts `remaining` itself with `staleSql`, so the retirement rule has
  one source of truth.
- For: the lease rule lives next to claim/save and is reviewed with them; the AAD
  is identical by construction; one UPDATE per tenant for both columns.
- Against: one more sweep kind in the job (small: one row per tenant, no cursor).

### Option C: no background reseal for ChatGPT

Rely on refresh rewriting `tokens_encrypted` under the active key, clear expired
`pending_encrypted`, disconnect idle tenants before retirement.

- Against: an idle connected tenant never refreshes, so `remaining` never reaches 0
  without a forced OpenAI call or a forced disconnect (owner must reconnect).
  Rejected.

|                             | A                        | **B**                      | C                   |
| --------------------------- | ------------------------ | -------------------------- | ------------------- |
| Race safety vs refresh/poll | good if SQL kept in sync | **good, owned by service** | best (no reseal)    |
| Retirement reachable        | yes                      | **yes**                    | no for idle tenants |
| Code touched                | job only                 | **job + ChatGPT service**  | service + ops step  |
| Migration                   | none                     | **none**                   | none                |

## 4. Recommended design (Option B)

### 4.1 Job framework (`sealed-secret-reseal.job.ts`)

1. `SealedSecretColumn.versionLabel?: { column: string; value(active: number): string }`.
   When set, the CAS UPDATE also sets `<column> = value(active)` in the same
   statement. The CAS stays on the ciphertext only; the stale filter stays on the
   envelope byte (the label is never trusted).
2. Service sweep hook:

   ```ts
   export type SealedServiceSweep = {
     table: string; // static identifier
     columns: readonly string[]; // sealed text columns, tenant scope
     /** One tenant, inside withTenant(jobContext). Never throws for one bad row,
      *  never logs values. busy = skipped this pass (still stale). */
     reseal(
       tx: Transaction,
       tenantId: string,
       active: number,
     ): Promise<
       Record<string, { resealed: number; failed: number; busy: number }>
     >;
   };
   export const SEALED_SERVICE_SWEEPS: readonly SealedServiceSweep[] = [];
   ```

   The job loops `listAllTenantIds()`, checks `options.signal` between tenants
   (sets `aborted`), calls `reseal` in its own `withTenant` transaction, then counts
   `remaining` per column with the existing `countRows`/`staleSql` (synthetic
   `{ table, column, scope: "tenant", encoding: "text" }`) in a SEPARATE
   transaction, so a `reseal` that throws (pool timeout, deadlock) still leaves its
   stale rows in `remaining`; the throw adds the tenant to `failedTenants`, like a
   registry scope does today (995 job `:798`, `:838`). With `options.reportOnly`
   the sweep is never called: only the count runs (same contract as the registry
   and JSON sweeps, `:575`, `:710`). Report keys `<table>.<column>`, with optional
   `busy` added to `SealedSecretColumnReport`. Same test rule as
   `SEALED_JSON_SECRETS`: a non-empty `columns` option skips the sweep unless
   `serviceSweeps` is passed.

3. Header comment (`:1-14`, `:116-122`): remove ChatGPT and push from "not
   covered".

### 4.2 Push entry

```ts
{
  // lib/push-subscription.ts associatedData()
  table: "push_subscriptions",
  column: "subscription_ciphertext",
  scope: "tenant",
  encoding: "text",
  extra: ["user_id"],
  versionLabel: { column: "key_version", value: (v) => `v${v}` },
  aad: (r) => [`push-subscription:${r.tenantId}:${r.extra[0]}`],
}
```

Interleavings, all safe without new code:

- Subscribe upsert vs reseal: both take the row lock. Upsert first: the row is
  already sealed under the active key (not stale) or the CAS misses (0 rows, not
  failed). Reseal first: the upsert waits on the row lock, then overwrites with a
  fresh value sealed under the active key. Either order ends under the active key.
- Unsubscribe / 410 cleanup / device delete: the CAS updates 0 rows.
- `last_success_at` update: serialized by the row lock, different column.
- Readers: the ring keeps the old key until retirement, so a value read just before
  the reseal still opens.

AAD form: `user_id::text` must equal the `userId` string the writer used. A
round-trip test through `createPushSubscriptionProtector().seal` and
`openPushSubscription` is mandatory (test P1).

### 4.3 ChatGPT: `resealChatgptConnectionAny`

In `ai-chatgpt.service.ts`, exported, `Any` suffix (job-only caller):

1. Factor the lock key into `lockKey(tenantId)` used by `lock()` and a new
   `tryLock()` = `pg_try_advisory_xact_lock(hashtextextended(lockKey, 0))`.
   Not acquired: return `busy` for every stale column. The job never waits on a
   user's request.
2. `read(tx, tenantId, true)` (row lock). No row: zeros.
3. Busy rule: `operation_id IS NOT NULL AND operation_lease_until > now() -
interval '10 minutes'`, so busy during every operation and for a 10-minute
   margin after its lease, because a save may land after the lease
   (`2*AI_TIMEOUT_MS + 10s`). Every save carries `operation_id` in its WHERE
   (`operationWhere`, `:303-310`, used at `:433`, `:546`, `:838`), so this rule
   covers start, poll and refresh. An operation whose process died (lease expired
   more than 10 minutes ago) or a row with `operation_id` but no lease (no setter
   does that today) does not block the row forever.
4. For each non-null column with `sealedVersion < active`: open with
   `aad(row, kind)`, seal with the same AAD. Open failure: `failed`, the row is left
   as is. **Never invalidate or disconnect from the job**: the live path owns state
   changes.
5. One UPDATE for both columns:
   `SET <changed columns>, updated_at = updated_at`
   `WHERE tenant_id = ? AND id = ? AND generation = ? AND operation_id IS NOT DISTINCT FROM ?`
   `AND tokens_encrypted IS NOT DISTINCT FROM ? AND pending_encrypted IS NOT DISTINCT FROM ?`.
   Leave unchanged: `updated_at` (otherwise the tenant's AI answer cache drops,
   which means extra upstream calls), `generation`, `operation_id`, lease,
   `next_poll_at`, `status`, `expires_at`. No audit row (not a business change; the
   job reports counts).
6. Runs even when `AI_CHATGPT_ENABLED` is off: the data must stay readable if
   ChatGPT is re-enabled after retirement.
7. Abandoned `pending_encrypted` is resealed like any other value (plaintext
   unchanged); no cleanup is added here.

Why every interleaving is safe:

| Order                                                   | Result                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Claim (lease) committed, then reseal                    | busy, untouched; the save writes under the active key; the next run sees nothing stale                |
| Reseal holds the lock, then a claim arrives             | claim waits on the advisory lock, then reads the resealed row; its CAS compares against the new value |
| Claim holds the lock, then reseal arrives               | try-lock fails: busy                                                                                  |
| Start/poll save without the lock, after a reseal        | impossible within the lease + 10 minutes (busy); later, the operation is dead                         |
| Reseal CAS misses (row changed between read and update) | 0 rows, counted neither resealed nor failed, retried next run                                         |

Accepted residual: a request holding a `credentialVersion` issued before the
reseal gets a 401, and its `invalidateChatgptConnection` is a no-op (the envelope
changed). The next request gets the resealed envelope and a new version, and its
401 invalidates. Cost: at most one extra failed upstream call per tenant per
rotation. Fixing it would need a token sequence column; not worth a migration.

### 4.4 Retirement rule (operator)

An old version may leave `DATA_ENCRYPTION_KEYS` only when the latest
`sealed-secret-reseal` report has ALL of: `aborted == false`, `failedTenants == 0`,
`failed == 0` and `remaining == 0` (frozen included) for every key, now including
`push_subscriptions.subscription_ciphertext`,
`ai_chatgpt_connections.tokens_encrypted` and `ai_chatgpt_connections.pending_encrypted`,
plus the existing `rotate-data-key` and `hris-pii-reseal` checks
(`docs/deployment.md:379-430`). The job header (`:12-14`) must say the same
(today it names only `remaining`, frozen and `aborted`).

A stale value that cannot be opened stays `failed` and blocks retirement on
purpose; the job never deletes or disconnects. The log names the tenant (never the
value). Operator step, per tenant, after a second run still shows it:

- ChatGPT: the tenant owner disconnects ChatGPT in Tanya AI settings and connects
  again (the live path also invalidates it on next use, `openTokens` catch). The
  disconnect clears both columns.
- Push: delete that tenant's unreadable `push_subscriptions` rows by id; the device
  registers again the next time the app opens. Users on that device miss
  notifications until then.

Retiring with `failed > 0` means choosing that loss for those tenants; it needs
CTO sign-off.

## 5. Migrations

None.

- The stale filter reads the envelope byte, so no version column is needed for
  ChatGPT (same choice as the 17 registry columns).
- `push_subscriptions.key_version` exists already.
- `sealed_secret_reseal_state` keys are free text without a CHECK (`0434`), and the
  ChatGPT sweep needs no cursor (one row per tenant).

`pnpm db:generate` must stay empty on every card.

## 6. Release order

0. The 995 branch (892f58a11) reaches `milestone/m1` first: it changes the same job
   file (abort signal) and its tests. All cards branch from m1 after that merge.
1. K1 and K2 in parallel (separate files).
2. K3 after K1 and K2 merge (wires the sweep, retirement test).
3. K4 (docs) in parallel with K3.
4. One Codex second opinion over K1-K3 together (area "key rotation"), before the
   release gate. It does not block K4.
5. Production: deploy, let the Sunday 03:30 run (or a manual run) finish, check the
   report, and only then do the second rollout that drops the old key.

## 7. Mandatory tests

Fail-first: each test must fail on m1 (sweep absent, column not covered) and pass
after the card. Two-version ring via `vi.hoisted` env (`sealed-secret-reseal-job.test.ts:44-48`)
or `vi.resetModules` + `vi.stubEnv` (`sealed-secret-reseal-voucher-idempotency.test.ts:59-66`);
gate-promise interleaving from `ai-chatgpt-review-b.test.ts:447-516` (`rawConnection`,
`seedConnected`, `revokedTokens`).

ChatGPT, K2 (`src/test/ai-chatgpt-reseal.test.ts`):

- T1 reseal during refresh: tokens near expiry, `tokenReply` held at a gate after
  the claim; reseal reports busy and leaves the row byte-identical; release the gate,
  the refresh saves, the new tokens open and are under the active key, no
  invalidate, credentials not `null`.
- T2 refresh after reseal holds the lock: a test transaction runs the reseal and
  holds commit at a gate; `getChatgptCredentials` (refresh needed) waits; release,
  the claim reads the resealed row, the refresh save CAS succeeds.
- T3 reseal during device-code poll: same as T1 with `pendingPoll`; the poll save
  succeeds and the connection becomes `connected`.
- T4 lease margin: lease expired 1 minute ago means busy; `operation_id` stuck with
  the lease expired 11 minutes ago means resealed.
- T5 try-lock: another transaction holds `lock()`, so reseal returns busy at once
  (bounded test timeout, no wait).
- T6 idempotent: a second run reseals 0 and leaves the ciphertext byte-identical;
  `updated_at`, `generation`, `operation_id`, lease and audit count are unchanged
  after the first run too; the plaintext is equal.
- T7 broken envelope (wrong AAD): `failed` 1, the row is unchanged and still `connected`.
- T8 fence residual: invalidate with a `credentialVersion` from before the reseal is
  a no-op; a fresh one invalidates.

Push, K1 (`src/test/sealed-secret-reseal-push.test.ts`):

- P1 round trip: seal under v1 through the real protector, set v2 active, run;
  `resealed` 1, `key_version = 'v2'`, `openPushSubscription` (with `endpoint_hash`)
  opens it.
- P2 locked row: another connection holds `FOR UPDATE`; `remaining` 1, nothing
  failed; after release the rerun reseals.
- P3 idempotent: the second run reseals 0; ciphertext and `key_version` are unchanged.
- P4 per-user AAD: swap `user_id` to another user: `failed` 1, row unchanged.
- P5 a delete between select and update (test hook or a deleted row id): 0 rows, not failed.
- P6 versionLabel is only set when the CAS hits: a CAS miss leaves key_version unchanged.

Retirement, K3 (`src/test/sealed-secret-reseal-retire.test.ts`):

- R1 full rotation: seed ChatGPT tokens, ChatGPT pending and push under v1; set v2
  active and run the whole job; `remaining` 0 for the three keys and `aborted` false.
  Reload with a ring WITHOUT v1: `getChatgptCredentials` returns the tokens, the poll
  path opens pending and `openPushSubscription` opens. Envelopes captured before
  the reseal fail `openSecret` under the v2-only ring (old token cannot be opened
  after rotation).
- R2 busy ChatGPT row: `remaining` 1 and `busy` 1, so the report is not
  retirement-ready.
- R3 abort between tenants: `aborted` true and unreached tenants absent.
- R4 rerunning the whole job at the same active version changes nothing (all
  counts 0, bytes identical).
- R5 reportOnly: a report-only run counts the three keys and changes nothing (ChatGPT sweep not called; bytes, updated_at identical).
- R6 sweep throws for one tenant (stub sweep that throws): that tenant is in failedTenants, its stale rows still count in remaining, other tenants are resealed.

## 8. Cards for engineers (separate file areas)

| Card                      | Files                                                                                                                                                                | Depends                 | Who                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| K1 Job framework + push   | `apps/api/src/worker/sealed-secret-reseal.job.ts`, `apps/api/src/test/sealed-secret-reseal-push.test.ts` (new)                                                       | 995 merged              | engineer Sonnet 5.5 high; architect review (xhigh)                          |
| K2 ChatGPT service reseal | `apps/api/src/services/ai-chatgpt.service.ts`, `apps/api/src/test/ai-chatgpt-reseal.test.ts` (new)                                                                   | none (parallel with K1) | engineer Sonnet 5.5 high (Opus after one failure); architect review (xhigh) |
| K3 Wire + retirement test | `sealed-secret-reseal.job.ts` (registry line only), `apps/api/src/test/sealed-secret-reseal-retire.test.ts` (new)                                                    | K1, K2                  | engineer Sonnet 5.5 high; architect review                                  |
| K4 Docs                   | `docs/deployment.md` (379-430 coverage + retirement checklist, incl. failed/failedTenants and the unreadable-row operator step), `docs/DECISIONS.md` (D-entry below) | K1, K2 design frozen    | tech-writer Sonnet 5.5                                                      |

Proof of done per card: listed tests pass via `LEGEND_TEST_FILES`, `db:generate`
empty, prettier check on changed files, one typecheck of `apps/api` through `heavy`.

Proposed decision text for K4:

> **Key rotation covers ChatGPT tokens and push subscriptions (legend-rj284).** Push
> subscriptions are moved by the generic reseal registry and the job keeps their
> `key_version` label in step. ChatGPT tokens are moved by their own service under
> the connection lock and never while an OpenAI call is in flight (plus 10 minutes),
> so a rotation cannot lose a refreshed token or an approved device code. An old key
> retires only when the weekly report shows nothing left, including these.

## 9. Risks

- Lease margin: a process paused for more than 10 minutes mid-refresh (VM freeze)
  could lose a token. Bounded by `AI_TIMEOUT_MS`; accepted.
- Retiring a key too early disconnects ChatGPT for every tenant and drops push
  subscriptions (users get no notifications until their device re-registers). Only
  mitigation: the operator rule in 4.4; K4 writes it into the runbook.
- AAD drift: a future change to either writer's AAD without the reseal breaks the
  reseal (it then counts as `failed`, not data loss). T6/P1 catch it.
- 995 must merge first or K1/K3 conflict in the job file.
- A row that will not open blocks retirement until the operator step in 4.4 runs; that is deliberate (no silent loss).
