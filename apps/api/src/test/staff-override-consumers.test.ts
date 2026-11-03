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
import { setAuditWriter, type AuditEntry } from "../services/audit-writer.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import { handleApprovalResolved } from "../services/staff-override-consumers.ts";
import { createPosOverride } from "../services/staff-override.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const bandung2 = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const audits: AuditEntry[] = [];
const createdUserIds: string[] = [];
const ACTIONS = ["void"];
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

async function createUser(templateKey: string, outletId = bandung) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, `Staf ${templateKey}`, `${id}@example.test`],
  );
  createdUserIds.push(id);
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
});

afterEach(() => {
  audits.length = 0;
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query(
    `DELETE FROM pos_overrides WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    `DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
    [tenantId, createdUserIds],
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
    [tenantId, createdUserIds],
  );
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
