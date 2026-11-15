// Shared fixture for the C6 selfie-ingest tests (bead legend-0wvoz): one
// disposable tenant, three outlets (A and B have a registered edge node, C has
// none), employees with their own login user, an edge-credential map for the
// HTTP route, and an `attendance.logged` builder + applier entry point. Rows
// are created by the migration owner and removed by `cleanup()`.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  createUlid,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { attendanceLogged } from "@starter/shared/hris";
import { db } from "../../db/index.ts";
import { withTenant } from "../../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../../edge/applier-registry.ts";
import { registerAttendanceLoggedEdgeApplier } from "../../edge/attendance-logged-applier.ts";
import { edgeEventApplier, type EdgeApplyMeta } from "../../edge/ports.ts";
import { setAuditWriter } from "../../services/audit-writer.ts";
import { coreAuditWriter } from "../../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../../services/edge-node.service.ts";
import {
  setEdgeCredentialVerifier,
  type VerifiedEdgeNode,
} from "../../services/staff-pin-sync.ts";

export type FixtureEmployee = { id: string; userId: string };
export type FixtureNode = {
  credential: string;
  verified: VerifiedEdgeNode;
  authenticated: AuthenticatedEdgeNode;
};

export type EventOverrides = {
  outletId?: string;
  employeeId?: string;
  attendanceLogId?: string;
  eventId?: string;
  clockedAt?: Date;
  type?: "in" | "out";
  method?: "selfie_geo" | "rotating_qr" | "manual_correction" | "outlet_device";
  validity?: "valid" | "flagged" | "rejected";
  /** v2 fields: left out of the payload entirely when undefined (a v1 payload). */
  selfieObjectId?: string | null;
  edgeFlagReasons?: string[];
  edgeDeviceId?: string | null;
};

export type LogRow = {
  id: string;
  outlet_id: string;
  employee_id: string;
  type: string;
  method: string;
  offline: boolean;
  validity: string;
  flag_reasons: string[];
  review_status: string;
  occurred_at: Date;
  photo_key: string | null;
  photo_purged_at: Date | null;
  client_event_id: string;
  late_minutes: number | null;
  overtime_minutes: number | null;
  shift_assignment_id: string | null;
};

export type ObjectRow = {
  id: string;
  outlet_id: string;
  purpose: string;
  object_key: string;
  thumbnail_key: string | null;
  content_type: string;
  owner_user_id: string | null;
  source_kind: string | null;
  source_id: string | null;
};

export type ReceiptRow = {
  object_id: string;
  outlet_id: string;
  edge_node_id: string;
  state: string;
  sealed_sha256: Buffer;
};

export type EdgeSelfieFixture = Awaited<
  ReturnType<typeof createEdgeSelfieFixture>
>;

export async function createEdgeSelfieFixture() {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const owner = new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 4,
  });
  const actor = randomUUID();
  const tenantId = randomUUID();
  const legalEntityId = randomUUID();
  const outletA = randomUUID();
  const outletB = randomUUID();
  const outletC = randomUUID();
  const userIds: string[] = [];
  let employeeSeq = 0;

  const scopeOf = (outletIds: string[]): ScopedTenantContext =>
    establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      {
        kind: "outlets",
        outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
      },
    );

  /** Owner connection with the tenant GUCs set, so reads and fixtures pass forced RLS. */
  async function asTenant<T>(
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
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
  const query = <R extends QueryResultRow>(sql: string, values: unknown[]) =>
    asTenant((client) => client.query<R>(sql, values));

  setAuditWriter(coreAuditWriter);
  const brand = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Selfie Edge', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `selfie-edge-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `selfie-edge-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [legalEntityId, tenantId],
  );
  for (const [id, code] of [
    [outletA, "SLF-01"],
    [outletB, "SLF-02"],
    [outletC, "SLF-03"],
  ])
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
      [id, tenantId, brand, legalEntityId, code],
    );

  async function createEmployee(
    status:
      | "onboarding"
      | "active"
      | "suspended"
      | "resigned"
      | "terminated" = "active",
    homeOutletId: string = outletA,
  ): Promise<FixtureEmployee> {
    const userId = randomUUID();
    const id = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Karyawan Selfie', $2)`,
      [userId, `${userId}@example.test`],
    );
    userIds.push(userId);
    employeeSeq += 1;
    await owner.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, legal_entity_id)
       VALUES ($1, $2, $3, $4, 'Karyawan Selfie Edge', $5, 'pkwtt', '2025-03-01', $6, $7)`,
      [
        id,
        tenantId,
        userId,
        `SLF-${String(employeeSeq).padStart(4, "0")}`,
        homeOutletId,
        status,
        legalEntityId,
      ],
    );
    return { id, userId };
  }

  const employee = await createEmployee();
  const otherEmployee = await createEmployee();

  async function registerNode(outletId: string, label: string) {
    const registered = await registerEdgeNode(scopeOf([outletId]), actor, {
      outletId,
      role: "primary",
      label,
    });
    const authenticated = await authenticateEdgeCredential(
      registered.credential,
    );
    if (!authenticated) throw new Error("Edge node did not authenticate");
    const node: FixtureNode = {
      credential: registered.credential,
      authenticated,
      verified: {
        tenantId: tenantId as VerifiedEdgeNode["tenantId"],
        outletId: outletId as VerifiedEdgeNode["outletId"],
        edgeNodeId: authenticated.scope.edgeNodeId,
      },
    };
    return node;
  }
  const nodeA = await registerNode(outletA, "Utama A");
  const nodeB = await registerNode(outletB, "Utama B");
  const credentials = new Map<string, VerifiedEdgeNode>([
    [nodeA.credential, nodeA.verified],
    [nodeB.credential, nodeB.verified],
  ]);
  setEdgeCredentialVerifier(
    async ({ credential }) => credentials.get(credential) ?? null,
  );
  resetEdgeApplierRegistryForTests();
  registerAttendanceLoggedEdgeApplier();

  let clock = Date.now();
  /** An edge `attendance.logged`; v2 fields only when the override sets them. */
  function attendanceEvent(overrides: EventOverrides = {}): {
    event: EventEnvelope;
    attendanceLogId: string;
  } {
    clock += 1_000;
    const attendanceLogId = overrides.attendanceLogId ?? createUlid(clock);
    const clockedAt = overrides.clockedAt ?? new Date(Date.now() - 10 * 60_000);
    const outletId = overrides.outletId ?? outletA;
    const event = attendanceLogged.envelopeSchema.parse({
      id: overrides.eventId ?? createUlid(clock),
      tenantId,
      outletId,
      name: "attendance.logged",
      version: 1,
      aggregateType: "attendance",
      aggregateId: attendanceLogId,
      sequence: 1,
      occurredAt: new Date(clockedAt.getTime() + 5_000).toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `attendance.logged:${attendanceLogId}`,
      payloadSchemaRef: "attendance.logged.v1",
      payload: {
        attendanceLogId,
        employeeId: overrides.employeeId ?? employee.id,
        outletId,
        type: overrides.type ?? "in",
        method: overrides.method ?? "outlet_device",
        occurredAt: clockedAt.toISOString(),
        validity: overrides.validity ?? "valid",
        shiftAssignmentId: null,
        ...(overrides.selfieObjectId !== undefined && {
          selfieObjectId: overrides.selfieObjectId,
        }),
        ...(overrides.edgeFlagReasons !== undefined && {
          edgeFlagReasons: overrides.edgeFlagReasons,
        }),
        ...(overrides.edgeDeviceId !== undefined && {
          edgeDeviceId: overrides.edgeDeviceId,
        }),
      },
    }) as EventEnvelope;
    return { event, attendanceLogId };
  }

  const meta = (context: ScopedTenantContext): EdgeApplyMeta => ({
    edgeNodeId: nodeA.authenticated.scope.edgeNodeId,
    direction: "edge_to_cloud",
    kind: "transaction_event",
    context,
  });

  /** Applies one event through the registered cloud applier (node A). */
  const applyEvent = (event: EventEnvelope) =>
    withTenant(db, nodeA.authenticated.context, (tx) =>
      edgeEventApplier("edge_to_cloud").apply(
        tx,
        event,
        meta(nodeA.authenticated.context),
      ),
    );

  async function logByClientEvent(
    attendanceLogId: string,
  ): Promise<LogRow | undefined> {
    const { rows } = await query<LogRow>(
      `SELECT id::text, outlet_id::text, employee_id::text, type, method, offline, validity,
              flag_reasons, review_status, occurred_at, photo_key, photo_purged_at,
              client_event_id, late_minutes, overtime_minutes, shift_assignment_id::text
         FROM attendance_logs WHERE tenant_id = $1 AND client_event_id = $2`,
      [tenantId, attendanceLogId],
    );
    return rows[0];
  }

  async function logCount(): Promise<number> {
    const { rows } = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM attendance_logs WHERE tenant_id = $1",
      [tenantId],
    );
    return rows[0]!.n;
  }

  async function objectRow(objectId: string): Promise<ObjectRow | undefined> {
    const { rows } = await query<ObjectRow>(
      `SELECT id::text, outlet_id::text, purpose, object_key, thumbnail_key, content_type,
              owner_user_id, source_kind, source_id::text
         FROM core_storage_objects WHERE tenant_id = $1 AND id = $2`,
      [tenantId, objectId],
    );
    return rows[0];
  }

  async function receiptRow(objectId: string): Promise<ReceiptRow | undefined> {
    const { rows } = await query<ReceiptRow>(
      `SELECT object_id::text, outlet_id::text, edge_node_id::text, state, sealed_sha256
         FROM edge_received_selfies WHERE tenant_id = $1 AND object_id = $2`,
      [tenantId, objectId],
    );
    return rows[0];
  }

  async function cleanup() {
    resetEdgeApplierRegistryForTests();
    setAuditWriter(null);
    setEdgeCredentialVerifier(null);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      // Append-only and guarded tables: replica mode lets the owner remove them.
      await client.query("SET LOCAL session_replication_role = replica");
      for (const table of [
        "domain_event_outbox",
        "attendance_logs",
        "attendance_corrections",
        "attendance_devices",
        "attendance_policies",
        "attendance_qr_secrets",
        "shift_assignments",
        "core_storage_objects",
        "edge_received_selfies",
        "payroll_runs",
        "payroll_policies",
        "employees",
        "edge_link_slots",
        "edge_inbound_events",
        "edge_received_events",
        "edge_sync_conflicts",
        "edge_outbound_queue",
        "sync_cursors",
        "edge_nodes",
        "hris_idempotency",
        "audit_logs",
        "outlets",
        "legal_entities",
        "brands",
      ])
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
          tenantId,
        ]);
      await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
      await client.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
        userIds,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await owner.end();
    }
  }

  return {
    owner,
    asTenant,
    actor,
    tenantId,
    legalEntityId,
    outletA,
    outletB,
    outletC,
    employee,
    otherEmployee,
    nodeA,
    nodeB,
    scopeOf,
    createEmployee,
    attendanceEvent,
    applyEvent,
    logByClientEvent,
    logCount,
    objectRow,
    receiptRow,
    cleanup,
  };
}
