// Data-import guard registry checks (bead legend-v4ld; PRD v1.7 §3 and §7).
// Pure filesystem and function checks, no database.
//
// 1. Every registered import source calls guardDataImport("<its id>").
// 2. No unregistered import/seed/backfill file exists under apps/api/src.
// 3. No script or package.json script reaches an unregistered importer.
// 4. guardDataImport allows and blocks the right deployment/classification pairs.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  DataClassification,
  DeploymentMode,
  DeploymentSettings,
} from "@starter/shared/env";
import {
  DATA_IMPORT_SOURCES,
  DataImportBlockedError,
  guardDataImport,
  type DataImportSourceId,
} from "../config/data-import.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const API_SRC = path.join(REPO_ROOT, "apps/api/src");

const toPosix = (p: string) => p.split(path.sep).join("/");
const readRepoFile = (repoRelative: string) =>
  readFileSync(path.join(REPO_ROOT, repoRelative), "utf8");

const sources = Object.entries(DATA_IMPORT_SOURCES) as [
  DataImportSourceId,
  { file: string; entry?: string; beforeWrite: string },
][];
const registeredFiles = new Set<string>(sources.map(([, s]) => s.file));

// Files whose name looks like an importer but that never write imported data.
// Each entry needs a reason; adding a real writer here defeats the guard.
const NOT_A_WRITER: Record<string, string> = {
  "apps/api/src/cli/backfill-employee-managers.ts":
    "operator wrapper (legend-1265): only calls the cli() of db/backfill-employee-managers.ts listed here; no database write of its own",
  "apps/api/src/cli/metrics-daily-backfill.ts":
    "operator wrapper (legend-1265): only calls the cli() of scripts/metrics-daily-backfill.ts listed here; no database write of its own",
  "apps/api/src/cli/payroll-pph21-receivable-backfill.ts":
    "operator wrapper (legend-1265): only calls the cli() of scripts/payroll-pph21-receivable-backfill.ts listed here; no database write of its own",
  "apps/api/src/worker/payout-evidence-backfill.job.ts":
    "worker sweep (legend-8vcsg): fills the missing SHA-256 hashes of payout proofs that already exist, read from their own stored objects, into the tenant's own evidence-file and return-claim rows (NULL to a value only); imports no data from outside",
  "apps/api/src/services/payroll-payout-proof-backfill.service.ts":
    "the payout proof fingerprint sweep the worker above runs (moved out of payroll-payout-proof-fingerprint.service.ts, legend-so897): hashes the tenant's own stored proof objects into its own evidence-file and return-claim rows (NULL to a value only); imports no data from outside",
  "apps/api/src/services/menu-import-parse.ts":
    "pure spreadsheet/CSV parser: returns rows, performs no database write",
  "apps/api/src/config/data-import.ts":
    "the guard registry itself: decides whether an import may run",
  "apps/api/src/routes/edge-bootstrap.routes.ts":
    "HTTP route serving the signed bundle: only calls the read-only export service",
  "apps/api/src/services/edge-bootstrap.service.ts":
    "cloud-side export: only reads and signs the bundle that edge/bootstrap.ts writes",
  "apps/api/src/routes/menu-import.routes.ts":
    "HTTP route only: delegates to menu-import.service.ts, which calls the guard",
  "apps/api/src/scripts/metrics-daily-backfill.ts":
    "release-only replay (legend-ka1hg): recomputes metrics_daily for past outlet days from the tenant's own source rows through the metric service (same locks and upserts as the live sweep), tenant by tenant, with --dry-run; imports no external data",
  "apps/api/src/db/backfill-employee-managers.ts":
    "one-off repair of employees.manager_id on existing rows (legend-qhqf8): dry-run by default, --apply writes only HR-reviewed before/after tuples from a manifest, one audit row each; imports no data",
  "apps/api/src/scripts/payroll-pph21-receivable-backfill.ts":
    "release-only backfill (legend-i848k) of the employee PPh 21 receivable open item for receivables that predate the 972 open item: one transaction per tenant, --dry-run available, idempotent (ON CONFLICT DO NOTHING on a deterministic id), inserts only the missing gap to the employee's own payslip balance (never more), holds doubtful cases and reports them; derives everything from the tenant's own payslips and employees, imports no external data",
  "apps/api/src/services/payroll-pph21-receivable-backfill.service.ts":
    "the per-tenant backfill the script above runs (legend-i848k): reads the tenant's own payslips and open items, inserts only the missing accounting_open_items receivable up to the payslip balance, never updates or deletes a row and never exceeds the balance; imports no external data",
  "apps/api/src/db/backfill-ptkp-history.ts":
    "one-shot release backfill (bead 1223 r2) of employee_ptkp_history from the tenant's own payslips and employees: one transaction per tenant, idempotent upsert on employee plus day, refused where HR already corrected a PTKP unless --force; prints counts only; imports no external data",
  "apps/api/src/services/payroll-ptkp-backfill.ts":
    "the per-tenant backfill the script above runs (bead 1223 r2): reads the tenant's own locked or paid payslips and employees and upserts employee_ptkp_history rows (status of the first slip of the tax year, and today's status from the next year); never touches a payslip or an amount; imports no external data",
};

// Files under apps/api/src/db referenced from scripts/*.mjs that are not
// data importers.
const SCRIPT_NOT_A_WRITER: Record<string, string> = {
  "apps/api/src/db/provision-roles.ts":
    "role provisioning (database roles and grants), writes no application data",
};

// SQL migrations that contain INSERT/UPDATE statements. They are schema
// upgrades of existing data, never imports. A new data statement in a
// migration must be added here with a reason, so it gets looked at.
const MIGRATION_DATA_STATEMENTS: Record<string, string> = {
  "0454_payroll_overtime_correction_activations.sql":
    "backfills one payroll_overtime_correction_activations row (tenant id plus the migration time) for each tenant that already has payroll runs (legend-72nod): the stamp after which a locked run may be corrected for late overtime, so no old history is paid or taken back twice; idempotent, ON CONFLICT DO NOTHING, edits no existing row, no amount touched, FORCE RLS lifted on payroll_runs for that one read and restored",
  "0456_mcp_flag_backfill.sql":
    "adds the mcp module to feature_flags.modules of tenants that already use MCP (approved client or live token) so enforcing the module (legend-hbuq3) does not switch MCP off silently; idempotent, touches no other tenant or flag, no imports",
  "0408_print_alert_notification_retry.sql":
    "marks legacy print alerts delivered because their historical event ids cannot be reconstructed safely; new alerts retain a null marker for durable retry; restores FORCE RLS",
  "0312_public_tarantula.sql":
    "backfills the selected loyalty legal entity and pauses existing claim tokens whose order or split no longer satisfies entity/refund eligibility; restores FORCE RLS and changes no payment amounts",
  "0013_outbox_dispatch_recovery.sql":
    "sets a lease on already queued outbox rows",
  "0027_accounting_invariants.sql":
    "trigger body that seals journal entries at runtime",
  "0042_safe_hydra.sql":
    "backfills paid_idr on existing promotion applications",
  "0065_edge_received_events.sql":
    "copies existing edge inbound events into the renamed table",
  "0376_edge_link_slots.sql":
    "backfills edge_link_slots from existing edge_inbound_events: one row per link slot with exactly one counted receipt (legend-pz641); idempotent, ON CONFLICT DO NOTHING, edits no existing row, FORCE RLS lifted for that one statement and restored",
  "0484_edge_txn_ledger.sql":
    "backfills edge_txn_ledger_baselines from sync_cursors: one row per edge node that already queued edge_to_cloud events, so reconciliation counts only later events (legend-kai); idempotent, ON CONFLICT DO NOTHING, edits no existing row, runs tenant by tenant under that tenant's GUCs because both tables are FORCE RLS (GUCs restored afterwards)",
  "0090_pos_day_close_permission.sql":
    "adds a permission string to each tenant's existing roles",
  "0096_menu_station_type_backfill.sql":
    "derives station_type of existing menu items from stations",
  "0104_edc_standalone_permission.sql":
    "adds a permission string to each tenant's existing roles",
  "0115_ai_role_templates_data.sql":
    "adds the ai.ask and ai.action.propose permission strings to existing role templates",
  "0116_ai_approval_policies_data.sql":
    "inserts default approval policies for each tenant's existing roles",
  "0120_ws03_roles_zone_manage.sql":
    "adds a permission string to each tenant's existing roles",
  "0126_ws08_delivery_store_index_rls.sql":
    "trigger body and backfill of the delivery store index from existing delivery channels",
  "0135_edc_pan_scrub.sql":
    "masks card-number-like digit runs in existing edc_transactions rows (legend-5gub); edits no other column",
  "0139_auto_journals_backfill_rls.sql":
    "backfills the two new posting roles (customer deposit and forfeited deposit) per legal entity: adds one chart account and one account mapping each, ON CONFLICT DO NOTHING; edits no existing row",
  "0140_refund_approval_policies_data.sql":
    "gives each tenant without a refund approval policy the default refund row (floor 0, level 1, supervisor template role); idempotent, never touches a tenant that configured refunds (legend-zi9o)",
  "0141_great_firedrake.sql":
    "sets pin_set_at of existing staff_pins rows to their updated_at (legend-kyie); FORCE RLS lifted for that one statement and restored; edits no other column",
  "0142_high_scrambler.sql":
    "sets pin_generation_at of existing staff_pins rows to their pin_set_at (legend-kyie, Codex 160); FORCE RLS lifted for that one statement and restored; edits no other column",
  "0143_edc_pan_scrub_separators.sql":
    "second pass of the 0135 scrub: masks card-number-like digit runs split by repeated or mixed separators in existing edc_transactions rows (legend-tjwb); idempotent, edits no other column",
  "0144_system_approval_requester.sql":
    "inserts the reserved banned system user (id 00000000-0000-4000-8000-000000000002, no role, no sign-in account) that opens system refund approval chains, ON CONFLICT DO NOTHING with a check that an existing row is that account; adds the user and role-assignment guard triggers (legend-2dnh)",
  "0145_cash_shift_close_approval_policies_data.sql":
    "gives each tenant without a cash_shift_close approval policy the default rows (floor 0, level 1, supervisor, outlet_manager and general_manager template roles); idempotent, never touches a tenant that configured shift close (legend-ccpn)",
  "0459_session_shared_device_ids.sql":
    "backfill only (legend-jqurl): copies each session's single shared_device_id into the new shared_device_ids array before the old column is dropped, and clears shared_mode on devices that are not POS before the pos-only CHECK is added; no import, no money.",
  "0467_supplier_payment_approval_policies_data.sql":
    "gives each tenant without a supplier_payment approval policy the default rows (floor 0, level 1, finance and owner template roles, distinct actor); idempotent, never touches a tenant that configured supplier_payment, no amount, journal or payment touched (it only makes every supplier payment wait for a second person), FORCE RLS lifted for that one statement and restored (legend-xxqz3)",
  "0486_supplier_payment_base_tier_backfill.sql":
    "adds a base tier (copies every level and approver role of the lowest existing tier to floor 0, distinct actor) to each tenant whose supplier_payment matrix has rows but no level 1 row with floor null or 0 (skipped when the lowest tier has no level 1 row); only adds a requirement, never deletes or updates a row, idempotent, no amount, journal or payment touched, FORCE RLS lifted for that one statement and restored (legend-98etn)",
  "0466_cash_out_approval_policies_data.sql":
    "gives each tenant without a cash_out approval policy the default row (floor 0, level 1, finance template role, distinct actor); idempotent, never touches a tenant that configured cash_out, no amount, journal or cash entry touched, FORCE RLS lifted for that one statement and restored (legend-4qowr)",
  "0147_accounting_coa_backfill_1204.sql":
    "backfills accounts 1204, 6110 and 6111 and the employee_receivable, reimbursement_expense and pph21_borne_expense mappings for every already provisioned legal entity that lacks them (legend-s8a3); idempotent, never updates or deletes, keeps a custom account with the same code",
  "0148_open_bill_roles_permissions.sql":
    "appends floor.session.open_bill and floor.open_bill_policy.manage to the stored template role rows that hold them for existing tenants (legend-8cm4, legend-2zb5); idempotent, never touches a custom role",
  "0150_station_printer_binding_cleanup.sql":
    "clears stations.printer_device_id where it does not point at an active, unrevoked printer of the same tenant and outlet (legend-4xai); idempotent, edits no other column, a manager binds a valid printer again",
  "0155_payroll_custom_deduction_role.sql":
    "maps the payroll_custom_deduction role to the same account as salary_expense for every legal entity that has a salary_expense mapping and no payroll_custom_deduction mapping (legend-75kr); idempotent, never updates or deletes, FORCE RLS lifted for that one statement and restored",
  "0156_receipt_number_writeoffs.sql":
    "appends pos.receipt.writeoff to the stored owner template role rows of every tenant (legend-0hzqw); idempotent, never touches a custom role or another template",
  "0159_notification_policy_permission.sql":
    "appends org.notification_policy.manage to the stored owner and tenant_admin template role rows of existing tenants (legend-63l6); idempotent, never touches a custom role, FORCE RLS lifted for that one statement and restored",
  "0160_support_access_requests.sql":
    "appends org.support_access.approve to the stored owner template role rows of every tenant, one tenant context at a time (legend-c9kbk); idempotent, never touches a custom role or another template",
  "0170_edc_pan_backfill_separators.sql":
    "masks card-number-like digit runs (any whitespace, slash, underscore, dash separators) in the stored edc_transactions.message of existing rows, in batches of 1000 (legend-0lrkl, backfill for legend-deu7r); overwrites message text, idempotent, never inserts or deletes rows",
  "0171_access_perm_backfill.sql":
    "appends hr.announcement.manage, self.loan.request and self.sop.read to the stored template role rows of existing tenants (legend-9yb5u); idempotent, never touches a custom role, FORCE RLS lifted for these statements and restored",
  "0172_inventory_item_manage_backfill.sql":
    "appends inventory.item.manage to every role that holds inventory.stock.receive and to the owner and warehouse templates; idempotent, skips rows that already hold it, FORCE RLS lifted and restored",
  "0174_finance_policy_asset_register.sql":
    "backfills fixed_assets.code of existing assets (FA-nnnnn per entity)",
  "0177_storage_object_owner.sql":
    "links legacy core_storage_objects rows to their source record (source_kind, source_id) and sets owner_user_id (legend-pszrm); rows with a link are not rewritten again, no rows inserted or deleted, FORCE RLS lifted and restored",
  "0178_tenant_claims.sql":
    "gives unverified custom tenant_domains rows a DNS verification token (legend-t57t); only rows with no token, idempotent",
  "0186_stock_ledger_posting_seq.sql":
    "numbers the existing stock_ledger rows by (occurred_at, id) into the new posting_seq column (legend-bsw9); the append-only trigger and FORCE RLS are lifted for that one statement and restored in the same transaction, no other column changes, never inserts or deletes rows",
  // legend-k2l
  "0218_profit_share_unabsorbed.sql":
    "appends profit_share.share_allocation.change to the stored owner and finance template role rows of existing tenants (legend-8s992, founder Q84); idempotent, never touches a custom role, FORCE RLS lifted for this statement and restored",
  "0221_k2l_member_signin_identity.sql":
    "sets session.auth_method on the existing session rows (management sessions become password, every other row legacy) so the sign-in method gate keeps today's staff sessions working (legend-k2l); no other column changes, never inserts or deletes rows",
  "0234_uom_is_system.sql":
    "marks the twelve standard unit rows (kg, g, l, ml, pcs, pack, ctn, btl, can, sachet, box, porsi) of existing tenants as is_system by exact, case-sensitive code (legend-ie6m); only the new is_system column changes, never inserts or deletes rows, FORCE RLS on uoms lifted and restored",
  // legend-33im6 / legend-tm6pp (batch48b)
  "0217_profit_share.sql":
    "creates one profit_entities row per legacy profit_entity_id found on existing shareholder_documents and shareholder_document_files (ids kept, so no document is rewritten or deleted) before the foreign keys are added; only a tenant with no free legal entity makes it fail; FORCE RLS lifted on the parents and restored in the same migration",
  "0239_profit_share_recipient_versions.sql":
    "flags distribution_lines.recipient_unverified = true for every PAID line created before the migration that has no recipient yet, whether or not its shareholder has a login now (legend-33im6, Codex 405); unpaid lines stay unflagged and get the login at payment time; never sets recipient_user_id (no trusted pre-migration snapshot), only rows with no recipient yet, idempotent, the lines guard trigger and the deferred totals trigger are paused for that one statement only, FORCE RLS lifted and restored in the same migration",
  "0241_shareholder_version_approval_policy.sql":
    "gives every existing tenant that has an Owner template role and no shareholder_version approval policy the default row (floor 0, level 1, Owner, distinct actor) (legend-tm6pp); idempotent, never touches a tenant that already has such a policy, FORCE RLS lifted and restored in the same migration",
  "0357_reconciliation_case_approval.sql":
    "gives every existing tenant that has an Owner template role and no reconciliation_case approval policy the default row (floor 0, level 1, Owner, distinct actor) (PAY recon, PRD §3.7); idempotent, never touches a tenant that already has such a policy, no reconciliation case row is written or changed, FORCE RLS lifted on roles and approval_policies and restored in the same migration",
  // legend-89pn
  "0360_cash_movement_mapping_backfill.sql":
    "inserts accounts 2108 (Kas Masuk Belum Diklasifikasi) and 6112 (Beban Kas Keluar Kasir) and their cash_in_clearing / cash_out_expense mappings for every already provisioned (tenant, legal entity) pair that has at least one account_mappings row (legend-89pn); idempotent (only when the code or role is absent), never updates or deletes an account or mapping, never takes over a tenant's own account on those codes, parent only when it is a same-type unmapped leaf, FORCE RLS on chart_of_accounts and account_mappings lifted and restored in the same migration",
  "0187_audit_retention_maintenance.sql":
    "defines the audit retention SQL functions; the INSERT INTO audit_logs sits inside the purge function body (one summary row per batch, written at purge time), no row is written or changed while the migration runs (legend-usyi)",
  // legend-111j
  "0203_member_loyalty_ledger.sql":
    "appends crm.loyalty.manage, crm.loyalty.review, crm.loyalty.fulfil, crm.customer.pii.read and crm.feedback.manage to the stored template role rows of existing tenants (legend-111j); idempotent, never touches a custom role, FORCE RLS on roles lifted and restored; the other INSERT/UPDATE text is inside trigger function bodies (ledger balance, point value lock, profile index), no rows written at migration time",
  // purchase-return-posting
  "0205_purchase_return_posting.sql":
    "adds the cogs expense account 5104 (Pembelian Langsung, Kas Kecil) under 5100 for every legal entity that already has account mappings, and maps it to the petty_purchase_expense role; idempotent (WHERE NOT EXISTS plus ON CONFLICT DO NOTHING), never edits or deletes an existing account or mapping, FORCE RLS on chart_of_accounts and account_mappings lifted and restored",
  // supplier-return-petty
  "0208_supplier_return_petty.sql":
    "appends purchasing.return.create, purchasing.petty.record and purchasing.petty_policy.manage to the stored template role rows of existing tenants; idempotent (skips rows that already hold the code), never touches a custom role, FORCE RLS on roles lifted and restored",
  // legend-m4p5
  "0207_loyalty_rewards_missions.sql":
    "before adding vouchers_profile_fk, sets customer_profile_id to NULL on vouchers whose profile has no customer_profiles row in the same tenant and cancels those still issued (cancelled_reason profile_missing_0207) (legend-m4p5); touches only orphan rows and edits only customer_profile_id, status and cancelled_reason, FORCE RLS lifted for that one statement and restored, never inserts or deletes rows",
  // legend-l9rji (sub-302 D7/D27)
  "0211_platform_payment_gateways.sql":
    "seeds the two rows of the new global platform_payment_gateways table it creates (doit enabled and default, duitku off); touches no existing table or tenant row",
  // legend-37wom (Codex 411, batch48d)
  "0249_backfill_marketing_opt_in_from_consents.sql":
    "sets customer_profiles.marketing_opt_in from each profile's latest marketing consent decision (highest seq) where the flag differs; edits only that one column, never inserts or deletes rows, idempotent, FORCE RLS on consents and customer_profiles lifted and restored in the same migration",
  "0257_flag_attendance_for_leave.sql":
    "defines app.flag_attendance_for_leave: when a leave is approved, UPDATEs the employee's countable or flagged `in` attendance logs inside the leave dates to validity flagged, review pending, reason leave_approved (reopening an HR-accepted log); never inserts or deletes rows, idempotent, tenant-tied SECURITY DEFINER function, runs only when called",
  "0258_leave_clash_backfill.sql":
    "redefines the two leave functions and runs one backfill UPDATE of attendance_logs that flags old logs clashing with an already approved leave (pending review, reason leave_approved); skips logs in closed payroll runs, never inserts or deletes rows, idempotent, FORCE RLS on the touched tables lifted and restored in the same migration",
  // legend-lt0v4 (497 ledger guards)
  "0270_ledger_version_period_guards.sql":
    "trigger function body only: bumps legal_entities.ledger_version when a fiscal period changes status; no existing row is edited by the migration, no import",
  "0271_depreciation_active_and_reversal_fn.sql":
    "sets fixed_asset_depreciations.reversed_at from the existing reversal row's created_at (FORCE RLS lifted for that one statement and restored); edits no other column, never inserts or deletes; the reversal function body also inserts a reversal row and stamps reversed_at at runtime",
  "0273_fiscal_period_transition_fn.sql":
    "sets period_reopen_requests.consumed_at = decided_at on every already approved request (every old approval reopened its period at once, so it is spent; FORCE RLS lifted for that one statement and restored); edits no other column, never inserts or deletes; the close and reopen function bodies UPDATE fiscal_periods status and version and stamp consumed_at at runtime",
  "0274_depreciation_correction_claim.sql":
    "backfills fixed_asset_correction_claims from the existing depreciation reversals (claimed amount and reversed flag per journal); inserts only into the table it creates (FORCE RLS lifted and restored on the three tables it reads), edits no existing row; function bodies also write claims and reversals at runtime",
  // legend-xhlbz (ws01-identity)
  "0283_identity_unlink_permission_backfill.sql":
    "appends crm.customer.identity.unlink to the stored owner and tenant_admin template role rows of existing tenants (legend-xhlbz); idempotent, never touches a custom role, FORCE RLS on roles lifted and restored",
  // founder Q63 (ws05-pay-admin)
  "0286_refund_approval_matrix_data.sql":
    "gives each tenant that still has the old default refund matrix (no refund row, or one row: floor 0, level 1, supervisor template) the missing default rows for outlet_manager, general_manager and owner; idempotent, never touches a tenant that configured its own refund matrix, FORCE RLS on roles and approval_policies lifted and restored",
  "0288_edge_promo_streams.sql":
    "trigger bodies that stamp sync_txid on promotions, vouchers and promo_settings at runtime and bump the parent promotion when its outlet rows change; no existing rows are rewritten",
  "0276_leave_flag_closed_payroll.sql":
    "redefines app.flag_attendance_for_leave (function body UPDATE of attendance_logs, now skipping logs in closed payroll runs); no rows written by the migration",
  "0291_leave_flag_reset_review_case.sql":
    "redefines the leave-flag reset function (function body UPDATE of attendance_logs that returns the reset rows, clearing review fields incl. decision_action); no rows written by the migration",
  "0292_tax_payable_ppn_other_roles.sql":
    "backfills accounts 2205 and 2206 and the tax_payable_ppn and tax_payable_other mappings for every already provisioned legal entity that lacks them (legend-xa9bc, 538-G3); idempotent, never updates or deletes, keeps a custom account with the same code, FORCE RLS lifted for those statements and restored",
  "0293_journal_entry_order_id.sql":
    "backfills the new journal_entries.order_id of existing sale and refund journals from their source ids (orders, pos_order_refunds, order_issues; legend-knfl6, 538-G3); only rows with order_id NULL, sets that one link column and no amount, date or account; the append-only trigger is disabled for these statements and enabled again, FORCE RLS lifted and restored",
  "0308_hris_u4.sql":
    "appends dashboard.management.view to existing supervisor template role rows; idempotent, never touches a custom role or another template, FORCE RLS on roles lifted for the backfill and restored",
  "0331_cash_out_approval_grants.sql":
    "appends accounting.cash_bank.approve, accounting.cash_bank.limit.manage and accounting.cash_bank.record to the stored owner and finance template role rows of existing tenants; idempotent, no duplicates, never touches tenant_admin, another template or a custom role; each tenant is named (app.tenant_id) before its roles rows are touched, FORCE RLS stays on",
  "0335_purchase_price_variance.sql":
    "adds account 5105 Selisih Harga Pembelian and its purchase_price_variance mapping to every already provisioned (tenant, legal entity) pair; idempotent, never updates or deletes an existing account or mapping, no amount or journal touched; FORCE RLS lifted for the backfill and restored",
  "0380_inventory_price_variance.sql":
    "adds account 5106 Selisih Harga Persediaan and its inventory_price_variance mapping to every already provisioned (tenant, legal entity) pair (legend-uloj6); idempotent, never updates or deletes an existing account or mapping, no amount or journal touched; FORCE RLS lifted for the backfill and restored",
  "0337_edge_printer_sync_guards.sql":
    "trigger function bodies only: stamp sync_txid on edge_printers and edge_printer_tombstones at runtime and write a tombstone row when a printer is deleted; the migration itself rewrites no existing row and imports nothing",
  "0348_payout_gl_postings.sql":
    "maps the new bank_charges posting role to the entity's own account 8101 (an active expense account with no child account) for every already provisioned legal entity that has no bank_charges mapping (legend-658); idempotent, never updates or deletes, no amount or journal touched; FORCE RLS lifted for that one statement and restored",
  "0355_payout_source_bank_frozen.sql":
    "sets the new source_bank_account_id on manual_bank payout batches that are still approved or exported, copying the payout config's source account (the config cannot change while a batch runs); finished batches stay empty, existing values are never overwritten, no amount or journal touched; FORCE RLS lifted for that one statement and restored",
  "0346_payroll_disbursement_grants.sql":
    "appends payroll.payout.configure, payroll.disburse.request and payroll.disburse.approve to the stored owner, finance and hr template role rows of existing tenants (legend-wnkep.1; configure: owner+finance, request: owner+hr, approve: owner+finance+hr); idempotent, no duplicates, never touches tenant_admin, another template or a custom role; each tenant is named (app.tenant_id) before its roles rows are touched, FORCE RLS stays on",
  "0508_sealed_reseal_frozen.sql":
    "creates the app.reseal_frozen_sealed SECURITY DEFINER function, the legend_sealed_reseal group role and the frozen-column guard exception; the migration itself rewrites no existing row, and the only row effect is the compare-and-set re-seal UPDATE of the sealed column inside the function body when the reseal job calls it (legend-4vfmn, legend-49onu); no amount or journal touched, imports nothing",
  "0525_edge_catalog_v4.sql":
    "trigger function bodies only: stamp sync_txid on the v4 catalog tables and write a row of edge_catalog_tombstones when one of their rows is deleted at runtime (legend-osqou.22); the migration itself rewrites no existing row and imports nothing",
  "0529_edge_failover.sql":
    "marks the existing cloud-owned receipt runs (device key = outlet id, prefix C) as series 'cloud' (receipt_sequences FORCE lifted for the transaction and restored) and appends pos.failover.manage to the stored owner, outlet_manager and supervisor template role rows of existing tenants (1271 F1); each tenant is named (app.tenant_id) before its roles rows are touched; idempotent, never touches another template or a custom role, no receipt number, amount or journal changes, imports nothing",
  "0523_period_close_override_grants.sql":
    "appends accounting.period.close_override to the stored owner and finance template role rows of existing tenants (card 1263, founder no. 19); idempotent, no duplicates, never touches another template or a custom role; each tenant is named (app.tenant_id) before its roles rows are touched, FORCE RLS stays on; no table added, no amount or journal touched, imports nothing",
  "0505_payout_gl_resolve_grants.sql":
    "appends payroll.payout.gl_resolve to the stored owner and finance template role rows of existing tenants (legend-3xzop, legend-6qp12; sub-brief 1184); idempotent, no duplicates, never touches tenant_admin, hr, general_manager, another template or a custom role; each tenant is named (app.tenant_id) before its roles rows are touched, FORCE RLS stays on; no table added, no amount or journal touched, imports nothing",
  "0356_ops_checklist_manage_backfill.sql":
    "appends ops.checklist.manage to the stored owner, outlet_manager and kitchen_lead template role rows of existing tenants (legend-wg0g); idempotent, skips rows that already hold it, never touches a custom role or another template, FORCE RLS on roles lifted for that one statement and restored; no table added, imports nothing",
  "0363_kitchen_station_config.sql":
    "numbers stations.display_order of existing stations per outlet (name, created_at, id) so the KDS tabs keep the order they had (legend-bopi2); idempotent, edits no other column, is_active and auto_print_fallback take their column defaults, no amount touched; FORCE RLS lifted for that one statement and restored",
  "0364_kitchen_ticket_no.sql":
    "fills kitchen_tickets.business_date (outlet business day of fired_at, from the outlet zone and cutoff) and numbers kitchen_tickets.ticket_no 1.. per tenant, outlet and business day by fired_at, id for every existing ticket (legend-tzyj2); idempotent for tickets without a number, edits no other column, no amount touched; FORCE RLS lifted on kitchen_tickets and outlets for that one statement and restored",
  "0374_menu_recipe_fk.sql":
    "sets menu_items, item_variants and modifiers recipe_id to NULL where it has no recipe of the same tenant, so the new composite foreign key (tenant_id, recipe_id) -> recipes can validate (legend-3kdd); idempotent, edits no other column, no price, tax or amount touched, the modifiers part is skipped on an edge database (session setting legend.edge_mode); FORCE RLS lifted on those tables and recipes for the migration transaction and restored",
  "0375_recipes_resync_edges.sql":
    "re-stamps recipes, menu_items and item_variants with UPDATE ... SET updated_at = updated_at so the sync_txid trigger (0262) gives every row a fresh stamp and each edge pulls them again (legend-2uqcd); idempotent, no value edited, no price, tax or amount touched, skipped on an edge database (session setting legend.edge_mode); FORCE RLS lifted on those tables for the migration transaction and restored",
  // founder Q6 (15 Nov 2026, 864)
  "0378_ai_assistant_auto_enable.sql":
    "switches on the ai_assistant module (feature_flags.modules) for active tenants whose plan is an active package that includes ai_assistant and that already used AI (an ok tanya_ai or mcp usage event, or a user message); idempotent, skips tenants that already have the module, touches no limits, plan or integration providers, writes one tenant.module_auto_enabled audit row per changed tenant; FORCE RLS lifted for the statements that read audit_logs, ai_usage_events and ai_messages and restored",
  // legend-wcd24 (888)
  "0390_payout_frozen_payable_account.sql":
    "backfills payroll_payout_gl_postings.salaries_payable_account_id (the salaries payable account the lock journal of the run credited, read from that journal's own account snapshot) and payable_account_hold (uncertain accounts are held for finance reconciliation) on existing settle postings only; changes no amount, journal or other column; the posting guard trigger is disabled for those two statements and re-enabled, FORCE RLS lifted on the posting, chart, journal and batch tables for the migration transaction and restored",
  // legend-so897 (897)
  "0395_payout_proof_bindings.sql":
    "trigger body only: the SECURITY DEFINER AFTER INSERT trigger on payroll_payout_proof_bindings copies the new binding's own proof hashes into the global payroll_payout_proof_hashes (ON CONFLICT DO NOTHING; a hash held by another binding refuses the binding); no backfill, no existing row edited, no amount touched",
  "0398_payout_proof_hash_contests.sql":
    "trigger body only: the 0395 claim trigger, re-created, also records in the global payroll_payout_proof_hash_contests each hash a new legacy_duplicate binding finds already held (ON CONFLICT DO NOTHING); no backfill, no existing row edited, no amount touched",
  // legend-p2v4s (900)
  "0399_payout_proof_global_gate.sql":
    "function bodies only, no row edited: app.payout_proof_contest_own (SECURITY DEFINER, called by the backfill) inserts the non-empty hashes of the caller tenant's own binding into the global payroll_payout_proof_hash_contests (ON CONFLICT DO NOTHING); the migration itself adds the stuck operations column with its default and writes no row, no amount touched",
  "0401_pos_qris_holds.sql":
    "backfills one open pos_qris_holds row (backfilled = true) for each existing authorized QRIS tender with an unpaid payment link and for each pending QRIS bill-split intent, aborting first if a bill has more than one collectible QRIS, plus one open backfilled hold per ambiguous provider code (QRIS intent with a provider_ref, not paid or failed, of a voided or failed POS QRIS tender, an expired split part, a guest order-wide code, or a sibling code on a POS tender's link) on a bill that is not completed or voided; only inserts into the new table, edits no existing row, no amount touched; FORCE RLS lifted on bill_splits, payment_intents, pos_order_tenders and pos_orders for those statements and restored",
  "0403_pos_customer_display.sql":
    "no backfill: the only UPDATE statements are trigger bodies that bump customer_display_sessions.version when the selected order, QRIS hold or tender changes at runtime; touches no existing row at migration time, no amount touched",
  // legend-i01jp (905): 0409-0414; 0409 and 0410 contain no row-writing statement of their own
  "0411_payout_trusted_binding.sql":
    "function bodies only, no row edited by the migration: the payout-role functions app.payout_bind_proof and app.payout_backfill_bind insert the proof bindings of their own tenant, app.payout_backfill_claim_hashes fills the missing content/stored hashes of one return claim from its evidence file, and app.payout_proof_contest_own inserts into the global contests (ON CONFLICT DO NOTHING), all when called; no backfill, no amount touched",
  "0412_payout_posting_source_trusted.sql":
    "function body only, no row edited by the migration: app.payout_posting_record_source (payout role) sets source_gl_account_id on a settle_pending/settle_skipped posting that has none and inserts the attestation of who did it, when called; no backfill, no amount or journal touched",
  "0413_payout_proof_closures.sql":
    "function bodies only, no row edited by the migration: app.payout_proof_closure_propose and app.payout_proof_closure_approve (payout role) insert a proof closure and its attestations, record the closed key's hashes in the global contests (ON CONFLICT DO NOTHING) and resolve the matching stuck backfill row, when called; no backfill, no amount touched",
  "0414_payout_trusted_transitions.sql":
    "function bodies only, no row edited by the migration: the payout-role functions (correction propose/approve, overpaid propose/record, return propose/confirm, recon flag, attest) insert and update the correction, overpaid-proposal, return-claim, exception and attestation rows and move the item status, when called; the migration itself writes no row and changes no amount (it revokes legend_app write and re-grants the item columns)",
  // legend-911 (temporary numbers, the merge train renumbers): closure bind, step grants
  "0418_payout_911_closure_bind.sql":
    "trigger and function bodies only, no row edited by the migration: the closed-key triggers also fire on UPDATE OF evidence_key and app.payout_bind_proof (payout role) inserts the proof bindings of its own tenant when called, now only for a proof uploaded for the same batch and legal entity; no backfill, no amount touched",
  "0419_payout_step_grants.sql":
    "creates the payroll_payout_grants table and the functions app.payout_grant_issue (grantor login) and app.payout_grant_consume (payout role): they insert and consume one-time step grants when called; the migration itself writes no row and changes no amount",
  "0420_payout_trusted_steps_grant.sql":
    "function bodies only, no row edited by the migration: the nine payout-role step functions and app.payout_attest now consume a one-time grant instead of taking an actor and session, and insert and update the correction, overpaid-proposal, return-claim, closure, posting and attestation rows when called; the migration itself writes no row and changes no amount",
  "0421_payout_911_grant_kinds.sql":
    "constraint changes and function bodies only, no row edited by the migration: it adds the resolve and bank_confirm kinds to the grant, attestation and recon-exception CHECKs, and app.payout_grant_issue (grantor login) and app.payout_recon_flag (payout role) insert a grant or a recon exception when called; no backfill, no amount touched",
  "0422_payout_resolve_bank_confirm.sql":
    "function bodies only, no row edited by the migration: app.payout_resolve_propose, app.payout_resolve_approve and app.payout_bank_confirm (payout role) spend a one-time grant and move an exported item to failed, not_sent or succeeded when called, and the item guard is replaced; the migration itself writes no row and changes no amount",
  "0423_payout_run_settle.sql":
    "function bodies only, no row edited by the migration: app.payout_run_settle (payout role) turns a run paid when called, after re-checking its payments; the run guard is replaced; the migration itself writes no row and changes no amount",
  "0425_payout_proposal_withdraw.sql":
    "function bodies only, no row edited by the migration: app.payout_grant_issue (grantor login), app.payout_correction_propose, app.payout_overpaid_propose and the withdraw functions (payout role) insert a grant or a proposal, or mark an open correction or overpaid proposal withdrawn, when called; a withdrawn proposal stays as a row and the item is untouched; the migration itself writes no row and changes no amount",
  "0426_payout_approval_log.sql":
    "creates the append-only payroll_payout_approval_log table and replaces the function body of app.payout_attest (payout role), which inserts an attestation and a log row when called; the migration itself writes no row and changes no amount",
  // legend-xbagc (990 card A)
  "0461_payout_990_recon_clear.sql":
    "function bodies only, no row edited by the migration: app.payout_grant_issue (grantor login) inserts a recon_clear grant, app.payout_recon_clear_propose and app.payout_recon_clear_approve (payout role) insert and approve a clearance of a reconciliation flag when called (two different finance people, step-up grants), and the item guard and app.payout_resolve_approve read the clearance; the migration itself writes no row and changes no amount (it only releases a payslip held by a false flag, nobody is paid by it)",
  // legend-nsqhm (990 card E)
  "0463_payout_990_return_bank_ref.sql":
    "function bodies and a guard trigger only, no row edited by the migration: app.payout_return_propose and app.payout_return_confirm (payout role) store the bank transaction reference of a return on the claim and the item when called, and refuse a missing, differing or reused reference; the migration itself writes no row and changes no amount (it only adds a refusal)",
  "0480_payout_1038_evidence_observations.sql":
    "creates the append-only payroll_payout_recon_evidence_observations table and function bodies only, no row edited by the migration: app.payout_recon_evidence_observe (payout role) inserts an observation of an operation's proof file when the nightly recon calls it, and app.payout_recon_flag_fingerprint adds the latest non-ok observation to a flag's fingerprint; a flag with no observation keeps its fingerprint, no amount, item, payslip or clearance row is touched, and a changed proof only holds a slip back (legend-63gyr)",
  "0481_payout_qh11l_read_error_hold.sql":
    "function bodies, a check constraint and one NOLOGIN role (legend_payout_recon, SET-only membership of the app role) only, no row edited by the migration: app.payout_recon_evidence_observe_ok (recon role only) is the one path that records an 'ok' read, and app.payout_recon_evidence_observe refuses 'ok'; app.payout_recon_evidence_observe_difference (recon role only) is the one path that records a missing or mismatch read after a read error, and app.payout_recon_evidence_observe refuses that from any other caller, so only a fresh recon read can release a held slip (legend-tiw2h); app.payout_recon_evidence_observe (payout role) also records an 'error' observation when the nightly recon cannot read a proof file for a reason other than not found, and app.payout_recon_flag_fingerprint adds a read_error key while the latest observation of an operation is an error, so a clearance held against the earlier fingerprint stops releasing the slip until a later read succeeds; app.payout_recon_clear_approve refuses while the error is the latest observation; a fingerprint without an error observation is unchanged, no amount, item, payslip or clearance row is touched, and the error only holds a slip back (legend-qh11l)",
  "0502_payout_jsrcs_clear_while_lock_held.sql":
    "function body only, no row edited by the migration: app.payout_recon_clear_approve (payout role) refuses the second step of a clearance of an evidence_read_locked flag while another backend still holds the advisory lock of the flag's operation; the migration itself writes no row, pays nobody and only holds a slip back (legend-jsrcs)",
  "0503_payout_attest_clock_and_lock_database.sql":
    "function bodies only, no row edited by the migration: app.payout_recon_clear_approve (payout role) counts only advisory locks of the current database when it refuses the second step of an evidence_read_locked clearance, and app.payout_attest (payout role) stamps attested_at with clock_timestamp() read after the session's mfa_verified_at, so a concurrent MFA re-verify no longer makes a good attestation look mfa_stale; the migration itself writes no row, pays nobody and changes no amount (legend-1e9py, legend-9cx64)",
  "0506_payout_so1173_lock_episode_and_approve_guard.sql":
    "function bodies only, no row edited by the migration: app.payout_recon_flag (payout role) raises a new evidence_read_locked flag, reason suffixed with the episode number, when a lock timeout comes after the latest flag of that day was cleared by two people, so the old clearance no longer frees the slip; app.payout_recon_clear_approve (payout role) takes the advisory lock of the flag's operation (pg_try_advisory_xact_lock) until the end of the approval instead of reading pg_locks, and refuses with PAYOUT-91 when a run holds it; the migration itself writes no row, pays nobody and only holds a slip back (legend-qqsw8, legend-1hpqt)",
  "0507_payout_t1ufu_hold_unwritten.sql":
    "creates the append-only payroll_payout_recon_unwritten_holds table and function bodies only, no row edited by the migration: app.payout_recon_hold_unwritten (payout role) inserts one hold row per item when the nightly recon could not write a flag, and app.payout_payslip_held_by_recon also holds a slip while such a hold is not taken over by a flag of the same kind, operation and item flagged since; the migration itself writes no row, pays nobody and changes no amount, a hold only holds a slip back (legend-t1ufu)",
  "0509_payout_1192_hold_release.sql":
    "creates the append-only payroll_payout_recon_hold_releases and payroll_payout_recon_hold_clean_reads tables (the latter is insert-only, read-only to the app role), adds a unique key to the holds table, adds the hold_release kind to the grant CHECKs and replaces function bodies only, no row edited by the migration: app.payout_recon_hold_unwritten (payout role) now returns how many items hold after the call and writes a new hold row when the older hold was released, app.payout_payslip_held_by_recon no longer holds a slip for a hold that has an approved release, and the new app.payout_recon_clean_read (payout role) writes one clean-read row when the proof file was read ok while an evidence hold is open; nobody is paid by it and no amount, item or payslip row is touched (legend-6o7pc)",
  "0510_payout_1192_hold_release_grant.sql":
    "function body only, no row edited by the migration: app.payout_grant_issue (grantor login) copied from 0472 with one added kind, hold_release, which inserts a password-only grant for proposing or approving the release of a hold; every other kind is unchanged and the migration writes no row and pays nobody (legend-6o7pc)",
  "0511_payout_1192_hold_release_functions.sql":
    "function bodies only, no row edited by the migration: app.payout_recon_hold_status reads (clean only for an evidence hold with a clean read after it), and app.payout_recon_hold_release_propose and app.payout_recon_hold_release_approve (payout role) insert and approve a hold release when called by two different finance people under step-up grants, only while the hold is not taken over by a flag and the recon evidence is clean; the release only lifts a hold on a slip, no amount is touched and nobody is paid by it (legend-6o7pc)",
  "0464_payout_990_flag_fingerprint.sql":
    "backfill only (legend-hklnq): one fingerprint sighting per existing payout recon exception, computed from that exception's own item, attestation and posting rows, so a later recon can tell whether the flagged data changed; no amount, item, payslip or clearance row is edited, and an exception without a matching clearance keeps holding its payslip",
  // legend-snwnn (1005)
  "0472_payout_1005_return_withdraw.sql":
    "creates the payroll_payout_return_withdrawals table, widens the return claim status and adds withdrawn_at, adds the return_withdraw kind to the grant, attestation and recon-exception CHECKs, and replaces function bodies and guards; no row is edited by the migration: app.payout_return_withdraw_propose and app.payout_return_withdraw_approve (payout role) insert a withdrawal row and, when called by two different finance people under step-up grants, move an OPEN return claim to withdrawn and clear the five return columns of its items (the item stays succeeded, no journal, payment record or batch is touched, nobody is paid again by it), app.payout_grant_issue (grantor login) inserts a grant, and the claim and item guards refuse any other change; the one existing-row effect is the unique bank_ref index, rebuilt to ignore withdrawn claims",
  "0473_payout_1005_recon_flag_kind.sql":
    "function body only, no row edited by the migration: app.payout_recon_flag (payout role) also accepts the return_withdraw kind and inserts a reconciliation exception and a sighting when called; no backfill, no amount touched",
  // legend-1089 (second opinion, round 5)
  "0519_ptkp_tax_year_history.sql":
    "bead 1223: creates employee_ptkp_history and seeds it once from the tenant's own employees (join date plus current PTKP status, NOT NULL only); the employees trigger is the only later writer; FORCE RLS on employees lifted for that one read and restored; no import, no payroll amount touched",
  "0520_ptkp_history_correction.sql":
    "bead 1223: replaces the PTKP history trigger function (an INSERT ... ON CONFLICT DO UPDATE inside the function body, run only on a later employees change) and revokes INSERT/UPDATE/DELETE/TRUNCATE on employee_ptkp_history from the app role; no existing row is written by the migration; no import",
  "0501_payout_waive_trusted.sql":
    "function bodies and grants only, no row edited by the migration: app.payout_waive_skipped (payout role) flips kind settle_skipped -> settle_waived on a cash posting when its correcting waive journal is valid, when called; the guard and the commit-check functions are redefined; no backfill, no amount or journal touched",
  // legend-628t9 (954)
  "0436_payout_grant_expiry_after_lock.sql":
    "function body only, no row edited by the migration: app.payout_grant_consume (payout role) reads its clock after the run, batch and grant row locks and refuses a grant that expired while it waited, marking a grant consumed only when called; it keeps the existing grant rules and changes no amount (it only blocks a late approval, nobody is paid)",
  // legend-s20iu, legend-dz8ci (947)
  "0433_payout_934_followups.sql":
    "trigger and function bodies only, no row edited by the migration: app.payout_batch_unfreeze (payout role) sends an approved batch back to pending_approval and its approved items back to prepared when called after a 'not me' on the main approval, app.payout_grant_issue (grantor login) and app.payout_batch_approve_attest (payout role) refuse the person who disowned a batch approval, and a new trigger refuses any change of the approval columns of a batch outside the approval step; the migration itself writes no row and changes no amount (it only blocks approvals and reopens one, nobody is paid)",
  // legend-xp8mc (934)
  "0432_payout_batch_approve_grant.sql":
    "adds the batch_approve grant and attestation kind, a trigger on payroll_disbursement_batches and function bodies only, no row edited by the migration: app.payout_grant_issue (grantor login) inserts a grant, app.payout_batch_approve_attest (payout role) spends it and inserts an attestation and an approval log row when called, app.payout_recon_flag (payout role) accepts the batch_approve kind and inserts a reconciliation flag when called; the trigger only refuses an approval without the grant; the migration itself writes no row and changes no amount (it only blocks approvals)",
  // legend-4us1a (987)
  "0474_facility_hours_wfc_breakfast.sql":
    "seeds one baseline facility_operating_hours_versions row per existing facility at 1970-01-01 (a copy of facilities.operating_hours, so every date resolves to the hours it has today) and adds the floor_zones.is_wfc and menu_items.is_breakfast flags with a default of false; no amount, status or bill touched, so nobody is paid more",
  // legend-3wpf (941 card C)
  "0439_payment_intent_provider_answered.sql":
    "adds the nullable payment_intents.provider_answered_at column and backfills it from provider_final_at on the rows that already have one (the provider already answered final, a copy of an existing value, NULL to a value only); no amount, status or bill touched, so nobody is paid more",
  // legend-39d.4 (964)
  "0446_promotion_ai_action_request_key.sql":
    "adds promotions.ai_action_request_id and backfills it only from the `[ai:<id>]` marker already at the end of promotions.description (the earliest promotion per tenant and marker keeps the key, so the partial unique index can be created); the description, money fields and every other row stay as they are, never imports data, FORCE RLS lifted on promotions and restored in the same migration",
  // legend-yd9u2 (923)
  "0430_payout_backfill_unfreeze_lock_order.sql":
    "function body only, no row edited by the migration: app.payout_batch_unfreeze acquires same-run batches in id order before its target; it keeps the existing grant, dispute and unfreeze rules and changes no amount",
  "0429_payout_freeze_run_lock.sql":
    "function bodies only, no row edited by the migration: payout freeze, unfreeze and settlement functions acquire the run before batches; grant issuance requires password step-up for unfreeze; the migration itself writes no row and changes no amount",
  // legend-l2zru (918)
  "0428_payout_batch_freeze_guards.sql":
    "trigger and function bodies only, no row edited by the migration: guards that refuse a payout step on a batch with an open dispute (PAYOUT-79), and the item/batch guard functions that update rows only when a payout function is called; the migration itself writes no row and changes no amount (it only blocks payments)",
  // legend-yn1of / legend-uvjqq (1035 B), 1090 P1-2
  "0496_provider_refund_id_kind.sql":
    "sets provider_refund_id_kind to provider on the refund_recon_holds rows that already name a refund id (a copy of the id they hold, no guess, no amount touched); only rows with a null kind, idempotent, never inserts or deletes rows, FORCE RLS lifted for that one statement and restored",
  "0499_refund_hold_invalid_report.sql":
    "relabels to invalid_report the refund_recon_holds conflict rows whose id carries the made-up invalid: or invalid-h: prefix (restrictive, no amount touched); only the kind column changes, never inserts or deletes rows, FORCE RLS lifted for that one statement and restored",
  "0427_payout_batch_disputes.sql":
    "creates the append-only payroll_payout_batch_disputes and payroll_payout_batch_unfreezes tables, adds the disown and unfreeze grant kinds, and function bodies only: app.payout_approval_disown and app.payout_batch_unfreeze (payout role) insert a dispute or the unfreeze rows of a batch when called, app.payout_grant_issue (grantor login) inserts a grant; the migration itself writes no row and changes no amount (a dispute only freezes a batch, nobody is paid more)",
};

// Entrypoints that open a database pool but import no data.
const POOL_OPENERS_NOT_IMPORTERS: Record<string, string> = {
  "apps/api/src/migrate.ts": "applies DDL migrations only",
  "apps/api/src/set-role.ts": "single admin UPDATE of one user's role",
  "apps/api/src/db/reset-preswitch-refund-payouts.ts":
    "one-off repair of refunds already in the database (UPDATE of payout state, dry-run by default), imports nothing",
  "apps/api/src/db/backfill-employee-managers.ts":
    "one-off repair of employees.manager_id on existing rows from an HR-reviewed manifest (dry-run by default), imports nothing (legend-qhqf8)",
  "apps/api/src/db/repair-supplier-invoice-npwp.ts":
    "explicit one-invoice repair of a legacy supplier_invoices.npwp_snapshot (one tenant, entity, invoice, actor and audited reason on the command line; the audit row shares the transaction), imports nothing (547b)",
  "apps/api/src/db/backfill-ptkp-history.ts":
    "one-shot release backfill of employee_ptkp_history from the tenant's own payslips (bead 1223 r2), idempotent, imports nothing",
  "apps/api/src/worker-main.ts":
    "job runner: delivery state of its own tenant's work, no imports",
  "apps/api/src/db/role.ts": "runtime role helper, no data writes",
  "scripts/doctor.mjs": "read-only health query",
  "scripts/dev-public-site.mjs":
    "read-only lookup of the synthetic development public site; writes local environment configuration only, imports no database rows",
  "scripts/test-setup.mjs":
    "writes a marker table into a disposable test database only",
  "apps/api/src/worker/audit-retention.job.ts":
    "maintenance pool for the daily audit retention purge: calls two SECURITY DEFINER functions that delete expired audit rows, imports nothing (legend-usyi)",
};

// package.json script names matching /seed|import|backfill/ that are not
// importers outside the registry. Empty on purpose: add an entry with a reason.
const SCRIPT_NAME_ALLOWLIST: Record<string, string> = {
  "package.json#db:backfill-defaults":
    "runs the registered, guarded source backfill.tenant-defaults (root alias)",
  "apps/api/package.json#metrics:backfill":
    "release-only recompute of derived metrics_daily from existing source rows (legend-ka1hg), --dry-run available; not an importer, no external data",
  "apps/api/package.json#db:backfill-employee-managers":
    "one-off repair of employees.manager_id from an HR-reviewed manifest (dry-run by default); not an importer, listed in POOL_OPENERS_NOT_IMPORTERS",
  "apps/api/package.json#db:backfill-defaults":
    "runs the registered, guarded source backfill.tenant-defaults",
  "apps/api/package.json#payroll:backfill-pph21-receivable":
    "release-only backfill of the employee PPh 21 receivable open item from the tenant's own payslips (legend-i848k), --dry-run available, idempotent, never above the payslip balance; not an importer, no external data, listed in NOT_A_WRITER",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = toPosix(path.relative(API_SRC, full));
    if (entry.isDirectory()) {
      if (
        entry.name === "test" ||
        entry.name === "node_modules" ||
        rel === "db/schema"
      )
        continue;
      walk(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(`apps/api/src/${rel}`);
    }
  }
  return out;
}

describe("data import registry: registered sources call the guard", () => {
  it("registers at least one source", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  for (const [id, source] of sources) {
    it(`[${id}] ${source.file} calls guardDataImport("${id}") before its first write`, () => {
      // Comments are stripped so a commented-out call cannot satisfy the test.
      const code = readRepoFile(source.file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const entry = source.entry === undefined ? 0 : code.indexOf(source.entry);
      expect(entry).toBeGreaterThanOrEqual(0);
      const call = new RegExp(`guardDataImport\\(\\s*"${id}"`).exec(
        code.slice(entry),
      );
      const guard = call ? entry + call.index : -1;
      expect(guard).toBeGreaterThanOrEqual(0);
      const write = code.indexOf(source.beforeWrite, entry);
      expect(write).toBeGreaterThanOrEqual(0);
      expect(guard).toBeLessThan(write);
    });
  }
});

describe("data import registry: edge master sync (legend-8izz)", () => {
  // master-sync.ts is not import-named, so the filename scan below skips it;
  // pin the guard statically next to the behaviour test in
  // edge-master-sync.test.ts.
  const code = readRepoFile("apps/api/src/edge/master-sync.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it('guardMasterImport calls guardDataImport("edge.bootstrap")', () => {
    const body = code.slice(code.indexOf("function guardMasterImport("));
    expect(code.indexOf("function guardMasterImport(")).toBeGreaterThanOrEqual(
      0,
    );
    expect(body.slice(0, body.indexOf("\n}"))).toMatch(
      /guardDataImport\(\s*"edge\.bootstrap"/,
    );
  });

  for (const entry of [
    "function applyEdgeMasterSnapshotInTransaction(",
    "function syncEdgeMasters(",
  ])
    it(`${entry} calls the guard before anything else writes or fetches`, () => {
      const start = code.indexOf(entry);
      expect(start).toBeGreaterThanOrEqual(0);
      const guard = code.indexOf("guardMasterImport()", start);
      expect(guard).toBeGreaterThan(start);
      const firstWrite = code.indexOf(".insert(", start);
      const firstFetch = code.indexOf("fetch", start + entry.length);
      if (firstWrite >= 0) expect(guard).toBeLessThan(firstWrite);
      if (entry.includes("syncEdgeMasters") && firstFetch >= 0)
        expect(guard).toBeLessThan(firstFetch);
    });
});

describe("data import registry: no unregistered import/seed/backfill file", () => {
  const candidates = walk(API_SRC).filter((file) =>
    /import|seed|backfill|bootstrap/i.test(path.posix.basename(file)),
  );

  it("finds the registered importer files while walking apps/api/src", () => {
    for (const file of registeredFiles) expect(candidates).toContain(file);
  });

  it("every import/seed/backfill-named file is registered or explained", () => {
    const unexplained = candidates.filter(
      (file) => !registeredFiles.has(file) && !(file in NOT_A_WRITER),
    );
    expect(
      unexplained,
      "register these in DATA_IMPORT_SOURCES (and call guardDataImport) or add them to NOT_A_WRITER with a reason",
    ).toEqual([]);
  });

  it("every NOT_A_WRITER entry still exists and has a reason", () => {
    for (const [file, reason] of Object.entries(NOT_A_WRITER)) {
      expect(candidates, file).toContain(file);
      expect(reason.length, file).toBeGreaterThan(10);
      expect(registeredFiles.has(file), `${file} is also registered`).toBe(
        false,
      );
    }
  });

  it("routes/menu-import.routes.ts only calls the service: no direct database access", () => {
    const route = readRepoFile("apps/api/src/routes/menu-import.routes.ts");
    expect(route).toContain("../services/menu-import.service.ts");
    expect(route).not.toMatch(/from\s+["'][^"']*\/db\//);
    expect(route).not.toMatch(/from\s+["']drizzle-orm/);
    expect(route).not.toMatch(/\b(?:db|tx)\.(?:insert|update|delete)\(/);
  });
});

describe("data import registry: scripts and package scripts", () => {
  const scriptsDir = path.join(REPO_ROOT, "scripts");
  const mjsFiles = readdirSync(scriptsDir).filter((f) => f.endsWith(".mjs"));

  it("every src/db/<x>.ts referenced from scripts/*.mjs is registered or explained", () => {
    const referenced = new Set<string>();
    for (const file of mjsFiles) {
      const text = readFileSync(path.join(scriptsDir, file), "utf8");
      for (const match of text.matchAll(/src\/db\/([\w.-]+\.ts)/g))
        referenced.add(`apps/api/src/db/${match[1]}`);
    }
    // Sanity: the walk sees the seed script that scripts/ runs.
    expect([...referenced]).toContain("apps/api/src/db/seed-dev-tenant.ts");

    const unexplained = [...referenced].filter(
      (file) => !registeredFiles.has(file) && !(file in SCRIPT_NOT_A_WRITER),
    );
    expect(
      unexplained,
      "register these in DATA_IMPORT_SOURCES or add them to SCRIPT_NOT_A_WRITER with a reason",
    ).toEqual([]);
  });

  it("every package.json script named seed/import/backfill is allowlisted", () => {
    const names: string[] = [];
    for (const pkg of ["package.json", "apps/api/package.json"]) {
      const json = JSON.parse(readRepoFile(pkg)) as {
        scripts?: Record<string, string>;
      };
      for (const name of Object.keys(json.scripts ?? {}))
        if (/seed|import|backfill/.test(name)) names.push(`${pkg}#${name}`);
    }
    const unexplained = names.filter((n) => !(n in SCRIPT_NAME_ALLOWLIST));
    expect(
      unexplained,
      "route these through a registered, guarded source, then allowlist with a reason",
    ).toEqual([]);
  });
});

describe("data import registry: migrations, pools and bootstrap", () => {
  it("every SQL migration with INSERT/UPDATE statements is acknowledged", () => {
    const dir = path.join(REPO_ROOT, "apps/api/drizzle");
    const withData = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) =>
        /^\s*(INSERT\s+INTO|UPDATE\s)/im.test(
          readFileSync(path.join(dir, f), "utf8"),
        ),
      );
    const unexplained = withData.filter(
      (f) => !(f in MIGRATION_DATA_STATEMENTS),
    );
    expect(
      unexplained,
      "a migration writes rows: explain it in MIGRATION_DATA_STATEMENTS (backfills only, never imports)",
    ).toEqual([]);
    for (const f of Object.keys(MIGRATION_DATA_STATEMENTS))
      expect(withData, f).toContain(f);
  });

  it("every non-test file that opens a Pool is registered or explained", () => {
    const files = [
      ...walk(API_SRC),
      ...readdirSync(path.join(REPO_ROOT, "scripts"))
        .filter((f) => f.endsWith(".mjs"))
        .map((f) => `scripts/${f}`),
    ].filter((file) => file !== "apps/api/src/config/data-import.ts");
    const openers = files.filter((file) =>
      /new\s+(?:pg\.)?Pool\(/.test(
        readRepoFile(file)
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, ""),
      ),
    );
    const unexplained = openers.filter(
      (file) =>
        !registeredFiles.has(file) && !(file in POOL_OPENERS_NOT_IMPORTERS),
    );
    expect(
      unexplained,
      "register in DATA_IMPORT_SOURCES or add to POOL_OPENERS_NOT_IMPORTERS with a reason",
    ).toEqual([]);
    for (const file of Object.keys(POOL_OPENERS_NOT_IMPORTERS))
      expect(openers, file).toContain(file);
  });
});

describe("seed.dev-tenant fails closed without an explicit deployment mode", () => {
  const deployment = (
    DEPLOYMENT_MODE: DeploymentMode,
    DATA_CLASSIFICATION: DataClassification,
  ) =>
    ({
      DEPLOYMENT_MODE,
      EDGE_MODE: false,
      DATA_CLASSIFICATION,
    }) as DeploymentSettings;
  const dev = {
    DEPLOYMENT_MODE: "development",
    EDGE_MODE: false,
    DATA_CLASSIFICATION: "synthetic",
  } as DeploymentSettings;

  it("refuses a remote database when DEPLOYMENT_MODE is unset", () => {
    for (const databaseUrl of [
      "postgres://u:p@db.prod.example.com:5432/legend",
      "postgres://u:p@10.0.0.5/legend",
      undefined,
      "not a url",
    ])
      expect(
        () => guardDataImport("seed.dev-tenant", dev, { databaseUrl, env: {} }),
        String(databaseUrl),
      ).toThrow(DataImportBlockedError);
  });

  it("is not fooled by host tricks in the URL", () => {
    for (const databaseUrl of [
      "postgres://u:p@localhost/db?host=db.prod.example.com",
      "postgres://u:p@localhost/db?hostaddr=10.0.0.5",
      "postgres://u:p@localhost/db?service=prod",
      "postgres://localhost@evil.example.com/db",
      "postgres://u:p@localhost.example.com/db",
      "postgres://u:p@localhost./db",
      "postgres:///db",
    ])
      expect(
        () => guardDataImport("seed.dev-tenant", dev, { databaseUrl, env: {} }),
        databaseUrl,
      ).toThrow(DataImportBlockedError);
    expect(() =>
      guardDataImport("seed.dev-tenant", dev, {
        databaseUrl: "postgres://u:p@LOCALHOST:5432/db",
        env: {},
      }),
    ).not.toThrow();
  });

  it("seed-dev-tenant hands the guard the URL its pool will use", () => {
    const code = readRepoFile("apps/api/src/db/seed-dev-tenant.ts");
    expect(code).toMatch(
      /process\.env\.MIGRATION_DATABASE_URL\s*\?\?\s*process\.env\.DATABASE_URL/,
    );
  });

  it("treats a blank DEPLOYMENT_MODE as unset", () => {
    expect(() =>
      guardDataImport("seed.dev-tenant", dev, {
        databaseUrl: "postgres://u:p@db.example.com/legend",
        env: { DEPLOYMENT_MODE: "  " },
      }),
    ).toThrow(DataImportBlockedError);
  });

  it("allows a local database when DEPLOYMENT_MODE is unset", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "db.localhost"])
      expect(() =>
        guardDataImport("seed.dev-tenant", dev, {
          databaseUrl: `postgres://u:p@${host}:5433/legend`,
          env: {},
        }),
      ).not.toThrow();
  });

  it("allows any host once DEPLOYMENT_MODE is explicit development", () => {
    expect(() =>
      guardDataImport("seed.dev-tenant", dev, {
        databaseUrl: "postgres://u:p@db.example.com/legend",
        env: { DEPLOYMENT_MODE: "development" },
      }),
    ).not.toThrow();
  });

  it("explicit staging or production is still blocked for the seed", () => {
    for (const mode of ["staging", "production"] as const)
      expect(() =>
        guardDataImport("seed.dev-tenant", deployment(mode, "synthetic"), {
          databaseUrl: "postgres://u:p@localhost/legend",
          env: { DEPLOYMENT_MODE: mode },
        }),
      ).toThrow(DataImportBlockedError);
  });
});

describe("edge.bootstrap follows the node's own deployment policy", () => {
  const edge = (mode: DeploymentMode, cls: DataClassification) =>
    ({
      DEPLOYMENT_MODE: mode,
      EDGE_MODE: true,
      DATA_CLASSIFICATION: cls,
    }) as DeploymentSettings;

  it("passes for synthetic data anywhere and real data in production", () => {
    for (const mode of ["development", "staging", "production"] as const)
      expect(() =>
        guardDataImport("edge.bootstrap", edge(mode, "synthetic")),
      ).not.toThrow();
    expect(() =>
      guardDataImport("edge.bootstrap", edge("production", "real")),
    ).not.toThrow();
  });

  it("blocks real data outside production", () => {
    for (const mode of ["development", "staging"] as const)
      expect(() =>
        guardDataImport("edge.bootstrap", edge(mode, "real")),
      ).toThrow(DataImportBlockedError);
  });
});

describe("guardDataImport behaviour", () => {
  const modes: DeploymentMode[] = ["development", "staging", "production"];
  const classifications: DataClassification[] = ["synthetic", "real"];

  const deployment = (
    DEPLOYMENT_MODE: DeploymentMode,
    DATA_CLASSIFICATION: DataClassification,
  ): DeploymentSettings =>
    ({
      DEPLOYMENT_MODE,
      EDGE_MODE: false,
      DATA_CLASSIFICATION,
    }) as DeploymentSettings;

  describe("seed.dev-tenant (synthetic, development only)", () => {
    for (const classification of classifications) {
      it(`passes in development with ${classification} classification`, () => {
        expect(() =>
          guardDataImport(
            "seed.dev-tenant",
            deployment("development", classification),
          ),
        ).not.toThrow();
      });
    }

    for (const mode of modes.filter((m) => m !== "development"))
      for (const classification of classifications)
        it(`is blocked in ${mode} with ${classification} classification`, () => {
          expect(() =>
            guardDataImport(
              "seed.dev-tenant",
              deployment(mode, classification),
            ),
          ).toThrow(DataImportBlockedError);
        });
  });

  describe("menu-import.commit (classification follows the deployment)", () => {
    const allowed: [DeploymentMode, DataClassification][] = [
      ["development", "synthetic"],
      ["staging", "synthetic"],
      ["production", "real"],
      ["production", "synthetic"],
    ];
    const blocked: [DeploymentMode, DataClassification][] = [
      ["staging", "real"],
      ["development", "real"],
    ];

    for (const [mode, classification] of allowed)
      it(`passes in ${mode} with ${classification} data`, () => {
        expect(() =>
          guardDataImport(
            "menu-import.commit",
            deployment(mode, classification),
          ),
        ).not.toThrow();
      });

    for (const [mode, classification] of blocked)
      it(`throws DataImportBlockedError in ${mode} with ${classification} data`, () => {
        const attempt = () =>
          guardDataImport(
            "menu-import.commit",
            deployment(mode, classification),
          );
        expect(attempt).toThrow(DataImportBlockedError);
        expect(attempt).toThrow(/production/);
      });
  });

  describe("payment-settlement.import (classification follows the deployment)", () => {
    const allowed: [DeploymentMode, DataClassification][] = [
      ["development", "synthetic"],
      ["staging", "synthetic"],
      ["production", "real"],
      ["production", "synthetic"],
    ];
    const blocked: [DeploymentMode, DataClassification][] = [
      ["staging", "real"],
      ["development", "real"],
    ];

    for (const [mode, classification] of allowed)
      it(`passes in ${mode} with ${classification} data`, () => {
        expect(() =>
          guardDataImport(
            "payment-settlement.import",
            deployment(mode, classification),
          ),
        ).not.toThrow();
      });

    for (const [mode, classification] of blocked)
      it(`throws DataImportBlockedError (403) in ${mode} with ${classification} data`, () => {
        try {
          guardDataImport(
            "payment-settlement.import",
            deployment(mode, classification),
          );
          expect.unreachable("guard should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(DataImportBlockedError);
          expect((error as DataImportBlockedError).status).toBe(403);
          expect((error as DataImportBlockedError).sourceId).toBe(
            "payment-settlement.import",
          );
        }
      });
  });

  it("throws DataImportBlockedError carrying the source id", () => {
    try {
      guardDataImport("menu-import.commit", deployment("staging", "real"));
      expect.unreachable("guard should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DataImportBlockedError);
      expect((error as DataImportBlockedError).sourceId).toBe(
        "menu-import.commit",
      );
    }
  });

  it("blocks an unregistered source id", () => {
    expect(() =>
      guardDataImport(
        "not.registered" as DataImportSourceId,
        deployment("production", "real"),
      ),
    ).toThrow(DataImportBlockedError);
  });
});
