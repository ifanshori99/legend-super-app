# Brief: ws/settlement-recon (legend-jlqi + legend-ds1o)

Worktree: /Users/ifanshori99/Projects/legend super app/legend-e682e1f9 (branch ws/settlement-recon, base milestone/m1).
Tier K (money + migration). Migration numbers: 0440-0445 only (m1 journal ends at idx 313; see scripts/migration-renumber.mjs).

## Cards
1. legend-jlqi: store settlement reports + lines (EDC bank / gateway settlement files), populate reconciliation cases/summary.
   Tenant isolation (RLS, FORCE RLS like other tables), idempotent ingest (re-import same report = no duplicate), EDC-06
   ("Laporan settlement EDC setiap bank cocok dengan transaksi POS; setiap selisih menjadi kasus rekonsiliasi"). PRD docs/PRD.md §3.13.
2. legend-ds1o: settlement-recon endpoint returning gross, fee, net, variance computed server-side.
   apps/web/src/features/ws07-cash-bank/components/gateway-settlement-card.tsx switches data source to it (no visual change). PRD §3.19.

## Money rules (founder, mandatory)
Reconciliation only READS and RECORDS differences. It never creates payouts, refunds, or journal postings.
Tests required: re-import same report does not duplicate; variance recorded and nobody is paid more; other tenant's data not readable.

## Out of scope
DOIT/Duitku payment flows, QRIS DP, refunds, journal posting. Do not edit those services.

## Existing code (to be filled by Explore)
- Schema candidates: apps/api/src/db/schema/payment-admin.ts, payment.ts, accounting-cash-bank.ts (+ .custom.sql)
- FE card: apps/web/src/features/ws07-cash-bank/components/gateway-settlement-card.tsx

## Test commands
- Targeted: `cd <worktree> && LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` (only the one subagent holding heavy token).
- Tests live in apps/api/src/test/.

## DESIGN (decided by engineer; implement exactly, report deviations)

### Facts from Explore
- `payment_reconciliation_cases` exists: apps/api/src/db/schema/payment-admin.ts:306 (settlement_id uuid NOT NULL no FK, settlement_line_id, source gateway|edc,
  provider "doit"|"edc_<bank>", reference, period_start/end, expected/received/variance_idr, reason, status open|resolved). RLS: drizzle/0031 + 0032.
- Service apps/api/src/services/payment-admin-reconciliation.service.ts: list (l.65), summary (l.126, currently throws 503 SETTLEMENT_IMPORT_UNAVAILABLE), resolve (l.154,
  pattern: assertTrustedScopedContext, withTenant, assertPaymentPermission("payment.reconcile", outlet), idempotentPaymentAdminWrite, recordAudit, appendOutbox).
- Routes apps/api/src/routes/payment-admin.routes.ts:353-380. Shared contract packages/shared/src/payment/admin.ts:422-475 + 653-675.
- POS sources: edc_transactions (apps/api/src/db/schema/edc.ts:33: outlet_id, terminal_id, bank bca|mandiri|bni|bjb, amount_idr, type sale|void|refund,
  status approved..., rrn, approval_code, batch_no, payment_intent_id). payment_intents (schema/payment.ts:165: provider, amount_idr, fee_idr, provider_ref, status, paid_at).
- Card 2 current FE math: apps/web/src/features/ws07-cash-bank/lib.ts:772-818 `settlementRows` (gross = sum credits of non-bank lines; each debit non-bank line = fee row;
  net = bank GL debit-credit; statement line = one whose matchedRefs has {type:"gateway_settlement", id: entry.sourceId}; variance = net - matchedAmount).
  Data today: api.ts:295-305 listJournals(sourceType gateway_settlement, limit 100) + getJournal each; statement lines via accounting-bank-lines.routes.ts:46-60.
  Guard there: requireAuth, requireTrustedOrigin, requireTenantContext, requireTenantPermission("accounting.journal.view").

### Part A — schema + migration (new file apps/api/src/db/schema/payment-settlement.ts, export from index.ts)
Table `payment_settlements` (export `paymentSettlements`): id uuid pk default random; tenant_id; outlet_id (composite FK (tenant_id,outlet_id) -> outlets like cases);
source varchar(20) CHECK IN ('gateway','edc'); provider varchar(100); terminal_id uuid NULL; batch_no varchar(20) NULL; reference varchar(100) (report id);
period_start, period_end businessDate (CHECK end >= start); gross_idr, fee_idr, net_idr idrColumn (CHECK all >= 0 AND net = gross - fee); line_count int >= 0;
content_hash varchar(64) NOT NULL; imported_by text NOT NULL; created_at timestamptz default now.
UNIQUE (tenant_id, id); UNIQUE `payment_settlements_report_key` (tenant_id, source, provider, reference).
Table `payment_settlement_lines` (export `paymentSettlementLines`): id; tenant_id; outlet_id; settlement_id (FK (tenant_id, settlement_id) -> payment_settlements(tenant_id,id));
line_no int; reference varchar(100); amount_idr (>0), fee_idr (>=0); expected_idr idr NULL; matched_edc_transaction_id uuid NULL; matched_payment_intent_id uuid NULL;
match_status varchar(20) CHECK IN ('matched','mismatch','unmatched'); created_at.
UNIQUE (tenant_id, settlement_id, reference); UNIQUE (tenant_id, id);
partial UNIQUE (tenant_id, matched_edc_transaction_id) WHERE NOT NULL; partial UNIQUE (tenant_id, matched_payment_intent_id) WHERE NOT NULL  (one POS txn settled once).
index (tenant_id, outlet_id, match_status).
RLS: same as payment_reconciliation_cases (tenant + outlet RLS, FORCE). Append-only: REVOKE UPDATE, DELETE, TRUNCATE ON both FROM legend_app (copy pattern in accounting-cash-bank.custom.sql).
Migration tag number MUST be 0440 (generate gives 0314; renumber with scripts/migration-renumber.mjs or match how other branches got reserved numbers). `pnpm db:generate` must be empty afterwards.
No change to existing tables.

### Part B — shared contract (packages/shared/src/payment/admin.ts, after reconciliation section)
- `settlementLineInputSchema` strictObject { reference: ref, amountIdr: positive idr, feeIdr: nonnegative idr }.
- `importSettlementInputSchema` clientInputSchema-style strict: { outletId, source, provider: ref, reference: ref, terminalId?: uuid, batchNo?: string max 20,
  periodStart, periodEnd: businessDate, grossIdr, feeIdr, netIdr: nonnegative idr, lines: array 1..1000 } with refinements:
  gross == sum(lines.amountIdr); fee == sum(lines.feeIdr); net == gross - fee; periodEnd >= periodStart; references unique within lines;
  source "edc" requires terminalId + batchNo and provider matching /^edc_(bca|mandiri|bni|bjb)$/; source "gateway" forbids terminalId/batchNo.
- `settlementImportViewSchema` strictObject { id, outletId, source, provider, reference, periodStart, periodEnd, grossIdr, feeIdr, netIdr, lineCount,
  matchedLines, mismatchLines, unmatchedLines, casesCreated, replayed: boolean, createdAt }.
- endpoint `importSettlement` POST `${ADMIN}/reconciliation/settlements`, body importSettlementInputSchema, response dataResponseSchema(settlementImportViewSchema).
- Accounting (packages/shared/src/accounting/endpoints.ts + its schema file): endpoint `getGatewaySettlementRecon` GET `/api/accounting/gateway-settlement-recon`
  query strict { legalEntityId, bankAccountId (uuid), from, to (business dates) }; response dataResponseSchema({ rows: [...], truncated: boolean }) where row =
  { journalId, sourceId, entryDate, description/number fields the card shows, grossIdr, fees: [{ accountId, amountIdr }], feeIdr (sum), netIdr,
    statementLineId: uuid|null, matchedAmountIdr, varianceIdr (= netIdr - matchedAmountIdr) }.  Match existing naming/style in that file.

### Part C — card 1 service + route
New apps/api/src/services/payment-settlement-import.service.ts `importSettlement(context, actorId, body, key)`; route in payment-admin.routes.ts (same guards as resolve:
requireAuth, requireTrustedOrigin, jsonBody, tenant context; permission payment.reconcile on the outlet; Idempotency-Key header like resolve).
Inside withTenant + idempotentPaymentAdminWrite:
1. content_hash = sha256 of canonical JSON (sorted lines by reference) of the parsed body minus nothing else volatile.
2. INSERT settlement ... ON CONFLICT (tenant_id, source, provider, reference) DO NOTHING RETURNING. If no row: SELECT existing; same hash -> return its view with replayed=true
   and counts from its lines (NO new rows); different hash -> 409 "SETTLEMENT_CONFLICT".
3. Per line, find POS txn in same tenant + outlet:
   - edc: edc_transactions where bank = provider suffix, terminal_id = terminalId, type='sale', status='approved', (rrn = reference OR approval_code = reference) — prefer rrn.
   - gateway: payment_intents where provider = provider AND provider_ref = reference AND status IN ('paid','partially_refunded','refunded').
   - found & not already matched by another settlement line & amount equal -> matched (expected = POS amount).
   - found & amount differs -> mismatch; case reason "Settlement amount differs from POS transaction", expected = POS amount, received = line amount.
   - not found OR already matched by another settlement -> unmatched; case expected 0, received = line amount, reason states which.
4. POS txns missing from report -> case per txn (settlement_line_id NULL, reference = rrn/provider_ref, expected = POS amount, received 0):
   edc: approved sales with same terminal + batch_no not matched by this report; gateway: paid intents for the provider+outlet whose paid_at business date
   (Asia/Jakarta; reuse existing business-date helper) is in [periodStart, periodEnd] and not matched by any settlement line.
5. Cases: insert into payment_reconciliation_cases (source, provider, reference, period, settlement_id, settlement_line_id, variance = received - expected, status open).
6. recordAudit + appendOutbox like resolve. NEVER insert/update payouts, refunds, journals, payment_intents, edc_transactions, unallocated funds.
Also replace the 503 in getReconciliationSummary with real values: matched/unmatched/mismatch line counts from payment_settlement_lines (optionally outlet filter),
openCases, resolvedThisMonth (Asia/Jakarta month), varianceIdr = sum variance of open cases. Respect outlet scope the same way list does.

### Part D — card 2 API + FE
Service fn (new file apps/api/src/services/accounting-gateway-recon.service.ts) + route (register next to accounting-bank-lines routes, same guard chain, read-only GET):
reproduce lib.ts settlementRows exactly server-side using bank account's GL account; journals with sourceType gateway_settlement in [from,to] for the legal entity;
statement lines of bankAccountId matched to {type gateway_settlement, id sourceId}. Cap 500 journals, `truncated` true if more.
FE: features/ws07-cash-bank api.ts/queries.ts/hooks.ts add getGatewaySettlementRecon + hook; gateway-settlement-card.tsx uses only that hook; markup/classes unchanged.
Keep lib.ts settlementRows if other code/tests use it; otherwise leave it (do not delete tests).

### Tests (test-writer) — apps/api/src/test/payment-settlement-import.test.ts, accounting-gateway-recon.test.ts
Fail-first for real reasons. Must cover: re-import same report (same key and different Idempotency-Key) -> no duplicate settlements/lines/cases; changed content same reference -> 409;
mismatch/unmatched/missing-POS each produce exactly one case with correct variance; one POS txn cannot be matched by two reports (second -> unmatched case);
row counts of journals/refunds/payouts/unallocated funds/payment_intents/edc_transactions unchanged; tenant B cannot read/import into tenant A outlet (RLS + 403/404);
summary returns real counts (update any existing test expecting 503); gateway recon gross/fee/net/variance numbers equal the old client formula on the same fixture.

## ROUND 2 — architect findings to fix (decided)
Fixed already: L3 aggregateType "settlement" (was the 422 in tests).
- H1 (import service ~361-437): missing-POS scan must skip sales matched by ANY settlement line (any report), and skip sales that already have an open case with settlement_line_id IS NULL for same provider+outlet+reference. One sale => at most one open missing case.
- M1: at top of run() take pg_advisory_xact_lock(hashtext('settlement:'||tenant||':'||source||':'||provider||':'||outlet)) (follow existing advisory-lock helper if repo has one). Also map any remaining 23505 on the partial unique indexes to 409 SETTLEMENT_CONFLICT, never 500.
- M2: report key -> UNIQUE (tenant_id, source, provider, outlet_id, reference); plus partial UNIQUE (tenant_id, terminal_id, batch_no) WHERE source='edc'. ON CONFLICT targets updated accordingly (batch collision with different reference -> 409).
- M3: EDC missing-POS scan excludes sales that have an approved type='void' row on same terminal + same reference (rrn/approval code — mirror how void links to sale in edc service).
- M4: shared importSettlementInputSchema: periodEnd - periodStart <= 31 days (inclusive range max 31 days).
- L1: 422 when terminalId does not belong to the outlet or its bank != provider suffix (check the terminal table edc_transactions.terminal_id refers to); gateway provider must be a known gateway provider code (reuse existing provider enum/list in shared payment).
- L2: schema checks on payment_settlement_lines: match_status='matched' => exactly one of matched_* NOT NULL and expected_idr = amount_idr; 'mismatch' => one matched_* NOT NULL and expected_idr <> amount_idr; 'unmatched' => both NULL; not both matched_* set. FK (tenant_id, settlement_id, outlet_id) -> payment_settlements(tenant_id, id, outlet_id) (add needed UNIQUE on parent).
- L4: gateway recon service: only statement lines with date in [from,to] count as matched (parity with old card).
Migration: 0440 is branch-local, regenerate it in place (drop 0440 sql/snapshot/journal entry, regenerate, renumber to 0440 again). db:generate must be empty after.
