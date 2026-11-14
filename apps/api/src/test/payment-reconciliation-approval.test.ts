// Settlement reconciliation cases (EDC-06) close only through an approval
// chain decided by someone other than the requester (brief
// docs/briefs/sub-payment-approvals.md, sections D and E; legend-hcqs).
// Runs the real Express app, Better Auth, the real approval service and the
// real `approval.resolved` consumer on PostgreSQL (RLS on). Written from the
// brief's contract (section E) and packages/shared, not from the service code.
//
// Assumptions where the contract is not exact:
// - The approving chain is fixture-built like the product default (founder
//   W8 Q10/Q12): `reconciliation_case`, one level, two policy rows (Owner and
//   Finance, either one is enough), distinct actor. The usual requester and
//   approver are two Owners; Finance is tested as approver and as requester.
// - The approver decides through the approval inbox service
//   (`decideApprovalRequest`), then the worker consumer applies the outcome
//   from the `approval.resolved` outbox event; the decision alone never
//   closes the case.
// - DTO `approvalRequestId` equals the DB `approval_chain_id`; DTO
//   `requestedBy`/`approvedBy` are user ids (contract E5: string | null).
// - A missing `reconciliation_case` policy is an error (>= 400) and leaves
//   the case open without any approval request (contract E3).
// - The older test "EDC-06 resolves a settlement difference only with a
//   note" in payment-admin-api.test.ts expects an immediate `resolved`; it
//   contradicts this contract and must be updated by the engineer.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { paymentTestScope } from "./payment-test-scope";

const scope = paymentTestScope();
const app = createApp();
const tenantId = scope.tenantId;
const outletA = scope.outletId;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const tenantContext = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);
const ADMIN = "/api/payments/admin/reconciliation";

type Client = ReturnType<typeof agent>;
let requester: Client; // Owner who asks to close cases
let requesterId: string;
let approverId: string; // another Owner: may decide
let finance: Client; // Finance: in the policy, may ask and may decide
let financeId: string;
let financeApproverId: string; // another Finance: may decide a Finance request
let nonApprover: Client; // Cashier: not in the policy
let nonApproverId: string;

const userIds: string[] = [];
const caseIds: string[] = [];

const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherLegal = randomUUID();
const otherOutlet = randomUUID();
const otherCase = randomUUID();

const key = (prefix = "case") => `${prefix}-${randomUUID()}`;

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function signedIn(
  templateKey: "owner" | "finance" | "cashier",
  label: string,
) {
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

async function installPolicy() {
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'reconciliation_case'",
    [tenantId],
  );
  // Default matrix: level 1, Owner or Finance, from Rp0, distinct actor.
  for (const templateKey of ["owner", "finance"])
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, 'reconciliation_case', NULL, $2, 1, true)`,
      [tenantId, await roleIdOf(templateKey)],
    );
}

/** An open case: 10.000 less arrived than the settlement booked. */
async function seedCase(varianceIdr = -10_000) {
  const caseId = randomUUID();
  caseIds.push(caseId);
  await owner.query(
    `INSERT INTO payment_reconciliation_cases (id, tenant_id, outlet_id, settlement_id, source, provider, reference, period_start, period_end, expected_idr, received_idr, variance_idr, reason)
     VALUES ($1, $2, $3, $4, 'edc', 'edc_bca', $5, '2026-10-01', '2026-10-01', 100000, $6, $7, 'Settlement mismatch')`,
    [
      caseId,
      tenantId,
      outletA,
      randomUUID(),
      `Batch ${caseId.slice(0, 8)}`,
      100_000 + varianceIdr,
      varianceIdr,
    ],
  );
  return caseId;
}

const resolveCase = (
  client: Client,
  caseId: string,
  note = "Biaya bank sudah diperiksa",
) =>
  client
    .post(`${ADMIN}/cases/${caseId}/resolve`)
    .set(originHeader)
    .set("Idempotency-Key", key())
    .send({ note });

async function caseRow(caseId: string) {
  const { rows } = await owner.query<{
    status: string;
    approval_chain_id: string | null;
    requested_by: string | null;
    approved_by: string | null;
    resolved_by: string | null;
    resolved_at: Date | null;
    note: string | null;
  }>(
    `SELECT status, approval_chain_id, requested_by, approved_by, resolved_by, resolved_at, note
     FROM payment_reconciliation_cases WHERE id = $1`,
    [caseId],
  );
  if (!rows[0]) throw new Error("case row missing");
  return rows[0];
}

async function requestsOfCase(caseId: string) {
  const { rows } = await owner.query<{
    id: string;
    chain_id: string;
    status: string;
    requested_by: string;
  }>(
    `SELECT id, chain_id, status, requested_by FROM approval_requests
     WHERE tenant_id = $1 AND object_type = 'payment_reconciliation_case' AND object_id = $2
     ORDER BY created_at`,
    [tenantId, caseId],
  );
  return rows;
}

async function listedCase(client: Client, caseId: string) {
  const listed = await client.get(
    `${ADMIN}/cases?outletId=${outletA}&limit=100`,
  );
  expect(listed.status).toBe(200);
  return listed.body.data.find((c: { id: string }) => c.id === caseId);
}

/** Resolve a case as the requester and return its single pending request. */
async function requestClose(caseId: string) {
  const response = await resolveCase(requester, caseId);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const requests = await requestsOfCase(caseId);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.status).toBe("pending");
  return { response, request: requests[0]! };
}

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

const inboxDecide = (
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

async function countOutboxEvents(name: string) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = $2`,
    [tenantId, name],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  await scope.seed(owner);
  ({ client: requester, userId: requesterId } = await signedIn(
    "owner",
    "Recon requester",
  ));
  ({ userId: approverId } = await signedIn("owner", "Recon approver"));
  ({ client: finance, userId: financeId } = await signedIn(
    "finance",
    "Recon finance",
  ));
  ({ userId: financeApproverId } = await signedIn(
    "finance",
    "Recon finance approver",
  ));
  ({ client: nonApprover, userId: nonApproverId } = await signedIn(
    "cashier",
    "Recon cashier",
  ));
  await installPolicy();

  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Other tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      otherTenant,
      `other-${otherTenant}`,
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
  await owner.query(
    `INSERT INTO payment_reconciliation_cases (id, tenant_id, outlet_id, settlement_id, source, provider, reference, period_start, period_end, expected_idr, received_idr, variance_idr, reason)
     VALUES ($1, $2, $3, $4, 'edc', 'edc_bca', 'Other batch', '2026-10-01', '2026-10-01', 100000, 90000, -10000, 'Settlement mismatch')`,
    [otherCase, otherTenant, otherOutlet, randomUUID()],
  );
});

afterAll(async () => {
  const all = [...caseIds, otherCase];
  await owner.query(
    "DELETE FROM approval_requests WHERE object_type = 'payment_reconciliation_case' AND object_id = ANY($1::text[])",
    [all],
  );
  await owner.query(
    "DELETE FROM payment_reconciliation_cases WHERE id = ANY($1::uuid[])",
    [all],
  );
  await owner.query("DELETE FROM outlets WHERE id = $1", [otherOutlet]);
  await owner.query("DELETE FROM legal_entities WHERE id = $1", [otherLegal]);
  await owner.query("DELETE FROM brands WHERE id = $1", [otherBrand]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.query(
    "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])",
    [tenantId, userIds],
  );
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'reconciliation_case'",
    [tenantId],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, userIds],
  );
  await owner.end();
});

describe("EDC-06 reconciliation case: request to close", () => {
  it("EDC-06 resolving a case files a pending approval and does not close it", async () => {
    const caseId = await seedCase(-10_000);
    const outboxBefore = await countOutboxEvents(
      "reconciliation_case.resolved",
    );
    const { response, request } = await requestClose(caseId);

    expect(response.body.data).toMatchObject({
      id: caseId,
      status: "pending_approval",
      varianceIdr: -10_000,
      approvalRequestId: request.chain_id,
      requestedBy: requesterId,
      approvedBy: null,
      resolvedAt: null,
    });
    expect(await caseRow(caseId)).toMatchObject({
      status: "pending_approval",
      approval_chain_id: request.chain_id,
      requested_by: requesterId,
      approved_by: null,
      resolved_at: null,
      note: "Biaya bank sudah diperiksa",
    });
    expect(request.requested_by).toBe(requesterId);
    // The variance is not written off before someone else agrees.
    expect(await countOutboxEvents("reconciliation_case.resolved")).toBe(
      outboxBefore,
    );
    const listed = await listedCase(requester, caseId);
    expect(listed).toMatchObject({ status: "pending_approval" });
  });

  it("EDC-06 a second resolve while the approval is pending answers 409", async () => {
    const caseId = await seedCase();
    await requestClose(caseId);
    const byRequester = await resolveCase(requester, caseId, "Dobel");
    expect(byRequester.status).toBe(409);
    expect(await requestsOfCase(caseId)).toHaveLength(1);
    expect((await caseRow(caseId)).status).toBe("pending_approval");
  });

  it("EDC-06 an already resolved case cannot be resolved again", async () => {
    const caseId = await seedCase();
    await owner.query(
      `UPDATE payment_reconciliation_cases SET status = 'resolved', resolved_at = now() WHERE id = $1`,
      [caseId],
    );
    const response = await resolveCase(requester, caseId);
    expect(response.status).toBe(409);
    expect(await requestsOfCase(caseId)).toHaveLength(0);
  });

  it("EDC-06 a note and a session are required", async () => {
    const caseId = await seedCase();
    const noNote = await resolveCase(requester, caseId, "");
    expect(noNote.status).toBe(422);
    const anonymous = await agent(app)
      .set("Host", scope.hostname)
      .post(`${ADMIN}/cases/${caseId}/resolve`)
      .set(originHeader)
      .set("Idempotency-Key", key())
      .send({ note: "Tanpa sesi" });
    expect(anonymous.status).toBe(401);
    expect((await caseRow(caseId)).status).toBe("open");
    expect(await requestsOfCase(caseId)).toHaveLength(0);
  });

  it("EDC-06 without an approval policy the case stays open and no request exists", async () => {
    const caseId = await seedCase();
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'reconciliation_case'",
      [tenantId],
    );
    try {
      const response = await resolveCase(requester, caseId);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).not.toBe(422);
      expect((await caseRow(caseId)).status).toBe("open");
      expect(await requestsOfCase(caseId)).toHaveLength(0);
    } finally {
      await installPolicy();
    }
  });
});

describe("EDC-06 reconciliation case: approval decides", () => {
  it("EDC-06 the requester cannot approve their own request; the case stays pending", async () => {
    const caseId = await seedCase();
    const { request } = await requestClose(caseId);
    await expect(
      inboxDecide(requesterId, request.id, "approved"),
    ).rejects.toMatchObject({ code: "APPROVER_IS_REQUESTER", status: 403 });
    expect((await requestsOfCase(caseId))[0]!.status).toBe("pending");
    expect((await caseRow(caseId)).status).toBe("pending_approval");
  });

  it("EDC-06 a user outside the approval policy (cashier) cannot decide", async () => {
    const caseId = await seedCase();
    const { request } = await requestClose(caseId);
    await expect(
      inboxDecide(nonApproverId, request.id, "approved"),
    ).rejects.toThrow();
    expect((await requestsOfCase(caseId))[0]!.status).toBe("pending");
    expect((await caseRow(caseId)).status).toBe("pending_approval");
    // The non-approver cannot close it through the case route either.
    const direct = await resolveCase(nonApprover, caseId, "Tutup paksa");
    expect([403, 409]).toContain(direct.status);
    expect((await caseRow(caseId)).status).toBe("pending_approval");
  });

  it("EDC-06 a Finance user can approve a request filed by an Owner and the case closes once", async () => {
    const caseId = await seedCase(-10_000);
    const { request } = await requestClose(caseId);
    const outboxBefore = await countOutboxEvents(
      "reconciliation_case.resolved",
    );

    await inboxDecide(financeId, request.id, "approved");
    const event = await resolvedEventOfChain(request.chain_id);
    await handleReconciliationApprovalResolved(tenantWide, event, new Date());

    expect(await caseRow(caseId)).toMatchObject({
      status: "resolved",
      requested_by: requesterId,
      approved_by: financeId,
      approval_chain_id: request.chain_id,
    });
    expect(await countOutboxEvents("reconciliation_case.resolved")).toBe(
      outboxBefore + 1,
    );
    expect(await listedCase(requester, caseId)).toMatchObject({
      status: "resolved",
      approvedBy: financeId,
    });
  });

  it("EDC-06 a Finance user can file the request and an Owner can approve it", async () => {
    const caseId = await seedCase();
    const response = await resolveCase(finance, caseId, "Dicek oleh finance");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "pending_approval",
      requestedBy: financeId,
    });
    const request = (await requestsOfCase(caseId))[0]!;
    await inboxDecide(approverId, request.id, "approved");
    const event = await resolvedEventOfChain(request.chain_id);
    await handleReconciliationApprovalResolved(tenantWide, event, new Date());
    expect(await caseRow(caseId)).toMatchObject({
      status: "resolved",
      requested_by: financeId,
      approved_by: approverId,
    });
  });

  it("EDC-06 a Finance requester cannot approve their own request, but another Finance can", async () => {
    const caseId = await seedCase();
    const response = await resolveCase(finance, caseId, "Dicek oleh finance");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const request = (await requestsOfCase(caseId))[0]!;
    await expect(
      inboxDecide(financeId, request.id, "approved"),
    ).rejects.toMatchObject({ code: "APPROVER_IS_REQUESTER", status: 403 });
    expect((await requestsOfCase(caseId))[0]!.status).toBe("pending");
    expect((await caseRow(caseId)).status).toBe("pending_approval");

    await inboxDecide(financeApproverId, request.id, "approved");
    const event = await resolvedEventOfChain(request.chain_id);
    await handleReconciliationApprovalResolved(tenantWide, event, new Date());
    expect(await caseRow(caseId)).toMatchObject({
      status: "resolved",
      approved_by: financeApproverId,
    });
  });

  it("EDC-06 approval by another person closes the case once and records who asked and who approved", async () => {
    const caseId = await seedCase(-10_000);
    const { request } = await requestClose(caseId);
    const outboxBefore = await countOutboxEvents(
      "reconciliation_case.resolved",
    );

    await inboxDecide(approverId, request.id, "approved");
    // The decision alone does not touch the case; the consumer applies it.
    expect((await caseRow(caseId)).status).toBe("pending_approval");

    const event = await resolvedEventOfChain(request.chain_id);
    await handleReconciliationApprovalResolved(tenantWide, event, new Date());

    const settled = await caseRow(caseId);
    expect(settled).toMatchObject({
      status: "resolved",
      resolved_by: requesterId,
      requested_by: requesterId,
      approved_by: approverId,
      approval_chain_id: request.chain_id,
    });
    expect(settled.resolved_at).not.toBeNull();
    expect(await countOutboxEvents("reconciliation_case.resolved")).toBe(
      outboxBefore + 1,
    );
    const listed = await listedCase(requester, caseId);
    expect(listed).toMatchObject({
      status: "resolved",
      approvalRequestId: request.chain_id,
      requestedBy: requesterId,
      approvedBy: approverId,
    });
    expect(listed.resolvedAt).not.toBeNull();

    // A replayed event neither changes the case nor emits a second event.
    await handleReconciliationApprovalResolved(tenantWide, event, new Date());
    expect(await caseRow(caseId)).toMatchObject({
      status: "resolved",
      approved_by: approverId,
    });
    expect(await countOutboxEvents("reconciliation_case.resolved")).toBe(
      outboxBefore + 1,
    );
    // And it cannot be asked for again.
    expect((await resolveCase(requester, caseId)).status).toBe(409);
    expect(await requestsOfCase(caseId)).toHaveLength(1);
  });

  it("EDC-06 a rejected request leaves the case open and it can be asked again", async () => {
    const caseId = await seedCase();
    const { request } = await requestClose(caseId);
    await inboxDecide(approverId, request.id, "rejected");
    const event = await resolvedEventOfChain(request.chain_id);
    await handleReconciliationApprovalResolved(tenantWide, event, new Date());

    expect(await caseRow(caseId)).toMatchObject({
      status: "open",
      approval_chain_id: null,
      approved_by: null,
      resolved_at: null,
    });
    expect((await listedCase(requester, caseId)).status).toBe("open");
    // Replay is a no-op.
    await handleReconciliationApprovalResolved(tenantWide, event, new Date());
    expect((await caseRow(caseId)).status).toBe("open");

    // A fresh request is allowed after a rejection (the case is open again).
    const second = await resolveCase(requester, caseId, "Bukti tambahan");
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data.status).toBe("pending_approval");
  });

  it("EDC-06 an expired request leaves the case open and cannot be approved later", async () => {
    const caseId = await seedCase();
    const { request } = await requestClose(caseId);
    await owner.query(
      `UPDATE approval_requests
       SET created_at = now() - interval '2 hours', deadline_at = now() - interval '1 minute'
       WHERE tenant_id = $1 AND chain_id = $2`,
      [tenantId, request.chain_id],
    );
    await expireDueApprovalRequests(tenantWide);

    await expect(
      inboxDecide(approverId, request.id, "approved"),
    ).rejects.toThrow();
    const event = await resolvedEventOfChain(request.chain_id);
    await handleReconciliationApprovalResolved(tenantWide, event, new Date());
    expect(await caseRow(caseId)).toMatchObject({
      status: "open",
      approval_chain_id: null,
      approved_by: null,
      resolved_at: null,
    });
    expect((await listedCase(requester, caseId)).status).toBe("open");
  });

  it("EDC-06 an approval event from another tenant's worker scope does not close the case", async () => {
    const caseId = await seedCase();
    const { request } = await requestClose(caseId);
    // The event is not authority: a different tenant's scope must not apply it.
    await inboxDecide(approverId, request.id, "approved");
    const event = await resolvedEventOfChain(request.chain_id);
    const foreign = establishScopedTenantContext(
      establishTenantContext({
        tenantId: otherTenant,
        brandId: null,
        source: "job",
      }),
      { kind: "tenant" },
    );
    await handleReconciliationApprovalResolved(foreign, event, new Date());
    expect((await caseRow(caseId)).status).toBe("pending_approval");
    expect((await caseRow(caseId)).approved_by).toBeNull();
  });
});

describe("EDC-06 reconciliation summary", () => {
  it("EDC-06 the summary still counts a case waiting for approval as open", async () => {
    const summaryOf = async () => {
      const response = await requester.get(
        `${ADMIN}/summary?outletId=${outletA}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data as { openCases: number; varianceIdr: number };
    };
    const before = await summaryOf();
    const caseId = await seedCase(-10_000);
    const open = await summaryOf();
    expect(open.openCases).toBe(before.openCases + 1);
    expect(open.varianceIdr).toBe(before.varianceIdr - 10_000);

    await requestClose(caseId);
    // Asking to close is not closing: the variance is not written off yet.
    const pending = await summaryOf();
    expect(pending.openCases).toBe(open.openCases);
    expect(pending.varianceIdr).toBe(open.varianceIdr);
  });
});

describe("EDC-06 reconciliation case closed automatically (legend-hbifd)", () => {
  // The import closes a missing case as `matched` when a later report settles
  // its sale (covered end to end in payment-settlement-import.test.ts). Here
  // the case is put in that state directly: what the admin API shows and does
  // with a `matched` case.
  async function matchedCase() {
    const caseId = await seedCase(-10_000);
    await owner.query(
      "UPDATE payment_reconciliation_cases SET status = 'matched' WHERE id = $1",
      [caseId],
    );
    return caseId;
  }

  it("EDC-06 a matched case cannot be closed by hand: 409 and no approval request", async () => {
    const caseId = await matchedCase();
    const response = await resolveCase(requester, caseId);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(JSON.stringify(response.body)).toContain(
      "Reconciliation case was closed automatically: its sale was matched in a settlement report.",
    );
    expect(await requestsOfCase(caseId)).toHaveLength(0);
    expect((await caseRow(caseId)).status).toBe("matched");
  });

  it("EDC-06 the case list shows a matched case and can filter by status matched", async () => {
    const caseId = await matchedCase();
    const openId = await seedCase(-5_000);
    const filtered = await requester.get(
      `${ADMIN}/cases?outletId=${outletA}&status=matched&limit=100`,
    );
    expect(filtered.status, JSON.stringify(filtered.body)).toBe(200);
    const ids = filtered.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(caseId);
    expect(ids).not.toContain(openId);
    expect(
      filtered.body.data.every(
        (c: { status: string }) => c.status === "matched",
      ),
    ).toBe(true);
    expect((await listedCase(requester, caseId)).status).toBe("matched");
    // The open filter does not return it.
    const open = await requester.get(
      `${ADMIN}/cases?outletId=${outletA}&status=open&limit=100`,
    );
    expect(open.status).toBe(200);
    expect(open.body.data.map((c: { id: string }) => c.id)).not.toContain(
      caseId,
    );
  });

  it("EDC-06 the summary does not count a matched case as open or as variance", async () => {
    const summaryOf = async () => {
      const response = await requester.get(
        `${ADMIN}/summary?outletId=${outletA}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data as { openCases: number; varianceIdr: number };
    };
    const before = await summaryOf();
    await matchedCase();
    const after = await summaryOf();
    expect(after.openCases).toBe(before.openCases);
    expect(after.varianceIdr).toBe(before.varianceIdr);
  });
});

describe("TEN-02 reconciliation tenant isolation", () => {
  it("TEN-02 another tenant's case cannot be resolved or seen", async () => {
    const response = await resolveCase(requester, otherCase);
    expect(response.status).toBe(404);
    const listed = await requester.get(`${ADMIN}/cases?limit=100`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((c: { id: string }) => c.id)).not.toContain(
      otherCase,
    );
    expect(await caseRow(otherCase)).toMatchObject({
      status: "open",
      approval_chain_id: null,
    });
    expect(
      (
        await owner.query(
          "SELECT 1 FROM approval_requests WHERE object_id = $1",
          [otherCase],
        )
      ).rows,
    ).toHaveLength(0);
  });
});
