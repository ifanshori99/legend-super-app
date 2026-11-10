# Sub-brief legend-0hzqw, review fixes

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/receipt-number-writeoff`. Do not commit, run tsc or full suites. Base spec: `docs/briefs/sub-receipt-number-writeoff.md`.

## Already changed in source (do not edit these)

- `apps/api/src/routes/pos-receipt-writeoff.routes.ts`: POST requires a verified second factor (`getAccessSnapshot(req).mfaVerified`), else `AccessError("MFA_REQUIRED")` (check the HTTP status it maps to in the error middleware). GET does not.
- `apps/api/src/services/pos-receipt.service.ts`: `writeoffOrdinalsBySequence` returns only write-offs whose ordinal still has no receipt. The fast paths in `receiptGapsForOutletFast` and `receiptGapsOfRun` add that count to the receipt count. So a receipt that arrives later for a written-off number makes the write-off disappear from `writtenOff` and is not counted twice.

## F1 (test-writer): `apps/api/src/test/pos-receipt-writeoff.test.ts`

- Existing POST cases: the owner session must now be MFA-verified. Call `verifySessionMfa(email)` from `./helpers.ts` (`signUp` returns the email) for the members that POST.
- New cases:
  1. Owner without a verified second factor: POST refused (MFA_REQUIRED, status as mapped), no row written.
  2. Late receipt: run lastNumber 3, receipts 1 and 3, write off 2 (201). Then insert receipt 2 with owner SQL, as the existing helpers do. Shift-report run for that prefix: no entry or `writtenOff: []`, `missing: []`. Day close passes.
  3. Late receipt must not hide a real gap: lastNumber 3, receipt 1, write off 2, then insert receipt 2. `receiptGapsForOutletFast` still reports 3 missing.
  4. Fast path mix: an outlet with one clean run and one run whose only hole is written off. `receiptGapsForOutletFast` returns `[]`.
  5. Outlet scope: a user holding `pos.receipt.writeoff` only through an outlet-scoped assignment on outlet X (`scope_type 'outlet'`; check the role_assignments columns) is refused on outlet Y (403/404).
  6. Edge refusal: with the edge state on, the service refuses with 409. Check how other tests toggle edge mode (grep `setEdgeRuntimeState`, `EDGE_MODE`) and restore it in `finally`.
- Write, don't run. Report the case names.

## F2 (doc-writer): `docs/runbooks/receipt-number-writeoff.md`

- The POST needs a verified second factor (2FA) in this session.
- Edge outlets: write-off rows are not synced to the edge node. If Tutup Hari runs on the edge, it stays refused after a cloud write-off. Until a follow-up card lands, close the day through the cloud. Mark this as a pending decision for the CTO.
- A receipt that arrives later for a written-off number: the number counts as present through the receipt and drops out of the written-off list. The audit row stays. Check the device that synced it.
- Release order: migration 0155 (payroll) must ship before or with 0156. The migrator skips an older `when` applied after a newer one.
- Rollback (prefer fixing forward; rollback blocks Tutup Hari again). Give the SQL: drop the triggers `receipt_number_writeoffs_check_insert_trg` and `receipt_number_writeoffs_append_only_trg`, the functions `app.receipt_number_writeoffs_check_insert()` and `app.receipt_number_writeoffs_append_only()`, and the table `receipt_number_writeoffs`. Remove `pos.receipt.writeoff` from the owner template roles per tenant with `set_config('app.tenant_id', ...)` (mirror the loop in `apps/api/drizzle/0156_receipt_number_writeoffs.sql`). Export the rows before dropping; they are audit evidence.
