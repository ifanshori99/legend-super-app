// Settlement report import + reconciliation (beads legend-jlqi, legend-ds1o part 1).
// PRD §3.13 EDC-06: "Laporan settlement EDC setiap bank cocok dengan transaksi
// POS; setiap selisih menjadi kasus rekonsiliasi". Written from the DESIGN in
// docs/briefs/ws-settlement-recon.md (contract: POST
// /api/payments/admin/reconciliation/settlements) and the existing shared
// reconciliation contract, not from any implementation.
//
// Assumptions (also in the report):
//  - A first import answers 200 or 201 (the design does not say which).
//  - Re-sending the SAME Idempotency-Key replays the stored response; a replay
//    through a NEW key answers success with replayed=true (design step 2).
//  - Same key + different body is refused with 409 or 422.
//  - Cross-tenant / out-of-scope outlet answers 403 or 404 (house pattern).
//  - Cases are read by settlement_id straight from payment_reconciliation_cases
//    so other test files and seeded rows never change the counts.
//  - legend-aegsj (founder rule, most restrictive): a "missing" case (no
//    settlement line) exists at most once per POS sale for life, whatever its
//    status (open, pending_approval, resolved). A later report with another
//    reference over the same period never opens a second one, so a second
//    reconciliation_case.resolved can never be approved for the same sale.
//  - The default approver of a reconciliation case is Owner OR Finance (two
//    policy rows at level 1); the requester can never approve their own.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { handleReconciliationApprovalResolved } from "../services/payment-reconciliation-approval-consumer";
import {
  decideApprovalRequest,
  expireDueApprovalRequests,
} from "../services/platform-approval.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

type MutableBody = {
  reference: string;
  source: string;
  periodStart: string;
  periodEnd: string;
  grossIdr: number;
  feeIdr: number;
  netIdr: number;
  lines: { reference: string; amountIdr: number; feeIdr: number }[];
  tenantId?: string;
  batchNo?: string;
  terminalId?: string;
};

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const IMPORT = "/api/payments/admin/reconciliation/settlements";
const SUMMARY = "/api/payments/admin/reconciliation/summary";
const uid = () => randomBytes(4).toString("hex");

const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherLegal = randomUUID();
const otherOutlet = randomUUID();
const userIds: string[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const txIds: string[] = [];
const terminalIds: string[] = [];
const settlementIds: string[] = [];
let manager: ReturnType<typeof agent>;
let approverId: string; // second tenant-wide Owner: may approve what manager asks
let scoped: ReturnType<typeof agent>;
let dayCounter = 0;

// ------------------------------------------------------------------ plumbing

/** Runs SQL as the migration owner with the tenant settings (FORCE RLS). */
async function asTenant<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function asAppRole<T>(
  settings: { tenant: string; outlets: string },
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [settings.tenant, settings.outlets],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function signedIn(scope: "tenant" | "outlet") {
  return (await signedInWithId(scope)).client;
}

async function signedInWithId(scope: "tenant" | "outlet") {
  const client = agent(app);
  const email = await signUp(client, `Settlement ${scope}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await verifySessionMfa(email);
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantId,
      userId,
      role.rows[0]!.id,
      scope,
      scope === "outlet" ? outletB : null,
    ],
  );
  return { client, userId };
}

/** Each scenario gets its own business day so gateway "missing" scans never overlap. */
function nextDay(): string {
  dayCounter += 1;
  const date = new Date(Date.UTC(2020, 0, 1 + dayCounter));
  return date.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ fixtures

async function seedIntent(o: {
  tenant?: string;
  outlet?: string;
  providerRef: string;
  amountIdr: number;
  day: string;
  status?: string;
}): Promise<string> {
  const tenant = o.tenant ?? tenantId;
  const outlet = o.outlet ?? outletA;
  const linkId = randomUUID();
  const id = randomUUID();
  await asTenant(tenant, async (c) => {
    await c.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
      [
        linkId,
        tenant,
        outlet,
        randomBytes(32).toString("hex"),
        `SETL-${linkId.slice(0, 8)}`,
        o.amountIdr,
      ],
    );
    await c.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, provider_ref, amount_idr,
          idempotency_key, status, paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, $7, $8, $9::timestamptz,
               '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
      [
        id,
        tenant,
        outlet,
        linkId,
        o.providerRef,
        o.amountIdr,
        `setl-${id}`,
        o.status ?? "paid",
        `${o.day} 12:00:00+07`,
      ],
    );
  });
  intentIds.push(id);
  linkIds.push(linkId);
  return id;
}

async function seedTerminal(
  o: { outlet?: string; bank?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await asTenant(tenantId, (c) =>
    c.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model, connection, supported_methods, status)
       VALUES ($1, $2, $3, $5, $4, 'MID-SETL', 'Verifone', 'lan', ARRAY['card','qris'], 'active')`,
      [
        id,
        tenantId,
        o.outlet ?? outletA,
        `TID-${id.slice(0, 10)}`,
        o.bank ?? "bca",
      ],
    ),
  );
  terminalIds.push(id);
  return id;
}

async function seedEdcSale(o: {
  terminalId: string;
  rrn: string;
  amountIdr: number;
  batchNo: string;
  /** POS reference; a void row shares the sale's reference (EDC-03). */
  reference?: string;
  approvalCode?: string;
  type?: "sale" | "void";
}): Promise<string> {
  const id = randomUUID();
  await asTenant(tenantId, (c) =>
    c.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key, request_fingerprint,
          amount_idr, method, status, type, trace, rrn, approval_code, batch_no, dispatched_at, completed_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp-setl', $7, 'card', 'approved', $12, $8, $9, $10, $11, now(), now())`,
      [
        id,
        tenantId,
        outletA,
        o.terminalId,
        o.reference ?? `POS-${id.slice(0, 10)}`,
        randomUUID(),
        o.amountIdr,
        `T${id.replace(/-/g, "").slice(0, 12)}`,
        o.rrn,
        o.approvalCode ?? id.slice(0, 6).toUpperCase(),
        o.batchNo,
        o.type ?? "sale",
      ],
    ),
  );
  txIds.push(id);
  return id;
}

type Line = { reference: string; amountIdr: number; feeIdr: number };

function gatewayBody(o: {
  day: string;
  reference: string;
  lines: Line[];
  outletId?: string;
  provider?: string;
}) {
  const gross = o.lines.reduce((s, l) => s + l.amountIdr, 0);
  const fee = o.lines.reduce((s, l) => s + l.feeIdr, 0);
  return {
    outletId: o.outletId ?? outletA,
    source: "gateway",
    provider: o.provider ?? "doit",
    reference: o.reference,
    periodStart: o.day,
    periodEnd: o.day,
    grossIdr: gross,
    feeIdr: fee,
    netIdr: gross - fee,
    lines: o.lines,
  };
}

function edcBody(o: {
  day: string;
  reference: string;
  terminalId: string;
  batchNo: string;
  lines: Line[];
}) {
  return {
    ...gatewayBody({ ...o, provider: "edc_bca" }),
    source: "edc",
    terminalId: o.terminalId,
    batchNo: o.batchNo,
  };
}

const post = (
  client: ReturnType<typeof agent>,
  body: unknown,
  key = `imp-${randomUUID()}`,
) =>
  client
    .post(IMPORT)
    .set(originHeader)
    .set("Idempotency-Key", key)
    .send(body as object);

const OK = [200, 201];
function expectOk(response: { status: number; body: unknown }) {
  expect(OK, JSON.stringify(response.body)).toContain(response.status);
}

// ---------------------------------------------------------------- DB readers

const num = (v: unknown) => Number(v);

async function settlementsBy(reference: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query(
      `SELECT id, source, provider, outlet_id, gross_idr, fee_idr, net_idr, line_count
         FROM payment_settlements WHERE tenant_id = $1 AND reference = $2`,
      [tenantId, reference],
    ),
  );
  return rows.map((r) => ({
    ...r,
    gross_idr: num(r.gross_idr),
    fee_idr: num(r.fee_idr),
    net_idr: num(r.net_idr),
  })) as {
    id: string;
    source: string;
    provider: string;
    outlet_id: string;
    gross_idr: number;
    fee_idr: number;
    net_idr: number;
    line_count: number;
  }[];
}

async function linesOf(settlementId: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query(
      `SELECT id, reference, amount_idr, fee_idr, expected_idr, match_status,
              matched_edc_transaction_id, matched_payment_intent_id
         FROM payment_settlement_lines WHERE tenant_id = $1 AND settlement_id = $2
         ORDER BY line_no`,
      [tenantId, settlementId],
    ),
  );
  return rows.map((r) => ({
    ...r,
    amount_idr: num(r.amount_idr),
    fee_idr: num(r.fee_idr),
    expected_idr: r.expected_idr === null ? null : num(r.expected_idr),
  })) as {
    id: string;
    reference: string;
    amount_idr: number;
    fee_idr: number;
    expected_idr: number | null;
    match_status: string;
    matched_edc_transaction_id: string | null;
    matched_payment_intent_id: string | null;
  }[];
}

async function casesOf(settlementId: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query(
      `SELECT id, reference, expected_idr, received_idr, variance_idr, status, settlement_line_id, reason, source, provider
         FROM payment_reconciliation_cases WHERE tenant_id = $1 AND settlement_id = $2
         ORDER BY reference`,
      [tenantId, settlementId],
    ),
  );
  return rows.map((r) => ({
    ...r,
    expected_idr: num(r.expected_idr),
    received_idr: num(r.received_idr),
    variance_idr: num(r.variance_idr),
  })) as {
    id: string;
    reference: string;
    expected_idr: number;
    received_idr: number;
    variance_idr: number;
    status: string;
    settlement_line_id: string | null;
    reason: string;
    source: string;
    provider: string;
  }[];
}

/** Every case of the tenant for one POS reference, whichever report opened it. */
async function casesByReference(reference: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query(
      `SELECT id, settlement_id, settlement_line_id, status, expected_idr, received_idr, variance_idr
         FROM payment_reconciliation_cases WHERE tenant_id = $1 AND reference = $2
         ORDER BY created_at`,
      [tenantId, reference],
    ),
  );
  return rows.map((r) => ({
    ...r,
    expected_idr: num(r.expected_idr),
    received_idr: num(r.received_idr),
    variance_idr: num(r.variance_idr),
  })) as {
    id: string;
    settlement_id: string;
    settlement_line_id: string | null;
    status: string;
    expected_idr: number;
    received_idr: number;
    variance_idr: number;
  }[];
}

/** Remembers a report's id for cleanup, whichever way it was created. */
async function track(reference: string) {
  for (const row of await settlementsBy(reference)) settlementIds.push(row.id);
}

// ------------------------------------------------- legend-aegsj case lifecycle

const tenantContext = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);
const RESOLVED_EVENT = "reconciliation_case.resolved";

async function countOutboxEvents(name: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = $2`,
      [tenantId, name],
    ),
  );
  return Number(rows[0]!.n);
}

/** manager asks to close the case: it waits for a second person. */
async function requestClose(caseId: string) {
  const response = await manager
    .post(`/api/payments/admin/reconciliation/cases/${caseId}/resolve`)
    .set(originHeader)
    .set("Idempotency-Key", `res-${randomUUID()}`)
    .send({ note: "Bank statement checked, accepted" });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data.status).toBe("pending_approval");
}

/** Another Owner decides the pending request and the worker applies it. */
async function decideCase(caseId: string, decision: "approved" | "rejected") {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query<{ id: string; chain_id: string }>(
      `SELECT id, chain_id FROM approval_requests
        WHERE tenant_id = $1 AND object_type = 'payment_reconciliation_case'
          AND object_id = $2 AND status = 'pending'`,
      [tenantId, caseId],
    ),
  );
  expect(rows).toHaveLength(1);
  const request = rows[0]!;
  await decideApprovalRequest(
    tenantContext(),
    approverId,
    request.id,
    { decision, reason: "Sesuai laporan settlement." },
    { mfaVerified: true, idempotencyKey: null },
  );
  const events = await asTenant(tenantId, (c) =>
    c.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND destination = 'cloud-sync'
          AND event->>'name' = 'approval.resolved'
          AND event->'payload'->>'chainId' = $2`,
      [tenantId, request.chain_id],
    ),
  );
  expect(events.rows).toHaveLength(1);
  await handleReconciliationApprovalResolved(
    tenantWide,
    eventEnvelopeSchema.parse(events.rows[0]!.event),
    new Date(),
  );
}

/** A gateway fixture: X settled by report A, Z never settled (missing). */
async function gatewayMissingSetup() {
  const day = nextDay();
  const tag = uid();
  const px = `PR-${tag}-X`;
  const pz = `PR-${tag}-Z`;
  await seedIntent({ providerRef: px, amountIdr: 100000, day });
  await seedIntent({ providerRef: pz, amountIdr: 50000, day });
  const a = await post(
    manager,
    gatewayBody({
      day,
      reference: `GW-${tag}-A`,
      lines: [{ reference: px, amountIdr: 100000, feeIdr: 700 }],
    }),
  );
  expectOk(a);
  settlementIds.push(a.body.data.id);
  const [missing] = await casesByReference(pz);
  expect(missing).toMatchObject({ status: "open", settlement_line_id: null });
  return { day, tag, px, pz, missingId: missing!.id };
}

/** A later report, another reference, same period; it carries one unknown payment. */
async function laterGatewayReport(
  s: { day: string; tag: string },
  suffix: string,
) {
  const response = await post(
    manager,
    gatewayBody({
      day: s.day,
      reference: `GW-${s.tag}-${suffix}`,
      lines: [
        { reference: `PR-${s.tag}-U${suffix}`, amountIdr: 30000, feeIdr: 210 },
      ],
    }),
  );
  expectOk(response);
  settlementIds.push(response.body.data.id);
  return response;
}

/** Everything a reconciliation import must never change (founder money rule). */
async function moneySnapshot() {
  return asTenant(tenantId, async (c) => {
    const one = async (sql: string, params: unknown[] = [tenantId]) =>
      (await c.query(sql, params)).rows[0] as Record<string, unknown>;
    const entity = (
      await c.query<{ legal_entity_id: string }>(
        "SELECT legal_entity_id FROM outlets WHERE id = $1",
        [outletA],
      )
    ).rows[0]!.legal_entity_id;
    return {
      refunds: await one(
        "SELECT count(*)::int n, coalesce(sum(amount_idr),0)::text s, coalesce(string_agg(id::text||status, ',' ORDER BY id),'') st FROM payment_refunds WHERE tenant_id = $1",
      ),
      unallocated: await one(
        "SELECT count(*)::int n, coalesce(sum(amount_idr),0)::text s FROM payment_unallocated_funds WHERE tenant_id = $1",
      ),
      intents: await one(
        "SELECT count(*)::int n, coalesce(sum(amount_idr),0)::text s, coalesce(string_agg(id::text||status||amount_idr::text, ',' ORDER BY id),'') st FROM payment_intents WHERE tenant_id = $1",
      ),
      edc: await one(
        "SELECT count(*)::int n, coalesce(sum(amount_idr),0)::text s, coalesce(string_agg(id::text||status||type, ',' ORDER BY id),'') st FROM edc_transactions WHERE tenant_id = $1",
      ),
      journals: await one(
        "SELECT count(*)::int n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
        [tenantId, entity],
      ),
      journalLines: await one(
        `SELECT count(*)::int n FROM journal_lines WHERE tenant_id = $1 AND entry_id IN
           (SELECT id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2)`,
        [tenantId, entity],
      ),
      deposits: await one(
        "SELECT count(*)::int n FROM cash_deposits WHERE tenant_id = $1 AND legal_entity_id = $2",
        [tenantId, entity],
      ),
      orderRefunds: await one(
        "SELECT count(*)::int n FROM pos_order_refunds WHERE tenant_id = $1",
      ),
      profitShare: await one(
        "SELECT count(*)::int n FROM profit_share_commands WHERE tenant_id = $1",
      ),
    };
  });
}

type Scenario = Awaited<ReturnType<typeof gatewayScenario>>;

/**
 * Gateway fixture, hand-computed (never recomputed with product code):
 *   POS X 100000 (paid), POS Y 250000 (paid), POS Z 50000 (paid, absent from report)
 *   report: X 100000 fee 700 -> matched
 *           Y 240000 fee 1700 -> mismatch, expected 250000, variance -10000
 *           W  30000 fee 200  -> unmatched, expected 0, variance +30000
 *   Z missing -> case expected 50000, received 0, variance -50000
 *   gross 370000, fee 2600, net 367400; three cases, sum variance -30000.
 */
async function gatewayScenario() {
  const day = nextDay();
  const tag = uid();
  const px = `PR-${tag}-X`;
  const py = `PR-${tag}-Y`;
  const pz = `PR-${tag}-Z`;
  const pw = `PR-${tag}-W`;
  const intentX = await seedIntent({
    providerRef: px,
    amountIdr: 100000,
    day,
  });
  const intentY = await seedIntent({
    providerRef: py,
    amountIdr: 250000,
    day,
  });
  const intentZ = await seedIntent({
    providerRef: pz,
    amountIdr: 50000,
    day,
  });
  const reference = `GW-${tag}`;
  const body = gatewayBody({
    day,
    reference,
    lines: [
      { reference: px, amountIdr: 100000, feeIdr: 700 },
      { reference: py, amountIdr: 240000, feeIdr: 1700 },
      { reference: pw, amountIdr: 30000, feeIdr: 200 },
    ],
  });
  return {
    day,
    tag,
    reference,
    body,
    px,
    py,
    pz,
    pw,
    intentX,
    intentY,
    intentZ,
  };
}

async function importScenario(s: Scenario) {
  const response = await post(manager, s.body);
  expectOk(response);
  const id = response.body.data.id as string;
  settlementIds.push(id);
  return { response, id };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  ({ client: manager } = await signedInWithId("tenant"));
  ({ userId: approverId } = await signedInWithId("tenant"));
  scoped = await signedIn("outlet");
  // Resolving a reconciliation case asks for approval: the tenant needs a policy.
  // Same as the product default: level 1, Owner or Finance (either is enough).
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'reconciliation_case'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     SELECT $1, 'reconciliation_case', NULL, id, 1, true
     FROM roles WHERE tenant_id = $1 AND template_key IN ('owner', 'finance')`,
    [tenantId],
  );
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Settlement other tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      otherTenant,
      `setl-${otherTenant}`,
      JSON.stringify(cafeLegendPlatformFixtures.packages[0].defaultLimits),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Other')",
    [otherBrand, otherTenant, `brand-${otherBrand}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Other', false)",
    [otherLegal, otherTenant],
  );
  await owner.query(
    "INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours) VALUES ($1, $2, $3, $4, 'OTHER', 'Other', 'Other', '{}')",
    [otherOutlet, otherTenant, otherBrand, otherLegal],
  );
});

afterAll(async () => {
  const quiet = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      // a missing table must not hide the real (fail-first) test failures
    }
  };
  const all = [tenantId, otherTenant];
  for (const tenant of all) {
    await quiet(() =>
      asTenant(tenant, async (c) => {
        await c.query(
          "DELETE FROM payment_reconciliation_cases WHERE tenant_id = $1 AND settlement_id IN (SELECT id FROM payment_settlements WHERE tenant_id = $1 AND provider IN ('doit','edc_bca') AND reference LIKE ANY (ARRAY['GW-%','EDC-%','RLS-%']))",
          [tenant],
        );
        await c.query(
          "DELETE FROM payment_settlement_lines WHERE tenant_id = $1 AND settlement_id IN (SELECT id FROM payment_settlements WHERE tenant_id = $1 AND reference LIKE ANY (ARRAY['GW-%','EDC-%','RLS-%']))",
          [tenant],
        );
        await c.query(
          "DELETE FROM payment_settlements WHERE tenant_id = $1 AND reference LIKE ANY (ARRAY['GW-%','EDC-%','RLS-%'])",
          [tenant],
        );
      }),
    );
  }
  await quiet(() =>
    asTenant(tenantId, async (c) => {
      await c.query("DELETE FROM edc_transactions WHERE id = ANY($1::uuid[])", [
        txIds,
      ]);
      await c.query(
        "DELETE FROM payment_edc_terminals WHERE id = ANY($1::uuid[])",
        [terminalIds],
      );
      await c.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
        intentIds,
      ]);
      await c.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
        linkIds,
      ]);
    }),
  );
  await quiet(() =>
    asTenant(otherTenant, async (c) => {
      await c.query("DELETE FROM payment_intents WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await c.query("DELETE FROM payment_links WHERE tenant_id = $1", [
        otherTenant,
      ]);
    }),
  );
  await quiet(() =>
    owner.query("DELETE FROM outlets WHERE id = $1", [otherOutlet]),
  );
  await quiet(() =>
    owner.query("DELETE FROM legal_entities WHERE id = $1", [otherLegal]),
  );
  await quiet(() =>
    owner.query("DELETE FROM brands WHERE id = $1", [otherBrand]),
  );
  await quiet(() =>
    owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]),
  );
  await quiet(() =>
    owner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [userIds],
    ),
  );
  await owner.end();
});

// ======================================================================= tests

describe("EDC-06 legend-jlqi gateway settlement import", () => {
  it("EDC-06 stores the report and lines, matches POS payments and opens one case per difference", async () => {
    const s = await gatewayScenario();
    const { response, id } = await importScenario(s);

    expect(response.body.data).toMatchObject({
      outletId: outletA,
      source: "gateway",
      provider: "doit",
      reference: s.reference,
      periodStart: s.day,
      periodEnd: s.day,
      grossIdr: 370000,
      feeIdr: 2600,
      netIdr: 367400,
      lineCount: 3,
      matchedLines: 1,
      mismatchLines: 1,
      unmatchedLines: 1,
      casesCreated: 3,
      replayed: false,
    });

    const stored = await settlementsBy(s.reference);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id,
      source: "gateway",
      provider: "doit",
      outlet_id: outletA,
      gross_idr: 370000,
      fee_idr: 2600,
      net_idr: 367400,
      line_count: 3,
    });

    const lines = await linesOf(id);
    expect(lines).toHaveLength(3);
    const byRef = new Map(lines.map((l) => [l.reference, l]));
    expect(byRef.get(s.px)).toMatchObject({
      amount_idr: 100000,
      fee_idr: 700,
      expected_idr: 100000,
      match_status: "matched",
      matched_payment_intent_id: s.intentX,
    });
    expect(byRef.get(s.py)).toMatchObject({
      amount_idr: 240000,
      expected_idr: 250000,
      match_status: "mismatch",
    });
    expect(byRef.get(s.pw)).toMatchObject({
      amount_idr: 30000,
      match_status: "unmatched",
      matched_payment_intent_id: null,
    });

    const cases = await casesOf(id);
    // Exactly one case per difference; the matched line opens none.
    expect(cases).toHaveLength(3);
    const caseBy = new Map(cases.map((c) => [c.reference, c]));
    expect(caseBy.get(s.px)).toBeUndefined();
    expect(caseBy.get(s.py)).toMatchObject({
      expected_idr: 250000,
      received_idr: 240000,
      variance_idr: -10000,
      status: "open",
      source: "gateway",
      provider: "doit",
      settlement_line_id: byRef.get(s.py)!.id,
    });
    expect(caseBy.get(s.pw)).toMatchObject({
      expected_idr: 0,
      received_idr: 30000,
      variance_idr: 30000,
      status: "open",
      settlement_line_id: byRef.get(s.pw)!.id,
    });
    // POS payment Z is missing from the report: a case with no line.
    expect(caseBy.get(s.pz)).toMatchObject({
      expected_idr: 50000,
      received_idr: 0,
      variance_idr: -50000,
      status: "open",
      settlement_line_id: null,
    });
    expect(cases.reduce((sum, c) => sum + c.variance_idr, 0)).toBe(-30000);
    for (const c of cases) expect(c.reason.length).toBeGreaterThan(0);
  });

  it("EDC-06 a report whose lines all match POS opens no case", async () => {
    const day = nextDay();
    const tag = uid();
    const ref1 = `PR-${tag}-1`;
    const ref2 = `PR-${tag}-2`;
    await seedIntent({ providerRef: ref1, amountIdr: 80000, day });
    await seedIntent({ providerRef: ref2, amountIdr: 20000, day });
    const reference = `GW-${tag}`;
    const response = await post(
      manager,
      gatewayBody({
        day,
        reference,
        lines: [
          { reference: ref1, amountIdr: 80000, feeIdr: 560 },
          { reference: ref2, amountIdr: 20000, feeIdr: 140 },
        ],
      }),
    );
    expectOk(response);
    settlementIds.push(response.body.data.id);
    expect(response.body.data).toMatchObject({
      matchedLines: 2,
      mismatchLines: 0,
      unmatchedLines: 0,
      casesCreated: 0,
      netIdr: 99300,
    });
    expect(await casesOf(response.body.data.id)).toHaveLength(0);
  });

  it("EDC-06 a refunded payment can still be settled (matched)", async () => {
    const day = nextDay();
    const tag = uid();
    const pr = `PR-${tag}-R`;
    await seedIntent({
      providerRef: pr,
      amountIdr: 60000,
      day,
      status: "partially_refunded",
    });
    const response = await post(
      manager,
      gatewayBody({
        day,
        reference: `GW-${tag}`,
        lines: [{ reference: pr, amountIdr: 60000, feeIdr: 420 }],
      }),
    );
    expectOk(response);
    settlementIds.push(response.body.data.id);
    expect(response.body.data).toMatchObject({
      matchedLines: 1,
      casesCreated: 0,
    });
  });
});

describe("EDC-06 legend-jlqi EDC bank settlement import", () => {
  /**
   * POS sales on one terminal/batch: R1 20000, R2 35000, R3 15000 (absent from
   * report); R4 7000 in another batch (must NOT become a case).
   * Report: R1 20000 fee 140 matched; R2 30000 fee 210 mismatch (-5000);
   * RX 5000 fee 35 unmatched (+5000). R3 missing: -15000. Net = 55000-385.
   */
  async function edcScenario() {
    const day = nextDay();
    const tag = uid();
    const terminalId = await seedTerminal();
    const batchNo = `B${tag.slice(0, 5)}`;
    const r1 = `RRN1${tag}`;
    const r2 = `RRN2${tag}`;
    const r3 = `RRN3${tag}`;
    const r4 = `RRN4${tag}`;
    const rx = `RRNX${tag}`;
    const t1 = await seedEdcSale({
      terminalId,
      rrn: r1,
      amountIdr: 20000,
      batchNo,
    });
    await seedEdcSale({ terminalId, rrn: r2, amountIdr: 35000, batchNo });
    await seedEdcSale({ terminalId, rrn: r3, amountIdr: 15000, batchNo });
    await seedEdcSale({
      terminalId,
      rrn: r4,
      amountIdr: 7000,
      batchNo: `${batchNo}X`,
    });
    const reference = `EDC-${tag}`;
    const body = edcBody({
      day,
      reference,
      terminalId,
      batchNo,
      lines: [
        { reference: r1, amountIdr: 20000, feeIdr: 140 },
        { reference: r2, amountIdr: 30000, feeIdr: 210 },
        { reference: rx, amountIdr: 5000, feeIdr: 35 },
      ],
    });
    return { reference, body, r1, r2, r3, r4, rx, t1 };
  }

  it("EDC-06 matches bank lines to EDC sales by RRN and records every difference as a case", async () => {
    const s = await edcScenario();
    const response = await post(manager, s.body);
    expectOk(response);
    const id = response.body.data.id as string;
    settlementIds.push(id);
    expect(response.body.data).toMatchObject({
      source: "edc",
      provider: "edc_bca",
      grossIdr: 55000,
      feeIdr: 385,
      netIdr: 54615,
      lineCount: 3,
      matchedLines: 1,
      mismatchLines: 1,
      unmatchedLines: 1,
      casesCreated: 3,
      replayed: false,
    });
    const lines = await linesOf(id);
    const byRef = new Map(lines.map((l) => [l.reference, l]));
    expect(byRef.get(s.r1)).toMatchObject({
      match_status: "matched",
      matched_edc_transaction_id: s.t1,
      expected_idr: 20000,
    });
    expect(byRef.get(s.r2)).toMatchObject({
      match_status: "mismatch",
      expected_idr: 35000,
    });
    expect(byRef.get(s.rx)).toMatchObject({ match_status: "unmatched" });

    const cases = await casesOf(id);
    expect(cases).toHaveLength(3);
    const caseBy = new Map(cases.map((c) => [c.reference, c]));
    expect(caseBy.get(s.r2)).toMatchObject({
      expected_idr: 35000,
      received_idr: 30000,
      variance_idr: -5000,
      source: "edc",
      provider: "edc_bca",
    });
    expect(caseBy.get(s.rx)).toMatchObject({
      expected_idr: 0,
      received_idr: 5000,
      variance_idr: 5000,
    });
    expect(caseBy.get(s.r3)).toMatchObject({
      expected_idr: 15000,
      received_idr: 0,
      variance_idr: -15000,
      settlement_line_id: null,
    });
    // A sale in a different batch is not part of this report.
    expect(caseBy.get(s.r4)).toBeUndefined();
    expect(cases.reduce((sum, c) => sum + c.variance_idr, 0)).toBe(-15000);
  });
});

describe("EDC-06 legend-jlqi idempotent re-import", () => {
  it("EDC-06 the same report again, with the same or a new Idempotency-Key, adds nothing", async () => {
    const s = await gatewayScenario();
    const key = `same-${randomUUID()}`;
    const first = await post(manager, s.body, key);
    expectOk(first);
    const id = first.body.data.id as string;
    settlementIds.push(id);
    const before = {
      settlements: await settlementsBy(s.reference),
      lines: await linesOf(id),
      cases: await casesOf(id),
    };
    expect(before.settlements).toHaveLength(1);
    expect(before.lines).toHaveLength(3);
    expect(before.cases).toHaveLength(3);

    // Same key: stored response comes back.
    const sameKey = await post(manager, s.body, key);
    expectOk(sameKey);
    expect(sameKey.body.data.id).toBe(id);

    // New key: the report key (source, provider, reference) dedupes it.
    const newKey = await post(manager, s.body);
    expectOk(newKey);
    expect(newKey.body.data).toMatchObject({
      id,
      replayed: true,
      lineCount: 3,
      matchedLines: 1,
      mismatchLines: 1,
      unmatchedLines: 1,
    });

    expect(await settlementsBy(s.reference)).toEqual(before.settlements);
    expect(await linesOf(id)).toEqual(before.lines);
    expect(await casesOf(id)).toEqual(before.cases);
  });

  it("EDC-06 two simultaneous identical imports store exactly one report", async () => {
    const s = await gatewayScenario();
    const [a, b] = await Promise.all([
      post(manager, s.body),
      post(manager, s.body),
    ]);
    expectOk(a);
    expectOk(b);
    expect(a.body.data.id).toBe(b.body.data.id);
    const id = a.body.data.id as string;
    settlementIds.push(id);
    expect(await settlementsBy(s.reference)).toHaveLength(1);
    expect(await linesOf(id)).toHaveLength(3);
    expect(await casesOf(id)).toHaveLength(3);
  });

  it("EDC-06 changed content under the same report reference is refused with 409 SETTLEMENT_CONFLICT", async () => {
    const s = await gatewayScenario();
    const { id } = await importScenario(s);
    const before = {
      lines: await linesOf(id),
      cases: await casesOf(id),
    };
    const changed = gatewayBody({
      day: s.day,
      reference: s.reference,
      lines: [
        { reference: s.px, amountIdr: 100000, feeIdr: 700 },
        { reference: s.py, amountIdr: 250000, feeIdr: 1750 },
      ],
    });
    const conflict = await post(manager, changed);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("SETTLEMENT_CONFLICT");
    expect(await settlementsBy(s.reference)).toHaveLength(1);
    expect((await settlementsBy(s.reference))[0]).toMatchObject({
      gross_idr: 370000,
      line_count: 3,
    });
    expect(await linesOf(id)).toEqual(before.lines);
    expect(await casesOf(id)).toEqual(before.cases);
  });

  it("EDC-06 one Idempotency-Key cannot carry a different report", async () => {
    const s = await gatewayScenario();
    const key = `key-${randomUUID()}`;
    const first = await post(manager, s.body, key);
    expectOk(first);
    settlementIds.push(first.body.data.id);
    const other = gatewayBody({
      day: s.day,
      reference: `GW-${uid()}`,
      lines: [{ reference: `PR-${uid()}`, amountIdr: 1000, feeIdr: 7 }],
    });
    const reused = await post(manager, other, key);
    expect([409, 422]).toContain(reused.status);
    expect(await settlementsBy(other.reference)).toHaveLength(0);
  });

  it("EDC-06 re-import does not reopen a case that was resolved or awaits approval", async () => {
    const s = await gatewayScenario();
    const { id } = await importScenario(s);
    const open = (await casesOf(id)).find((c) => c.reference === s.pw)!;
    const resolved = await manager
      .post(`/api/payments/admin/reconciliation/cases/${open.id}/resolve`)
      .set(originHeader)
      .set("Idempotency-Key", `res-${randomUUID()}`)
      .send({ note: "Bank statement checked, accepted" });
    expect(resolved.status).toBe(200);
    const again = await post(manager, s.body);
    expectOk(again);
    const cases = await casesOf(id);
    expect(cases).toHaveLength(3);
    expect(cases.find((c) => c.id === open.id)?.status).toBe(
      "pending_approval",
    );
    expect(cases.filter((c) => c.status === "open")).toHaveLength(2);
  });

  it("EDC-06 one POS payment cannot be settled by two reports: the second line is unmatched", async () => {
    const day = nextDay();
    const tag = uid();
    const pr = `PR-${tag}-D`;
    await seedIntent({ providerRef: pr, amountIdr: 90000, day });
    const first = await post(
      manager,
      gatewayBody({
        day,
        reference: `GW-${tag}-A`,
        lines: [{ reference: pr, amountIdr: 90000, feeIdr: 630 }],
      }),
    );
    expectOk(first);
    expect(first.body.data).toMatchObject({ matchedLines: 1, casesCreated: 0 });
    settlementIds.push(first.body.data.id);

    const second = await post(
      manager,
      gatewayBody({
        day,
        reference: `GW-${tag}-B`,
        lines: [{ reference: pr, amountIdr: 90000, feeIdr: 630 }],
      }),
    );
    expectOk(second);
    const id2 = second.body.data.id as string;
    settlementIds.push(id2);
    expect(second.body.data).toMatchObject({
      matchedLines: 0,
      unmatchedLines: 1,
    });
    const lines = await linesOf(id2);
    expect(lines[0]).toMatchObject({
      match_status: "unmatched",
      matched_payment_intent_id: null,
    });
    const cases = (await casesOf(id2)).filter((c) => c.reference === pr);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      expected_idr: 0,
      received_idr: 90000,
      variance_idr: 90000,
    });
  });
});

describe("EDC-06 legend-jlqi money guard: reconciliation only reads and records", () => {
  it("EDC-06 importing, replaying and resolving change no refund, payout, journal, deposit, payment or EDC row", async () => {
    const s = await gatewayScenario();
    const before = await moneySnapshot();

    const { id } = await importScenario(s);
    expect(await casesOf(id)).toHaveLength(3);
    expect(await moneySnapshot()).toEqual(before);

    const replay = await post(manager, s.body);
    expectOk(replay);
    expect(await moneySnapshot()).toEqual(before);

    // Over-reported line (settlement says more than the POS took) is only a case.
    const over = (await casesOf(id)).find((c) => c.variance_idr > 0)!;
    expect(over.variance_idr).toBe(30000);
    const resolved = await manager
      .post(`/api/payments/admin/reconciliation/cases/${over.id}/resolve`)
      .set(originHeader)
      .set("Idempotency-Key", `res-${randomUUID()}`)
      .send({ note: "Investigated" });
    expect(resolved.status).toBe(200);
    expect(await moneySnapshot()).toEqual(before);
  });

  it("EDC-06 an EDC import changes no money row either", async () => {
    const tag = uid();
    const day = nextDay();
    const terminalId = await seedTerminal();
    const batchNo = `M${tag.slice(0, 5)}`;
    await seedEdcSale({
      terminalId,
      rrn: `RRNM${tag}`,
      amountIdr: 12000,
      batchNo,
    });
    const before = await moneySnapshot();
    const response = await post(
      manager,
      edcBody({
        day,
        reference: `EDC-${tag}`,
        terminalId,
        batchNo,
        lines: [{ reference: `RRNM${tag}`, amountIdr: 99000, feeIdr: 693 }],
      }),
    );
    expectOk(response);
    settlementIds.push(response.body.data.id);
    expect(response.body.data.mismatchLines).toBe(1);
    expect(await moneySnapshot()).toEqual(before);
  });
});

describe("EDC-06 legend-jlqi round 2: one missing case per POS sale (H1)", () => {
  it("EDC-06 overlapping gateway reports never open a second missing case for the same payment", async () => {
    const day = nextDay();
    const tag = uid();
    const px = `PR-${tag}-X`; // settled by report A
    const pz = `PR-${tag}-Z`; // never settled by anybody
    const pw = `PR-${tag}-W`; // unknown payment in report B
    await seedIntent({ providerRef: px, amountIdr: 100000, day });
    await seedIntent({ providerRef: pz, amountIdr: 50000, day });

    const a = await post(
      manager,
      gatewayBody({
        day,
        reference: `GW-${tag}-A`,
        lines: [{ reference: px, amountIdr: 100000, feeIdr: 700 }],
      }),
    );
    expectOk(a);
    settlementIds.push(a.body.data.id);
    expect(a.body.data).toMatchObject({ matchedLines: 1, casesCreated: 1 });
    const missingAfterA = await casesByReference(pz);
    expect(missingAfterA).toHaveLength(1);
    expect(missingAfterA[0]).toMatchObject({
      status: "open",
      settlement_line_id: null,
      expected_idr: 50000,
      received_idr: 0,
      variance_idr: -50000,
    });

    // Report B covers the same day: Z is still missing (already has its case),
    // X is settled by report A so it is not missing either.
    const b = await post(
      manager,
      gatewayBody({
        day,
        reference: `GW-${tag}-B`,
        lines: [{ reference: pw, amountIdr: 30000, feeIdr: 210 }],
      }),
    );
    expectOk(b);
    settlementIds.push(b.body.data.id);
    expect(b.body.data).toMatchObject({ unmatchedLines: 1, casesCreated: 1 });

    const missingZ = (await casesByReference(pz)).filter(
      (c) => c.settlement_line_id === null && c.status === "open",
    );
    expect(missingZ).toHaveLength(1);
    expect(missingZ[0]!.id).toBe(missingAfterA[0]!.id);
    // X was settled by report A: no missing case in any report.
    expect(await casesByReference(px)).toEqual([]);
  });

  it("EDC-06 a missing case awaiting approval still blocks a second missing case for the same payment", async () => {
    const day = nextDay();
    const tag = uid();
    const px = `PR-${tag}-X`; // settled by report A
    const pz = `PR-${tag}-Z`; // never settled by anybody
    const pw = `PR-${tag}-W`; // unknown payment in report B
    await seedIntent({ providerRef: px, amountIdr: 100000, day });
    await seedIntent({ providerRef: pz, amountIdr: 50000, day });

    const a = await post(
      manager,
      gatewayBody({
        day,
        reference: `GW-${tag}-A`,
        lines: [{ reference: px, amountIdr: 100000, feeIdr: 700 }],
      }),
    );
    expectOk(a);
    settlementIds.push(a.body.data.id);
    const [missing] = await casesByReference(pz);
    expect(missing).toMatchObject({ status: "open", settlement_line_id: null });

    // Ask to close the missing case: it now waits for a second person.
    const requested = await manager
      .post(`/api/payments/admin/reconciliation/cases/${missing!.id}/resolve`)
      .set(originHeader)
      .set("Idempotency-Key", `res-${randomUUID()}`)
      .send({ note: "Bank statement checked, accepted" });
    expect(requested.status).toBe(200);
    expect((await casesByReference(pz))[0]?.status).toBe("pending_approval");

    // Report B overlaps the same day: Z must not get a second case.
    const b = await post(
      manager,
      gatewayBody({
        day,
        reference: `GW-${tag}-B`,
        lines: [{ reference: pw, amountIdr: 30000, feeIdr: 210 }],
      }),
    );
    expectOk(b);
    settlementIds.push(b.body.data.id);
    expect(b.body.data).toMatchObject({ unmatchedLines: 1, casesCreated: 1 });

    const afterB = await casesByReference(pz);
    expect(afterB).toHaveLength(1);
    expect(afterB[0]).toMatchObject({
      id: missing!.id,
      status: "pending_approval",
    });
  });

  it("EDC-06 a second report for the same EDC batch is refused, so no sale gets a second missing case", async () => {
    const day = nextDay();
    const tag = uid();
    const terminalId = await seedTerminal();
    const batchNo = `H${tag.slice(0, 5)}`;
    const r1 = `RRNH1${tag}`;
    const r3 = `RRNH3${tag}`;
    await seedEdcSale({ terminalId, rrn: r1, amountIdr: 20000, batchNo });
    await seedEdcSale({ terminalId, rrn: r3, amountIdr: 15000, batchNo });
    const first = await post(
      manager,
      edcBody({
        day,
        reference: `EDC-${tag}-A`,
        terminalId,
        batchNo,
        lines: [{ reference: r1, amountIdr: 20000, feeIdr: 140 }],
      }),
    );
    expectOk(first);
    settlementIds.push(first.body.data.id);
    expect(await casesByReference(r3)).toHaveLength(1);

    const second = await post(
      manager,
      edcBody({
        day,
        reference: `EDC-${tag}-B`,
        terminalId,
        batchNo,
        lines: [{ reference: `RRNHX${tag}`, amountIdr: 1000, feeIdr: 7 }],
      }),
    );
    expect(second.status).toBe(409);
    // Still exactly one open case for the sale missing from the batch report.
    const missing = await casesByReference(r3);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      status: "open",
      settlement_line_id: null,
    });
  });
});

describe("EDC-06 legend-jlqi round 2: concurrent imports (M1)", () => {
  it("EDC-06 two reports that carry the same payment at the same time never fail with 500 and match it once", async () => {
    const day = nextDay();
    const tag = uid();
    const pr = `PR-${tag}-C`;
    const intentId = await seedIntent({
      providerRef: pr,
      amountIdr: 45000,
      day,
    });
    const refA = `GW-${tag}-A`;
    const refB = `GW-${tag}-B`;
    const line = { reference: pr, amountIdr: 45000, feeIdr: 315 };
    const [a, b] = await Promise.all([
      post(manager, gatewayBody({ day, reference: refA, lines: [line] })),
      post(manager, gatewayBody({ day, reference: refB, lines: [line] })),
    ]);
    await track(refA);
    await track(refB);
    // Never a 500: each request succeeds (or is told to retry as a conflict).
    for (const r of [a, b]) {
      expect([200, 201, 409], JSON.stringify(r.body)).toContain(r.status);
    }
    // One POS payment is settled once: exactly one line holds it.
    const holders = await asTenant(tenantId, (c) =>
      c.query(
        "SELECT id FROM payment_settlement_lines WHERE tenant_id = $1 AND matched_payment_intent_id = $2",
        [tenantId, intentId],
      ),
    );
    expect(holders.rows).toHaveLength(1);
    // When both calls succeeded, one report matched and the other flagged it.
    if (OK.includes(a.status) && OK.includes(b.status)) {
      expect(a.body.data.matchedLines + b.body.data.matchedLines).toBe(1);
      expect(a.body.data.unmatchedLines + b.body.data.unmatchedLines).toBe(1);
    }
  });
});

describe("EDC-06 legend-jlqi round 2: report key and EDC batch key (M2)", () => {
  it("EDC-06 the same report reference is allowed in two outlets and stays separate", async () => {
    const day = nextDay();
    const tag = uid();
    const reference = `GW-${tag}`;
    const lineFor = (suffix: string) => [
      { reference: `PR-${tag}-${suffix}`, amountIdr: 10000, feeIdr: 70 },
    ];
    const inA = await post(
      manager,
      gatewayBody({ day, reference, outletId: outletA, lines: lineFor("A") }),
    );
    const inB = await post(
      manager,
      gatewayBody({ day, reference, outletId: outletB, lines: lineFor("B") }),
    );
    expectOk(inA);
    expectOk(inB);
    settlementIds.push(inA.body.data.id, inB.body.data.id);
    expect(inA.body.data.id).not.toBe(inB.body.data.id);
    expect(inA.body.data.replayed).toBe(false);
    expect(inB.body.data.replayed).toBe(false);
    const stored = await settlementsBy(reference);
    expect(stored.map((r) => r.outlet_id).sort()).toEqual(
      [outletA, outletB].sort(),
    );

    // Re-sending outlet A's report replays outlet A's report only.
    const again = await post(
      manager,
      gatewayBody({ day, reference, outletId: outletA, lines: lineFor("A") }),
    );
    expectOk(again);
    expect(again.body.data).toMatchObject({
      id: inA.body.data.id,
      replayed: true,
    });
    expect(await settlementsBy(reference)).toHaveLength(2);
  });

  it("EDC-06 a new report reference for a terminal and batch that already has a report is refused with 409", async () => {
    const day = nextDay();
    const tag = uid();
    const terminalId = await seedTerminal();
    const batchNo = `K${tag.slice(0, 5)}`;
    const rrn = `RRNK${tag}`;
    await seedEdcSale({ terminalId, rrn, amountIdr: 22000, batchNo });
    const lines = [{ reference: rrn, amountIdr: 22000, feeIdr: 154 }];
    const first = await post(
      manager,
      edcBody({ day, reference: `EDC-${tag}-1`, terminalId, batchNo, lines }),
    );
    expectOk(first);
    settlementIds.push(first.body.data.id);

    const before = {
      lines: await linesOf(first.body.data.id),
      cases: await casesOf(first.body.data.id),
    };
    const second = await post(
      manager,
      edcBody({ day, reference: `EDC-${tag}-2`, terminalId, batchNo, lines }),
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("SETTLEMENT_CONFLICT");
    expect(await settlementsBy(`EDC-${tag}-2`)).toHaveLength(0);
    // The sale stays settled once.
    expect(await linesOf(first.body.data.id)).toEqual(before.lines);
    expect(await casesOf(first.body.data.id)).toEqual(before.cases);
    const holders = await asTenant(tenantId, (c) =>
      c.query(
        "SELECT id FROM payment_settlement_lines WHERE tenant_id = $1 AND reference = $2",
        [tenantId, rrn],
      ),
    );
    expect(holders.rows).toHaveLength(1);
  });
});

describe("EDC-06 legend-jlqi round 2: voided sale is not missing (M3)", () => {
  it("EDC-06 an EDC sale that was voided is not reported as missing from the bank report", async () => {
    const day = nextDay();
    const tag = uid();
    const terminalId = await seedTerminal();
    const batchNo = `V${tag.slice(0, 5)}`;
    const r1 = `RRNV1${tag}`; // settled
    const r2 = `RRNV2${tag}`; // sold then voided at the terminal
    const r3 = `RRNV3${tag}`; // really missing
    const voidedPos = `POS-V2-${tag}`;
    const voidedApproval = `AP${tag}`;
    await seedEdcSale({ terminalId, rrn: r1, amountIdr: 20000, batchNo });
    await seedEdcSale({
      terminalId,
      rrn: r2,
      amountIdr: 18000,
      batchNo,
      reference: voidedPos,
      approvalCode: voidedApproval,
    });
    // The void row shares the sale's POS reference, RRN and approval code.
    await seedEdcSale({
      terminalId,
      rrn: r2,
      amountIdr: 18000,
      batchNo,
      reference: voidedPos,
      approvalCode: voidedApproval,
      type: "void",
    });
    await seedEdcSale({ terminalId, rrn: r3, amountIdr: 15000, batchNo });

    const response = await post(
      manager,
      edcBody({
        day,
        reference: `EDC-${tag}`,
        terminalId,
        batchNo,
        lines: [{ reference: r1, amountIdr: 20000, feeIdr: 140 }],
      }),
    );
    expectOk(response);
    settlementIds.push(response.body.data.id);
    expect(response.body.data).toMatchObject({
      matchedLines: 1,
      casesCreated: 1,
    });
    const cases = await casesOf(response.body.data.id);
    expect(cases.map((c) => c.reference)).toEqual([r3]);
    expect(await casesByReference(r2)).toEqual([]);
    expect(await casesByReference(voidedPos)).toEqual([]);
  });
});

describe("EDC-06 legend-jlqi round 2: period length limit (M4)", () => {
  // Assumption: the brief says both "end - start <= 31 days" and "inclusive
  // range max 31 days". The tests avoid the single ambiguous boundary day:
  // a 31-day inclusive period (end = start + 30) must pass, a period whose end
  // is 32 days after the start must be refused.
  const period = (start: string, endOffsetDays: number) => {
    const end = new Date(`${start}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + endOffsetDays);
    return end.toISOString().slice(0, 10);
  };

  it("EDC-06 a period longer than a month is refused with 422 and nothing is written", async () => {
    const body = gatewayBody({
      day: "2019-03-01",
      reference: `GW-${uid()}`,
      lines: [{ reference: `PR-${uid()}`, amountIdr: 10000, feeIdr: 70 }],
    });
    body.periodEnd = period("2019-03-01", 32);
    const response = await post(manager, body);
    expect(response.status).toBe(422);
    expect(await settlementsBy(body.reference)).toHaveLength(0);

    const yearLong = { ...body, periodEnd: "2019-12-31" };
    expect((await post(manager, yearLong)).status).toBe(422);
    expect(await settlementsBy(body.reference)).toHaveLength(0);
  });

  it("EDC-06 a period of 31 days (inclusive) is still accepted", async () => {
    const body = gatewayBody({
      day: "2019-05-01",
      reference: `GW-${uid()}`,
      lines: [{ reference: `PR-${uid()}`, amountIdr: 10000, feeIdr: 70 }],
    });
    body.periodEnd = period("2019-05-01", 30);
    const response = await post(manager, body);
    expectOk(response);
    settlementIds.push(response.body.data.id);
    expect(response.body.data).toMatchObject({
      periodStart: "2019-05-01",
      periodEnd: "2019-05-31",
    });
  });
});

describe("EDC-06 legend-jlqi round 2: terminal and provider must be real (L1)", () => {
  const oneLine = () => [
    { reference: `RRNL${uid()}`, amountIdr: 10000, feeIdr: 70 },
  ];

  it("EDC-06 refuses an EDC report for a terminal of another outlet, a missing terminal, or another bank", async () => {
    const day = nextDay();
    const otherOutletTerminal = await seedTerminal({ outlet: outletB });
    const bniTerminal = await seedTerminal({ bank: "bni" });
    const ownTerminal = await seedTerminal();
    const cases: [string, ReturnType<typeof edcBody>][] = [
      [
        "terminal of another outlet",
        edcBody({
          day,
          reference: `EDC-${uid()}`,
          terminalId: otherOutletTerminal,
          batchNo: "L1",
          lines: oneLine(),
        }),
      ],
      [
        "terminal that does not exist",
        edcBody({
          day,
          reference: `EDC-${uid()}`,
          terminalId: randomUUID(),
          batchNo: "L2",
          lines: oneLine(),
        }),
      ],
      [
        "terminal of another bank than the provider",
        edcBody({
          day,
          reference: `EDC-${uid()}`,
          terminalId: bniTerminal,
          batchNo: "L3",
          lines: oneLine(),
        }),
      ],
    ];
    for (const [name, body] of cases) {
      const response = await post(manager, body);
      expect(response.status, name).toBe(422);
      expect(await settlementsBy(body.reference), name).toHaveLength(0);
    }
    // Control: the same payload with the outlet's own bca terminal passes.
    const ok = edcBody({
      day,
      reference: `EDC-${uid()}`,
      terminalId: ownTerminal,
      batchNo: "L4",
      lines: oneLine(),
    });
    const accepted = await post(manager, ok);
    expectOk(accepted);
    settlementIds.push(accepted.body.data.id);
  });

  it("EDC-06 refuses a gateway report from an unknown provider code", async () => {
    const body = gatewayBody({
      day: nextDay(),
      reference: `GW-${uid()}`,
      provider: "notagateway",
      lines: oneLine(),
    });
    const response = await post(manager, body);
    expect(response.status).toBe(422);
    expect(await settlementsBy(body.reference)).toHaveLength(0);
  });
});

describe("EDC-06 legend-aegsj one missing case per sale for life", () => {
  it("EDC-06 a later report never opens a second case for a sale whose missing case was approved and resolved", async () => {
    const s = await gatewayMissingSetup();
    await requestClose(s.missingId);
    const eventsBefore = await countOutboxEvents(RESOLVED_EVENT);
    await decideCase(s.missingId, "approved");
    expect((await casesByReference(s.pz))[0]).toMatchObject({
      id: s.missingId,
      status: "resolved",
    });
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(eventsBefore + 1);

    // Two more reports over the same day, other references: Z is still absent
    // from both, but it already had its case.
    for (const suffix of ["B", "C"]) {
      const later = await laterGatewayReport(s, suffix);
      // Only the unknown payment of that report opens a case, never Z again.
      expect(later.body.data).toMatchObject({
        unmatchedLines: 1,
        casesCreated: 1,
      });
    }
    const all = await casesByReference(s.pz);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: s.missingId, status: "resolved" });
    // No second case, so no second approval and no second booked write-off.
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(eventsBefore + 1);
  });

  it("EDC-06 a rejected missing case goes back to open and stays the same single case", async () => {
    const s = await gatewayMissingSetup();
    await requestClose(s.missingId);
    await decideCase(s.missingId, "rejected");
    expect((await casesByReference(s.pz))[0]).toMatchObject({
      id: s.missingId,
      status: "open",
    });

    const later = await laterGatewayReport(s, "B");
    expect(later.body.data).toMatchObject({ casesCreated: 1 });
    const all = await casesByReference(s.pz);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: s.missingId, status: "open" });
  });

  it("EDC-06 an open or pending missing case still blocks a later report", async () => {
    const s = await gatewayMissingSetup();
    await laterGatewayReport(s, "B");
    expect(await casesByReference(s.pz)).toHaveLength(1);
    await requestClose(s.missingId);
    await laterGatewayReport(s, "C");
    const all = await casesByReference(s.pz);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: s.missingId,
      status: "pending_approval",
    });
  });

  it("EDC-06 two reports imported at the same time open exactly one missing case and count it once", async () => {
    const day = nextDay();
    const tag = uid();
    const px = `PR-${tag}-X`;
    const pz = `PR-${tag}-Z`;
    await seedIntent({ providerRef: px, amountIdr: 100000, day });
    await seedIntent({ providerRef: pz, amountIdr: 50000, day });
    const eventsBefore = await countOutboxEvents(RESOLVED_EVENT);

    // Both reports leave Z out. Report A settles X; report B carries an
    // unknown payment W (one case of its own).
    const [a, b] = await Promise.all([
      post(
        manager,
        gatewayBody({
          day,
          reference: `GW-${tag}-A`,
          lines: [{ reference: px, amountIdr: 100000, feeIdr: 700 }],
        }),
      ),
      post(
        manager,
        gatewayBody({
          day,
          reference: `GW-${tag}-B`,
          lines: [{ reference: `PR-${tag}-W`, amountIdr: 30000, feeIdr: 210 }],
        }),
      ),
    ]);
    expectOk(a);
    expectOk(b);
    settlementIds.push(a.body.data.id, b.body.data.id);

    const missing = await casesByReference(pz);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      status: "open",
      settlement_line_id: null,
      expected_idr: 50000,
      variance_idr: -50000,
    });
    // The summaries count only rows that really went in. Which report runs
    // first decides whether the still-unsettled X also gets a missing case
    // (report B first) or not (report A first), so compare with the rows.
    const { rows: inserted } = await asTenant(tenantId, (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM payment_reconciliation_cases
          WHERE tenant_id = $1 AND settlement_id = ANY($2::uuid[])`,
        [tenantId, [a.body.data.id, b.body.data.id]],
      ),
    );
    expect(
      (a.body.data.casesCreated as number) +
        (b.body.data.casesCreated as number),
    ).toBe(Number(inserted[0]!.n));

    // The single case closes once: one approval, one resolved event.
    await requestClose(missing[0]!.id);
    await decideCase(missing[0]!.id, "approved");
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(eventsBefore + 1);
  });

  it("EDC-06 an EDC sale missing from a batch report gets one case for life, even after approval and later reports", async () => {
    const day = nextDay();
    const tag = uid();
    const terminalId = await seedTerminal();
    const batchNo = `A${tag.slice(0, 5)}`;
    const r1 = `RRNA1${tag}`;
    const r3 = `RRNA3${tag}`;
    await seedEdcSale({ terminalId, rrn: r1, amountIdr: 20000, batchNo });
    await seedEdcSale({ terminalId, rrn: r3, amountIdr: 15000, batchNo });
    const first = await post(
      manager,
      edcBody({
        day,
        reference: `EDC-${tag}-A`,
        terminalId,
        batchNo,
        lines: [{ reference: r1, amountIdr: 20000, feeIdr: 140 }],
      }),
    );
    expectOk(first);
    settlementIds.push(first.body.data.id);
    const [missing] = await casesByReference(r3);
    expect(missing).toMatchObject({ status: "open", settlement_line_id: null });

    await requestClose(missing!.id);
    const eventsBefore = await countOutboxEvents(RESOLVED_EVENT);
    await decideCase(missing!.id, "approved");
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(eventsBefore + 1);

    // Later EDC reports (new reference, same period) over the same batch, and
    // over another terminal with the same batch number. Whether the product
    // refuses (409) or accepts them, r3 never gets a second case. A 500 is a bug.
    const otherTerminal = await seedTerminal();
    for (const [suffix, terminal] of [
      ["B", terminalId],
      ["C", otherTerminal],
    ] as const) {
      const later = await post(
        manager,
        edcBody({
          day,
          reference: `EDC-${tag}-${suffix}`,
          terminalId: terminal,
          batchNo,
          lines: [
            {
              reference: `RRNAX${suffix}${tag}`,
              amountIdr: 1000,
              feeIdr: 7,
            },
          ],
        }),
      );
      expect([200, 201, 409]).toContain(later.status);
      await track(`EDC-${tag}-${suffix}`);
    }
    const all = await casesByReference(r3);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: missing!.id, status: "resolved" });
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(eventsBefore + 1);
  });
});

// ------------------------------------------- legend-hbifd matched auto-close
//
// Rule (CTO decision, brief legend-hbifd): when a LATER report matches (or
// mismatches) a sale that still has an open / pending_approval "missing" case,
// the case closes itself as `matched`: no `reconciliation_case.resolved`
// event, no write-off, no resolvedBy/approvedBy; a pending approval chain is
// cancelled so it can never be approved afterwards.
//
// Assumptions: the exact note text and the 409 message come from the brief;
// the audit row is found by action name + case id anywhere in the event JSON;
// an approval request cancelled by the import has status "cancelled".

const MATCHED_AUDIT = "payment.reconciliation_case_matched_closed";
const MATCHED_409 =
  "Reconciliation case was closed automatically: its sale was matched in a settlement report.";
const matchedNote = (report: string, line: number) =>
  `Closed automatically: sale matched a settlement line (report ${report}, line ${line})`;

async function caseDetail(caseId: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query<{
      status: string;
      note: string | null;
      resolved_by: string | null;
      approved_by: string | null;
      settlement_line_id: string | null;
    }>(
      `SELECT status, note, resolved_by, approved_by, settlement_line_id
         FROM payment_reconciliation_cases WHERE tenant_id = $1 AND id = $2`,
      [tenantId, caseId],
    ),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function requestsOfCase(caseId: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query<{ id: string; chain_id: string; status: string }>(
      `SELECT id, chain_id, status FROM approval_requests
        WHERE tenant_id = $1 AND object_type = 'payment_reconciliation_case'
          AND object_id = $2 ORDER BY created_at`,
      [tenantId, caseId],
    ),
  );
  return rows;
}

async function pendingRequestOf(caseId: string) {
  const pending = (await requestsOfCase(caseId)).filter(
    (r) => r.status === "pending",
  );
  expect(pending).toHaveLength(1);
  return pending[0]!;
}

const approveRequest = (requestId: string) =>
  decideApprovalRequest(
    tenantContext(),
    approverId,
    requestId,
    { decision: "approved", reason: "Sesuai laporan settlement." },
    { mfaVerified: true, idempotencyKey: null },
  );

/** Runs the worker over every approval.resolved event of a chain not yet handled. */
async function applyChainEvents(chainId: string, handled: Set<string>) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND destination = 'cloud-sync'
          AND event->>'name' = 'approval.resolved'
          AND event->'payload'->>'chainId' = $2`,
      [tenantId, chainId],
    ),
  );
  for (const row of rows) {
    const event = eventEnvelopeSchema.parse(row.event);
    if (handled.has(event.id)) continue;
    handled.add(event.id);
    await handleReconciliationApprovalResolved(tenantWide, event, new Date());
  }
}

/** A later report, another reference, same period, that carries the missing sale Z. */
async function matchingGatewayReport(
  s: { day: string; tag: string; pz: string },
  suffix: string,
  amountIdr = 50000,
) {
  const response = await post(
    manager,
    gatewayBody({
      day: s.day,
      reference: `GW-${s.tag}-${suffix}`,
      lines: [
        {
          reference: s.pz,
          amountIdr,
          feeIdr: Math.round(amountIdr * 0.007),
        },
      ],
    }),
  );
  expectOk(response);
  settlementIds.push(response.body.data.id);
  return response;
}

async function matchedAuditCount(caseId: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2 AND event::text LIKE $3`,
      [tenantId, MATCHED_AUDIT, `%${caseId}%`],
    ),
  );
  return Number(rows[0]!.n);
}

async function resolveViaApi(caseId: string) {
  return manager
    .post(`/api/payments/admin/reconciliation/cases/${caseId}/resolve`)
    .set(originHeader)
    .set("Idempotency-Key", `res-${randomUUID()}`)
    .send({ note: "Bank statement checked, accepted" });
}

describe("EDC-06 legend-hbifd a later report that matches the sale closes its missing case as matched", () => {
  it("EDC-06 an open missing case becomes matched when a later gateway report settles its sale; nothing is written off", async () => {
    const s = await gatewayMissingSetup();
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);
    const money = await moneySnapshot();

    const later = await matchingGatewayReport(s, "B");
    expect(later.body.data).toMatchObject({ matchedLines: 1, casesCreated: 0 });

    const row = await caseDetail(s.missingId);
    expect(row).toMatchObject({
      status: "matched",
      resolved_by: null,
      approved_by: null,
      settlement_line_id: null,
    });
    expect(row.note).toBe(matchedNote(`GW-${s.tag}-B`, 1));
    expect(await matchedAuditCount(s.missingId)).toBe(1);
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore);
    expect(await moneySnapshot()).toEqual(money);

    // Nobody can close it any more; it is closed by the match already.
    const resolve = await resolveViaApi(s.missingId);
    expect(resolve.status, JSON.stringify(resolve.body)).toBe(409);
    expect(JSON.stringify(resolve.body)).toContain(MATCHED_409);
    expect(await requestsOfCase(s.missingId)).toHaveLength(0);

    // It stays the one case of that sale for life: more reports neither
    // reopen it nor add a second one (migration 0358 still holds).
    await laterGatewayReport(s, "C");
    const all = await casesByReference(s.pz);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: s.missingId, status: "matched" });
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore);
  });

  it("EDC-06 an open missing EDC case becomes matched when a later batch report settles the sale", async () => {
    const day = nextDay();
    const tag = uid();
    const terminalId = await seedTerminal();
    const batchA = `A${tag.slice(0, 5)}`;
    const batchB = `B${tag.slice(0, 5)}`;
    const r1 = `RRNH1${tag}`;
    const r3 = `RRNH3${tag}`;
    await seedEdcSale({
      terminalId,
      rrn: r1,
      amountIdr: 20000,
      batchNo: batchA,
    });
    await seedEdcSale({
      terminalId,
      rrn: r3,
      amountIdr: 15000,
      batchNo: batchA,
    });
    const first = await post(
      manager,
      edcBody({
        day,
        reference: `EDC-${tag}-A`,
        terminalId,
        batchNo: batchA,
        lines: [{ reference: r1, amountIdr: 20000, feeIdr: 140 }],
      }),
    );
    expectOk(first);
    settlementIds.push(first.body.data.id);
    const [missing] = await casesByReference(r3);
    expect(missing).toMatchObject({ status: "open", settlement_line_id: null });
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);

    // Another batch number (the same batch would be refused with 409): the
    // sale is found by terminal + RRN and the report settles it.
    const second = await post(
      manager,
      edcBody({
        day,
        reference: `EDC-${tag}-B`,
        terminalId,
        batchNo: batchB,
        lines: [{ reference: r3, amountIdr: 15000, feeIdr: 105 }],
      }),
    );
    expectOk(second);
    settlementIds.push(second.body.data.id);
    expect(second.body.data).toMatchObject({
      matchedLines: 1,
      casesCreated: 0,
    });

    const row = await caseDetail(missing!.id);
    expect(row).toMatchObject({
      status: "matched",
      resolved_by: null,
      approved_by: null,
    });
    expect(row.note).toBe(matchedNote(`EDC-${tag}-B`, 1));
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore);
    expect((await resolveViaApi(missing!.id)).status).toBe(409);
    expect(await casesByReference(r3)).toHaveLength(1);
  });

  it("EDC-06 a mismatching line (different amount) for the sale also closes its missing case as matched", async () => {
    const s = await gatewayMissingSetup();
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);

    const later = await matchingGatewayReport(s, "B", 45000);
    expect(later.body.data).toMatchObject({
      matchedLines: 0,
      mismatchLines: 1,
      casesCreated: 1,
    });

    // The amount difference is its own (open) case on the new report's line.
    const all = await casesByReference(s.pz);
    expect(all).toHaveLength(2);
    const mismatch = all.find((c) => c.id !== s.missingId)!;
    expect(mismatch).toMatchObject({
      status: "open",
      expected_idr: 50000,
      received_idr: 45000,
      variance_idr: -5000,
    });
    expect(mismatch.settlement_line_id).not.toBeNull();

    const row = await caseDetail(s.missingId);
    expect(row.status).toBe("matched");
    expect(row.note).toBe(matchedNote(`GW-${s.tag}-B`, 1));
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore);
  });

  it("EDC-06 a case waiting for approval becomes matched, its request is cancelled and approving it afterwards is refused", async () => {
    const s = await gatewayMissingSetup();
    await requestClose(s.missingId);
    const request = await pendingRequestOf(s.missingId);
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);

    await matchingGatewayReport(s, "B");

    expect(await caseDetail(s.missingId)).toMatchObject({
      status: "matched",
      resolved_by: null,
      approved_by: null,
    });
    expect((await requestsOfCase(s.missingId))[0]).toMatchObject({
      id: request.id,
      status: "cancelled",
    });
    expect(await matchedAuditCount(s.missingId)).toBe(1);

    // The approver clicks approve on the stale request: refused, 409.
    await expect(approveRequest(request.id)).rejects.toMatchObject({
      code: "APPROVAL_REQUEST_NOT_PENDING",
      status: 409,
    });
    // The worker may see the cancellation event; it must not reopen the case.
    await applyChainEvents(request.chain_id, new Set());
    expect((await caseDetail(s.missingId)).status).toBe("matched");
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore);
    expect((await resolveViaApi(s.missingId)).status).toBe(409);
  });

  it("EDC-06 an approval already recorded but not yet applied by the worker loses to the match: no write-off", async () => {
    const s = await gatewayMissingSetup();
    await requestClose(s.missingId);
    const request = await pendingRequestOf(s.missingId);
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);

    await approveRequest(request.id); // recorded, worker has not run yet
    expect((await caseDetail(s.missingId)).status).toBe("pending_approval");

    await matchingGatewayReport(s, "B");
    expect((await caseDetail(s.missingId)).status).toBe("matched");

    // The worker now handles whatever events the chain has: still matched.
    await applyChainEvents(request.chain_id, new Set());
    expect(await caseDetail(s.missingId)).toMatchObject({
      status: "matched",
      resolved_by: null,
      approved_by: null,
    });
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore);
  });

  it("EDC-06 approve and a matching import at the same time: exactly one wins, never a write-off of a matched sale", async () => {
    // Repeated: the interleaving differs from run to run. Either outcome is
    // fine, a mix is not. Approve first and applied -> resolved + exactly one
    // event (the write-off happened before the match). Import first -> matched
    // + no event.
    const outcomes: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      const s = await gatewayMissingSetup();
      await requestClose(s.missingId);
      const request = await pendingRequestOf(s.missingId);
      const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);
      const handled = new Set<string>();

      const approveAndApply = async () => {
        try {
          await approveRequest(request.id);
        } catch (error) {
          // The import cancelled the request first.
          expect(error).toMatchObject({
            code: "APPROVAL_REQUEST_NOT_PENDING",
          });
          return "refused" as const;
        }
        await applyChainEvents(request.chain_id, handled);
        return "approved" as const;
      };
      const [decision, imported] = await Promise.all([
        approveAndApply(),
        matchingGatewayReport(s, "B"),
      ]);
      await applyChainEvents(request.chain_id, handled);

      expect(imported.body.data).toMatchObject({ matchedLines: 1 });
      const row = await caseDetail(s.missingId);
      const events = (await countOutboxEvents(RESOLVED_EVENT)) - resolvedBefore;
      if (row.status === "resolved") {
        expect(decision).toBe("approved");
        expect(events).toBe(1);
        expect(row.approved_by).toBe(approverId);
      } else {
        expect(row.status).toBe("matched");
        expect(events).toBe(0);
        expect(row.approved_by).toBeNull();
      }
      outcomes.push(row.status);
      // One case per sale, whatever the outcome.
      expect(await casesByReference(s.pz)).toHaveLength(1);
    }
    expect(outcomes.every((o) => o === "resolved" || o === "matched")).toBe(
      true,
    );
  });

  it("EDC-06 another missing sale of the same report is not touched when only one sale is matched", async () => {
    const day = nextDay();
    const tag = uid();
    const px = `PR-${tag}-X`;
    const pz = `PR-${tag}-Z`;
    const pq = `PR-${tag}-Q`;
    await seedIntent({ providerRef: px, amountIdr: 100000, day });
    await seedIntent({ providerRef: pz, amountIdr: 50000, day });
    await seedIntent({ providerRef: pq, amountIdr: 70000, day });
    const a = await post(
      manager,
      gatewayBody({
        day,
        reference: `GW-${tag}-A`,
        lines: [{ reference: px, amountIdr: 100000, feeIdr: 700 }],
      }),
    );
    expectOk(a);
    settlementIds.push(a.body.data.id);
    const [caseZ] = await casesByReference(pz);
    const [caseQ] = await casesByReference(pq);
    expect(caseZ).toMatchObject({ status: "open", settlement_line_id: null });
    expect(caseQ).toMatchObject({ status: "open", settlement_line_id: null });
    await requestClose(caseQ!.id); // Q waits for approval

    await matchingGatewayReport({ day, tag, pz }, "B");

    expect((await caseDetail(caseZ!.id)).status).toBe("matched");
    // Q still waits, with its pending request, and can still be approved.
    expect((await caseDetail(caseQ!.id)).status).toBe("pending_approval");
    expect((await requestsOfCase(caseQ!.id))[0]!.status).toBe("pending");
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);
    await decideCase(caseQ!.id, "approved");
    expect((await caseDetail(caseQ!.id)).status).toBe("resolved");
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore + 1);
  });

  it("EDC-06 the summary stops counting a missing case once its sale is matched", async () => {
    const summaryOf = async () => {
      const response = await manager.get(`${SUMMARY}?outletId=${outletA}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data as { openCases: number; varianceIdr: number };
    };
    const before = await summaryOf();
    const s = await gatewayMissingSetup();
    const open = await summaryOf();
    expect(open.openCases).toBe(before.openCases + 1);
    expect(open.varianceIdr).toBe(before.varianceIdr - 50000);

    await requestClose(s.missingId); // pending_approval still counts
    const pending = await summaryOf();
    expect(pending.openCases).toBe(open.openCases);
    expect(pending.varianceIdr).toBe(open.varianceIdr);

    await matchingGatewayReport(s, "B");
    const matched = await summaryOf();
    expect(matched.openCases).toBe(before.openCases);
    expect(matched.varianceIdr).toBe(before.varianceIdr);
  });
});

// ---------------------------------------- legend-hbifd review gaps (a)-(f)
//
// Assumptions: a request that expired stays `expired` when a later import
// closes its case (terminal outcomes stand, like cancel on expired = 409);
// a report for another outlet never closes a case of this outlet, whichever
// way its line is classified; a case whose source_transaction_id is NULL
// (legacy, written before migration 0358) cannot be tied to a sale, so a
// match never closes it. Hardening (f): the worker, applying an approved
// chain, closes the case as `matched` (no resolved event) when its sale
// already has a settlement line, even though no import closed it first.

type SaleSet = { day: string; tag: string; px: string; pz: string; pq: string };

/** X settled by report A; Z and Q never settled (two open missing cases). */
async function twoMissingSetup(): Promise<
  SaleSet & { caseZ: string; caseQ: string }
> {
  const day = nextDay();
  const tag = uid();
  const px = `PR-${tag}-X`;
  const pz = `PR-${tag}-Z`;
  const pq = `PR-${tag}-Q`;
  await seedIntent({ providerRef: px, amountIdr: 100000, day });
  await seedIntent({ providerRef: pz, amountIdr: 50000, day });
  await seedIntent({ providerRef: pq, amountIdr: 70000, day });
  const a = await post(
    manager,
    gatewayBody({
      day,
      reference: `GW-${tag}-A`,
      lines: [{ reference: px, amountIdr: 100000, feeIdr: 700 }],
    }),
  );
  expectOk(a);
  settlementIds.push(a.body.data.id);
  const [caseZ] = await casesByReference(pz);
  const [caseQ] = await casesByReference(pq);
  expect(caseZ).toMatchObject({ status: "open", settlement_line_id: null });
  expect(caseQ).toMatchObject({ status: "open", settlement_line_id: null });
  return { day, tag, px, pz, pq, caseZ: caseZ!.id, caseQ: caseQ!.id };
}

async function expireChain(chainId: string) {
  await asTenant(tenantId, (c) =>
    c.query(
      `UPDATE approval_requests
          SET created_at = now() - interval '2 hours',
              deadline_at = now() - interval '1 minute'
        WHERE tenant_id = $1 AND chain_id = $2`,
      [tenantId, chainId],
    ),
  );
  await expireDueApprovalRequests(tenantWide);
}

describe("EDC-06 legend-hbifd review gaps: what a later match must not touch", () => {
  it("EDC-06 (a) a resolved missing case is not touched by a later matching report: still resolved, still one event", async () => {
    const s = await gatewayMissingSetup();
    await requestClose(s.missingId);
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);
    await decideCase(s.missingId, "approved");
    expect((await caseDetail(s.missingId)).status).toBe("resolved");
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore + 1);
    const before = await caseDetail(s.missingId);
    const money = await moneySnapshot();

    const later = await matchingGatewayReport(s, "B");
    expect(later.body.data).toMatchObject({ matchedLines: 1, casesCreated: 0 });

    expect(await caseDetail(s.missingId)).toEqual(before);
    expect(before.approved_by).toBe(approverId);
    expect(await matchedAuditCount(s.missingId)).toBe(0);
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore + 1);
    expect(await casesByReference(s.pz)).toHaveLength(1);
    expect(await moneySnapshot()).toEqual(money);
  });

  it("EDC-06 (b) an import by an outlet-scoped user closes the waiting case as matched and cancels its chain", async () => {
    const day = nextDay();
    const tag = uid();
    const px = `PR-${tag}-X`;
    const pz = `PR-${tag}-Z`;
    await seedIntent({
      outlet: outletB,
      providerRef: px,
      amountIdr: 100000,
      day,
    });
    await seedIntent({
      outlet: outletB,
      providerRef: pz,
      amountIdr: 50000,
      day,
    });
    const a = await post(
      scoped,
      gatewayBody({
        outletId: outletB,
        day,
        reference: `GW-${tag}-A`,
        lines: [{ reference: px, amountIdr: 100000, feeIdr: 700 }],
      }),
    );
    expectOk(a);
    settlementIds.push(a.body.data.id);
    const [missing] = await casesByReference(pz);
    expect(missing).toMatchObject({ status: "open", settlement_line_id: null });
    await requestClose(missing!.id);
    const request = await pendingRequestOf(missing!.id);
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);

    const b = await post(
      scoped,
      gatewayBody({
        outletId: outletB,
        day,
        reference: `GW-${tag}-B`,
        lines: [{ reference: pz, amountIdr: 50000, feeIdr: 350 }],
      }),
    );
    expectOk(b);
    settlementIds.push(b.body.data.id);
    expect(b.body.data).toMatchObject({ matchedLines: 1, casesCreated: 0 });

    expect(await caseDetail(missing!.id)).toMatchObject({
      status: "matched",
      resolved_by: null,
      approved_by: null,
    });
    expect((await requestsOfCase(missing!.id))[0]).toMatchObject({
      id: request.id,
      status: "cancelled",
    });
    expect(await matchedAuditCount(missing!.id)).toBe(1);
    await expect(approveRequest(request.id)).rejects.toMatchObject({
      code: "APPROVAL_REQUEST_NOT_PENDING",
      status: 409,
    });
    await applyChainEvents(request.chain_id, new Set());
    expect((await caseDetail(missing!.id)).status).toBe("matched");
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore);
  });

  it("EDC-06 (c) a report of another outlet does not close an open or waiting case of this outlet", async () => {
    const s = await twoMissingSetup();
    await requestClose(s.caseQ);
    const request = await pendingRequestOf(s.caseQ);
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);

    const other = await post(
      manager,
      gatewayBody({
        outletId: outletB,
        day: s.day,
        reference: `GW-${s.tag}-OB`,
        lines: [
          { reference: s.pz, amountIdr: 50000, feeIdr: 350 },
          { reference: s.pq, amountIdr: 70000, feeIdr: 490 },
        ],
      }),
    );
    expectOk(other);
    settlementIds.push(other.body.data.id);

    expect((await caseDetail(s.caseZ)).status).toBe("open");
    expect((await caseDetail(s.caseQ)).status).toBe("pending_approval");
    expect((await requestsOfCase(s.caseQ))[0]).toMatchObject({
      id: request.id,
      status: "pending",
    });
    expect(await matchedAuditCount(s.caseZ)).toBe(0);
    expect(await matchedAuditCount(s.caseQ)).toBe(0);
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore);
  });

  it("EDC-06 (c) a legacy case without a sale id (source_transaction_id NULL) is not closed by a match", async () => {
    const s = await twoMissingSetup();
    await requestClose(s.caseQ);
    const request = await pendingRequestOf(s.caseQ);
    await asTenant(tenantId, (c) =>
      c.query(
        `UPDATE payment_reconciliation_cases SET source_transaction_id = NULL
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenantId, [s.caseZ, s.caseQ]],
      ),
    );
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);

    const later = await post(
      manager,
      gatewayBody({
        day: s.day,
        reference: `GW-${s.tag}-B`,
        lines: [
          { reference: s.pz, amountIdr: 50000, feeIdr: 350 },
          { reference: s.pq, amountIdr: 70000, feeIdr: 490 },
        ],
      }),
    );
    expectOk(later);
    settlementIds.push(later.body.data.id);
    expect(later.body.data).toMatchObject({ matchedLines: 2 });

    expect((await caseDetail(s.caseZ)).status).toBe("open");
    expect((await caseDetail(s.caseQ)).status).toBe("pending_approval");
    expect((await requestsOfCase(s.caseQ))[0]).toMatchObject({
      id: request.id,
      status: "pending",
    });
    expect(await matchedAuditCount(s.caseZ)).toBe(0);
    expect(await matchedAuditCount(s.caseQ)).toBe(0);
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore);
  });

  it("EDC-06 (d) an expired chain, worker already applied (case open again): a later match closes it as matched without error", async () => {
    const s = await gatewayMissingSetup();
    await requestClose(s.missingId);
    const request = await pendingRequestOf(s.missingId);
    await expireChain(request.chain_id);
    const handled = new Set<string>();
    await applyChainEvents(request.chain_id, handled);
    expect((await caseDetail(s.missingId)).status).toBe("open");
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);

    await matchingGatewayReport(s, "B");

    expect(await caseDetail(s.missingId)).toMatchObject({
      status: "matched",
      resolved_by: null,
      approved_by: null,
    });
    expect((await requestsOfCase(s.missingId))[0]).toMatchObject({
      id: request.id,
      status: "expired",
    });
    await applyChainEvents(request.chain_id, handled);
    expect((await caseDetail(s.missingId)).status).toBe("matched");
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore);
  });

  it("EDC-06 (d) an expired chain, worker not yet run (case still waiting): a later match closes it as matched without error", async () => {
    const s = await gatewayMissingSetup();
    await requestClose(s.missingId);
    const request = await pendingRequestOf(s.missingId);
    await expireChain(request.chain_id);
    expect((await requestsOfCase(s.missingId))[0]!.status).toBe("expired");
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);

    await matchingGatewayReport(s, "B");

    expect(await caseDetail(s.missingId)).toMatchObject({
      status: "matched",
      resolved_by: null,
      approved_by: null,
    });
    expect((await requestsOfCase(s.missingId))[0]!.status).toBe("expired");
    // The worker now sees the expiry event: the case must stay matched.
    await applyChainEvents(request.chain_id, new Set());
    expect((await caseDetail(s.missingId)).status).toBe("matched");
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore);
    expect(await casesByReference(s.pz)).toHaveLength(1);
  });

  it("EDC-06 (e) an approval recorded before the match never produces a write-off event, even when the worker sees the event twice", async () => {
    const s = await gatewayMissingSetup();
    await requestClose(s.missingId);
    const request = await pendingRequestOf(s.missingId);
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);
    await approveRequest(request.id); // chain recorded as approved

    await matchingGatewayReport(s, "B"); // closes the case as matched first
    const closed = await caseDetail(s.missingId);
    expect(closed).toMatchObject({
      status: "matched",
      resolved_by: null,
      approved_by: null,
    });

    await applyChainEvents(request.chain_id, new Set());
    await applyChainEvents(request.chain_id, new Set()); // replayed delivery
    expect(await caseDetail(s.missingId)).toEqual(closed);
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore);
    expect(await casesByReference(s.pz)).toHaveLength(1);
  });

  it("EDC-06 (f) hardening: an approved chain whose sale already has a settlement line closes the case as matched, with no resolved event", async () => {
    const s = await gatewayMissingSetup();
    await requestClose(s.missingId);
    const request = await pendingRequestOf(s.missingId);
    const resolvedBefore = await countOutboxEvents(RESOLVED_EVENT);
    const money = await moneySnapshot();
    await approveRequest(request.id);
    expect((await caseDetail(s.missingId)).status).toBe("pending_approval");

    // No import closed the case: the sale gets its settlement line straight in SQL.
    const [report] = await settlementsBy(`GW-${s.tag}-A`);
    const { rows: intents } = await asTenant(tenantId, (c) =>
      c.query<{ id: string }>(
        "SELECT id FROM payment_intents WHERE tenant_id = $1 AND provider_ref = $2",
        [tenantId, s.pz],
      ),
    );
    expect(intents).toHaveLength(1);
    await asTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO payment_settlement_lines
           (tenant_id, outlet_id, settlement_id, line_no, reference, amount_idr, fee_idr,
            expected_idr, matched_payment_intent_id, match_status)
         VALUES ($1, $2, $3, 99, $4, 50000, 350, 50000, $5, 'matched')`,
        [tenantId, outletA, report!.id, s.pz, intents[0]!.id],
      ),
    );

    await applyChainEvents(request.chain_id, new Set());

    expect(await caseDetail(s.missingId)).toMatchObject({
      status: "matched",
      resolved_by: null,
      approved_by: null,
    });
    expect(await countOutboxEvents(RESOLVED_EVENT)).toBe(resolvedBefore);
    expect(await casesByReference(s.pz)).toHaveLength(1);
    expect(await moneySnapshot()).toEqual(money);
  });
});

describe("EDC-06 legend-aegsj database refuses a second missing case (migration 0358)", () => {
  it("EDC-06 the journal registers 0358 after the last earlier entry", () => {
    const journal = JSON.parse(
      readFileSync(
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../../drizzle/meta/_journal.json",
        ),
        "utf8",
      ),
    ) as { entries: { idx: number; when: number; tag: string }[] };
    const entry = journal.entries.find((row) => row.idx === 358);
    expect(entry?.tag).toMatch(/^0358_/);
    const earlier = journal.entries.filter((row) => row.idx < 358);
    expect(entry!.when).toBeGreaterThan(
      Math.max(...earlier.map((r) => r.when)),
    );
  });

  // The brief named a (tenant, outlet, source, provider, reference) key; the
  // implementation may key it on the sale id instead (card approval codes
  // repeat). The test only requires a partial UNIQUE index on the missing rows.
  it("EDC-06 a partial unique index guards missing cases (settlement_line_id IS NULL)", async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'payment_reconciliation_cases'`,
    );
    const guards = rows.filter(
      (row) =>
        /CREATE UNIQUE INDEX/i.test(row.indexdef) &&
        /settlement_line_id\)?\s+IS NULL/i.test(row.indexdef) &&
        /tenant_id/.test(row.indexdef),
    );
    expect(guards.length).toBeGreaterThanOrEqual(1);
  });

  // The index keys on the sale id (source_transaction_id), not on reference:
  // two missing rows for one sale are refused even with different references,
  // while legacy rows (null sale id) may repeat. Rows are inserted straight as
  // the migration owner, copying a real missing case so FKs and checks hold.
  it("EDC-06 the database refuses a second missing row for one sale (23505) but allows repeated null sale ids", async () => {
    const s = await gatewayMissingSetup();
    const insertCopy = (saleId: string | null, reference: string) =>
      asTenant(tenantId, (c) =>
        c.query(
          `INSERT INTO payment_reconciliation_cases
             (id, tenant_id, outlet_id, settlement_id, settlement_line_id, source,
              provider, reference, source_transaction_id, period_start, period_end,
              expected_idr, received_idr, variance_idr, reason, status)
           SELECT gen_random_uuid(), tenant_id, outlet_id, settlement_id, NULL, source,
                  provider, $3, $4::uuid, period_start, period_end,
                  expected_idr, received_idr, variance_idr, reason, 'open'
             FROM payment_reconciliation_cases WHERE tenant_id = $1 AND id = $2`,
          [tenantId, s.missingId, reference, saleId],
        ),
      );

    const saleId = randomUUID();
    await insertCopy(saleId, `GW-${s.tag}-DUP1`);
    await expect(insertCopy(saleId, `GW-${s.tag}-DUP2`)).rejects.toMatchObject({
      code: "23505",
      constraint: "payment_reconciliation_cases_missing_sale_key",
    });

    // Legacy rows without a sale id are not guarded by the index.
    await insertCopy(null, `GW-${s.tag}-NULL1`);
    await insertCopy(null, `GW-${s.tag}-NULL2`);
  });
});

describe("EDC-06 legend-jlqi summary", () => {
  it("EDC-06 the summary reports real line and case counts instead of 503", async () => {
    const before = await manager.get(`${SUMMARY}?outletId=${outletA}`);
    expect(before.status).toBe(200);
    const b = before.body.data as Record<string, number>;
    const s = await gatewayScenario();
    await importScenario(s);
    const after = await manager.get(`${SUMMARY}?outletId=${outletA}`);
    expect(after.status).toBe(200);
    const a = after.body.data as Record<string, number>;
    expect(a.matchedLines - b.matchedLines).toBe(1);
    expect(a.mismatchLines - b.mismatchLines).toBe(1);
    expect(a.unmatchedLines - b.unmatchedLines).toBe(1);
    expect(a.openCases - b.openCases).toBe(3);
    expect(a.varianceIdr - b.varianceIdr).toBe(-30000);
    expect(a.resolvedThisMonth).toBeGreaterThanOrEqual(b.resolvedThisMonth);
  });

  it("EDC-06 the tenant-wide summary answers 200", async () => {
    const response = await manager.get(SUMMARY);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty("openCases");
  });
});

describe("EDC-06 legend-jlqi payload validation writes nothing", () => {
  const valid = () =>
    gatewayBody({
      day: nextDay(),
      reference: `GW-${uid()}`,
      lines: [
        { reference: `PR-${uid()}-1`, amountIdr: 10000, feeIdr: 70 },
        { reference: `PR-${uid()}-2`, amountIdr: 20000, feeIdr: 140 },
      ],
    });

  it("EDC-06 rejects totals that do not add up and malformed reports with 422", async () => {
    const terminalId = await seedTerminal();
    const cases: [string, (b: MutableBody) => void][] = [
      ["net != gross - fee", (b) => (b.netIdr = b.netIdr + 1)],
      ["gross != sum of lines", (b) => (b.grossIdr = b.grossIdr + 1)],
      ["fee != sum of lines", (b) => (b.feeIdr = b.feeIdr + 1)],
      [
        "duplicate line reference",
        (b) => (b.lines[1].reference = b.lines[0].reference),
      ],
      ["negative amount", (b) => (b.lines[0].amountIdr = -10000)],
      ["zero amount", (b) => (b.lines[0].amountIdr = 0)],
      ["negative fee", (b) => (b.lines[0].feeIdr = -1)],
      ["no lines", (b) => (b.lines = [])],
      ["period end before start", (b) => (b.periodEnd = "2019-01-01")],
      ["bad date", (b) => (b.periodStart = "2020-13-45")],
      ["unknown source", (b) => (b.source = "paypal")],
      ["client-supplied tenant", (b) => (b.tenantId = randomUUID())],
      ["gateway with batchNo", (b) => (b.batchNo = "B1")],
      ["gateway with terminalId", (b) => (b.terminalId = terminalId)],
      ["edc without terminal and batch", (b) => (b.source = "edc")],
      [
        "edc with gateway provider",
        (b) => {
          b.source = "edc";
          b.terminalId = terminalId;
          b.batchNo = "B1";
        },
      ],
    ];
    for (const [name, mutate] of cases) {
      const body = valid() as unknown as MutableBody;
      mutate(body);
      const response = await post(manager, body);
      expect(response.status, name).toBe(422);
      expect(await settlementsBy(body.reference), name).toHaveLength(0);
    }
  });
});

describe("TEN-01 TEN-02 TEN-03 legend-jlqi access and isolation", () => {
  it("TEN-02 needs a session and a trusted origin", async () => {
    const body = valid2();
    const anonymous = await agent(app)
      .post(IMPORT)
      .set(originHeader)
      .set("Idempotency-Key", `anon-${randomUUID()}`)
      .send(body);
    expect(anonymous.status).toBe(401);
    const noOrigin = await manager
      .post(IMPORT)
      .set("Idempotency-Key", `origin-${randomUUID()}`)
      .send(body);
    expect(noOrigin.status).toBe(403);
    expect(await settlementsBy(body.reference)).toHaveLength(0);
  });

  it("TEN-03 an administrator of another outlet cannot import for this outlet", async () => {
    const body = valid2();
    const denied = await post(scoped, body);
    expect([403, 404]).toContain(denied.status);
    expect(await settlementsBy(body.reference)).toHaveLength(0);
    // ...but can import for the outlet they administer.
    const own = valid2(outletB);
    const allowed = await post(scoped, own);
    expectOk(allowed);
    settlementIds.push(allowed.body.data.id);
    expect((await settlementsBy(own.reference))[0]?.outlet_id).toBe(outletB);
  });

  it("TEN-01 cannot import into another tenant's outlet", async () => {
    const body = valid2(otherOutlet);
    const response = await post(manager, body);
    expect([403, 404]).toContain(response.status);
    const leaked = await asTenant(otherTenant, (c) =>
      c.query("SELECT id FROM payment_settlements WHERE reference = $1", [
        body.reference,
      ]),
    );
    expect(leaked.rows).toEqual([]);
    expect(await settlementsBy(body.reference)).toHaveLength(0);
  });

  it("TEN-01 another tenant's POS payment is never matched or touched", async () => {
    const day = nextDay();
    const tag = uid();
    const foreignRef = `PR-${tag}-FOREIGN`;
    await seedIntent({
      tenant: otherTenant,
      outlet: otherOutlet,
      providerRef: foreignRef,
      amountIdr: 70000,
      day,
    });
    const beforeOther = await asTenant(otherTenant, (c) =>
      c.query(
        "SELECT id, status, amount_idr::text a FROM payment_intents WHERE tenant_id = $1 ORDER BY id",
        [otherTenant],
      ),
    );
    const response = await post(
      manager,
      gatewayBody({
        day,
        reference: `GW-${tag}`,
        lines: [{ reference: foreignRef, amountIdr: 70000, feeIdr: 490 }],
      }),
    );
    expectOk(response);
    const id = response.body.data.id as string;
    settlementIds.push(id);
    expect(response.body.data).toMatchObject({
      matchedLines: 0,
      unmatchedLines: 1,
    });
    expect((await linesOf(id))[0]).toMatchObject({
      match_status: "unmatched",
      matched_payment_intent_id: null,
    });
    // The other tenant's payment (paid on the same day) is not our missing case.
    expect((await casesOf(id)).map((c) => c.reference)).toEqual([foreignRef]);
    const afterOther = await asTenant(otherTenant, (c) =>
      c.query(
        "SELECT id, status, amount_idr::text a FROM payment_intents WHERE tenant_id = $1 ORDER BY id",
        [otherTenant],
      ),
    );
    expect(afterOther.rows).toEqual(beforeOther.rows);
  });

  function valid2(outletId: string = outletA) {
    return gatewayBody({
      day: nextDay(),
      reference: `GW-${uid()}`,
      outletId,
      lines: [{ reference: `PR-${uid()}`, amountIdr: 10000, feeIdr: 70 }],
    });
  }
});

describe("TEN-01 TEN-02 legend-jlqi settlement tables (RLS and append-only)", () => {
  const settlementA = randomUUID();
  const lineA = randomUUID();
  const reference = `RLS-${uid()}`;
  const insertSettlement = (id: string, tenant: string, outlet: string) =>
    `INSERT INTO payment_settlements
       (id, tenant_id, outlet_id, source, provider, reference, period_start, period_end,
        gross_idr, fee_idr, net_idr, line_count, content_hash, imported_by)
     VALUES ('${id}', '${tenant}', '${outlet}', 'gateway', 'doit', '${reference}',
             '2020-02-01', '2020-02-01', 1000, 7, 993, 1, '${"a".repeat(64)}', 'seed')`;

  beforeAll(async () => {
    await asTenant(tenantId, async (c) => {
      await c.query(insertSettlement(settlementA, tenantId, outletA));
      await c.query(
        `INSERT INTO payment_settlement_lines
           (id, tenant_id, outlet_id, settlement_id, line_no, reference, amount_idr, fee_idr, match_status)
         VALUES ($1, $2, $3, $4, 1, 'RLS-LINE', 1000, 7, 'unmatched')`,
        [lineA, tenantId, outletA, settlementA],
      );
    });
  });

  it("TEN-02 both tables are forced through restrictive tenant and outlet policies", async () => {
    const result = await owner.query(
      `SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'tenant_isolation' AND NOT p.polpermissive) AS tenant,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'outlet_isolation' AND NOT p.polpermissive) AS outlet
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('payment_settlements','payment_settlement_lines')
        ORDER BY c.relname`,
    );
    expect(result.rows).toEqual([
      {
        name: "payment_settlement_lines",
        enabled: true,
        forced: true,
        tenant: true,
        outlet: true,
      },
      {
        name: "payment_settlements",
        enabled: true,
        forced: true,
        tenant: true,
        outlet: true,
      },
    ]);
  });

  it("TEN-01 only the owning tenant and outlet read the rows", async () => {
    const own = await asAppRole(
      { tenant: tenantId, outlets: "*" },
      async (c) => ({
        s: await c.query("SELECT id FROM payment_settlements WHERE id = $1", [
          settlementA,
        ]),
        l: await c.query(
          "SELECT id FROM payment_settlement_lines WHERE id = $1",
          [lineA],
        ),
      }),
    );
    expect(own.s.rows).toEqual([{ id: settlementA }]);
    expect(own.l.rows).toEqual([{ id: lineA }]);
    const other = await asAppRole(
      { tenant: otherTenant, outlets: "*" },
      async (c) => ({
        s: await c.query("SELECT id FROM payment_settlements"),
        l: await c.query("SELECT id FROM payment_settlement_lines"),
      }),
    );
    expect(other.s.rows).toEqual([]);
    expect(other.l.rows).toEqual([]);
    const otherOutletOnly = await asAppRole(
      { tenant: tenantId, outlets: JSON.stringify([outletB]) },
      async (c) => ({
        s: await c.query("SELECT id FROM payment_settlements WHERE id = $1", [
          settlementA,
        ]),
        l: await c.query(
          "SELECT id FROM payment_settlement_lines WHERE id = $1",
          [lineA],
        ),
      }),
    );
    expect(otherOutletOnly.s.rows).toEqual([]);
    expect(otherOutletOnly.l.rows).toEqual([]);
  });

  it("TEN-01 a row cannot be written for another tenant", async () => {
    await expect(
      asAppRole({ tenant: otherTenant, outlets: "*" }, (c) =>
        c.query(insertSettlement(randomUUID(), tenantId, outletA)),
      ),
    ).rejects.toThrow();
  });

  it("TEN-01 the report key is per tenant: another tenant may use the same reference", async () => {
    await asTenant(otherTenant, (c) =>
      c.query(insertSettlement(randomUUID(), otherTenant, otherOutlet)),
    );
    const mine = await settlementsBy(reference);
    expect(mine).toHaveLength(1);
  });

  it("EDC-06 the application role cannot update or delete settlement history", async () => {
    for (const sql of [
      "UPDATE payment_settlements SET fee_idr = 0 WHERE id = $1",
      "DELETE FROM payment_settlements WHERE id = $1",
    ]) {
      await expect(
        asAppRole({ tenant: tenantId, outlets: "*" }, (c) =>
          c.query(sql, [settlementA]),
        ),
      ).rejects.toThrow(/permission denied/i);
    }
    for (const sql of [
      "UPDATE payment_settlement_lines SET match_status = 'matched' WHERE id = $1",
      "DELETE FROM payment_settlement_lines WHERE id = $1",
    ]) {
      await expect(
        asAppRole({ tenant: tenantId, outlets: "*" }, (c) =>
          c.query(sql, [lineA]),
        ),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it("EDC-06 the database refuses a report whose net is not gross minus fee", async () => {
    await expect(
      asTenant(tenantId, (c) =>
        c.query(
          `INSERT INTO payment_settlements
             (tenant_id, outlet_id, source, provider, reference, period_start, period_end,
              gross_idr, fee_idr, net_idr, line_count, content_hash, imported_by)
           VALUES ($1, $2, 'gateway', 'doit', $3, '2020-02-01', '2020-02-01', 1000, 7, 1000, 1, $4, 'seed')`,
          [tenantId, outletA, `RLS-${uid()}`, "b".repeat(64)],
        ),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("EDC-06 the database refuses an EDC report without a batch number, so the per-batch key cannot be bypassed", async () => {
    await expect(
      asTenant(tenantId, (c) =>
        c.query(
          `INSERT INTO payment_settlements
             (tenant_id, outlet_id, source, provider, terminal_id, batch_no, reference, period_start, period_end,
              gross_idr, fee_idr, net_idr, line_count, content_hash, imported_by)
           VALUES ($1, $2, 'edc', 'bca', $3, NULL, $4, '2020-02-01', '2020-02-01', 1000, 7, 993, 1, $5, 'seed')`,
          [tenantId, outletA, randomUUID(), `RLS-${uid()}`, "c".repeat(64)],
        ),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "payment_settlements_edc_batch_check",
    });
  });
});
