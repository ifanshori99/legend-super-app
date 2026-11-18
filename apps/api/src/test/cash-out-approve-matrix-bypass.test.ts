// Approval matrix bypass fixes (beads legend-bf8f2 F1 and legend-ycb4h F2; tier
// K money; second opinion docs/qa/second-opinion-supplier-payout.md "Temuan
// 991"; founder decision Q27, 17 Nov 2026). Written from the briefs, the shared
// approval contract (packages/shared/src/access/approval.ts) and the existing
// HTTP/inbox conventions, not from the implementation. Real Express app, Better
// Auth, RLS and PostgreSQL on the disposable test DB.
//
// Rules under test:
// - F1: a cash out that has an approval chain is posted by the direct endpoint
//   `POST /api/accounting/cash-bank/entries/:id/approve` ONLY once EVERY level
//   of the chain is approved, each by a different person holding that level's
//   role. Before that the call is refused, the entry stays `pending_approval`,
//   no journal is written, and the chain is left intact (not cancelled).
// - F2: a supplier payment ALWAYS needs at least one approval by a person other
//   than the requester, at every amount, also in a tenant with a single Owner.
//   A tier threshold may only ADD levels. `PUT /api/access/approval-policies`
//   refuses a `supplier_payment` configuration that would let one person pay
//   alone (only tiers with threshold > 0 and no base tier that requires
//   approval).
//
// Ids used in test names:
// - BP-F1-a  direct approve before level 1 is refused, nothing moves
// - BP-F1-b  direct approve after level 1 (before the Owner level) is refused
// - BP-F1-c  after all levels approved the direct approve posts exactly once
// - BP-F1-d  same, when the consumer already applied the decision first
// - BP-F1-e  another tenant is not touched, a foreign entry stays invisible
// - BP-F2-a  below any threshold the payment is held; requester cannot approve
// - BP-F2-b  at or above the threshold the tier still applies (control)
// - BP-F2-c  sole Owner cannot pay alone at any amount
// - BP-F2-d  PUT approval-policies refuses a loosening supplier_payment matrix
// - BP-F2-e  another tenant is not touched
//
// Assumptions where the briefs are silent (also in the report):
// - F1 refusal answers a 4xx domain error (409 or 403 or 422, not pinned), never
//   404, for a call made by a finance user who is not the creator. The response
//   code is not pinned.
// - Chain rows: `approval_requests` has one row per level of a chain
//   (`level`, `status`, `chain_id`, `object_type = 'cash_bank_entry'`,
//   `object_id` = entry id), as in platform-approval.test.ts. "Chain intact"
//   means no row of the chain is `cancelled`, `rejected` or `expired` after the
//   refused call, and the first pending level is still pending.
// - The two-level cash_out matrix is built for the shared test tenant as the
//   migration owner (level 1 Finance, level 2 Owner, threshold 0, distinct
//   actor) under the exclusive limit lock, and the previous cash_out rows are
//   put back afterwards, like cash-out-approval-inbox.test.ts does.
// - A decision made in the inbox alone changes nothing on the entry (the
//   consumer applies it); the direct endpoint after the LAST level approved is
//   a legitimate way to apply it (200, status approved, one journal). Replays
//   of the consumer or of the direct call keep exactly one journal.
// - F1 single-level default matrix: this file does NOT pin whether a direct
//   approve of a chain with ONE level still pending is refused or counted as
//   that level's decision (the older accounting-cash-out-approval.test.ts
//   relies on the latter). The engineer decides; only multi-level skipping
//   (the finding) is pinned here.
// - F2: with a loosened matrix (threshold > 0 only, set directly as the
//   migration owner, as a tenant configured before the fix would have it) a
//   payment request is ACCEPTED (200/201) with status `pending_approval` and an
//   approval chain. Money is never moved by the request itself.
// - F2: the approver of the base level is Finance or Owner (the default of
//   DEFAULT_SUPPLIER_PAYMENT_APPROVAL_POLICIES). The test tries a Finance and
//   an Owner template user, whoever the fixed code names, and only asserts
//   that the chain resolves and the consumer pays exactly once.
// - F2: the requester cannot approve their own payment (the inbox decision is
//   refused); `supplier_payment` is not a self-approvable action.
// - F2 PUT: the refusal is a 4xx other than 401/403/404 (the caller is a
//   legitimate Owner with MFA; a control PUT with a valid matrix first proves
//   that the caller may configure the matrix). The stored matrix does not
//   change on a refusal. The PUT replaces the whole matrix, so the test sends
//   back every other action type it read.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { approvalResolvedEvent } from "@starter/shared/identity";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { seedTenantRoleTemplates } from "../services/access.service.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { handleCashBankApprovalResolved } from "../services/cash-bank-approval-consumer.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
import { handlePurchasingApprovalResolved } from "../services/purchasing-approval-consumer.ts";
import { originHeader, verifySessionMfa } from "./helpers.ts";
import {
  closeKit,
  daysAgo,
  journalLinesOf,
  journalsByKey,
  key,
  makeWorld,
  owner,
  short,
  signedIn,
  tenantId,
  type Session,
  type World,
} from "./helpers/cash-bank-world.ts";
import { stampMfa } from "./helpers/cash-out-chain.ts";
import { limitExclusiveLock } from "./helpers/cash-limit-lock.ts";
import {
  addUser,
  api,
  appPool as aparAppPool,
  contextFor,
  createInvoice,
  createWorld,
  invoiceBody,
  invoiceIdOf,
  key as aparKey,
  owner as aparOwner,
  receive,
  seedPo,
  today,
  type Session as AparSession,
  type World as AparWorld,
} from "./purchasing-apar-helpers.ts";

const app = createApp();
const ENTRIES = "/api/accounting/cash-bank/entries";
const DEFAULT_LIMIT = 5_000_000;
const ACTION = "cash_out";
const HELD_ACTION = "cash_out_held_by_bf8f2";

const is4xx = (status: number) => status >= 400 && status < 500;

// ============================================================================
// F1: cash out, direct approve versus a two-level matrix
// ============================================================================

let world: World;
let approver: Session; // Finance, decides level 1
let bypasser: Session; // Finance, calls the direct endpoint (not the creator)
let financeOther: Session; // Finance, tries to take level 2
let noMfaCaller: Session; // Finance, never verifies a second factor
let ownerUser: Session; // Owner, decides level 2

const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);
const tenantContext = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });

const freshCreator = (label: string) =>
  signedIn(app, `BP ${label}`, [{ role: "finance", outletId: null }]);

const post = (who: Session, body: Record<string, unknown>) =>
  who.client
    .post(ENTRIES)
    .set(originHeader)
    .send(body as object);
const directApprove = (who: Session, entryId: string) =>
  who.client
    .post(`${ENTRIES}/${encodeURIComponent(entryId)}/approve`)
    .set(originHeader)
    .send({});

const cashOutBody = (extra: Record<string, unknown> = {}) => ({
  kind: "cash_out",
  legalEntityId: world.entityId,
  bankAccountId: world.bankAccountA,
  counterAccountId: world.gl.expense,
  amountIdr: DEFAULT_LIMIT + 1_000,
  entryDate: daysAgo(1),
  description: "Bayar supplier besar dua tingkat",
  reference: `REF-${short()}`,
  idempotencyKey: key(),
  ...extra,
});

async function submitPending(amountIdr: number) {
  // A fresh creator each time: the daily anti-split total starts at zero.
  const creator = await freshCreator(`creator ${amountIdr}`);
  const res = await post(creator, cashOutBody({ amountIdr }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.data.status).toBe("pending_approval");
  return { id: res.body.data.id as string, creator };
}

type EntryRow = {
  status: string;
  approver_id: string | null;
  journal_entry_id: string | null;
};
async function entryRow(id: string): Promise<EntryRow> {
  const { rows } = await owner.query<EntryRow>(
    "SELECT status, approver_id, journal_entry_id FROM cash_bank_entries WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  expect(rows, `entry ${id}`).toHaveLength(1);
  return rows[0]!;
}

const journalsOf = (entryId: string) =>
  journalsByKey(world.entityId, `cb:${entryId}`);

async function bankNet(): Promise<number> {
  const { rows } = await owner.query<{ net: string }>(
    "SELECT coalesce(sum(debit_idr - credit_idr), 0)::text AS net FROM journal_lines WHERE tenant_id = $1 AND account_id = $2",
    [tenantId, world.gl.bankA],
  );
  return Number(rows[0]!.net);
}

type RequestRow = {
  id: string;
  chain_id: string;
  level: number;
  status: string;
};
/** The approval requests of the entry, one row per level, lowest level first. */
async function requestRows(entryId: string): Promise<RequestRow[]> {
  const { rows } = await owner.query<RequestRow>(
    `SELECT id, chain_id, level, status FROM approval_requests
      WHERE tenant_id = $1 AND object_type = 'cash_bank_entry' AND object_id = $2
      ORDER BY level, created_at`,
    [tenantId, entryId],
  );
  return rows;
}
async function pendingRequest(entryId: string): Promise<RequestRow> {
  const pending = (await requestRows(entryId)).filter(
    (r) => r.status === "pending",
  );
  expect(pending.length, `pending request of ${entryId}`).toBeGreaterThan(0);
  return pending[0]!;
}

const inboxDecide = (
  userId: string,
  requestId: string,
  decision: "approved" | "rejected",
) =>
  decideApprovalRequest(
    tenantContext(),
    userId,
    requestId,
    { decision, reason: "Sesuai bukti pembayaran." },
    { mfaVerified: true, idempotencyKey: null },
  );

async function resolvedEventOfChain(chainId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [tenantId, chainId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** Nothing happened to the entry: pending, no journal, no money, chain intact. */
async function expectUntouched(entryId: string, netBefore: number) {
  expect(await entryRow(entryId)).toMatchObject({
    status: "pending_approval",
    approver_id: null,
    journal_entry_id: null,
  });
  expect(await journalsOf(entryId)).toHaveLength(0);
  expect(await bankNet()).toBe(netBefore);
  const statuses = (await requestRows(entryId)).map((r) => r.status);
  for (const bad of ["cancelled", "rejected", "expired"])
    expect(statuses, `chain of ${entryId} must stay intact`).not.toContain(bad);
}

/** Replaces the tenant's cash_out matrix by Finance (level 1) + Owner (level 2). */
async function withTwoLevelMatrix(run: () => Promise<void>): Promise<void> {
  const held = await owner.query<{ id: string }>(
    `UPDATE approval_policies SET action_type = $3
      WHERE tenant_id = $1 AND action_type = $2 RETURNING id`,
    [tenantId, ACTION, HELD_ACTION],
  );
  let inserted: string[] = [];
  try {
    const roleOf = async (templateKey: string) => {
      const { rows } = await owner.query<{ id: string }>(
        "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
        [tenantId, templateKey],
      );
      if (!rows[0]) throw new Error(`No ${templateKey} template role`);
      return rows[0].id;
    };
    for (const [templateKey, level] of [
      ["finance", 1],
      ["owner", 2],
    ] as const) {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         VALUES ($1, $2, 0, $3, $4, true) RETURNING id`,
        [tenantId, ACTION, await roleOf(templateKey), level],
      );
      inserted = [...inserted, rows[0]!.id];
    }
    await run();
  } finally {
    if (inserted.length > 0)
      await owner.query(
        "DELETE FROM approval_policies WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, inserted],
      );
    if (held.rows.length > 0)
      await owner.query(
        "UPDATE approval_policies SET action_type = $2 WHERE tenant_id = $1 AND id = ANY($3::uuid[])",
        [tenantId, ACTION, held.rows.map((r) => r.id)],
      );
  }
}

/** Safety net: put held cash_out rows back if a test died in the middle. */
async function restoreHeldPolicies() {
  await owner.query(
    "UPDATE approval_policies SET action_type = $2 WHERE tenant_id = $1 AND action_type = $3",
    [tenantId, ACTION, HELD_ACTION],
  );
}

// ============================================================================
// F2: supplier payment, one person can never pay alone
// ============================================================================

/** Invoice of 10 kg x Rp 10.000, no tax: payable is Rp 100.000. */
const PAYABLE = 100_000;
/** Tier floor of the loosened matrix. */
const THRESHOLD = 50_000;
/** A floor nobody reaches. */
const NEVER = 1_000_000_000_000;

type Tenant = {
  world: AparWorld;
  bankAccountId: string;
  buyer: AparSession;
  warehouse: AparSession;
  /** Requests payments; also holds the Finance template (an approver role). */
  requester: AparSession;
  approverFinance: AparSession;
  approverOwner: AparSession;
};

async function templateRoleId(w: AparWorld, templateKey: string) {
  const { rows } = await aparOwner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [w.tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} template role`);
  return rows[0].id;
}

async function assignTemplate(
  w: AparWorld,
  who: AparSession,
  templateKey: string,
) {
  await aparOwner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [w.tenantId, who.userId, await templateRoleId(w, templateKey)],
  );
}

/** A new tenant as provisioning leaves it (role templates + default policies). */
async function setupTenant(
  label: string,
  options: { withOwner?: boolean } = {},
): Promise<Tenant> {
  const w = await createWorld(label);
  await withTenant(db, contextFor(w, null), (tx) =>
    seedTenantRoleTemplates(tx, w.tenantId),
  );
  const bank = await aparOwner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '1103', 'Bank Operasional', 'asset', 'cash_and_equivalents') RETURNING id`,
    [w.tenantId, w.entityId],
  );
  await aparOwner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'bank', $3)`,
    [w.tenantId, w.entityId, bank.rows[0]!.id],
  );
  const requester = await addUser(w, `${label} requester`, [
    { role: "finance", outletId: null },
  ]);
  await assignTemplate(w, requester, "finance");
  const approverFinance = await addUser(w, `${label} approver finance`, []);
  await assignTemplate(w, approverFinance, "finance");
  const approverOwner = await addUser(w, `${label} approver owner`, []);
  if (options.withOwner !== false)
    await assignTemplate(w, approverOwner, "owner");
  return {
    world: w,
    bankAccountId: bank.rows[0]!.id,
    buyer: await addUser(w, `${label} buyer`, [
      { role: "purchasing", outletId: w.outletId },
    ]),
    warehouse: await addUser(w, `${label} warehouse`, [
      { role: "warehouse", outletId: w.outletId },
    ]),
    requester,
    approverFinance,
    approverOwner,
  };
}

/**
 * The loosened matrix of a tenant configured before the fix: ONE tier from
 * `thresholdIdr` (> 0), Finance, one level. No tier below it.
 */
async function loosenPolicy(t: Tenant, thresholdIdr: number): Promise<void> {
  await aparOwner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'supplier_payment'",
    [t.world.tenantId],
  );
  await aparOwner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     VALUES ($1, 'supplier_payment', $2, $3, 1, true)`,
    [t.world.tenantId, thresholdIdr, await templateRoleId(t.world, "finance")],
  );
}

async function invoiceFor(t: Tenant): Promise<string> {
  const po = await receive(t.world, t.warehouse, await seedPo(t.world));
  const res = await createInvoice(t.world, t.buyer, invoiceBody(t.world, po));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return invoiceIdOf(res);
}

const requestPayment = (
  t: Tenant,
  who: AparSession,
  invoiceId: string,
  amountIdr: number,
) =>
  api.post(t.world, who, `/supplier-invoices/${invoiceId}/payments`, {
    amountIdr,
    paidOn: today(),
    idempotencyKey: aparKey(),
  });

type PaymentRow = {
  id: string;
  status: string;
  amount_idr: string;
  requested_by: string;
  approval_chain_id: string | null;
};
async function paymentRows(
  t: Tenant,
  invoiceId: string,
): Promise<PaymentRow[]> {
  const { rows } = await aparOwner.query<PaymentRow>(
    `SELECT id, status, amount_idr::text, requested_by, approval_chain_id
       FROM supplier_payments
      WHERE tenant_id = $1 AND supplier_invoice_id = $2 ORDER BY created_at`,
    [t.world.tenantId, invoiceId],
  );
  return rows;
}

async function outstanding(t: Tenant, invoiceId: string): Promise<number> {
  const { rows } = await aparOwner.query<{ outstanding: string }>(
    `SELECT (original_idr - settled_idr)::text AS outstanding
       FROM accounting_open_items
      WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
    [t.world.tenantId, invoiceId],
  );
  return Number(rows[0]!.outstanding);
}

async function paymentJournals(t: Tenant) {
  const { rows } = await aparOwner.query<{
    id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT e.id, coalesce(sum(l.debit_idr), 0)::text AS debit, coalesce(sum(l.credit_idr), 0)::text AS credit
       FROM journal_entries e LEFT JOIN journal_lines l ON l.entry_id = e.id AND l.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1 AND e.source_type = 'supplier_payment'
      GROUP BY e.id ORDER BY e.id`,
    [t.world.tenantId],
  );
  return rows.map((r) => ({
    id: r.id,
    debit: Number(r.debit),
    credit: Number(r.credit),
  }));
}

const aparTenantContext = (t: Tenant) =>
  establishTenantContext({
    tenantId: tenantIdSchema.parse(t.world.tenantId),
    brandId: null,
    source: "domain",
  });

function decideChain(
  t: Tenant,
  who: AparSession,
  chainId: string,
  decision: "approved" | "rejected" = "approved",
) {
  return decideApprovalRequest(
    aparTenantContext(t),
    who.userId,
    chainId,
    { decision, reason: "Sesuai tagihan dan bukti pemasok." },
    { mfaVerified: true, idempotencyKey: null },
  );
}

async function resolvedEvents(t: Tenant, chainId: string) {
  const { rows } = await aparOwner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [t.world.tenantId, chainId],
  );
  return rows.map((row) =>
    approvalResolvedEvent.envelopeSchema.parse(row.event),
  );
}

/**
 * Whoever the fixed code names as approver (Finance or Owner template role),
 * as many different people as the chain needs, until the chain is resolved.
 * The requester is never among them.
 */
async function approveChain(t: Tenant, chainId: string) {
  for (const who of [t.approverFinance, t.approverOwner]) {
    if ((await resolvedEvents(t, chainId)).length > 0) break;
    await decideChain(t, who, chainId).catch(() => undefined);
  }
  expect(
    (await resolvedEvents(t, chainId)).length,
    "the chain is resolved by people other than the requester",
  ).toBe(1);
}

async function applyResolved(t: Tenant, chainId: string) {
  await handlePurchasingApprovalResolved(
    contextFor(t.world, null),
    (await resolvedEvents(t, chainId))[0]!,
  );
}

/** Requests a payment and checks it is held: accepted, pending, no money. */
async function expectHeld(
  t: Tenant,
  who: AparSession,
  invoiceId: string,
  amountIdr: number,
) {
  const res = await requestPayment(t, who, invoiceId, amountIdr);
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  const id = (res.body as { data: { id: string; status: string } }).data.id;
  const row = (await paymentRows(t, invoiceId)).find((r) => r.id === id)!;
  expect(
    row.status,
    `Rp ${amountIdr} must not be paid by the requester alone`,
  ).toBe("pending_approval");
  expect(row.requested_by).toBe(who.userId);
  expect(row.approval_chain_id).toBeTruthy();
  return { id, chainId: row.approval_chain_id! };
}

type PolicyRow = {
  action_type: string;
  threshold_idr: string | null;
  approver_role_id: string;
  levels: number;
};
async function policyRows(
  tenant: string,
  actionType?: string,
): Promise<PolicyRow[]> {
  const { rows } = await aparOwner.query<PolicyRow>(
    `SELECT action_type, threshold_idr::text, approver_role_id, levels
       FROM approval_policies
      WHERE tenant_id = $1 AND ($2::text IS NULL OR action_type = $2)
      ORDER BY action_type, threshold_idr NULLS FIRST, levels, approver_role_id`,
    [tenant, actionType ?? null],
  );
  return rows;
}

let LOOSE: Tenant; // threshold Rp 50.000 only, requester + approvers
let SOLE: Tenant; // threshold NEVER, one Owner who also requests
let OTHER: Tenant; // default matrix, never touched
let POLICY: Tenant; // PUT approval-policies tests
let soleOwner: AparSession;
let policyAdmin: AparSession;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // F1 fixtures.
  world = await makeWorld();
  approver = await freshCreator("approver");
  bypasser = await freshCreator("bypasser");
  financeOther = await freshCreator("finance other");
  noMfaCaller = await freshCreator("no mfa");
  // The direct endpoint needs a verified second factor (998) on top of the
  // chain rule (1037): the callers that are meant to get past it carry one.
  await stampMfa(approver);
  await stampMfa(bypasser);
  ownerUser = await signedIn(app, "BP owner", [
    { role: "owner", outletId: null },
  ]);
  // F2 fixtures.
  setAuditWriter(coreAuditWriter);
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
  LOOSE = await setupTenant("bp-loose");
  await loosenPolicy(LOOSE, THRESHOLD);
  // Only one Owner in this tenant, and that Owner also requests payments.
  SOLE = await setupTenant("bp-sole", { withOwner: false });
  soleOwner = await addUser(SOLE.world, "bp sole owner", [
    { role: "finance", outletId: null },
  ]);
  await assignTemplate(SOLE.world, soleOwner, "owner");
  await loosenPolicy(SOLE, NEVER);
  OTHER = await setupTenant("bp-other");
  POLICY = await setupTenant("bp-policy", { withOwner: false });
  policyAdmin = await addUser(POLICY.world, "bp policy admin", []);
  await assignTemplate(POLICY.world, policyAdmin, "owner");
  await verifySessionMfa(policyAdmin.email);
});

afterAll(async () => {
  await restoreHeldPolicies().catch(() => {});
  setSupplierInvoicePostingEnabled(null);
  setPurchaseReturnPostingEnabled(null);
  setAuditWriter(null);
  await closeKit();
  await aparAppPool.end();
  await aparOwner.end();
});

// ============================================================================

describe("legend-bf8f2 cash out: a direct approve cannot skip matrix levels", () => {
  limitExclusiveLock();

  it("[cash-out-approve-matrix-bypass-F1-a] a direct approve before level 1 is refused: still pending, no journal, chain intact", async () => {
    await withTwoLevelMatrix(async () => {
      const { id } = await submitPending(6_010_000);
      const first = await pendingRequest(id);
      expect(first.level).toBe(1);
      const netBefore = await bankNet();

      const res = await directApprove(bypasser, id);
      expect(is4xx(res.status), JSON.stringify(res.body)).toBe(true);
      expect(res.status, JSON.stringify(res.body)).not.toBe(404);
      expect(typeof res.body.error.code).toBe("string");

      await expectUntouched(id, netBefore);
      expect((await pendingRequest(id)).id).toBe(first.id);

      // Control: the real path works, so the refusal was the matrix.
      await inboxDecide(approver.userId, first.id, "approved");
      expect(
        (await requestRows(id)).find((r) => r.id === first.id)?.status,
      ).toBe("approved");
    });
  });

  it("[cash-out-approve-matrix-bypass-F1-b] after level 1 but before the Owner level a direct approve is refused; level 2 stays open and only the Owner can decide it", async () => {
    await withTwoLevelMatrix(async () => {
      const { id } = await submitPending(6_020_000);
      const level1 = await pendingRequest(id);
      await inboxDecide(approver.userId, level1.id, "approved");
      const level2 = await pendingRequest(id);
      expect(level2.level).toBe(2);
      expect(level2.id).not.toBe(level1.id);
      const netBefore = await bankNet();

      // Finance B (not the creator, not the level 1 approver) and the level 1
      // approver himself both try the direct endpoint.
      for (const who of [bypasser, approver]) {
        const res = await directApprove(who, id);
        expect(is4xx(res.status), JSON.stringify(res.body)).toBe(true);
        expect(res.status, JSON.stringify(res.body)).not.toBe(404);
      }
      await expectUntouched(id, netBefore);
      expect((await pendingRequest(id)).id).toBe(level2.id);

      // The Owner level cannot be taken by a Finance user in the inbox either.
      await expect(
        inboxDecide(financeOther.userId, level2.id, "approved"),
      ).rejects.toThrow();
      await expectUntouched(id, netBefore);

      // Control: the Owner decides level 2, the chain resolves.
      await inboxDecide(ownerUser.userId, level2.id, "approved");
      expect((await requestRows(id)).map((r) => [r.level, r.status])).toEqual([
        [1, "approved"],
        [2, "approved"],
      ]);
    });
  });

  it("[cash-out-approve-matrix-bypass-F1-c] once every level is approved the direct approve posts exactly one balanced journal; replays add none", async () => {
    await withTwoLevelMatrix(async () => {
      const amountIdr = 6_030_000;
      const { id } = await submitPending(amountIdr);
      const netBefore = await bankNet();

      // Not yet: nothing is posted before, between and after the refused calls.
      expect(is4xx((await directApprove(bypasser, id)).status)).toBe(true);
      const level1 = await pendingRequest(id);
      await inboxDecide(approver.userId, level1.id, "approved");
      expect(is4xx((await directApprove(bypasser, id)).status)).toBe(true);
      await expectUntouched(id, netBefore);

      const level2 = await pendingRequest(id);
      await inboxDecide(ownerUser.userId, level2.id, "approved");
      // The decisions alone move no money (the consumer applies them).
      expect(await journalsOf(id)).toHaveLength(0);

      const ok = await directApprove(bypasser, id);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.data.status).toBe("approved");
      const journals = await journalsOf(id);
      expect(journals).toHaveLength(1);
      expect((await entryRow(id)).journal_entry_id).toBe(journals[0]!.id);
      const lines = await journalLinesOf(journals[0]!.id);
      const debit = lines.reduce((sum, l) => sum + l.debit, 0);
      const credit = lines.reduce((sum, l) => sum + l.credit, 0);
      expect(debit).toBe(amountIdr);
      expect(credit).toBe(amountIdr);
      expect(await bankNet()).toBe(netBefore - amountIdr);

      // Replays: the consumer and a second direct call keep one journal.
      const event = await resolvedEventOfChain(level1.chain_id);
      await handleCashBankApprovalResolved(tenantWide, event, new Date());
      const again = await directApprove(bypasser, id);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(await journalsOf(id)).toHaveLength(1);
      expect(await bankNet()).toBe(netBefore - amountIdr);
    });
  });

  it("[cash-out-approve-matrix-bypass-F1-f] a direct approve without a verified second factor is refused although the chain is already approved: nothing posted, then the same call with MFA posts once", async () => {
    await withTwoLevelMatrix(async () => {
      const amountIdr = 6_040_000;
      const { id } = await submitPending(amountIdr);
      const level1 = await pendingRequest(id);
      await inboxDecide(approver.userId, level1.id, "approved");
      const level2 = await pendingRequest(id);
      await inboxDecide(ownerUser.userId, level2.id, "approved");
      expect(await journalsOf(id)).toHaveLength(0);
      const netBefore = await bankNet();

      // The chain is fully approved, yet a session without MFA gets nothing.
      const refused = await directApprove(noMfaCaller, id);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.error.code).toBe("MFA_REQUIRED");
      expect(await entryRow(id)).toMatchObject({
        status: "pending_approval",
        approver_id: null,
        journal_entry_id: null,
      });
      expect(await journalsOf(id)).toHaveLength(0);
      expect(await bankNet()).toBe(netBefore);

      // Control: the same caller after verifying MFA posts exactly once.
      await stampMfa(noMfaCaller);
      const ok = await directApprove(noMfaCaller, id);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.data.status).toBe("approved");
      expect(await journalsOf(id)).toHaveLength(1);
      expect(await bankNet()).toBe(netBefore - amountIdr);
    });
  });

  it("[cash-out-approve-matrix-bypass-F1-d] when the consumer applied the full chain first, a later direct approve changes nothing: one journal", async () => {
    await withTwoLevelMatrix(async () => {
      const amountIdr = 6_040_000;
      const { id } = await submitPending(amountIdr);
      const netBefore = await bankNet();
      const level1 = await pendingRequest(id);
      await inboxDecide(approver.userId, level1.id, "approved");
      await inboxDecide(
        ownerUser.userId,
        (await pendingRequest(id)).id,
        "approved",
      );
      const event = await resolvedEventOfChain(level1.chain_id);
      await handleCashBankApprovalResolved(tenantWide, event, new Date());
      await handleCashBankApprovalResolved(tenantWide, event, new Date());
      expect((await entryRow(id)).status).toBe("approved");
      expect(await journalsOf(id)).toHaveLength(1);

      const late = await directApprove(bypasser, id);
      expect(late.status, JSON.stringify(late.body)).toBe(200);
      expect(await journalsOf(id)).toHaveLength(1);
      expect(await bankNet()).toBe(netBefore - amountIdr);
    });
  });

  it("[cash-out-approve-matrix-bypass-F1-e] another tenant is not touched: its entry stays invisible and its matrix and journals do not change", async () => {
    const foreignPolicies = () =>
      owner.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM approval_policies WHERE tenant_id = $1",
        [world.foreign.tenantId],
      );
    const foreignJournals = () =>
      owner.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1",
        [world.foreign.tenantId],
      );
    await withTwoLevelMatrix(async () => {
      const own = await submitPending(6_050_000);
      const policiesBefore = (await foreignPolicies()).rows[0]!.n;
      const journalsBefore = (await foreignJournals()).rows[0]!.n;

      // A pending entry of the foreign tenant: a copy of this tenant's row.
      const foreignCounter = await owner.query<{ id: string }>(
        `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
         VALUES ($1, $2, '6101', 'Beban asing', 'expense', 'operating_expense') RETURNING id`,
        [world.foreign.tenantId, world.foreign.entityId],
      );
      const foreignId = randomUUID();
      const source = await owner.query<{ doc: Record<string, unknown> }>(
        "SELECT to_jsonb(e) AS doc FROM cash_bank_entries e WHERE tenant_id = $1 AND id = $2",
        [tenantId, own.id],
      );
      const doc = {
        ...source.rows[0]!.doc,
        id: foreignId,
        tenant_id: world.foreign.tenantId,
        legal_entity_id: world.foreign.entityId,
        bank_account_id: world.foreign.bankAccountId,
        counter_account_id: foreignCounter.rows[0]!.id,
        outlet_id: null,
        idempotency_key: key(),
        journal_entry_id: null,
        status: "pending_approval",
        approver_id: null,
        decided_at: null,
        decision_reason: null,
      };
      await owner.query(
        "INSERT INTO cash_bank_entries SELECT (json_populate_record(NULL::cash_bank_entries, $1::json)).*",
        [JSON.stringify(doc)],
      );
      const policiesWithEntry = (await foreignPolicies()).rows[0]!.n;

      const res = await directApprove(bypasser, foreignId);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.error.code).toBe("CASH_ENTRY_NOT_FOUND");
      const { rows } = await owner.query<EntryRow & { tenant_id: string }>(
        "SELECT tenant_id, status, approver_id, journal_entry_id FROM cash_bank_entries WHERE id = $1",
        [foreignId],
      );
      expect(rows[0]).toMatchObject({
        tenant_id: world.foreign.tenantId,
        status: "pending_approval",
        approver_id: null,
        journal_entry_id: null,
      });
      expect(policiesWithEntry).toBe(policiesBefore);
      expect((await foreignPolicies()).rows[0]!.n).toBe(policiesBefore);
      expect((await foreignJournals()).rows[0]!.n).toBe(journalsBefore);

      // The own entry is still bound by the two levels (control).
      expect(is4xx((await directApprove(bypasser, own.id)).status)).toBe(true);
      expect((await entryRow(own.id)).status).toBe("pending_approval");
    });
  });
});

// ============================================================================

describe("legend-ycb4h supplier payment: one person can never pay alone", () => {
  it("[cash-out-approve-matrix-bypass-F2-a] below the loosened threshold the payment is held, the requester cannot approve it, and another person's approval pays it once", async () => {
    const t = LOOSE;
    const invoiceId = await invoiceFor(t);
    const journalsBefore = (await paymentJournals(t)).length;

    // Rp 1,000 and Rp 49,999 are both below the Rp 50,000 threshold.
    const small = await expectHeld(t, t.requester, invoiceId, 1_000);
    const nearLimit = await expectHeld(t, t.requester, invoiceId, 49_999);
    expect((await paymentJournals(t)).length).toBe(journalsBefore);
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE);

    // The requester holds an approver role, yet cannot decide their own payment.
    await expect(decideChain(t, t.requester, small.chainId)).rejects.toThrow();
    expect((await paymentRows(t, invoiceId)).map((r) => r.status)).toEqual([
      "pending_approval",
      "pending_approval",
    ]);
    expect((await paymentJournals(t)).length).toBe(journalsBefore);

    // Another person approves; the consumer pays exactly once, balanced.
    await approveChain(t, small.chainId);
    await applyResolved(t, small.chainId);
    await applyResolved(t, small.chainId);
    const rows = await paymentRows(t, invoiceId);
    expect(rows.find((r) => r.id === small.id)?.status).toBe("paid");
    expect(rows.find((r) => r.id === nearLimit.id)?.status).toBe(
      "pending_approval",
    );
    const journals = await paymentJournals(t);
    expect(journals).toHaveLength(journalsBefore + 1);
    const fresh = journals.at(-1)!;
    expect(fresh.debit).toBe(fresh.credit);
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE - 1_000);
  });

  it("[cash-out-approve-matrix-bypass-F2-b] at or above the threshold the payment is still held until another person approves (control)", async () => {
    const t = LOOSE;
    const invoiceId = await invoiceFor(t);
    const journalsBefore = (await paymentJournals(t)).length;
    const big = await expectHeld(t, t.requester, invoiceId, 60_000);
    expect((await paymentJournals(t)).length).toBe(journalsBefore);
    await expect(decideChain(t, t.requester, big.chainId)).rejects.toThrow();
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE);
    await approveChain(t, big.chainId);
    await applyResolved(t, big.chainId);
    expect((await paymentRows(t, invoiceId)).map((r) => r.status)).toEqual([
      "paid",
    ]);
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE - 60_000);
  });

  it("[cash-out-approve-matrix-bypass-F2-c] a tenant with a single Owner: the Owner cannot pay a supplier alone at any amount", async () => {
    const t = SOLE;
    const journalsBefore = (await paymentJournals(t)).length;
    for (const amountIdr of [1, 10_000, PAYABLE]) {
      const invoiceId = await invoiceFor(t);
      const held = await expectHeld(t, soleOwner, invoiceId, amountIdr);
      // The sole Owner cannot approve their own payment either.
      await expect(decideChain(t, soleOwner, held.chainId)).rejects.toThrow();
      expect((await paymentRows(t, invoiceId)).map((r) => r.status)).toEqual([
        "pending_approval",
      ]);
      expect(await outstanding(t, invoiceId)).toBe(PAYABLE);
    }
    expect((await paymentJournals(t)).length).toBe(journalsBefore);
  });

  it("[cash-out-approve-matrix-bypass-F2-d] PUT approval-policies refuses a supplier_payment matrix that lets one person pay alone; the stored matrix does not change", async () => {
    const t = POLICY;
    const path = "/api/access/approval-policies";
    const put = (policies: object[]) =>
      policyAdmin.client
        .put(path)
        .set(originHeader)
        .set("Host", t.world.hostname)
        .send({ policies });
    const financeRole = await templateRoleId(t.world, "finance");
    const ownerRole = await templateRoleId(t.world, "owner");
    const tier = (
      thresholdIdr: number | null,
      approverRoleId: string,
      levels: number,
    ) => ({
      actionType: "supplier_payment",
      thresholdIdr,
      approverRoleId,
      levels,
    });

    // The PUT replaces the whole matrix: keep every other action type as read.
    const listed = await policyAdmin.client
      .get(path)
      .set(originHeader)
      .set("Host", t.world.hostname);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const others = (
      listed.body.data as {
        actionType: string;
        thresholdIdr: number | null;
        approverRoleId: string;
        levels: number;
      }[]
    )
      .filter((row) => row.actionType !== "supplier_payment")
      .map((row) => ({
        actionType: row.actionType,
        thresholdIdr: row.thresholdIdr,
        approverRoleId: row.approverRoleId,
        levels: row.levels,
      }));

    // Control: a threshold that only ADDS a level on top of a base tier that
    // requires approval is accepted, so the caller may configure the matrix.
    const good = await put([
      ...others,
      tier(0, financeRole, 1),
      tier(0, ownerRole, 1),
      tier(5_000_000, financeRole, 1),
      tier(5_000_000, ownerRole, 2),
    ]);
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    const stored = await policyRows(t.world.tenantId);
    const otherTenantBefore = await policyRows(OTHER.world.tenantId);

    // Loosening configurations: a positive threshold and no base tier.
    const loosening: [string, object[]][] = [
      ["one tier from Rp 5.000.000", [tier(5_000_000, financeRole, 1)]],
      [
        "Finance and Owner, only from Rp 5.000.000",
        [tier(5_000_000, financeRole, 1), tier(5_000_000, ownerRole, 1)],
      ],
      ["a floor nobody reaches", [tier(NEVER, ownerRole, 1)]],
      [
        "two levels, only from Rp 1",
        [tier(1, financeRole, 1), tier(1, ownerRole, 2)],
      ],
    ];
    for (const [label, supplierRows] of loosening) {
      const res = await put([...others, ...supplierRows]);
      expect(
        is4xx(res.status),
        `${label} -> ${res.status} ${JSON.stringify(res.body)}`,
      ).toBe(true);
      // The caller is entitled (control above): not an auth or routing refusal.
      expect([401, 403, 404], label).not.toContain(res.status);
      expect(await policyRows(t.world.tenantId), label).toEqual(stored);
    }
    expect(await policyRows(OTHER.world.tenantId)).toEqual(otherTenantBefore);
  });

  it("[cash-out-approve-matrix-bypass-F2-e] another tenant is not touched: its payment stays held and the approvers of other tenants cannot decide it", async () => {
    const t = OTHER;
    const policiesBefore = await policyRows(
      t.world.tenantId,
      "supplier_payment",
    );
    // The default matrix of a new tenant: from Rp 0, Finance and Owner.
    expect(policiesBefore.length).toBeGreaterThanOrEqual(2);
    for (const row of policiesBefore) expect(Number(row.threshold_idr)).toBe(0);

    const invoiceId = await invoiceFor(t);
    const held = await expectHeld(t, t.requester, invoiceId, 1);
    const journalsBefore = (await paymentJournals(t)).length;

    // Approvers of the loosened and the sole-Owner tenants decide in OTHER's
    // context: they hold no role there.
    for (const stranger of [
      LOOSE.approverFinance,
      LOOSE.approverOwner,
      soleOwner,
    ])
      await expect(decideChain(t, stranger, held.chainId)).rejects.toThrow();
    expect((await paymentRows(t, invoiceId)).map((r) => r.status)).toEqual([
      "pending_approval",
    ]);
    expect((await paymentJournals(t)).length).toBe(journalsBefore);
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE);
    expect(await policyRows(t.world.tenantId, "supplier_payment")).toEqual(
      policiesBefore,
    );

    // Control: its own approver can still pay it (nothing was broken).
    await approveChain(t, held.chainId);
    await applyResolved(t, held.chainId);
    expect((await paymentRows(t, invoiceId)).map((r) => r.status)).toEqual([
      "paid",
    ]);
  });
});
