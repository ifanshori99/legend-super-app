// approval.resolved consumer for phone-approved POS overrides (bead
// legend-obh5, from legend-dxb; PRD v1.7 §3 F6 "Override Supervisor", §3 F7
// "Kotak Approval", AUTH-06, TEN-01/TEN-03). Runs the real services on the
// disposable PostgreSQL (RLS on).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  createPosOverrideSchema,
  posOverrideRecordedEvent,
  type PosOverrideView,
} from "@starter/shared/access/override";
import {
  createUlid,
  ulidToUuid,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { approvalResolvedEvent } from "@starter/shared/identity";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { setStaffPin } from "../services/device-pin.service.ts";
import { setAuditWriter, type AuditEntry } from "../services/audit-writer.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import { handleApprovalResolved } from "../services/staff-override-consumers.ts";
import {
  createPosOverride,
  getPosOverride,
} from "../services/staff-override.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const bandung2 = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const audits: AuditEntry[] = [];
const createdUserIds: string[] = [];
// Cashiers that own a shift row: a shift is history (POS-03, no delete), so
// these users stay behind, like in the pos-shift suites.
const shiftUserIds: string[] = [];
const PIN = "582914";
const ACTIONS = ["void", "cash_shift_close"];
let savedPolicies: Record<string, unknown>[] = [];

const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
/** What the worker hands a consumer: tenant-wide scope minted from the job. */
const workerContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function createUser(
  templateKey: string,
  outletId = bandung,
  bucket: string[] = createdUserIds,
) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, `Staf ${templateKey}`, `${id}@example.test`],
  );
  bucket.push(id);
  // Backdated: the container clock may drift from the Node clock.
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, id, await roleIdOf(templateKey), outletId],
  );
  return id;
}

async function phoneOverride(cashier: string): Promise<PosOverrideView> {
  const { override } = await createPosOverride(
    tenant,
    cashier,
    createPosOverrideSchema.parse({
      outletId: bandung,
      action: "void",
      valueIdr: 45_000,
      reason: "Tamu membatalkan menu sebelum dimasak.",
      objectType: "order",
      objectId: randomUUID(),
      approval: { method: "supervisor_phone" },
    }),
    { idempotencyKey: null },
  );
  return override;
}

async function overrideRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    approved_by: string | null;
    requested_by: string;
    resolved_at: Date | null;
  }>(
    "SELECT status, approved_by, requested_by, resolved_at FROM pos_overrides WHERE id = $1",
    [ulidToUuid(id)],
  );
  return rows[0];
}

async function recordedEvents(overrideId: string) {
  const { rows } = await owner.query<{ name: string }>(
    `SELECT event->>'name' AS name FROM domain_event_outbox
     WHERE tenant_id = $1 AND aggregate_type = 'pos_override' AND aggregate_id = $2`,
    [tenantId, ulidToUuid(overrideId)],
  );
  return rows;
}

/** The real approval.resolved envelope the approval service appended. */
async function resolvedEventOf(chainId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND destination = 'cloud-sync'
       AND event->>'name' = 'approval.resolved'
       AND event->'payload'->>'chainId' = $2`,
    [tenantId, chainId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]?.event);
}

/** A well-formed approval.resolved the database never produced. */
function forgedResolved(input: {
  chainId: string;
  objectId: string;
  requestedBy: string;
  decidedBy: string;
  outcome?: "approved" | "rejected";
  sourceModule?: string;
}): EventEnvelope {
  return approvalResolvedEvent.envelopeSchema.parse({
    id: createUlid(),
    tenantId,
    outletId: bandung,
    name: approvalResolvedEvent.name,
    version: approvalResolvedEvent.version,
    aggregateType: approvalResolvedEvent.entry.aggregateType,
    aggregateId: input.chainId,
    sequence: 99,
    occurredAt: new Date().toISOString(),
    actor: { type: "user", id: input.decidedBy },
    deviceId: null,
    idempotencyKey: `forged:${input.chainId}`,
    payloadSchemaRef: approvalResolvedEvent.payloadSchemaRef,
    payload: {
      chainId: input.chainId,
      requestId: input.chainId,
      sourceModule: input.sourceModule ?? "pos_override",
      actionType: "void",
      objectType: "pos_override",
      objectId: input.objectId,
      source: "user",
      outcome: input.outcome ?? "approved",
      level: 1,
      requiredLevels: 1,
      requestedBy: input.requestedBy,
      decidedBy: input.decidedBy,
      amountIdr: 45_000,
    },
  }) as EventEnvelope;
}

function withPayload(
  event: EventEnvelope,
  patch: Record<string, unknown>,
): EventEnvelope {
  return { ...event, payload: { ...event.payload, ...patch } } as EventEnvelope;
}

async function approve(supervisor: string, chainId: string) {
  await decideApprovalRequest(
    tenant,
    supervisor,
    chainId,
    { decision: "approved", reason: "Sesuai bukti transaksi." },
    { mfaVerified: true, idempotencyKey: null },
  );
}

beforeAll(async () => {
  setAuditWriter({
    record: async (entry) => {
      audits.push(entry);
    },
  });
  savedPolicies = (
    await owner.query(
      `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
      [tenantId, ACTIONS],
    )
  ).rows;
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
    [tenantId, ACTIONS],
  );
  // §3.7 matrix: a void goes to a supervisor, one level.
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'void', NULL, $2, 1)`,
    [tenantId, await roleIdOf("supervisor")],
  );
  // Same for closing a shift (legend-o0w6): one supervisor level, no amount.
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'cash_shift_close', NULL, $2, 1)`,
    [tenantId, await roleIdOf("supervisor")],
  );
});

afterEach(() => {
  audits.length = 0;
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query(
    `DELETE FROM pos_overrides WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
    [tenantId, [...createdUserIds, ...shiftUserIds]],
  );
  await owner.query(
    `DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
    [tenantId, [...createdUserIds, ...shiftUserIds]],
  );
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
    [tenantId, ACTIONS],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
    );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, [...createdUserIds, ...shiftUserIds]],
  );
  // staff_pins reference the user: delete the pins first (FK 23503 otherwise).
  await owner.query(`DELETE FROM staff_pins WHERE user_id = ANY($1::text[])`, [
    createdUserIds,
  ]);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUserIds,
  ]);
  await owner.end();
});

describe("legend-obh5 approval.resolved consumer (sourceModule pos_override)", () => {
  it("legend-obh5 AUTH-06 an approved chain records the override once with approver != requester; replays add nothing", async () => {
    const cashier = await createUser("cashier");
    const supervisor = await createUser("supervisor");
    const pending = await phoneOverride(cashier);
    await approve(supervisor, pending.approvalRequestId!);
    const event = await resolvedEventOf(pending.approvalRequestId!);

    await handleApprovalResolved(workerContext, event);
    const settled = await overrideRow(pending.id);
    expect(settled).toMatchObject({
      status: "approved",
      approved_by: supervisor,
      requested_by: cashier,
    });
    expect(settled?.approved_by).not.toBe(settled?.requested_by);
    expect(settled?.resolved_at).not.toBeNull();

    // At-least-once delivery: the same event again, twice.
    await handleApprovalResolved(workerContext, event);
    await handleApprovalResolved(workerContext, event);
    expect((await recordedEvents(pending.id)).map((row) => row.name)).toEqual([
      "pos_override.recorded",
    ]);
    expect(
      audits.filter(
        (row) =>
          row.action === "pos_override.recorded" && row.objectId === pending.id,
      ),
    ).toHaveLength(1);
    expect((await overrideRow(pending.id))?.resolved_at).toEqual(
      settled?.resolved_at,
    );
  });

  it("legend-obh5 AUTH-06 a rejected chain grants no override, and a replay keeps it rejected", async () => {
    const cashier = await createUser("cashier");
    const supervisor = await createUser("supervisor");
    const pending = await phoneOverride(cashier);
    await decideApprovalRequest(
      tenant,
      supervisor,
      pending.approvalRequestId!,
      { decision: "rejected", reason: "Pesanan sudah dimasak." },
      { mfaVerified: true, idempotencyKey: null },
    );
    const event = await resolvedEventOf(pending.approvalRequestId!);
    await handleApprovalResolved(workerContext, event);
    await handleApprovalResolved(workerContext, event);
    expect(await overrideRow(pending.id)).toMatchObject({
      status: "rejected",
      approved_by: null,
    });
    expect(await recordedEvents(pending.id)).toHaveLength(0);
    expect(
      audits.filter(
        (row) =>
          row.action === "pos_override.denied" && row.objectId === pending.id,
      ),
    ).toHaveLength(1);
  });

  it("legend-obh5 AUTH-06 a forged 'approved' event for a chain the database still has pending approves nothing, even naming the requester as approver", async () => {
    const cashier = await createUser("cashier");
    const supervisor = await createUser("supervisor");
    const pending = await phoneOverride(cashier);
    for (const decidedBy of [supervisor, cashier])
      await handleApprovalResolved(
        workerContext,
        forgedResolved({
          chainId: pending.approvalRequestId!,
          objectId: pending.id,
          requestedBy: cashier,
          decidedBy,
        }),
      );
    expect(await overrideRow(pending.id)).toMatchObject({
      status: "pending",
      approved_by: null,
      resolved_at: null,
    });
    expect(await recordedEvents(pending.id)).toHaveLength(0);
  });

  it("legend-obh5 other source modules and other event names are ignored without touching overrides", async () => {
    const cashier = await createUser("cashier");
    const supervisor = await createUser("supervisor");
    const pending = await phoneOverride(cashier);
    await approve(supervisor, pending.approvalRequestId!);
    const real = await resolvedEventOf(pending.approvalRequestId!);
    // Not ours: even an odd shape is not this consumer's business.
    await handleApprovalResolved(
      workerContext,
      withPayload(real, { sourceModule: "purchasing", outcome: "whatever" }),
    );
    await handleApprovalResolved(workerContext, {
      ...real,
      name: "payment.paid",
    } as EventEnvelope);
    expect(await overrideRow(pending.id)).toMatchObject({ status: "pending" });
    expect(await recordedEvents(pending.id)).toHaveLength(0);
  });

  it("legend-obh5 fail closed: a pos_override event of unknown shape or naming another override throws and writes nothing", async () => {
    const cashier = await createUser("cashier");
    const supervisor = await createUser("supervisor");
    const pending = await phoneOverride(cashier);
    const other = await phoneOverride(cashier);
    await approve(supervisor, pending.approvalRequestId!);
    const real = await resolvedEventOf(pending.approvalRequestId!);
    await expect(
      handleApprovalResolved(
        workerContext,
        withPayload(real, { outcome: "maybe" }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      handleApprovalResolved(
        workerContext,
        withPayload(real, { pin: "582914" }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      handleApprovalResolved(
        workerContext,
        withPayload(real, { objectType: "purchase_order" }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // The chain belongs to `pending`; an event claiming it for `other` is refused.
    await expect(
      handleApprovalResolved(
        workerContext,
        withPayload(real, { objectId: other.id }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      handleApprovalResolved(workerContext, { ...real, outletId: null }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await overrideRow(pending.id)).toMatchObject({ status: "pending" });
    expect(await overrideRow(other.id)).toMatchObject({ status: "pending" });
    expect(await recordedEvents(pending.id)).toHaveLength(0);
  });

  it("legend-obh5 TEN-01 an event of tenant A on tenant B's context is refused, and tenant B's context cannot settle tenant A's chain", async () => {
    const cashier = await createUser("cashier");
    const supervisor = await createUser("supervisor");
    const pending = await phoneOverride(cashier);
    await approve(supervisor, pending.approvalRequestId!);
    const real = await resolvedEventOf(pending.approvalRequestId!);
    const otherTenantId = randomUUID();
    const otherContext = establishScopedTenantContext(
      establishTenantContext({
        tenantId: otherTenantId,
        brandId: null,
        source: "job",
      }),
      { kind: "tenant" },
    );
    await expect(
      handleApprovalResolved(otherContext, real),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // Same chain id relabelled as tenant B: RLS hides tenant A's override.
    await handleApprovalResolved(otherContext, {
      ...real,
      tenantId: otherTenantId,
    } as EventEnvelope);
    expect(await overrideRow(pending.id)).toMatchObject({
      status: "pending",
      approved_by: null,
    });
    expect(await recordedEvents(pending.id)).toHaveLength(0);
  });

  it("legend-obh5 TEN-03 an event naming another outlet does not settle this outlet's override", async () => {
    const cashier = await createUser("cashier");
    const supervisor = await createUser("supervisor");
    const pending = await phoneOverride(cashier);
    await approve(supervisor, pending.approvalRequestId!);
    const real = await resolvedEventOf(pending.approvalRequestId!);
    await handleApprovalResolved(workerContext, {
      ...real,
      outletId: bandung2,
    } as EventEnvelope);
    expect(await overrideRow(pending.id)).toMatchObject({ status: "pending" });
    // The genuine event still settles it afterwards.
    await handleApprovalResolved(workerContext, real);
    expect(await overrideRow(pending.id)).toMatchObject({
      status: "approved",
      approved_by: supervisor,
    });
  });
});

// ---------------------------------------------------------------------------
// legend-cx3nb: an approval.resolved event that died in the m1 window (worker
// had no audit writer) is replayed by the operator long after the chain's
// deadline. The consumer must judge the chain by what the database says now:
// a decision made in time stands, an undecided overdue chain is expired.
//
// Assumptions (the brief leaves them open): the deadline is moved into the past
// by rewriting approval_requests timestamps on the owner pool, like
// device-pin-service.test.ts does; the late event for the overdue pending chain
// is a well-formed "approved" envelope (the replay of a dead event never
// carries more than the DB allows); "poll" is getPosOverride by the cashier.
// ---------------------------------------------------------------------------

/** Pretend the chain was opened 2h ago, decided 90 min ago, due 1h ago. */
async function backdateDecidedChain(chainId: string) {
  await owner.query(
    `UPDATE approval_requests
       SET created_at = now() - interval '2 hours',
           decided_at = CASE WHEN decided_at IS NULL THEN NULL
                             ELSE now() - interval '90 minutes' END,
           deadline_at = now() - interval '1 hour'
     WHERE tenant_id = $1 AND chain_id = $2`,
    [tenantId, chainId],
  );
}

function deniedAudits(overrideId: string) {
  return audits.filter(
    (row) => row.action === "pos_override.denied" && row.objectId === overrideId,
  );
}

function recordedAudits(overrideId: string) {
  return audits.filter(
    (row) =>
      row.action === "pos_override.recorded" && row.objectId === overrideId,
  );
}

describe("legend-cx3nb late replay of a dead approval.resolved event", () => {
  it("legend-cx3nb AUTH-06 (a) approved in time, consumed after the deadline: approved once, a second replay is a no-op", async () => {
    const cashier = await createUser("cashier");
    const supervisor = await createUser("supervisor");
    const pending = await phoneOverride(cashier);
    await approve(supervisor, pending.approvalRequestId!);
    const event = await resolvedEventOf(pending.approvalRequestId!);
    // The decision was in time; only the consumer is late.
    await backdateDecidedChain(pending.approvalRequestId!);

    await handleApprovalResolved(workerContext, event);
    const settled = await overrideRow(pending.id);
    expect(settled).toMatchObject({
      status: "approved",
      approved_by: supervisor,
      requested_by: cashier,
    });
    expect(settled?.resolved_at).not.toBeNull();
    expect((await recordedEvents(pending.id)).map((row) => row.name)).toEqual([
      "pos_override.recorded",
    ]);
    expect(recordedAudits(pending.id)).toHaveLength(1);

    await handleApprovalResolved(workerContext, event);
    expect(await overrideRow(pending.id)).toEqual(settled);
    expect((await recordedEvents(pending.id)).map((row) => row.name)).toEqual([
      "pos_override.recorded",
    ]);
    expect(recordedAudits(pending.id)).toHaveLength(1);
    expect(deniedAudits(pending.id)).toHaveLength(0);
  });

  it("legend-cx3nb AUTH-06 (b) still pending past the deadline at consumption: expired, no override recorded", async () => {
    const cashier = await createUser("cashier");
    const supervisor = await createUser("supervisor");
    const pending = await phoneOverride(cashier);
    await owner.query(
      `UPDATE approval_requests
         SET created_at = now() - interval '2 hours',
             deadline_at = now() - interval '1 hour'
       WHERE tenant_id = $1 AND chain_id = $2`,
      [tenantId, pending.approvalRequestId],
    );

    const late = forgedResolved({
      chainId: pending.approvalRequestId!,
      objectId: pending.id,
      requestedBy: cashier,
      decidedBy: supervisor,
    });
    await handleApprovalResolved(workerContext, late);
    const expired = await overrideRow(pending.id);
    expect(expired).toMatchObject({ status: "expired", approved_by: null });
    expect(await recordedEvents(pending.id)).toHaveLength(0);
    expect(recordedAudits(pending.id)).toHaveLength(0);

    // Replaying again keeps it expired and records nothing.
    await handleApprovalResolved(workerContext, late);
    expect(await overrideRow(pending.id)).toEqual(expired);
    expect(await recordedEvents(pending.id)).toHaveLength(0);
    expect(recordedAudits(pending.id)).toHaveLength(0);
  });

  it("legend-cx3nb AUTH-06 (c) already settled by the cashier's poll, then the event is replayed: nothing changes, no second audit or event", async () => {
    const cashier = await createUser("cashier");
    const supervisor = await createUser("supervisor");
    const pending = await phoneOverride(cashier);
    await approve(supervisor, pending.approvalRequestId!);
    const event = await resolvedEventOf(pending.approvalRequestId!);

    // Poll settles it first (the worker never delivered the event).
    expect(await getPosOverride(tenant, cashier, pending.id)).toMatchObject({
      status: "approved",
      approvedBy: supervisor,
    });
    const settled = await overrideRow(pending.id);
    expect(settled?.status).toBe("approved");
    expect(recordedAudits(pending.id)).toHaveLength(1);

    await backdateDecidedChain(pending.approvalRequestId!);
    await handleApprovalResolved(workerContext, event);
    await handleApprovalResolved(workerContext, event);

    expect(await overrideRow(pending.id)).toEqual(settled);
    expect((await recordedEvents(pending.id)).map((row) => row.name)).toEqual([
      "pos_override.recorded",
    ]);
    expect(recordedAudits(pending.id)).toHaveLength(1);
    expect(deniedAudits(pending.id)).toHaveLength(0);
  });

  // (d) lives in pos-order-approval.test.ts: it needs a real POS order and the
  // void consumeApproval path, whose fixtures are built there.

  // (e) Assumptions: "revoke the override permission" = the supervisor's role
  // assignments are removed after the approval and before the replay (the
  // chain stays approved in the database); the denial reason is recorded in
  // the audit entry's `reason` field.
  it("legend-cx3nb AUTH-06 (e) supervisor loses the override permission after approving, then the event is replayed: rejected, denial audited, nothing recorded", async () => {
    const cashier = await createUser("cashier");
    const supervisor = await createUser("supervisor");
    const pending = await phoneOverride(cashier);
    await approve(supervisor, pending.approvalRequestId!);
    const event = await resolvedEventOf(pending.approvalRequestId!);
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, supervisor],
    );

    await handleApprovalResolved(workerContext, event);
    expect(await overrideRow(pending.id)).toMatchObject({
      status: "rejected",
    });
    const denied = deniedAudits(pending.id);
    expect(denied).toHaveLength(1);
    expect(denied[0]?.reason).toBe("approver_lacks_override_permission");
    expect(recordedAudits(pending.id)).toHaveLength(0);
    expect(
      (await recordedEvents(pending.id)).filter(
        (row) => row.name === "pos_override.recorded",
      ),
    ).toHaveLength(0);

    // A second replay changes nothing.
    await handleApprovalResolved(workerContext, event);
    expect(await overrideRow(pending.id)).toMatchObject({ status: "rejected" });
    expect(deniedAudits(pending.id)).toHaveLength(1);
    expect(await recordedEvents(pending.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// legend-o0w6: the recorded-override outbox event must not carry the blind
// count's variance. For `cash_shift_close` the override's value is
// |counted - expected| of the cashier's blind count, a secret from the cashier
// (POS-03). The event rides the `cloud-sync` outbox towards edge/devices, so
// it carries `valueIdr: null` there; the supervisor-only audit and the
// override row keep the real value.
//
// Assumptions (the brief leaves them open): other actions keep their value in
// the event. This suite never runs the worker, so it cannot show routing: that
// "reaches no device" is proven only by the transport routing tests in
// worker-transport.test.ts. Here the event is checked to sit on `cloud-sync`
// with `valueIdr: null`.
// ---------------------------------------------------------------------------

/** variance = 70_000 - 100_000, so the secret value is |variance| = 30_000. */
const BLIND_VARIANCE_ABS_IDR = 30_000;

/** An open shift with one blind count by a fresh cashier; returns both ids. */
async function cashierWithBlindCount() {
  const cashier = await createUser("cashier", bandung, shiftUserIds);
  const shiftId = randomUUID();
  await owner.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, current_date, 'open', now(), 100000, $6, $7)`,
    [
      shiftId,
      tenantId,
      bandung,
      randomUUID(),
      cashier,
      randomUUID(),
      "a".repeat(64),
    ],
  );
  const countId = randomUUID();
  await owner.query(
    `INSERT INTO pos_shift_counts
       (id, tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
        counted_idr, expected_idr, variance_idr, submitted_by, submitted_at,
        idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, 1, '[]'::jsonb, $5, 70000, 100000, -30000, $6, now(), $7, $5)`,
    [
      countId,
      tenantId,
      bandung,
      shiftId,
      "b".repeat(64),
      cashier,
      randomUUID(),
    ],
  );
  return { cashier, countId };
}

function shiftCloseInput(countId: string, approval: Record<string, unknown>) {
  return createPosOverrideSchema.parse({
    outletId: bandung,
    action: "cash_shift_close",
    // Ignored by the service for this action: the cashier cannot know it.
    valueIdr: 0,
    reason: "Hitung kas akhir shift",
    objectType: "pos_shift_count",
    objectId: countId,
    approval,
  });
}

/** Every outbox row of one override, with its destination and full envelope. */
async function recordedOutboxRows(overrideId: string) {
  const { rows } = await owner.query<{
    destination: string;
    event: unknown;
  }>(
    `SELECT destination, event FROM domain_event_outbox
     WHERE tenant_id = $1 AND aggregate_type = 'pos_override' AND aggregate_id = $2
       AND event->>'name' = 'pos_override.recorded'`,
    [tenantId, ulidToUuid(overrideId)],
  );
  return rows;
}

async function overrideValueInRow(overrideId: string) {
  const { rows } = await owner.query<{ value_idr: string }>(
    "SELECT value_idr FROM pos_overrides WHERE id = $1",
    [ulidToUuid(overrideId)],
  );
  return Number(rows[0]?.value_idr);
}

function recordedAudit(overrideId: string) {
  return audits.find(
    (row) =>
      row.action === "pos_override.recorded" && row.objectId === overrideId,
  );
}

async function expectBlindValueStripped(overrideId: string) {
  const outbox = await recordedOutboxRows(overrideId);
  expect(outbox).toHaveLength(1);
  expect(outbox[0]?.destination).toBe("cloud-sync");
  const envelope = posOverrideRecordedEvent.envelopeSchema.parse(
    outbox[0]?.event,
  );
  expect(envelope.payload.action).toBe("cash_shift_close");
  expect(envelope.payload.valueIdr).toBeNull();
  // The supervisor-only records keep the real variance.
  expect(await overrideValueInRow(overrideId)).toBe(BLIND_VARIANCE_ABS_IDR);
  expect(recordedAudit(overrideId)).toMatchObject({
    after: { action: "cash_shift_close", valueIdr: BLIND_VARIANCE_ABS_IDR },
  });
}

describe("legend-o0w6 pos_override.recorded event keeps the blind count variance out", () => {
  it("legend-o0w6 a PIN-approved shift close records the event with valueIdr null; audit and override row keep the variance", async () => {
    const { cashier, countId } = await cashierWithBlindCount();
    const supervisor = await createUser("supervisor");
    await setStaffPin(
      tenant,
      supervisor,
      { outletId: bandung, userId: supervisor },
      { pin: PIN },
    );
    const { override } = await createPosOverride(
      tenant,
      cashier,
      shiftCloseInput(countId, {
        method: "supervisor_pin",
        approverUserId: supervisor,
        pin: PIN,
      }),
      { idempotencyKey: null },
    );
    expect(override.status).toBe("approved");
    // The cashier's own view already hides it (existing behaviour).
    expect(override.valueIdr).toBeNull();
    await expectBlindValueStripped(override.id);
  });

  it("legend-o0w6 a phone-approved shift close records the event with valueIdr null; audit and override row keep the variance", async () => {
    const { cashier, countId } = await cashierWithBlindCount();
    const supervisor = await createUser("supervisor");
    const { override: pending } = await createPosOverride(
      tenant,
      cashier,
      shiftCloseInput(countId, { method: "supervisor_phone" }),
      { idempotencyKey: null },
    );
    await approve(supervisor, pending.approvalRequestId!);
    await handleApprovalResolved(
      workerContext,
      await resolvedEventOf(pending.approvalRequestId!),
    );
    expect(await overrideRow(pending.id)).toMatchObject({
      status: "approved",
      approved_by: supervisor,
    });
    await expectBlindValueStripped(pending.id);
  });

  it("legend-o0w6 another action (void) keeps its value in the event, for PIN and phone", async () => {
    const cashier = await createUser("cashier");
    const supervisor = await createUser("supervisor");
    await setStaffPin(
      tenant,
      supervisor,
      { outletId: bandung, userId: supervisor },
      { pin: PIN },
    );
    const { override: byPin } = await createPosOverride(
      tenant,
      cashier,
      createPosOverrideSchema.parse({
        outletId: bandung,
        action: "void",
        valueIdr: 45_000,
        reason: "Tamu membatalkan menu sebelum dimasak.",
        objectType: "order",
        objectId: randomUUID(),
        approval: {
          method: "supervisor_pin",
          approverUserId: supervisor,
          pin: PIN,
        },
      }),
      { idempotencyKey: null },
    );
    const pending = await phoneOverride(cashier);
    await approve(supervisor, pending.approvalRequestId!);
    await handleApprovalResolved(
      workerContext,
      await resolvedEventOf(pending.approvalRequestId!),
    );
    for (const id of [byPin.id, pending.id]) {
      const outbox = await recordedOutboxRows(id);
      expect(outbox).toHaveLength(1);
      const envelope = posOverrideRecordedEvent.envelopeSchema.parse(
        outbox[0]?.event,
      );
      expect(envelope.payload).toMatchObject({
        action: "void",
        valueIdr: 45_000,
      });
      expect(recordedAudit(id)).toMatchObject({
        after: { action: "void", valueIdr: 45_000 },
      });
    }
  });
});

describe("legend-o0w6 posOverrideRecordedEvent payload schema", () => {
  const payload = (action: string, valueIdr: number | null) => ({
    overrideId: createUlid(),
    action,
    method: "supervisor_pin",
    requestedBy: randomUUID(),
    approvedBy: randomUUID(),
    valueIdr,
    objectType: "order",
    objectId: randomUUID(),
    approvalRequestId: null,
  });
  const parse = (action: string, valueIdr: number | null) =>
    posOverrideRecordedEvent.payloadSchema.safeParse(payload(action, valueIdr));

  it("legend-o0w6 cash_shift_close with a number is rejected, zero included; null is accepted", () => {
    const withNumber = parse("cash_shift_close", 30_000);
    expect(withNumber.success).toBe(false);
    expect(
      withNumber.success ? [] : withNumber.error.issues.map((i) => i.path),
    ).toContainEqual(["valueIdr"]);
    expect(parse("cash_shift_close", 0).success).toBe(false);
    expect(parse("cash_shift_close", null).success).toBe(true);
  });

  it("legend-o0w6 other actions with a number are still accepted", () => {
    for (const action of ["void", "discount", "refund", "edc_standalone"])
      expect(parse(action, 45_000).success, action).toBe(true);
  });

  // Assumption: cloud ingest (edge/db-link-store.ts) validates with the generic
  // `eventEnvelopeSchema`, which does not know per-event payload rules. So a
  // pre-deploy envelope (cash_shift_close with a number) must still be
  // accepted there, while the domain-specific schema rejects it.
  it("legend-o0w6 a pre-deploy cash_shift_close envelope with valueIdr 5000 passes the generic envelope schema but not the domain one", () => {
    const envelope = {
      id: createUlid(),
      tenantId,
      outletId: bandung,
      name: "pos_override.recorded",
      version: 1,
      aggregateType: "pos_override",
      aggregateId: createUlid(),
      sequence: 1,
      occurredAt: new Date().toISOString(),
      actor: { type: "user", id: randomUUID() },
      deviceId: null,
      idempotencyKey: `pre-deploy-${randomUUID()}`,
      payloadSchemaRef: "pos_override.recorded.v1",
      payload: payload("cash_shift_close", 5_000),
    };
    const generic = eventEnvelopeSchema.safeParse(envelope);
    expect(
      generic.success,
      generic.success ? "" : JSON.stringify(generic.error.issues),
    ).toBe(true);
    expect(
      posOverrideRecordedEvent.envelopeSchema.safeParse(envelope).success,
    ).toBe(false);
  });
});
