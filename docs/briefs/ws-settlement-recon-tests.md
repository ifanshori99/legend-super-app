# Test plan: ws/settlement-recon (legend-jlqi + legend-ds1o)

Phase 1 plan. No test files yet. Source of truth: PRD §3.13 (EDC-06), §3.19 "Rekonsiliasi Gateway", PRD table `settlements`/`settlement_lines`/`edc_settlements` (docs/PRD.md ~L1774-1777), brief money rules. Route paths, DTO names, table/column names, and import payload shape are unknown until docs/CONTRACT.md or a shared validator lands. All `<...>` below are placeholders to bind then.

## 1. Patterns found (reuse, do not reinvent)

| Need | Pattern | Source |
|---|---|---|
| Owner pool for fixtures | `new Pool({ connectionString: process.env.STARTER_TEST_DATABASE_URL, max: 2..4 })`; guard `STARTER_TEST_RUN` startsWith `starter-pg-test-` | payment-admin-rls.test.ts, edc-rls.test.ts |
| Seeded tenant/outlets | `cafeLegendPlatformFixtures.tenant.id`; outlets: `cafeLegendAccessFixtures.outletIds.bandung / bandung2` | payment-admin-api.test.ts |
| Sign-in + role | `agent(createApp())`, `signUp(client)`, `verifySessionMfa(email)` from `./helpers`; insert `role_assignments` for `roles.template_key='owner'` (scope `tenant` or `outlet`+scope_id) | payment-admin-api.test.ts `signedIn()` |
| Cookie-based variant | sign-up via `/api/auth/sign-up/email` with `originHeader`, grab `set-cookie`, insert `role_assignments` with template (e.g. `finance`, none = 403 user) | accounting-bank-recon-cases.test.ts `signedIn()` |
| Origin header | `.set(originHeader)` on every mutation; `Idempotency-Key` header on payment-admin POSTs | helpers.ts, payment-admin-api.test.ts |
| Second tenant | `INSERT INTO tenants ... SELECT ... FROM tenants WHERE id = seeded` (random uuid, cleaned in afterAll); or host app with `x-test-tenant` header via `tenantContext({fallback})` | accounting-bank-recon-cases.test.ts `newTenant()`, `host` |
| Cross-tenant HTTP | other tenant's case/entity id returns 404 (not 403, no leak) | accounting-bank-recon-cases.test.ts L932+ |
| RLS catalog check | query `pg_class.relrowsecurity/relforcerowsecurity` + `pg_policy` where `polname='tenant_isolation' AND NOT polpermissive` | payment-admin-rls.test.ts |
| RLS row check | `BEGIN; SET LOCAL ROLE legend_app; set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*' or JSON array, true)`; rows from another tenant = `[]`; WITH CHECK insert rejected | edc-rls.test.ts `asAppRole()` |
| FORCE RLS fixtures | owner insert needs `set_config('app.tenant_id')` in a tx (`asOwner()`); some tables (legal_entities etc.) were seeded directly via owner pool | edc-rls.test.ts, recon-cases test |
| Existing legal entity + bank fixtures | `seedEntity()`: legal_entities, chart_of_accounts (1102 Bank, 4101), fiscal_periods, bank_accounts, bank_statement_imports; `seedLine()` into bank_statement_lines | accounting-bank-recon-cases.test.ts |
| Existing recon case rows | `payment_reconciliation_cases` columns: id, tenant_id, outlet_id, settlement_id, source ('edc'), provider ('edc_bca'), reference, period_start/end, expected_idr, received_idr, variance_idr, reason; routes `/api/payments/admin/reconciliation/cases`, `/summary`, `/cases/:id/resolve` (note required, 422 empty) | payment-admin-api.test.ts L127, L420 |
| Existing accounting cases | `bank_reconciliation_cases` + `_events`, route `/api/accounting/reconciliation-cases`, ref type `gateway_settlement` | accounting-bank-recon-cases.test.ts |
| Cleanup | afterAll deletes by tenant + created entity ids, `DELETE FROM tenants` for extras, `DELETE FROM "user"`; journal tables need `app.journal_entry_seals` deleted first | accounting-bank-recon-cases.test.ts L377+ |
| Money no-side-effect checks | count rows before/after in `payment_refunds`, `journal_entries`/`journal_lines`, `cash_deposits` (scoped by tenant/entity) | payment-admin-api.test.ts (refund counts), recon-cases test |

Gap: no existing helper for settlement fixtures. Create `apps/api/src/test/settlement-recon-helpers.ts` (fixtures only, no assertions).

## 2. Files

1. `apps/api/src/test/settlement-recon-rls.test.ts`  (legend-jlqi, schema level)
2. `apps/api/src/test/settlement-recon-import.test.ts`  (legend-jlqi, ingest + cases + idempotency + money guard)
3. `apps/api/src/test/settlement-recon-summary.test.ts`  (legend-ds1o, gross/fee/net/variance endpoint + isolation)
4. `apps/api/src/test/settlement-recon-helpers.ts`  (shared fixtures; not a `.test.ts`)
5. Optional after contract: `e2e/acceptance/settlement-recon.spec.ts` (card shows server-computed values, no visual change). Only if brief asks.

Run each: `LEGEND_TEST_FILES="src/test/settlement-recon-<x>.test.ts" heavy pnpm test`. One runner at a time.

Test names: prefix with `EDC-06` (ingest/case), `ACC-04` where it ties to case with PIC, `TEN-01/TEN-02` for isolation, `legend-jlqi` / `legend-ds1o` suffix for traceability.

## 3. Helpers (settlement-recon-helpers.ts)

- `seedTenantWithEntity()`: seeded tenant + fresh `legal_entities` row + bank account + GL (copy `seedEntity` shape).
- `seedPosTransactions(entity, outlet, items[{provider/bank, amountIdr, feeIdr, reference, date}])`: matching POS/payment rows for lines to match against. Table names pending contract.
- `buildReportPayload({ provider|bank, periodStart, periodEnd, lines[{reference, amountIdr, feeIdr?, settledAt}], reportRef/fileSha })`: payload per contract validator.
- `seedOtherTenant()`: second tenant plus its own entity, report, lines, case.
- `moneySnapshot(tenantId)`: row counts and `sum(amount_idr)` of `payment_refunds`, any payout table (name from contract; tests must fail loudly if table absent, not skip), `journal_entries`, `journal_lines`, `cash_deposits`, `bank_statement_lines` (match_status counts), `payment_intents` paid_idr/status. Returns plain object for `toEqual` before/after.
- `signedIn(role: 'owner' | 'finance' | 'none' | outlet-scoped)`.

## 4. Cases

### 4.1 settlement-recon-rls.test.ts (TEN-01/TEN-02)
- R1 each new settlement report/line table: `relrowsecurity`, `relforcerowsecurity`, restrictive `tenant_isolation` policy (same query as payment-admin-rls).
- R2 outlet-owned tables also have `outlet_isolation` (only if contract marks them outlet-owned).
- R3 as `legend_app` with other tenant: `SELECT` on report and line tables returns `[]` while owner tenant sees its rows.
- R4 as `legend_app`, tenant A context: INSERT of a row with tenant B's `tenant_id` fails (WITH CHECK).
- R5 UPDATE/DELETE of tenant A row under tenant B context affects 0 rows.
- R6 dedupe unique key is per tenant: same file hash/ref in tenant A and tenant B both insert OK (no cross-tenant collision, no leak via unique-violation).

### 4.2 settlement-recon-import.test.ts (legend-jlqi)
Main flow:
- I1 EDC bank report import (e.g. BCA, 3 lines) stores one report + 3 lines for caller's tenant/entity; response reports counts; lines carry gross/fee/net.
- I2 gateway (DOIT) report import stores report + lines the same way.
- I3 lines matching POS transactions exactly (amount, ref) become `matched`; no case opened for them.
- I4 line with no POS match (unmatched) opens one reconciliation case (EDC-06 "setiap selisih menjadi kasus"), `variance_idr` = report amount minus POS expected; case shows in `/api/payments/admin/reconciliation/cases` and `/summary` counts it.
- I5 amount mismatch (POS 100000, report 90000) opens case with `expectedIdr=100000, receivedIdr=90000, varianceIdr=-10000`.
- I6 POS transaction with no report line (missing in settlement) is recorded as a case too, if contract says so (confirm).

Idempotent re-import (money rule):
- D1 import same report twice (same body, same idempotency key/file hash): second call 200 replay or 409 per contract; row counts in report, lines, cases unchanged after second call.
- D2 same report, different idempotency key: still no duplicates (dedupe by file hash / provider+period+ref), counts unchanged.
- D3 same idempotency key, different body: refused (422/409 per contract), nothing written.
- D4 two simultaneous identical imports (`Promise.all`): exactly one report, one set of lines, one case per variance.
- D5 re-import after a case was resolved: case stays resolved, no new case reopened, no duplicate.
- D6 overlapping report (same provider+period, extra line): only the new line is added, existing lines untouched (assumption: confirm).

Money guard (nobody paid more, no side effects):
- M1 variance recorded: positive variance (report > POS) and negative variance both stored with correct sign; sum of case variances equals sum(report - expected).
- M2 `moneySnapshot` before/after an import with variances and re-import: `payment_refunds` rows/sum, payout rows, `journal_entries`/`journal_lines` counts, `cash_deposits`, `payment_intents` paid amounts unchanged. The import is the only writer to settlement + case tables.
- M3 same snapshot invariant after resolving a case (`POST .../cases/:id/resolve` with note): resolving only changes case status, creates no refund, payout, or journal.
- M4 over-report line (gateway claims more than POS): no `payment_unallocated_funds`/refund row created; nothing becomes payable.
- M5 line referencing another tenant's POS transaction id: not matched, opens case, never touches other tenant's rows.
- M6 invalid payloads: negative amount, fee > gross, net != gross - fee, bad date, empty lines: 422 with nothing written. (Net inconsistency behavior per contract: reject vs record as case. Assumption: pick per contract.)

Auth/access:
- A1 no session 401; no role 403; wrong origin on POST 403 (origin check); cashier-only role (if exists) 403.
- A2 outlet-scoped admin sees/imports only own outlet's lines; entity-level report needs tenant scope (mirror recon-cases outlet visibility test).

### 4.3 settlement-recon-summary.test.ts (legend-ds1o)
Math (hand-computed constants in the test, never recomputed with the same formula):
- S1 seed report lines: (100000 fee 700), (250000 fee 1750), (50000 fee 350) for one period: `gross=400000`, `fee=2800`, `net=397200`.
- S2 variance = net received (bank) minus net expected. Seed bank line / expected 397200 vs received 390000: `variance=-7200`; exact-match period: `variance=0`; received higher: positive variance.
- S3 integers only (IDR, no floats); large values (e.g. 9,000,000,000) still exact (bigint safe).
- S4 per-fee rows: MDR QRIS and VA service fee reported separately if contract exposes breakdown (PRD §3.19); sum of rows = `fee`.
- S5 period filter: lines outside `from..to` excluded; boundary dates inclusive.
- S6 provider/entity filter: DOIT vs EDC BCA totals are independent.
- S7 empty state: no report in period: `gross=0, fee=0, net=0, variance=0` and empty rows (no 404/500). Verify with UI card empty state (e2e optional).
- S8 totals computed server-side: client cannot override (extra `gross` query param ignored or 422 by strict validator).
- S9 after re-import (D1), summary totals unchanged (no double count).
- S10 reversed/void lines (if contract has negative lines): netted correctly.

Isolation:
- T1 tenant B owner calling endpoint with tenant A's `legalEntityId`: 404 (matches recon-cases pattern), no totals leak.
- T2 tenant B with its own entity sees only its own totals; tenant A's data does not change B's numbers.
- T3 tenant A with two entities: totals do not mix across `legalEntityId`.
- T4 summary GET is read-only: `moneySnapshot` plus report/line/case counts identical before/after (no payouts, refunds, journals).
- T5 auth: 401 unauth, 403 no role, outlet-scoped caller sees only own outlet portion.

## 5. Fail-first notes
Before engineer work: tests must fail on missing behavior (route 404 on a path that the validator-defined contract says exists, missing table `relation does not exist` is acceptable only for R-series as "table missing"; but a 401/403/422 from bad setup is not a valid fail). Verify with one smoke call per test file that auth is OK (e.g. existing `/api/payments/admin/reconciliation/summary` returns 200 for the same fixture user) so failures come from the new route only.

## 6. Assumptions to confirm with contract
1. Import endpoint is tenant/entity scoped and takes parsed lines JSON (not file upload); dedupe key is file hash or provider+period+reportRef.
2. Variance case rows land in existing `payment_reconciliation_cases` (source `edc`/`gateway`) not only in `bank_reconciliation_cases`.
3. Variance sign: received minus expected (negative = short), matching existing seed row `-10000` for `expected 100000, received 90000`.
4. `net = gross - fee` is enforced on ingest; inconsistent line rejected with 422 (alt: recorded as case).
5. Summary variance = bank-received net minus settlement-reported net unless contract says otherwise.
6. Cross-tenant access returns 404, not 403.
7. Payout table name unknown; `moneySnapshot` must cover whatever the repo calls it (confirm from schema listing `payment.ts`/`accounting-profit-share.ts`: profit-share payouts and refunds payouts both in scope).
