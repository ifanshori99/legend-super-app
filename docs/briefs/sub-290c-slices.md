# Sub-brief 290c: slices and shared interfaces (legend-m4p5, legend-wa4hp)

Worktree: `.worktrees/m4p5-rewards`, branch `ws/m4p5-rewards` (base `ws/ws08-111j`, 290a done). Source of truth:
`docs/briefs/290c-m4p5-rewards-missions.md`, `docs/briefs/290-aturan-bersama.md` (B5-B13, B16),
`docs/design/ws08-member-loyalty.md` §M5 (lines 260-305), §M6 step 8 (359-369), §3 0195 (562-614), §7.
Contract `packages/shared/src/crm/*` wins on shapes/enums/error codes. Paths are under `apps/api/src` unless they start
with `packages/`, `apps/` or `docs/`. Edit ONLY the files of your slice. Do not commit. Do not run `pnpm check`,
full `pnpm test`, or `pnpm db:generate` (the engineer does). You may run, from the worktree root (`cd` there, print
`pwd`): `LEGEND_TEST_FILES="src/test/<file>.test.ts" pnpm test`, `pnpm exec eslint <files>`, and at most once at the end
`heavy pnpm --filter @starter/api typecheck`. Every shared-registry edit goes in its own block with a `// legend-m4p5`
comment (wa4hp edits: `// legend-wa4hp`). Read 290a code for patterns: `db/member-scope.ts`, `middleware/member.ts`,
`services/point-ledger.service.ts`, `services/loyalty-earn-consumer.ts`, `routes/member.routes.ts`,
`routes/loyalty-program.routes.ts`, `test/member-loyalty-helpers.ts`, `db/schema/crm-member.custom.sql`.

## Fixed facts (decided, do not change)

- Migration `apps/api/drizzle/0207_*.sql`, journal `when` 1794286000000, `prevId` = 0203 snapshot id. Engineer runs
  `db:generate` and appends the custom SQL. Custom SQL lives in `db/schema/crm-rewards.custom.sql`.
- FK rule (`docs/plan/contracts.md` "Migrations: foreign keys into FORCE RLS tables"): NEVER `NOT VALID`. New tables:
  FK inline in CREATE TABLE (pattern 1). `vouchers` → `customer_profiles`: pattern 2 (`NO FORCE` both, ADD CONSTRAINT,
  `FORCE` both again) and an entry in `MIGRATION_DATA_STATEMENTS` (`test/data-import-registry.test.ts`, key
  `0207_<name>.sql`). (Same accepted deviation as 290a's `orders` FK.)
- Ledger: write ONLY via `postLedgerEntry` (`services/point-ledger.service.ts`), never touch `points_balance`.
  Redeem row: `type:'redeem'`, `points:-cost`, `sourceType:'reward_redemption'`, `sourceId`=redemption id,
  `event:{rewardId}` (emits `points.redeemed`). Restore row (cancel/expiry): `type:'adjust'`, `points:+pointsSpent`,
  `sourceType:'adjustment'`, `sourceId`=redemption id, `reversesEntryId`=redeem row id, `expiresAt:null`,
  `reason:'redemption_cancelled'|'redemption_expired'`, emits `points.adjusted` `{kind:'restore', reversesEntryId}`.
  Mission points: `type:'bonus'`, `sourceType:'mission'`, `sourceId`=mission_progress id,
  `expiresAt = addMonthsUtc(paidAt, program.expiryMonths)` (same as earn, consumer line ~419).
- Lock order everywhere: `withProfileLock(tx, tenantId, profileId)` FIRST, then `rewards ... FOR UPDATE`, then
  redemption/voucher rows. Never the other way (deadlocks).
- Voucher reward: voucher code = the redemption code. `vouchers` row: `codeHash = hashPromoCode(code)` (from
  `crm-promo-engine.ts`), `promotionId:null`, `customerProfileId`, `source:'loyalty_reward'`, `status:'issued'`,
  `valueIdr = reward.voucherValueIdr`, `validFrom = now`, `validUntil = redemption.expires_at`. The cashier applies it
  through the existing POS voucher flow (`resolveCode` supports `promotionId:null`).
- Mission voucher reward: same voucher shape, code = new random redemption-style code, stored on
  `mission_progress.voucher_id` + `voucher_code` (so the member can see it).
- Redemption code: 10 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` via `crypto.randomInt`; unique per tenant (retry on
  unique violation at most 3x).
- New error code (additive): `REDEMPTION_NOT_CANCELLABLE` 409, "Penukaran ini tidak bisa dibatalkan." Used when the
  redemption is not `pending`, or its voucher is no longer `issued` (already used).
- Fulfil and voucher rewards: `fulfil` of a voucher reward only succeeds when its voucher is already `redeemed`
  (copies `orderId = voucher.redeemedOrderId`); otherwise 422 `VOUCHER_INVALID`. Item rewards: fulfil marks it
  fulfilled (adding the zero-price line to the POS order is NOT in this card; TBD-verify for CTO).
- Expiry job: pending redemptions with `expires_at <= now`: voucher reward whose voucher is `redeemed` → status
  `fulfilled` (`fulfilled_at = voucher.redeemed_at`, `order_id = voucher.redeemed_order_id`); otherwise → `expired` +
  restore + stock back + voucher `cancelled`. Re-run posts nothing.
- Refunds/voids do not undo mission progress in m1 (design 609).

## Slice C — contract (packages/shared only)

Files: `packages/shared/src/crm/{endpoints,errors,events,loyalty,promo,crm}.ts`. Additive only:
1. `loyalty.ts` `rewardObjectSchema`: add `perCustomerLimit: positive int .nullable()`, `redemptionValidDays: int
   1..365`. `createRewardInputSchema` (endpoints.ts) makes both optional (defaults null / 30). Reward redemption
   schema: add `rewardType: rewardTypeSchema`, `expiresAt: iso`, `voucherId: uuid.nullable()`,
   `fulfilledOutletId: uuid.nullable()` (keep strict; additive response fields).
2. `promo.ts` `voucherSourceSchema` + `loyalty_reward`.
3. `errors.ts`: `REDEMPTION_NOT_CANCELLABLE` (status + message).
4. `events.ts`: `points.adjusted` in `crmEventNames`, payload `{customerProfileId, points (positive), kind:
   'restore'|'manual', reversesEntryId: ulid nullable, sourceType:'adjustment', sourceId: uuid|ulid nullable, reason:
   string nullable, liabilityIdr: nonneg, balanceAfter}`; register in `payloadSchemas` and the event registry that
   `crmEvents` uses (find it; `aggregateType` like `points.redeemed`).
5. `endpoints.ts`: `cancelMemberRedemption` POST `/api/member/redemptions/:redemptionId/cancel` (no body, response
   redemption); `listMemberRedemptions` GET `/api/member/redemptions` (cursor page of redemption); `fulfilRedemption`
   POST `/api/loyalty/redemptions/fulfil` body `{redemptionCode, outletId: uuid, orderId: ulid optional}` response
   redemption. Add `redemptionIdParams` if absent.
6. `crm.ts` `missionWithProgressSchema`: add `voucherCode: redemptionCodeSchema.nullable()` (always present).
Then point-ledger `eventFor` support is slice R's job, not yours. Run `heavy pnpm --filter @starter/shared typecheck`.

## Slice S — schema + custom SQL

Files: `db/schema/crm-rewards.ts` (new), `db/schema/crm-rewards.custom.sql` (new), `db/schema/index.ts` (export),
`db/schema/crm-promo.ts` (vouchers source CHECK + `loyalty_reward`), `db/schema/crm-ledger.ts` (point_earn_records
add `applied_reversal_ids text[] NOT NULL DEFAULT '{}'` for wa4hp), `test/data-import-registry.test.ts` (0207 entry).
Tables (all `tenant_id` NOT NULL, unique keys include tenant, `unique(tenant_id,id)`):
- `rewards`: id uuid, tenant_id, name, description, type (CHECK free_item|item_upgrade|voucher), points_cost int >0,
  stock int null CHECK >=0, valid_from, valid_until null, menu_item_id uuid null (composite FK to menu_items if it has
  `unique(tenant_id,id)`), voucher_value_idr null, is_active, sort_order, per_customer_limit int null CHECK >0,
  redemption_valid_days int NOT NULL default 30 CHECK 1..365, created_by text null, created_at, updated_at. CHECK:
  voucher ⇒ value NOT NULL and menu_item NULL; else menu_item NOT NULL and value NULL.
- `reward_redemptions`: id, tenant_id, reward_id (FK rewards), customer_profile_id (FK customer_profiles), order_id
  ulid-in-uuid null (FK orders), points_spent int >0, status CHECK pending|fulfilled|cancelled|expired default pending,
  redemption_code varchar(32), idempotency_key varchar(100), redeemed_at, fulfilled_at, cancelled_at, expires_at NOT
  NULL, ledger_entry_id (ulid of point_ledger, FK if `unique(tenant_id,id)` exists), voucher_id uuid null (FK
  vouchers), fulfilled_outlet_id null (FK outlets), fulfilled_by text null, restore_entry_id null, created_at,
  updated_at. Unique `(tenant_id, customer_profile_id, idempotency_key)`, `(tenant_id, redemption_code)`. CHECKs:
  fulfilled ⇔ fulfilled_at, cancelled ⇔ cancelled_at. Index `(tenant_id, status, expires_at)`,
  `(tenant_id, customer_profile_id, reward_id)`.
- `missions`: id, tenant_id, name, description, type CHECK, rule jsonb, reward jsonb, period jsonb, is_active,
  starts_at null, ends_at null, created_by, created_at, updated_at.
- `mission_progress`: id, tenant_id, mission_id (FK), customer_profile_id (FK), period_key varchar(32), progress int
  >=0, target int >0, completed_at null, reward_issued_at null, voucher_id null (FK vouchers), voucher_code varchar(32)
  null, created_at, updated_at. Unique `(tenant_id, mission_id, customer_profile_id, period_key)`.
Custom SQL (pattern `crm-member.custom.sql`, `sales-targets.custom.sql`): `app.enforce_tenant_rls` on all 4;
`app.enforce_member_rls` on `reward_redemptions`, `mission_progress`, `vouchers`; REVOKE DELETE, TRUNCATE on the 4 new
tables from legend_app; trigger `reward_redemptions_status_guard` BEFORE UPDATE rejecting any status change other than
`pending → fulfilled|cancelled|expired` and any change of reward_id/customer_profile_id/points_spent/redemption_code/
idempotency_key; vouchers CHECK `source` replaced (+ `loyalty_reward`); vouchers FK pattern 2 as above. Check whether
`customer_visits` has DELETE granted to legend_app; report it (wa4hp needs DELETE of a visit row).

## Slice T1 — tests: rewards (test-writer)

File `test/member-rewards.test.ts` (+ helpers in `test/member-rewards-helpers.ts`). Use `member-loyalty-helpers.ts`.
Cover every item of 290c "Tes gagal-dulu" except missions and wa4hp, plus: fulfil item reward by code (staff with
`crm.loyalty.fulfil`) → `fulfilled`; fulfil voucher reward before voucher used → 422 `VOUCHER_INVALID`; expiry job
re-run posts nothing; cross-tenant for rewards/redemptions/missions/mission_progress. Concurrency test: 20 parallel
`redeemReward` service calls (separate transactions, 20 members or one member with 20 keys), stock 1. Call services
through the interfaces below; routes through HTTP (`newMemberUser`, staff session helper used by
`loyalty-program` tests).

## Slice T2 — tests: missions + wa4hp (test-writer)

Files `test/member-missions.test.ts`, `test/member-visit-reversal.test.ts`. Missions via `deliver(orderPaidEvent)`:
visit_count completes at target and posts ONE bonus (`source_type='mission'`, `source_id`=progress id); replay of the
same order event posts nothing; monthly `period_key` = `YYYY-MM` of business date, weekly `YYYY-Www` (ISO), date_range
`<start>..<end>` and outside the range no progress; weekday_visit counts only listed weekdays (0=Sunday, business date);
try_new_item counts distinct menu items never in the member's earlier paid orders (filtered by `menuItemIds` if
non-empty); stamp_card +1 per paid order; inactive or outside starts_at/ends_at → no progress; voucher reward creates a
`vouchers` row (`loyalty_reward`) and `voucher_code` on progress; `GET /api/member/missions`. wa4hp: void of a final
order → `visits_count` -1, `lifetime_spend_idr` -= eligible spend not yet refunded, customer_visits row gone; partial
refund → spend -= refunded eligible, visits unchanged; refunds reaching full eligible → visits -1; replay of the same
refund/void changes nothing; never below 0.

## Slice R — redemption service (+ ledger event)

Files `services/reward-redemption.service.ts`, `services/point-ledger.service.ts` (only `eventFor`: `adjust` →
`points.adjusted` with `kind` = `reversesEntryId ? 'restore' : 'manual'`, plus `sourceType/sourceId/reason`).
Exports (binding):
```ts
export async function redeemReward(tx: Tx, scope: MemberScope, rewardId: string, idempotencyKey: string, now: Date): Promise<RewardRedemptionDto>
export async function cancelRedemption(tx: Tx, scope: MemberScope, redemptionId: string, now: Date): Promise<RewardRedemptionDto>
export async function listMemberRedemptions(tx: Tx, scope: MemberScope, page: {cursor?: string; limit: number}): Promise<{items: RewardRedemptionDto[]; nextCursor: string | null}>
export async function listActiveRewards(tx: Tx, tenantId: string, page): Promise<{items: Reward[]; nextCursor}>
export async function fulfilRedemption(tx: Tx, context: ScopedTenantContext, actorUserId: string, input: {redemptionCode: string; outletId: string; orderId?: string}, now: Date): Promise<RewardRedemptionDto>
export async function expireDueRedemptions(tx: Tx, context: ScopedTenantContext, now: Date, limit?: number): Promise<{expired: number; fulfilled: number}>
export function toRedemptionDto(row): RewardRedemptionDto
```
Errors via `HttpError(status, code, crmErrorMessages[code])`. Map `rewardRedemptionCheck` reasons:
reward_inactive/not_started/expired → `REWARD_EXPIRED`, out_of_stock → `REWARD_OUT_OF_STOCK`, insufficient_points →
`POINTS_INSUFFICIENT`, limit_reached → `REDEMPTION_LIMIT_REACHED`. `existingRedemptions` counts pending+fulfilled.
Replay: same `(profile, idempotencyKey)` returns the first row (check before checks; also catch unique violation).
Unknown reward / other member's redemption → 404 `NOT_FOUND` (do not leak). Profile id comes ONLY from
`scope.customerProfileId`. Cancel: profile lock → redemption FOR UPDATE → if not pending 409
`REDEMPTION_NOT_CANCELLABLE`; voucher `UPDATE ... SET status='cancelled', cancelled_reason='redemption_cancelled'
WHERE id AND status='issued'` 0 rows → throw 409 `REDEMPTION_NOT_CANCELLABLE` (tx rolls back); restore ledger; stock
+1 when not null; set `restore_entry_id`, `cancelled_at`. Idempotent: second cancel = 409, no 2nd ledger row.

## Slice M — missions

Files `services/missions.service.ts`, `services/loyalty-earn-mission-step.ts`. `afterVisit(ctx)` loads active missions
of the tenant valid at `ctx.order.paidAt`, computes period_key from `ctx.order.businessDate`, upserts progress
(`INSERT ... ON CONFLICT DO NOTHING` then `SELECT ... FOR UPDATE`), increments (capped at target), on reaching target
sets `completed_at` and issues the reward once (`reward_issued_at` guard + ledger idempotency). Consumer replay does
not call steps, but stay idempotent anyway. Exports also `listMissionsForMember(tx, scope, now)` →
`MissionWithProgress[]` (current period progress or null) and staff CRUD helpers `createMission`, `updateMission`,
`listMissions` (validate with contract `missionSchema`).

## Slice MR — member routes

File `routes/member-rewards.routes.ts` exporting `memberRewardsRouter` (mounted by slice W under `/member`). Pattern
of `routes/member.routes.ts` (`base`, `requireMember()` default = active only, `withMemberScope`, no `withTenant`).
Routes: `GET /rewards`, `POST /rewards/:rewardId/redemptions`, `GET /redemptions`, `POST
/redemptions/:redemptionId/cancel`, `GET /missions`, `GET /vouchers` (vouchers of `scope.customerProfileId`, cursor page,
`voucherDtoSchema`). Parse params/body/query with the contract endpoint schemas.

## Slice SR — staff routes

File `routes/loyalty-rewards.routes.ts` exporting `loyaltyRewardsRouter`. Pattern of `routes/loyalty-program.routes.ts`.
`GET/POST /api/loyalty/rewards`, `PATCH /api/loyalty/rewards/:rewardId`, `GET/POST /api/loyalty/missions`, `PATCH
/api/loyalty/missions/:missionId` (`crm.loyalty.manage`); `POST /api/loyalty/redemptions/fulfil`
(`crm.loyalty.fulfil`, outlet must be in the caller's outlet scope). Reward CRUD lives in this route file or a small
`services/loyalty-rewards-admin.service.ts` (yours).

## Slice W — wiring + job

Files `worker/redemption-expiry.job.ts`, `worker-main.ts`, `routes/index.ts`. Job `runRedemptionExpirySweep` pattern
of `worker/loyalty-balance-check.job.ts` (once per day per tenant, batches, calls `expireDueRedemptions`). Mount
`memberRewardsRouter` at `/member` and `loyaltyRewardsRouter` like `loyaltyProgramRouter`.

## Slice V — wa4hp (void/refund lowers visits and spend)

File `services/loyalty-earn-consumer.ts` (`reverseForOrder` only). Under the profile lock: if `input.sourceId` is in
`record.appliedReversalIds` → return (replay guard, before any write). Compute `spendDelta = refunded −
previousRefunded` (void: `eligible − previousRefunded`). Update `customer_profiles`: `lifetime_spend_idr =
GREATEST(0, … − spendDelta)`, and `visits_count = GREATEST(0, visits_count − 1)` when this event removes the visit (void,
or cumulative refund reaches `eligible > 0`) and the visit was not removed before. `customer_visits`: decrement
`spend_idr` (≥0); DELETE the row when the visit is removed. Append `sourceId` to `applied_reversal_ids` in the same
`settleRecord` update. Keep all existing 290a behaviour (ledger, anomaly) unchanged.

## Review fixes (architect, round 1)

Add a failing test first for each fix, in the test file named, then fix. Run only that test file plus the files you touch.

- Fix A (files `services/reward-redemption.service.ts`, `services/loyalty-rewards-admin.service.ts`,
  `worker/redemption-expiry.job.ts`, tests in `test/member-rewards.test.ts`):
  1. Fulfil and expiry branch on `redemption.voucherId !== null`, never on the current `reward.type`.
  2. Reward PATCH: 409 (code `VALIDATION_ERROR` style already used in the file, or `REWARD_EXPIRED`? no: use
     `HttpError(409, "REWARD_HAS_PENDING_REDEMPTIONS", "Hadiah masih punya penukaran yang belum selesai.")`) when
     `type`, `menuItemId` or `voucherValueIdr` change while the reward has `pending` redemptions.
  3. Expiry: one transaction per redemption. Export `expireRedemption(tx, context, redemptionId, now)` (profile lock
     → redemption FOR UPDATE → re-check still pending and due → act). Job scans due ids (limit 100) in one read tx,
     then one `withTenant` per id; one failure is logged and does not stop the rest. Keep
     `expireDueRedemptions` as a thin loop for tests or remove it and update the tests.
- Fix B (files `services/loyalty-earn-consumer.ts` `reverseForOrder`, `services/loyalty-earn-mission-step.ts`, tests
  in `test/member-visit-reversal.test.ts`, `test/member-missions.test.ts`):
  1. wa4hp counters run for every record whose visit was counted (`booked`, `capped`, self-serve `blocked`, and
     `reversed` from an earlier partial refund); return early only when no visit was counted. Ledger reversal stays
     gated on `state === 'booked'` exactly as before. `refundedEligibleIdr` and `appliedReversalIds` always update.
     Read the record states and outcome reasons in the consumer to get the exact values.
  2. Mission step: do nothing when the order was blocked as self-serve (read the record's outcome reason field).
- Fix C (files `db/schema/crm-rewards.custom.sql`, `apps/api/drizzle/0207_loyalty_rewards_missions.sql` (same text
  in the hand-SQL section), `test/data-import-registry.test.ts`): before adding `vouchers_profile_fk`, with FORCE
  lifted, neutralise orphan rows: vouchers whose `customer_profile_id` has no `customer_profiles` row in the same
  tenant get `customer_profile_id = NULL`, and if `status = 'issued'` also `status = 'cancelled'` with
  `cancelled_reason = 'profile_missing_0207'` (respect the vouchers CHECKs in `drizzle/0034_*.sql`). Start the
  statement at line start with `UPDATE` and add the `MIGRATION_DATA_STATEMENTS` entry (reason text like 0186).
