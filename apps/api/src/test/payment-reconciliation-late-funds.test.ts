// Late funds after a write-off (bead legend-oan3p, EDC-06).
// A "missing" reconciliation case (no settlement line, one per POS sale) that
// was closed `resolved` through the approval chain is a write-off. If a LATER
// settlement report then lists that sale, the funds did arrive. Written from
// docs/briefs/sub-writeoff-late-funds.md (rule + contract), not from any
// implementation.
//
// Rule under test:
//  - nothing is reversed automatically: the case stays `resolved`, no journal,
//    no outbox money event; the settlement line keeps only its normal effects;
//  - instead ONE correction row per case, for life (idempotent), flagged on
//    the case view as `lateFunds` and listed for finance;
//  - finance closes the correction through the approval matrix (action type
//    `reconciliation_case`, object type `payment_reconciliation_correction`):
//    Owner or Finance, one level, either is enough, approver != requester;
//    fail closed (409) when the tenant has no policy;
//  - tenant isolation everywhere.
//
// Assumptions (also in the report):
//  - The late line carries fee 0, so "received amount" is unambiguous
//    (gross == net == 50000); `receivedIdr` of the correction is that amount.
//  - Correction endpoints: GET  /api/payments/admin/reconciliation/corrections
//    (cursor page, `outletId`, `status`), POST .../corrections/:id/resolve
//    with { decision, note } (brief, Part A).
//  - Requesting a resolution answers 200 and a `pending_approval` view that
//    already carries the chosen `decision` (brief, Part B).
//  - Re-sending the same import with a NEW key answers success (replayed) or
//    409; both are accepted, only the single correction row matters.
//  - The suite runs in its own tenant (paymentTestScope) so counts of
//    journals / outbox events are not disturbed by other test files.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { handleReconciliationApprovalResolved } from "../services/payment-reconciliation-approval-consumer";
import { decideApprovalRequest } from "../services/platform-approval.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { paymentTestScope } from "./payment-test-scope";

const scope = paymentTestScope();
const app = createApp();
const tenantId = scope.tenantId;
const outletA = scope.outletId;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const ADMIN = "/api/payments/admin/reconciliation";
const IMPORT = `${ADMIN}/settlements`;
const CORRECTION_OBJECT = "payment_reconciliation_correction";
const CASE_OBJECT = "payment_reconciliation_case";
const RESOLVED_EVENT = "reconciliation_case.resolved";
const OPENED_AUDIT = "payment.reconciliation_correction_opened";
const uid = () => randomBytes(4).toString("hex");

const tenantContext = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);

type Client = ReturnType<typeof agent>;
let requester: Client; // Owner: writes off, asks to resolve corrections
let requesterId: string;
let approverId: string; // another Owner
let financeApproverId: string; // Finance manager
let financeId: string;

const userIds: string[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
let dayCounter = 0;

// Second tenant, "same-shaped" data that must never be touched.
const otherTenant = tenantIdSchema.parse(randomUUID());
const otherBrand = randomUUID();
const otherLegal = randomUUID();
const otherOutlet = randomUUID();

// ------------------------------------------------------------------ plumbing

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

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function signedIn(templateKey: "owner" | "finance", label: string) {
  const client = agent(app).set("Host", scope.hostname);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenantId, userId, await roleIdOf(templateKey)],
  );
  return { client, userId };
}

/** Product default: level 1, Owner or Finance (either is enough), distinct actor. */
async function installPolicy() {
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'reconciliation_case'",
    [tenantId],
  );
  for (const templateKey of ["owner", "finance"])
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, 'reconciliation_case', NULL, $2, 1, true)`,
      [tenantId, await roleIdOf(templateKey)],
    );
}

/** Each scenario gets its own business day so "missing" scans never overlap. */
function nextDay(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2020, 0, 1 + dayCounter)).toISOString().slice(0, 10);
}

async function seedIntent(o: {
  tenant?: string;
  outlet?: string;
  providerRef: string;
  amountIdr: number;
  day: string;
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
        `LATE-${linkId.slice(0, 8)}`,
        o.amountIdr,
      ],
    );
    await c.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, provider_ref, amount_idr,
          idempotency_key, status, paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, $7, 'paid', $8::timestamptz,
               '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
      [
        id,
        tenant,
        outlet,
        linkId,
        o.providerRef,
        o.amountIdr,
        `late-${id}`,
        `${o.day} 12:00:00+07`,
      ],
    );
  });
  intentIds.push(id);
  linkIds.push(linkId);
  return id;
}

type Line = { reference: string; amountIdr: number; feeIdr: number };

function gatewayBody(o: { day: string; reference: string; lines: Line[] }) {
  const gross = o.lines.reduce((s, l) => s + l.amountIdr, 0);
  const fee = o.lines.reduce((s, l) => s + l.feeIdr, 0);
  return {
    outletId: outletA,
    source: "gateway",
    provider: "doit",
    reference: o.reference,
    periodStart: o.day,
    periodEnd: o.day,
    grossIdr: gross,
    feeIdr: fee,
    netIdr: gross - fee,
    lines: o.lines,
  };
}

const post = (client: Client, body: unknown, key = `imp-${randomUUID()}`) =>
  client
    .post(IMPORT)
    .set(originHeader)
    .set("Idempotency-Key", key)
    .send(body as object);

function expectOk(response: { status: number; body: unknown }) {
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
}

// ---------------------------------------------------------------- DB readers

async function casesByReference(reference: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query<{
      id: string;
      status: string;
      settlement_line_id: string | null;
      variance_idr: string;
    }>(
      `SELECT id, status, settlement_line_id, variance_idr
         FROM payment_reconciliation_cases WHERE tenant_id = $1 AND reference = $2
         ORDER BY created_at`,
      [tenantId, reference],
    ),
  );
  return rows;
}

async function correctionsOfCase(caseId: string, tenant = tenantId) {
  const { rows } = await asTenant(tenant, (c) =>
    c.query<{
      id: string;
      case_id: string;
      settlement_id: string;
      settlement_line_id: string;
      written_off_idr: string;
      received_idr: string;
      status: string;
      decision: string | null;
      approval_chain_id: string | null;
      requested_by: string | null;
      approved_by: string | null;
      resolved_by: string | null;
      resolved_at: Date | null;
    }>(
      `SELECT id, case_id, settlement_id, settlement_line_id, written_off_idr, received_idr,
              status, decision, approval_chain_id, requested_by, approved_by, resolved_by, resolved_at
         FROM payment_reconciliation_corrections WHERE tenant_id = $1 AND case_id = $2`,
      [tenant, caseId],
    ),
  );
  return rows;
}

async function oneCorrection(caseId: string) {
  const rows = await correctionsOfCase(caseId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function caseStatus(caseId: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query<{ status: string; approved_by: string | null }>(
      `SELECT status, approved_by FROM payment_reconciliation_cases WHERE tenant_id = $1 AND id = $2`,
      [tenantId, caseId],
    ),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function outboxByName(): Promise<Record<string, number>> {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query<{ name: string; n: string }>(
      `SELECT event->>'name' AS name, count(*)::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 GROUP BY 1`,
      [tenantId],
    ),
  );
  return Object.fromEntries(rows.map((r) => [r.name, Number(r.n)]));
}

const outboxCount = async (name: string) => (await outboxByName())[name] ?? 0;

async function auditCount(action: string, needle: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2 AND event::text LIKE $3`,
      [tenantId, action, `%${needle}%`],
    ),
  );
  return Number(rows[0]!.n);
}

/** Everything a late import must never add to (journals, money events, refunds). */
async function moneySnapshot() {
  return asTenant(tenantId, async (c) => {
    const n = async (sql: string) =>
      Number((await c.query<{ n: string }>(sql, [tenantId])).rows[0]!.n);
    return {
      journalEntries: await n(
        "SELECT count(*)::text n FROM journal_entries WHERE tenant_id = $1",
      ),
      journalLines: await n(
        "SELECT count(*)::text n FROM journal_lines WHERE tenant_id = $1",
      ),
      refunds: await n(
        "SELECT count(*)::text n FROM payment_refunds WHERE tenant_id = $1",
      ),
      unallocated: await n(
        "SELECT count(*)::text n FROM payment_unallocated_funds WHERE tenant_id = $1",
      ),
      outbox: await outboxByName(),
    };
  });
}

type Snapshot = Awaited<ReturnType<typeof moneySnapshot>>;

function delta(before: Snapshot, after: Snapshot) {
  const names = new Set([
    ...Object.keys(before.outbox),
    ...Object.keys(after.outbox),
  ]);
  return {
    journalEntries: after.journalEntries - before.journalEntries,
    journalLines: after.journalLines - before.journalLines,
    refunds: after.refunds - before.refunds,
    unallocated: after.unallocated - before.unallocated,
    outbox: Object.fromEntries(
      [...names]
        .map((k) => [k, (after.outbox[k] ?? 0) - (before.outbox[k] ?? 0)])
        .filter(([, d]) => d !== 0),
    ),
  };
}

// ------------------------------------------------------- approval plumbing

async function requestsOf(objectType: string, objectId: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query<{ id: string; chain_id: string; status: string }>(
      `SELECT id, chain_id, status FROM approval_requests
        WHERE tenant_id = $1 AND object_type = $2 AND object_id = $3 ORDER BY created_at`,
      [tenantId, objectType, objectId],
    ),
  );
  return rows;
}

async function pendingRequest(objectType: string, objectId: string) {
  const pending = (await requestsOf(objectType, objectId)).filter(
    (r) => r.status === "pending",
  );
  expect(pending).toHaveLength(1);
  return pending[0]!;
}

const decide = (
  userId: string,
  requestId: string,
  decision: "approved" | "rejected",
) =>
  decideApprovalRequest(
    tenantContext(),
    userId,
    requestId,
    { decision, reason: "Sesuai laporan settlement." },
    { mfaVerified: true, idempotencyKey: null },
  );

async function approvalEvents(chainId: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND destination = 'cloud-sync'
          AND event->>'name' = 'approval.resolved'
          AND event->'payload'->>'chainId' = $2`,
      [tenantId, chainId],
    ),
  );
  return rows.map((r) => eventEnvelopeSchema.parse(r.event));
}

/** The worker consumes the `approval.resolved` event(s) of a chain. */
async function runWorker(chainId: string) {
  const events = await approvalEvents(chainId);
  expect(events.length).toBeGreaterThan(0);
  for (const event of events)
    await handleReconciliationApprovalResolved(tenantWide, event, new Date());
  return events;
}

const resolveCase = (caseId: string, key = `res-${randomUUID()}`) =>
  requester
    .post(`${ADMIN}/cases/${caseId}/resolve`)
    .set(originHeader)
    .set("Idempotency-Key", key)
    .send({ note: "Bank statement checked, accepted" });

const resolveCorrection = (
  client: Client,
  correctionId: string,
  decision: "reverse_write_off" | "keep_write_off" = "keep_write_off",
  note = "Dana sudah diperiksa finance",
) =>
  client
    .post(`${ADMIN}/corrections/${correctionId}/resolve`)
    .set(originHeader)
    .set("Idempotency-Key", `cor-${randomUUID()}`)
    .send({ decision, note });

// ------------------------------------------------------------------ scenarios

/** A gateway fixture: X settled by report A, Z (50000) never settled -> open missing case. */
async function missingSetup() {
  const day = nextDay();
  const tag = uid();
  const px = `PR-${tag}-X`;
  const pz = `PR-${tag}-Z`;
  await seedIntent({ providerRef: px, amountIdr: 100000, day });
  const intentZ = await seedIntent({ providerRef: pz, amountIdr: 50000, day });
  const a = await post(
    requester,
    gatewayBody({
      day,
      reference: `GW-${tag}-A`,
      lines: [{ reference: px, amountIdr: 100000, feeIdr: 700 }],
    }),
  );
  expectOk(a);
  const [missing] = await casesByReference(pz);
  expect(missing).toMatchObject({ status: "open", settlement_line_id: null });
  return { day, tag, px, pz, intentZ, caseId: missing!.id };
}

/** Case closed `resolved` through the approval chain + worker: the write-off. */
async function writeOffSetup() {
  const s = await missingSetup();
  const asked = await resolveCase(s.caseId);
  expect(asked.status, JSON.stringify(asked.body)).toBe(200);
  expect(asked.body.data.status).toBe("pending_approval");
  const request = await pendingRequest(CASE_OBJECT, s.caseId);
  await decide(approverId, request.id, "approved");
  await runWorker(request.chain_id);
  expect((await caseStatus(s.caseId)).status).toBe("resolved");
  return { ...s, caseChainId: request.chain_id };
}

/** A later report, another reference, same period, that carries the written-off sale. */
async function lateReport(
  s: { day: string; tag: string; pz: string },
  suffix = "LATE",
  key?: string,
) {
  return post(
    requester,
    gatewayBody({
      day: s.day,
      reference: `GW-${s.tag}-${suffix}`,
      lines: [{ reference: s.pz, amountIdr: 50000, feeIdr: 0 }],
    }),
    key,
  );
}

async function writeOffThenLate() {
  const s = await writeOffSetup();
  const late = await lateReport(s);
  expectOk(late);
  return { ...s, lateSettlementId: late.body.data.id as string };
}

async function listCorrections(client: Client, query = "") {
  const response = await client.get(
    `${ADMIN}/corrections?outletId=${outletA}&limit=100${query}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as {
    id: string;
    caseId: string;
    status: string;
    decision: string | null;
    writtenOffIdr: number;
    receivedIdr: number;
  }[];
}

async function listedCase(client: Client, caseId: string) {
  const listed = await client.get(
    `${ADMIN}/cases?outletId=${outletA}&limit=100`,
  );
  expect(listed.status).toBe(200);
  const found = listed.body.data.find((c: { id: string }) => c.id === caseId);
  expect(found).toBeDefined();
  return found;
}

beforeAll(async () => {
  await scope.seed(owner);
  ({ client: requester, userId: requesterId } = await signedIn(
    "owner",
    "Late funds requester",
  ));
  ({ userId: approverId } = await signedIn("owner", "Late funds approver"));
  ({ userId: financeApproverId } = await signedIn(
    "finance",
    "Late funds finance",
  ));
  financeId = financeApproverId;
  await installPolicy();

  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Late funds other tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      otherTenant,
      `late-${otherTenant}`,
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
  await quiet(() =>
    owner.query(
      "DELETE FROM payment_reconciliation_corrections WHERE tenant_id = ANY($1::uuid[])",
      [[tenantId, otherTenant]],
    ),
  );
  await quiet(() =>
    owner.query(
      "DELETE FROM payment_reconciliation_cases WHERE tenant_id = ANY($1::uuid[])",
      [[tenantId, otherTenant]],
    ),
  );
  await quiet(() =>
    owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
      intentIds,
    ]),
  );
  await quiet(() =>
    owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
      linkIds,
    ]),
  );
  await quiet(() =>
    owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'reconciliation_case'",
      [tenantId],
    ),
  );
  await quiet(() =>
    owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, userIds],
    ),
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
  await owner.end();
});

// ======================================================================= tests

describe("EDC-06 legend-oan3p a later report that settles a written-off sale flags a correction", () => {
  it("EDC-06 late funds: one open correction with the right amounts; the case stays resolved and is flagged", async () => {
    const s = await writeOffSetup();
    const resolvedBefore = await outboxCount(RESOLVED_EVENT);
    expect(resolvedBefore).toBeGreaterThanOrEqual(1);

    const late = await lateReport(s);
    expectOk(late);
    expect(late.body.data).toMatchObject({ matchedLines: 1, casesCreated: 0 });

    // exactly one correction row, open, amounts hand-computed from the fixture
    const correction = await oneCorrection(s.caseId);
    expect(correction).toMatchObject({
      status: "open",
      decision: null,
      approval_chain_id: null,
      settlement_id: late.body.data.id,
    });
    expect(Number(correction.written_off_idr)).toBe(50000);
    expect(Number(correction.received_idr)).toBe(50000);

    // the case is never reversed
    expect((await caseStatus(s.caseId)).status).toBe("resolved");
    expect(await casesByReference(s.pz)).toHaveLength(1);
    expect(await outboxCount(RESOLVED_EVENT)).toBe(resolvedBefore);

    // GET cases shows the flag
    const view = await listedCase(requester, s.caseId);
    expect(view.status).toBe("resolved");
    expect(view.lateFunds).toMatchObject({
      correctionId: correction.id,
      settlementId: late.body.data.id,
      settlementLineId: correction.settlement_line_id,
      receivedIdr: 50000,
      correctionStatus: "open",
    });
    expect(typeof view.lateFunds.detectedAt).toBe("string");

    // GET corrections lists it for finance
    const listed = await listCorrections(requester);
    const row = listed.find((c) => c.id === correction.id);
    expect(row).toMatchObject({
      caseId: s.caseId,
      status: "open",
      decision: null,
      writtenOffIdr: 50000,
      receivedIdr: 50000,
    });
    const onlyOpen = await listCorrections(requester, "&status=open");
    expect(onlyOpen.map((c) => c.id)).toContain(correction.id);
    const onlyResolved = await listCorrections(requester, "&status=resolved");
    expect(onlyResolved.map((c) => c.id)).not.toContain(correction.id);
  });

  it("EDC-06 late funds: before any late report a written-off case has no flag and no correction exists", async () => {
    const s = await writeOffSetup();
    expect(await correctionsOfCase(s.caseId)).toHaveLength(0);
    expect((await listedCase(requester, s.caseId)).lateFunds).toBeNull();
    expect(
      (await listCorrections(requester)).map((c) => c.caseId),
    ).not.toContain(s.caseId);
  });
});

describe("EDC-06 legend-oan3p nothing is reversed automatically", () => {
  it("EDC-06 late funds: the late import adds only the normal line effects (same as a sale with no case); no journal, no money event, no correction event", async () => {
    const s = await writeOffSetup();

    // Control: the same line for a fresh sale that never had a case.
    const cday = nextDay();
    const ctag = uid();
    const cref = `PR-${ctag}-C`;
    await seedIntent({ providerRef: cref, amountIdr: 50000, day: cday });
    const controlBefore = await moneySnapshot();
    const control = await post(
      requester,
      gatewayBody({
        day: cday,
        reference: `GW-${ctag}-C`,
        lines: [{ reference: cref, amountIdr: 50000, feeIdr: 0 }],
      }),
    );
    expectOk(control);
    const controlDelta = delta(controlBefore, await moneySnapshot());

    const before = await moneySnapshot();
    const late = await lateReport(s);
    expectOk(late);
    const lateDelta = delta(before, await moneySnapshot());

    expect(await oneCorrection(s.caseId)).toMatchObject({ status: "open" });
    expect(lateDelta).toEqual(controlDelta);
    expect(lateDelta.journalEntries).toBe(controlDelta.journalEntries);
    expect(lateDelta.outbox[RESOLVED_EVENT] ?? 0).toBe(0);
    expect(
      Object.keys(lateDelta.outbox).filter((k) => /correction/i.test(k)),
    ).toEqual([]);
    expect((await caseStatus(s.caseId)).status).toBe("resolved");
  });
});

describe("EDC-06 legend-oan3p the correction is idempotent for life", () => {
  it("EDC-06 late funds: replaying the import (same key and a new key), another report with the sale, and the approval event keep one correction and one audit", async () => {
    const s = await writeOffSetup();
    const key = `late-${randomUUID()}`;
    const first = await lateReport(s, "LATE", key);
    expectOk(first);
    const correction = await oneCorrection(s.caseId);
    expect(await auditCount(OPENED_AUDIT, correction.id)).toBe(1);

    // same Idempotency-Key replays the stored response
    const replay = await lateReport(s, "LATE", key);
    expectOk(replay);
    expect(replay.body.data.id).toBe(first.body.data.id);

    // the same report through a new key, and a second report with the same sale
    const again = await lateReport(s, "LATE", `late-${randomUUID()}`);
    expect([200, 201, 409]).toContain(again.status);
    const second = await lateReport(s, "LATE2", `late-${randomUUID()}`);
    expect([200, 201, 409]).toContain(second.status);

    // the write-off approval event is replayed by the worker
    const resolvedBefore = await outboxCount(RESOLVED_EVENT);
    await runWorker(s.caseChainId);

    const rows = await correctionsOfCase(s.caseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(correction.id);
    expect(rows[0]!.status).toBe("open");
    expect(await auditCount(OPENED_AUDIT, correction.id)).toBe(1);
    expect((await caseStatus(s.caseId)).status).toBe("resolved");
    expect(await outboxCount(RESOLVED_EVENT)).toBe(resolvedBefore);
  });
});

describe("TEN-02 legend-oan3p late funds tenant isolation", () => {
  it("TEN-02 late funds: a same-shaped written-off sale in another tenant is untouched, and its correction cannot be listed or resolved", async () => {
    // Tenant B: same POS reference as tenant A's sale, a resolved missing case.
    const s = await writeOffSetup();
    const otherIntent = await seedIntent({
      tenant: otherTenant,
      outlet: otherOutlet,
      providerRef: s.pz,
      amountIdr: 50000,
      day: s.day,
    });
    const otherCase = randomUUID();
    const otherCorrection = randomUUID();
    await asTenant(otherTenant, async (c) => {
      await c.query(
        `INSERT INTO payment_reconciliation_cases
           (id, tenant_id, outlet_id, settlement_id, source, provider, reference, period_start, period_end,
            expected_idr, received_idr, variance_idr, reason, status, source_transaction_id)
         VALUES ($1, $2, $3, $4, 'gateway', 'doit', $5, $6, $6, 50000, 0, -50000, 'Missing from settlement', 'resolved', $7)`,
        [
          otherCase,
          otherTenant,
          otherOutlet,
          randomUUID(),
          s.pz,
          s.day,
          otherIntent,
        ],
      );
      await c.query(
        `INSERT INTO payment_reconciliation_corrections
           (id, tenant_id, outlet_id, case_id, settlement_id, settlement_line_id, source, reference,
            written_off_idr, received_idr, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'gateway', $7, 50000, 50000, 'open')`,
        [
          otherCorrection,
          otherTenant,
          otherOutlet,
          otherCase,
          randomUUID(),
          randomUUID(),
          s.pz,
        ],
      );
    });

    const late = await lateReport(s);
    expectOk(late);

    // A got its correction, B's case got none from A's import.
    expect(await oneCorrection(s.caseId)).toMatchObject({ status: "open" });
    expect(await correctionsOfCase(otherCase, otherTenant)).toHaveLength(1);
    const { rows: bRows } = await asTenant(otherTenant, (c) =>
      c.query<{ n: string }>(
        "SELECT count(*)::text n FROM payment_reconciliation_corrections WHERE tenant_id = $1",
        [otherTenant],
      ),
    );
    expect(Number(bRows[0]!.n)).toBe(1);

    // A cannot see or resolve B's correction.
    const listed = await listCorrections(requester);
    expect(listed.map((c) => c.id)).not.toContain(otherCorrection);
    const resolve = await resolveCorrection(requester, otherCorrection);
    expect(resolve.status).toBe(404);
    expect(await requestsOf(CORRECTION_OBJECT, otherCorrection)).toHaveLength(
      0,
    );
    const after = await asTenant(otherTenant, (c) =>
      c.query<{ status: string }>(
        "SELECT status FROM payment_reconciliation_corrections WHERE id = $1",
        [otherCorrection],
      ),
    );
    expect(after.rows[0]!.status).toBe("open");
  });
});

describe("EDC-06 legend-oan3p finance closes the correction through the approval matrix", () => {
  it("EDC-06 late funds: asking files a pending request; the requester cannot approve it; another Owner approves; the worker resolves it and keeps the decision", async () => {
    const s = await writeOffThenLate();
    const correction = await oneCorrection(s.caseId);
    const resolvedBefore = await outboxCount(RESOLVED_EVENT);

    const asked = await resolveCorrection(
      requester,
      correction.id,
      "keep_write_off",
    );
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body.data).toMatchObject({
      id: correction.id,
      status: "pending_approval",
      decision: "keep_write_off",
      requestedBy: requesterId,
      approvedBy: null,
    });
    const request = await pendingRequest(CORRECTION_OBJECT, correction.id);
    expect(asked.body.data.approvalRequestId).toBe(request.chain_id);

    // the requester cannot approve their own request
    await expect(
      decide(requesterId, request.id, "approved"),
    ).rejects.toMatchObject({ code: "APPROVER_IS_REQUESTER", status: 403 });
    expect((await oneCorrection(s.caseId)).status).toBe("pending_approval");

    // a second ask while pending is refused
    const twice = await resolveCorrection(requester, correction.id);
    expect(twice.status).toBe(409);

    // another Owner approves (one level is enough); nothing changes until the worker runs
    await decide(approverId, request.id, "approved");
    expect((await oneCorrection(s.caseId)).status).toBe("pending_approval");
    await runWorker(request.chain_id);

    expect(await oneCorrection(s.caseId)).toMatchObject({
      status: "resolved",
      decision: "keep_write_off",
      requested_by: requesterId,
      approved_by: approverId,
      resolved_by: requesterId,
    });
    expect((await oneCorrection(s.caseId)).resolved_at).not.toBeNull();
    // still no automatic reversal
    expect((await caseStatus(s.caseId)).status).toBe("resolved");
    expect(await outboxCount(RESOLVED_EVENT)).toBe(resolvedBefore);
    expect(
      Object.keys(await outboxByName()).filter((k) => /correction/i.test(k)),
    ).toEqual([]);

    // listing and case flag show the resolved state
    expect((await listedCase(requester, s.caseId)).lateFunds).toMatchObject({
      correctionId: correction.id,
      correctionStatus: "resolved",
    });
    const listed = await listCorrections(requester, "&status=resolved");
    expect(listed.find((c) => c.id === correction.id)).toMatchObject({
      status: "resolved",
      decision: "keep_write_off",
    });

    // a resolved correction cannot be resolved again; worker replay is a no-op
    expect((await resolveCorrection(requester, correction.id)).status).toBe(
      409,
    );
    await runWorker(request.chain_id);
    expect((await oneCorrection(s.caseId)).status).toBe("resolved");
  });

  it("EDC-06 late funds: a Finance manager can approve an Owner's request (either approver is enough)", async () => {
    const s = await writeOffThenLate();
    const correction = await oneCorrection(s.caseId);
    const asked = await resolveCorrection(
      requester,
      correction.id,
      "reverse_write_off",
    );
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const request = await pendingRequest(CORRECTION_OBJECT, correction.id);

    await decide(financeId, request.id, "approved");
    await runWorker(request.chain_id);

    expect(await oneCorrection(s.caseId)).toMatchObject({
      status: "resolved",
      decision: "reverse_write_off",
      approved_by: financeId,
    });
    // Even "reverse" is only a decision record: the case is not changed here.
    expect((await caseStatus(s.caseId)).status).toBe("resolved");
  });

  it("EDC-06 late funds: a rejected request returns the correction to open and it can be asked again", async () => {
    const s = await writeOffThenLate();
    const correction = await oneCorrection(s.caseId);
    const asked = await resolveCorrection(requester, correction.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const request = await pendingRequest(CORRECTION_OBJECT, correction.id);

    await decide(approverId, request.id, "rejected");
    const events = await runWorker(request.chain_id);

    expect(await oneCorrection(s.caseId)).toMatchObject({
      status: "open",
      decision: null,
      approval_chain_id: null,
      approved_by: null,
      resolved_at: null,
    });
    expect((await caseStatus(s.caseId)).status).toBe("resolved");
    // replay is a no-op
    for (const event of events)
      await handleReconciliationApprovalResolved(tenantWide, event, new Date());
    expect((await oneCorrection(s.caseId)).status).toBe("open");
    // one row for life, and it can be asked again
    const again = await resolveCorrection(requester, correction.id);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.status).toBe("pending_approval");
    expect(await correctionsOfCase(s.caseId)).toHaveLength(1);
  });

  it("EDC-06 late funds: without an approval policy the resolution fails closed with 409 and files no request", async () => {
    const s = await writeOffThenLate();
    const correction = await oneCorrection(s.caseId);
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'reconciliation_case'",
      [tenantId],
    );
    try {
      const response = await resolveCorrection(requester, correction.id);
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(await oneCorrection(s.caseId)).toMatchObject({
        status: "open",
        approval_chain_id: null,
        decision: null,
      });
      expect(await requestsOf(CORRECTION_OBJECT, correction.id)).toHaveLength(
        0,
      );
    } finally {
      await installPolicy();
    }
  });

  it("EDC-06 late funds: a decision and a note are required", async () => {
    const s = await writeOffThenLate();
    const correction = await oneCorrection(s.caseId);
    const noNote = await requester
      .post(`${ADMIN}/corrections/${correction.id}/resolve`)
      .set(originHeader)
      .set("Idempotency-Key", `cor-${randomUUID()}`)
      .send({ decision: "keep_write_off" });
    expect(noNote.status).toBe(422);
    const badDecision = await requester
      .post(`${ADMIN}/corrections/${correction.id}/resolve`)
      .set(originHeader)
      .set("Idempotency-Key", `cor-${randomUUID()}`)
      .send({ decision: "delete_it", note: "x" });
    expect(badDecision.status).toBe(422);
    expect((await oneCorrection(s.caseId)).status).toBe("open");
    expect(await requestsOf(CORRECTION_OBJECT, correction.id)).toHaveLength(0);
  });
});

describe("EDC-06 legend-oan3p only a written-off case is flagged", () => {
  it("EDC-06 late funds: an open missing case becomes matched by the later report and gets no correction", async () => {
    const s = await missingSetup();
    const late = await lateReport(s);
    expectOk(late);
    expect((await caseStatus(s.caseId)).status).toBe("matched");
    expect(await correctionsOfCase(s.caseId)).toHaveLength(0);
    expect((await listedCase(requester, s.caseId)).lateFunds).toBeNull();
  });

  it("EDC-06 late funds: a case waiting for approval becomes matched and gets no correction", async () => {
    const s = await missingSetup();
    const asked = await resolveCase(s.caseId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const late = await lateReport(s);
    expectOk(late);
    expect((await caseStatus(s.caseId)).status).toBe("matched");
    expect(await correctionsOfCase(s.caseId)).toHaveLength(0);
  });

  it("EDC-06 late funds: a later report that does not carry the written-off sale flags nothing", async () => {
    const s = await writeOffSetup();
    const other = await post(
      requester,
      gatewayBody({
        day: s.day,
        reference: `GW-${s.tag}-OTHER`,
        lines: [
          { reference: `PR-${s.tag}-UNKNOWN`, amountIdr: 30000, feeIdr: 210 },
        ],
      }),
    );
    expectOk(other);
    expect(await correctionsOfCase(s.caseId)).toHaveLength(0);
    expect((await caseStatus(s.caseId)).status).toBe("resolved");
    expect((await listedCase(requester, s.caseId)).lateFunds).toBeNull();
  });
});

// ------------------------------------------------- D2: mismatch link and race

async function mismatchCaseIdOf(correctionId: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query<{ mismatch_case_id: string | null }>(
      `SELECT mismatch_case_id FROM payment_reconciliation_corrections WHERE tenant_id = $1 AND id = $2`,
      [tenantId, correctionId],
    ),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.mismatch_case_id;
}

describe("EDC-06 legend-oan3p a late line with a different amount links its mismatch case", () => {
  it("EDC-06 late funds: written off 50000, 48000 arrives -> one correction (received 48000) linked to the new mismatch case; the case view shows the same link", async () => {
    const s = await writeOffSetup();
    const late = await post(
      requester,
      gatewayBody({
        day: s.day,
        reference: `GW-${s.tag}-SHORT`,
        lines: [{ reference: s.pz, amountIdr: 48000, feeIdr: 0 }],
      }),
    );
    expectOk(late);

    // The import opens a mismatch case for the line (assumption: it is the only
    // case of this sale that carries a settlement line; the write-off has none).
    const cases = await casesByReference(s.pz);
    const mismatch = cases.filter((c) => c.settlement_line_id !== null);
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.id).not.toBe(s.caseId);
    const mismatchId = mismatch[0]!.id;
    expect((await caseStatus(s.caseId)).status).toBe("resolved");

    const correction = await oneCorrection(s.caseId);
    expect(Number(correction.written_off_idr)).toBe(50000);
    expect(Number(correction.received_idr)).toBe(48000);
    expect(await mismatchCaseIdOf(correction.id)).toBe(mismatchId);

    const view = await listedCase(requester, s.caseId);
    expect(view.lateFunds).toMatchObject({
      correctionId: correction.id,
      receivedIdr: 48000,
      mismatchCaseId: mismatchId,
    });
    const listed = await listCorrections(requester);
    expect(listed.find((c) => c.id === correction.id)).toMatchObject({
      receivedIdr: 48000,
      mismatchCaseId: mismatchId,
    });

    // replaying the import never moves the link nor adds a second correction
    const again = await post(
      requester,
      gatewayBody({
        day: s.day,
        reference: `GW-${s.tag}-SHORT`,
        lines: [{ reference: s.pz, amountIdr: 48000, feeIdr: 0 }],
      }),
    );
    expect([200, 201, 409]).toContain(again.status);
    expect(await correctionsOfCase(s.caseId)).toHaveLength(1);
    expect(await mismatchCaseIdOf(correction.id)).toBe(mismatchId);
  });

  it("EDC-06 late funds: an exact-amount late line has no mismatch case, so mismatchCaseId is null everywhere", async () => {
    const s = await writeOffThenLate();
    const correction = await oneCorrection(s.caseId);
    expect(await mismatchCaseIdOf(correction.id)).toBeNull();
    expect(
      (await casesByReference(s.pz)).filter((c) => c.settlement_line_id),
    ).toHaveLength(0);
    expect((await listedCase(requester, s.caseId)).lateFunds).toMatchObject({
      correctionId: correction.id,
      mismatchCaseId: null,
    });
    const listed = await listCorrections(requester);
    expect(listed.find((c) => c.id === correction.id)).toMatchObject({
      mismatchCaseId: null,
    });
  });
});

describe("EDC-06 legend-oan3p the import and the write-off settle can overlap", () => {
  it("EDC-06 late funds: the import runs while the settle holds the case row lock; once the settle commits there is exactly one correction and the case is resolved", async () => {
    // Case asked, chain fully approved, but the worker has not settled it yet.
    const s = await missingSetup();
    const asked = await resolveCase(s.caseId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const request = await pendingRequest(CASE_OBJECT, s.caseId);
    await decide(approverId, request.id, "approved");
    expect((await caseStatus(s.caseId)).status).not.toBe("resolved");

    // Connection 2 plays the settle: it takes the case row lock first.
    const settle = await owner.connect();
    let committed = false;
    try {
      await settle.query("BEGIN");
      await settle.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      const { rows: pidRows } = await settle.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      await settle.query(
        "SELECT id FROM payment_reconciliation_cases WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantId, s.caseId],
      );

      // Connection 1: the late import starts while the lock is held.
      let importDone = false;
      const importing = lateReport(s).then((r) => {
        importDone = true;
        return r;
      });

      // Wait until the import is queued behind our lock (or has finished
      // without needing it); bounded, never a fixed sleep.
      const deadline = Date.now() + 20_000;
      for (;;) {
        if (importDone || Date.now() > deadline) break;
        const { rows } = await owner.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
          [pidRows[0]!.pid],
        );
        if (Number(rows[0]!.n) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // The settle completes: the write-off lands, then the lock is released.
      await settle.query(
        "UPDATE payment_reconciliation_cases SET status = 'resolved', approved_by = $3 WHERE tenant_id = $1 AND id = $2",
        [tenantId, s.caseId, approverId],
      );
      await settle.query("COMMIT");
      committed = true;

      const late = await importing;
      expectOk(late);
    } finally {
      if (!committed) await settle.query("ROLLBACK").catch(() => undefined);
      settle.release();
    }

    // No lost write-off, no lost correction, no duplicate.
    expect((await caseStatus(s.caseId)).status).toBe("resolved");
    const rows = await correctionsOfCase(s.caseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "open" });
    expect(Number(rows[0]!.received_idr)).toBe(50000);
    expect(await auditCount(OPENED_AUDIT, rows[0]!.id)).toBe(1);

    // The worker replaying the approval afterwards changes nothing.
    await runWorker(request.chain_id);
    expect((await caseStatus(s.caseId)).status).toBe("resolved");
    expect(await correctionsOfCase(s.caseId)).toHaveLength(1);
  });
});

// ------------------------- E2 (legend-kbf9v): linked mismatch case is blocked
// Assumption: the 409 error body carries `error.code`
// "LATE_FUNDS_CORRECTION_PENDING" (same envelope as SETTLEMENT_CONFLICT).
// Assumption: a rejected correction returns to `open`, so the block is back.

const BLOCKED = "LATE_FUNDS_CORRECTION_PENDING";

/** Written off 50000, then 48000 arrives: a correction linked to a new mismatch case. */
async function writeOffThenShortLate() {
  const s = await writeOffSetup();
  const late = await post(
    requester,
    gatewayBody({
      day: s.day,
      reference: `GW-${s.tag}-SHORT`,
      lines: [{ reference: s.pz, amountIdr: 48000, feeIdr: 0 }],
    }),
  );
  expectOk(late);
  const mismatch = (await casesByReference(s.pz)).filter(
    (c) => c.settlement_line_id !== null,
  );
  expect(mismatch).toHaveLength(1);
  const correction = await oneCorrection(s.caseId);
  expect(await mismatchCaseIdOf(correction.id)).toBe(mismatch[0]!.id);
  return { ...s, mismatchId: mismatch[0]!.id, correctionId: correction.id };
}

async function expectBlocked(mismatchId: string) {
  const response = await resolveCase(mismatchId);
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body.error.code).toBe(BLOCKED);
  // nothing was started: the case stays open and no approval request exists
  expect((await caseStatus(mismatchId)).status).toBe("open");
  expect(await requestsOf(CASE_OBJECT, mismatchId)).toHaveLength(0);
}

describe("EDC-06 legend-kbf9v a mismatch case linked to an undecided correction cannot be resolved yet", () => {
  it("EDC-06 late funds: 409 LATE_FUNDS_CORRECTION_PENDING while the correction is open and while it is pending approval", async () => {
    const s = await writeOffThenShortLate();
    await expectBlocked(s.mismatchId); // correction open

    const asked = await resolveCorrection(requester, s.correctionId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect((await oneCorrection(s.caseId)).status).toBe("pending_approval");
    await expectBlocked(s.mismatchId); // correction pending_approval
  });

  it("EDC-06 late funds: once the correction is approved and resolved, the mismatch case can be resolved (pending approval)", async () => {
    const s = await writeOffThenShortLate();
    await expectBlocked(s.mismatchId);

    const asked = await resolveCorrection(requester, s.correctionId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const request = await pendingRequest(CORRECTION_OBJECT, s.correctionId);
    await decide(approverId, request.id, "approved");
    await runWorker(request.chain_id);
    expect((await oneCorrection(s.caseId)).status).toBe("resolved");

    const resolved = await resolveCase(s.mismatchId);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.data).toMatchObject({
      id: s.mismatchId,
      status: "pending_approval",
    });
    expect(await requestsOf(CASE_OBJECT, s.mismatchId)).toHaveLength(1);
  });

  it("EDC-06 late funds: a blocked 409 is not stored under the idempotency key, so the same key succeeds once the correction is resolved", async () => {
    // Assumption: a failed (409) attempt must not poison its Idempotency-Key.
    const s = await writeOffThenShortLate();
    const key = `res-${randomUUID()}`;

    const blocked = await resolveCase(s.mismatchId, key);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(blocked.body.error.code).toBe(BLOCKED);

    const asked = await resolveCorrection(requester, s.correctionId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const request = await pendingRequest(CORRECTION_OBJECT, s.correctionId);
    await decide(approverId, request.id, "approved");
    await runWorker(request.chain_id);
    expect((await oneCorrection(s.caseId)).status).toBe("resolved");

    const resolved = await resolveCase(s.mismatchId, key); // SAME key
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.data).toMatchObject({
      id: s.mismatchId,
      status: "pending_approval",
    });
    expect(await requestsOf(CASE_OBJECT, s.mismatchId)).toHaveLength(1);
  });

  it("EDC-06 late funds: when the correction is rejected it is open again and the mismatch case is blocked again", async () => {
    const s = await writeOffThenShortLate();
    const asked = await resolveCorrection(requester, s.correctionId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const request = await pendingRequest(CORRECTION_OBJECT, s.correctionId);
    await decide(approverId, request.id, "rejected");
    await runWorker(request.chain_id);
    expect((await oneCorrection(s.caseId)).status).toBe("open");

    await expectBlocked(s.mismatchId);
  });

  it("EDC-06 late funds: a mismatch case of another sale, linked to no correction, is not affected", async () => {
    // Make sure a correction with a linked mismatch case exists in the tenant too.
    await writeOffThenShortLate();

    const day = nextDay();
    const tag = uid();
    const ref = `PR-${tag}-M`;
    await seedIntent({ providerRef: ref, amountIdr: 50000, day });
    const imported = await post(
      requester,
      gatewayBody({
        day,
        reference: `GW-${tag}-M`,
        lines: [{ reference: ref, amountIdr: 48000, feeIdr: 0 }],
      }),
    );
    expectOk(imported);
    const [plain] = (await casesByReference(ref)).filter(
      (c) => c.settlement_line_id !== null,
    );
    expect(plain).toMatchObject({ status: "open" });

    const response = await resolveCase(plain!.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe("pending_approval");
  });
});
