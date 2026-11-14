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
  "apps/api/src/db/backfill-employee-managers.ts":
    "one-off repair of employees.manager_id on existing rows (legend-qhqf8): dry-run by default, --apply writes only HR-reviewed before/after tuples from a manifest, one audit row each; imports no data",
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
  "0337_edge_printer_sync_guards.sql":
    "trigger function bodies only: stamp sync_txid on edge_printers and edge_printer_tombstones at runtime and write a tombstone row when a printer is deleted; the migration itself rewrites no existing row and imports nothing",
  "0348_payout_gl_postings.sql":
    "maps the new bank_charges posting role to the entity's own account 8101 (an active expense account with no child account) for every already provisioned legal entity that has no bank_charges mapping (legend-658); idempotent, never updates or deletes, no amount or journal touched; FORCE RLS lifted for that one statement and restored",
  "0355_payout_source_bank_frozen.sql":
    "sets the new source_bank_account_id on manual_bank payout batches that are still approved or exported, copying the payout config's source account (the config cannot change while a batch runs); finished batches stay empty, existing values are never overwritten, no amount or journal touched; FORCE RLS lifted for that one statement and restored",
  "0346_payroll_disbursement_grants.sql":
    "appends payroll.payout.configure, payroll.disburse.request and payroll.disburse.approve to the stored owner, finance and hr template role rows of existing tenants (legend-wnkep.1; configure: owner+finance, request: owner+hr, approve: owner+finance+hr); idempotent, no duplicates, never touches tenant_admin, another template or a custom role; each tenant is named (app.tenant_id) before its roles rows are touched, FORCE RLS stays on",
  "0356_ops_checklist_manage_backfill.sql":
    "appends ops.checklist.manage to the stored owner, outlet_manager and kitchen_lead template role rows of existing tenants (legend-wg0g); idempotent, skips rows that already hold it, never touches a custom role or another template, FORCE RLS on roles lifted for that one statement and restored; no table added, imports nothing",
  "0363_kitchen_station_config.sql":
    "numbers stations.display_order of existing stations per outlet (name, created_at, id) so the KDS tabs keep the order they had (legend-bopi2); idempotent, edits no other column, is_active and auto_print_fallback take their column defaults, no amount touched; FORCE RLS lifted for that one statement and restored",
  "0364_kitchen_ticket_no.sql":
    "fills kitchen_tickets.business_date (outlet business day of fired_at, from the outlet zone and cutoff) and numbers kitchen_tickets.ticket_no 1.. per tenant, outlet and business day by fired_at, id for every existing ticket (legend-tzyj2); idempotent for tickets without a number, edits no other column, no amount touched; FORCE RLS lifted on kitchen_tickets and outlets for that one statement and restored",
  "0374_menu_recipe_fk.sql":
    "sets menu_items, item_variants and modifiers recipe_id to NULL where it has no recipe of the same tenant, so the new composite foreign key (tenant_id, recipe_id) -> recipes can validate (legend-3kdd); idempotent, edits no other column, no price, tax or amount touched; FORCE RLS lifted on those tables and recipes for the migration transaction and restored",
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
  "apps/api/package.json#db:backfill-employee-managers":
    "one-off repair of employees.manager_id from an HR-reviewed manifest (dry-run by default); not an importer, listed in POOL_OPENERS_NOT_IMPORTERS",
  "apps/api/package.json#db:backfill-defaults":
    "runs the registered, guarded source backfill.tenant-defaults",
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
