# I1 contract (A-db): clearance of a recon flag

Migrations: `apps/api/drizzle/0580_payout_990_schema.sql` (table, RLS, ACL, guard trigger) and `0581_payout_990_recon_clear.sql` (functions). Not run against a database yet.

## Table `payroll_payout_recon_clearances` (0580)

Columns: id, tenant_id, exception_id, reason, proposed_by, proposed_session_id, proposed_grant_id, proposed_at, approved_by, approved_session_id, approved_grant_id, approved_at. One clearance per flag (unique tenant_id, exception_id). legend_app: SELECT only. legend_payout: SELECT, INSERT, UPDATE of approved_* only. Trigger: DELETE, TRUNCATE and any UPDATE other than filling approved_* once from NULL are refused with PAYOUT-87 (23514). CHECK: approver differs from proposer.

## SQL signatures (EXECUTE: legend_app only, SECURITY DEFINER, owner legend_payout)

- `app.payout_recon_clear_propose(p_exception uuid, p_grant text, p_reason text) RETURNS uuid` : clearance id. A flag with an open clearance returns that id (idempotent, first reason stays). Reason is stored as sent.
- `app.payout_recon_clear_approve(p_clearance uuid, p_grant text) RETURNS uuid` : the clearance id.
- Helper (invoker): `app.payout_payslip_held_by_recon(p_tenant uuid, p_payslip uuid) RETURNS boolean`.

## Grant (`app.payout_grant_issue`, signature unchanged, 11 args)

kind `recon_clear`, step `propose` | `approve`. Password step-up only (else PAYOUT-72, 22023). Actor needs `payroll.disburse.approve` and a tenant-scope owner or finance role (PAYOUT-42, 42501).

- `p_batch`: NOT NULL, the batch of the flagged item (else PAYOUT-72).
- propose: `p_ref` = flag id (recon_exceptions.id), `p_detail` = sha256 hex of the proposed reason (UTF-8 bytes of the exact string sent as `p_reason`).
- approve: `p_ref` = clearance id, `p_detail` = sha256 hex of the reason stored on the clearance (same exact string). The service must read the stored reason to compute it.
- `p_item_ids` = NULL/empty, `p_key` = NULL, `p_target` = NULL.
- Approve grant refused at issue for the proposer or the proposing session (PAYOUT-86) and for an approved clearance (PAYOUT-87). Frozen batch: PAYOUT-79 as other kinds.
- Consume binding (the function call passes it): `('recon_clear', step, batch, NULL, NULL, ref, NULL, detail)`.

## Error codes

| Code      | SQLSTATE | Meaning                                                    |
| --------- | -------- | ---------------------------------------------------------- |
| PAYOUT-85 | 23514    | reason not 10-500 chars (propose)                          |
| PAYOUT-86 | 42501    | proposer (user or session) cannot approve                  |
| PAYOUT-87 | 23514    | clearance already approved / row cannot change             |
| PAYOUT-69 | P0002    | flag or clearance not found (also other tenant)            |
| PAYOUT-42 | 42501    | not tenant-wide owner/finance, or no permission            |
| PAYOUT-72 | 22023    | grant shape invalid, flag/clearance not in tenant or batch |
| PAYOUT-70 | 42501    | grant missing, spent, expired or not matching              |

## Held logic

A flag holds a payslip unless it has an approved clearance. Replaced to use the helper (PAYOUT-62): `app.payroll_disbursement_items_guard()` (from 0433) and `app.payout_resolve_approve` (from 0422). The overpaid PAYOUT-62 stays. `app.payout_run_settle` (0429) not changed: it reads flags only for payslips with no item, and a flag always names an item. `payout_recon_flag` (0432) unchanged: ON CONFLICT DO NOTHING, so a cleared flag does not return for the same key.

## Replaced functions (origin)

- `app.payout_grant_issue`: 0433:703
- `app.payout_resolve_approve`: 0422:533 (no later version)
- `app.payroll_disbursement_items_guard`: 0433:248
- `app.payout_grant_consume`: not changed (0436:20)
