# 201b Second opinion: audited write-off of a lost receipt number (legend-0hzqw)

Read-only review. Do not edit or commit. Do not read `.env*` or `~/.ssh`.

Worktree: `.worktrees/receipt-number-writeoff`, branch `ws/receipt-number-writeoff` (base `ws/day-close-all-gaps` 57e92b6d). Review `git diff 57e92b6d..ws/receipt-number-writeoff` (commits bd7d28a9 feature, 8958272c review fixes: POST needs a verified second factor; write-offs whose number later got a receipt are ignored by gap counting and the fast paths add the remaining write-off count; runbook covers edge, release order and rollback; a3649cdd reads run write-offs after the receipt count and makes the runbook rollback safe). Spec: `docs/briefs/201-receipt-number-writeoff.md` (main folder).

## What changed

- New table `receipt_number_writeoffs` (`apps/api/src/db/schema/pos-receipt-writeoff.ts` + `.custom.sql`), migration `apps/api/drizzle/0156_receipt_number_writeoffs.sql` (journal idx 156, when 1794235000000; 0155 is reserved for payroll). FORCE RLS tenant + outlet, append-only trigger, BEFORE INSERT backstop (prefix/outlet match, ordinal <= last_number, no receipt at that ordinal), owner template backfill of `pos.receipt.writeoff`.
- Permission `pos.receipt.writeoff` (`packages/shared/src/access/permissions.ts`), owner template only (via catalog).
- `POST`/`GET /api/outlets/:outletId/pos/receipt-writeoffs` (`apps/api/src/routes/pos-receipt-writeoff.routes.ts`, `apps/api/src/services/pos-receipt-writeoff.service.ts`): cloud only, locks the sequence row FOR UPDATE, refuses above lastNumber, an ordinal with a receipt, and a duplicate (409), and writes a tenant audit row `pos.receipt.written_off`.
- Gap counting (`apps/api/src/services/pos-receipt.service.ts`: `receiptGapsForOutlet`, `receiptGapsForOutletFast`, `receiptGapsForDevice`, `receiptGapsOfRun`) treats written-off ordinals as present. The shift report run gains `writtenOff`.

## Questions

1. Can a written-off number later receive a real receipt (late edge sync / merge of a retired run), and what happens then (unique conflict, double count, silent hide)? `mergeDeviceReceiptRun` is not changed on purpose.
2. Is the fast path (count of receipts <= lastNumber == lastNumber) still correct when write-offs exist, including when a receipt arrives for a written-off ordinal?
3. Authorization: is owner-only really enforced (template backfill, custom roles via `access.role.manage`, outlet scope, cross-tenant)? Should this require MFA / re-auth?
4. Migration safety: FK and trigger under FORCE RLS, backfill loop for tenants without an owner template, rollback story.
5. Edge: write-off rows are not synced to edge nodes. Can a day close running on edge still be blocked, and is that acceptable?
6. Anything in the audit row that should not be there, or is missing (TEN-04)?

Answer per question: verdict (OK / risk / bug), evidence (file:line), suggested fix.
