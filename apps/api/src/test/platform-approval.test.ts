// Generic approval service (bead legend-y5q; PRD v1.7 §3 F7 Matriks Approval +
// Kotak Approval, §6 B approval_requests, AUTH-06, MCP-04, TEN-01..03).
// Service tests run the real services on the disposable PostgreSQL (RLS on);
// HTTP tests run the real Express app and Better Auth.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext, TenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { setAuditWriter, type AuditEntry } from "../services/audit-writer";
import {
  cancelApprovalRequest,
  decideApprovalRequest,
  expireDueApprovalRequests,
  getApprovalChainOutcome,
  getApprovalRequest,
  listApprovalRequests,
  openApprovalRequest,
  type OpenApprovalRequestInput,
} from "../services/platform-approval.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const bandung2 = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const audits: AuditEntry[] = [];
const createdUserIds: string[] = [];
const ACTIONS = ["void", "refund", "payroll", "mcp_action", "expense"];
let savedPolicies: Record<string, unknown>[] = [];
const tenantB = randomUUID();
const tenantBUser = randomUUID();

const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const tenantWide: ScopedTenantContext = establishScopedTenantContext(tenant, {
  kind: "tenant",
});
const outletScope = (outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: [outletId as never],
  });

const users = {} as Record<
  | "cashier"
  | "supervisor"
  | "supervisor2"
  | "supervisorOther"
  | "manager"
  | "manager2"
  | "hr"
  | "finance",
  string
>;

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function createUser(
  name: string,
  templateKey: string,
  scope: { type: string; id?: string },
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, name, `${id}@example.test`],
  );
  createdUserIds.push(id);
  await assign(id, templateKey, scope);
  return id;
}

async function assign(
  userId: string,
  templateKey: string,
  scope: { type: string; id?: string },
) {
  // Backdated: the container clock may drift from the Node clock.
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenantId,
      userId,
      await roleIdOf(templateKey),
      scope.type,
      scope.id ?? null,
    ],
  );
}

async function setPolicy(
  actionType: string,
  thresholdIdr: number | null,
  templateKey: string,
  level: number,
) {
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, actionType, thresholdIdr, await roleIdOf(templateKey), level],
  );
}

const objectId = () => randomUUID();

async function open(
  input: Partial<OpenApprovalRequestInput> &
    Pick<OpenApprovalRequestInput, "actionType" | "requestedBy">,
  context: ScopedTenantContext = tenantWide,
) {
  return withTenant(db, context, (tx) =>
    openApprovalRequest(tx, context, {
      sourceModule: "payment",
      objectType: "order",
      objectId: objectId(),
      amountIdr: null,
      outletId: bandung,
      source: "user",
      requestReason: "Pelanggan membatalkan pesanan sebelum dapur mulai.",
      ...input,
    }),
  );
}

async function openRequired(
  input: Parameters<typeof open>[0],
  context?: ScopedTenantContext,
) {
  const result = await open(input, context);
  if (!result.required) throw new Error("expected an approval requirement");
  return result;
}

function decide(
  userId: string,
  requestId: string,
  decision: "approved" | "rejected" = "approved",
  options: { reason?: string; key?: string | null; now?: Date } = {},
) {
  return decideApprovalRequest(
    tenant,
    userId,
    requestId,
    { decision, reason: options.reason ?? "Sesuai bukti transaksi." },
    {
      mfaVerified: true,
      idempotencyKey: options.key ?? null,
      now: options.now,
    },
  );
}

async function events(chainId: string, destination = "cloud-sync") {
  const { rows } = await owner.query<{
    name: string;
    payload: Record<string, unknown>;
    sequence: number;
  }>(
    `SELECT event->>'name' AS name, event->'payload' AS payload, sequence
     FROM domain_event_outbox
     WHERE tenant_id = $1 AND aggregate_type = 'approval' AND aggregate_id = $2
       AND destination = $3
     ORDER BY sequence`,
    [tenantId, chainId, destination],
  );
  return rows;
}

async function chain(chainId: string) {
  const { rows } = await owner.query<{
    id: string;
    level: number;
    status: string;
    decided_by: string | null;
  }>(
    `SELECT id, level, status, decided_by FROM approval_requests
     WHERE tenant_id = $1 AND chain_id = $2 ORDER BY level`,
    [tenantId, chainId],
  );
  return rows;
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
  // §3.7 matrix (fixture policy seeds): refunds tier at Rp500.000 into two
  // levels; payroll is "HR lalu Finance" (§3 Payroll Run); MCP drafts go to
  // the outlet manager; expenses need approval from Rp1.000.000.
  await setPolicy("void", null, "supervisor", 1);
  await setPolicy("refund", null, "supervisor", 1);
  await setPolicy("refund", 500_000, "supervisor", 1);
  await setPolicy("refund", 500_000, "outlet_manager", 2);
  await setPolicy("payroll", null, "hr", 1);
  await setPolicy("payroll", null, "finance", 2);
  await setPolicy("mcp_action", null, "outlet_manager", 1);
  await setPolicy("expense", 1_000_000, "finance", 1);

  users.cashier = await createUser("Kasir A", "cashier", {
    type: "outlet",
    id: bandung,
  });
  users.supervisor = await createUser("Supervisor A", "supervisor", {
    type: "outlet",
    id: bandung,
  });
  users.supervisor2 = await createUser("Supervisor A2", "supervisor", {
    type: "outlet",
    id: bandung,
  });
  users.supervisorOther = await createUser("Supervisor B", "supervisor", {
    type: "outlet",
    id: bandung2,
  });
  users.manager = await createUser("Manajer A", "outlet_manager", {
    type: "outlet",
    id: bandung,
  });
  users.manager2 = await createUser("Manajer A2", "outlet_manager", {
    type: "outlet",
    id: bandung,
  });
  users.hr = await createUser("HR", "hr", { type: "tenant" });
  users.finance = await createUser("Finance", "finance", { type: "tenant" });

  // A second tenant with one approval request (cross-tenant isolation).
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Approval test tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantB, `approval-${tenantB}`, tenantBUser],
  );
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'B', $2)`,
    [tenantBUser, `${tenantBUser}@example.test`],
  );
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query(
    `DELETE FROM approval_requests WHERE tenant_id = ANY($1::uuid[])
       AND requested_by = ANY($2::text[])`,
    [
      [tenantId, tenantB],
      [...createdUserIds, tenantBUser],
    ],
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
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    [...createdUserIds, tenantBUser],
  ]);
  await owner.end();
  await appPool.end();
});

describe("legend-y5q policy evaluation (§3.7 Matriks Approval)", () => {
  it("§3.7 threshold routing: tier picks the level count, below tier needs no approval, no policy fails closed", async () => {
    const small = await openRequired({
      actionType: "refund",
      requestedBy: users.cashier,
      amountIdr: 100_000,
    });
    expect(small.request).toMatchObject({
      level: 1,
      requiredLevels: 1,
      status: "pending",
      amountIdr: 100_000,
      source: "user",
    });
    const big = await openRequired({
      actionType: "refund",
      requestedBy: users.cashier,
      amountIdr: 750_000,
    });
    expect(big.request.requiredLevels).toBe(2);
    // Unknown amount applies every tier (fail closed).
    const unknown = await openRequired({
      actionType: "refund",
      requestedBy: users.cashier,
      amountIdr: null,
    });
    expect(unknown.request.requiredLevels).toBe(2);
    // Expense below the Rp1.000.000 tier: no approval needed.
    expect(
      await open({
        actionType: "expense",
        requestedBy: users.cashier,
        amountIdr: 400_000,
      }),
    ).toEqual({ required: false });
    // No policy for the action: nobody may approve.
    await expect(
      open({ actionType: "leave", requestedBy: users.cashier }),
    ).rejects.toMatchObject({ code: "APPROVAL_POLICY_MISSING" });
    // approval.requested reaches the source stream and the notification stream.
    expect((await events(big.chainId)).map((row) => row.name)).toEqual([
      "approval.requested",
    ]);
    expect(
      (await events(big.chainId, "notification")).map((row) => row.name),
    ).toEqual(["approval.requested"]);
    expect(
      audits.some(
        (row) =>
          row.action === "approval.requested" &&
          row.objectId === big.request.id,
      ),
    ).toBe(true);
  });

  it("§3.7 a matrix edit does not change a request already in flight (snapshot)", async () => {
    const opened = await openRequired({
      actionType: "void",
      requestedBy: users.cashier,
    });
    await owner.query(
      `UPDATE approval_policies SET approver_role_id = $3
       WHERE tenant_id = $1 AND action_type = $2`,
      [tenantId, "void", await roleIdOf("outlet_manager")],
    );
    try {
      // The supervisor still decides: the requirement was snapshotted.
      const decided = await decide(users.supervisor, opened.request.id);
      expect(decided.status).toBe("approved");
    } finally {
      await owner.query(
        `UPDATE approval_policies SET approver_role_id = $3
         WHERE tenant_id = $1 AND action_type = $2`,
        [tenantId, "void", await roleIdOf("supervisor")],
      );
    }
  });
});

describe("legend-y5q decisions (AUTH-06, MCP-04)", () => {
  it("AUTH-06 the requester cannot approve their own request; another approver can", async () => {
    const opened = await openRequired({
      actionType: "void",
      requestedBy: users.supervisor,
    });
    await expect(
      decide(users.supervisor, opened.request.id),
    ).rejects.toMatchObject({ code: "APPROVER_IS_REQUESTER" });
    const approved = await decide(users.supervisor2, opened.request.id);
    expect(approved).toMatchObject({
      status: "approved",
      decidedBy: users.supervisor2,
      reason: "Sesuai bukti transaksi.",
    });
    const names = (await events(opened.chainId)).map((row) => row.name);
    expect(names).toEqual([
      "approval.requested",
      "approval.decided",
      "approval.resolved",
    ]);
    const resolved = (await events(opened.chainId)).at(-1)!;
    expect(resolved.payload).toMatchObject({
      chainId: opened.chainId,
      sourceModule: "payment",
      outcome: "approved",
      decidedBy: users.supervisor2,
    });
    expect(
      await withTenant(db, tenantWide, (tx) =>
        getApprovalChainOutcome(tx, {
          chainId: opened.chainId,
          sourceModule: "payment",
        }),
      ),
    ).toBe("approved");
    expect(
      audits.some(
        (row) =>
          row.action === "approval.decided" &&
          row.objectId === opened.request.id &&
          row.actorId === users.supervisor2,
      ),
    ).toBe(true);
  });

  it("MCP-04 an MCP action request is approved only by an authorised user different from the requester", async () => {
    const opened = await openRequired({
      actionType: "mcp_action",
      requestedBy: users.manager,
      source: "mcp",
      objectType: "purchase_order",
      sourceModule: "mcp",
      payload: { tool: "inventory.purchase_order.draft" },
    });
    expect(opened.request.source).toBe("mcp");
    // The human the agent acts for cannot approve the agent's request.
    await expect(
      decide(users.manager, opened.request.id),
    ).rejects.toMatchObject({ code: "APPROVER_IS_REQUESTER" });
    // A supervisor may decide approvals in general but is not the matrix role.
    await expect(
      decide(users.supervisor, opened.request.id),
    ).rejects.toMatchObject({ code: "APPROVER_ROLE_MISMATCH" });
    // A cashier holds no approval permission at all.
    await expect(
      decide(users.cashier, opened.request.id),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    // AUTH-05: the outlet manager role requires MFA on the dashboard.
    await expect(
      decideApprovalRequest(
        tenant,
        users.manager2,
        opened.request.id,
        { decision: "approved", reason: "Draf PO sesuai par level." },
        { mfaVerified: false, idempotencyKey: null },
      ),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    const approved = await decide(users.manager2, opened.request.id);
    expect(approved.status).toBe("approved");
  });

  it("TEN-03 an approver whose scope does not cover the outlet is denied", async () => {
    const opened = await openRequired({
      actionType: "void",
      requestedBy: users.cashier,
      outletId: bandung,
    });
    // Outside the approver's outlet reach the row is invisible (RLS): 404.
    await expect(
      decide(users.supervisorOther, opened.request.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getApprovalRequest(tenant, users.supervisorOther, opened.request.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const inbox = await listApprovalRequests(tenant, users.supervisorOther, {
      limit: 100,
    });
    expect(inbox.data.map((row) => row.id)).not.toContain(opened.request.id);
    // A tenant-wide request is invisible to an outlet-scoped approver.
    const payroll = await openRequired({
      actionType: "payroll",
      requestedBy: users.cashier,
      outletId: null,
      objectType: "payroll_run",
      sourceModule: "payroll",
    });
    await expect(
      decide(users.supervisor, payroll.request.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("§3 Payroll Run two levels: HR then Finance, a different person each level, then resolved", async () => {
    const opened = await openRequired({
      actionType: "payroll",
      requestedBy: users.cashier,
      outletId: null,
      objectType: "payroll_run",
      sourceModule: "payroll",
      amountIdr: 85_000_000,
    });
    expect(opened.request.requiredLevels).toBe(2);
    // Level 1 belongs to HR: Finance is the wrong role for it.
    await expect(
      decide(users.finance, opened.request.id),
    ).rejects.toMatchObject({ code: "APPROVER_ROLE_MISMATCH" });
    await decide(users.hr, opened.request.id);
    const rows = await chain(opened.chainId);
    expect(rows.map((row) => [row.level, row.status])).toEqual([
      [1, "approved"],
      [2, "pending"],
    ]);
    const levelTwo = rows[1]!.id;
    // The level-1 approver cannot also decide level 2.
    await expect(decide(users.hr, levelTwo)).rejects.toMatchObject({
      code: "APPROVER_ALREADY_DECIDED",
    });
    const final = await decide(users.finance, levelTwo);
    expect(final).toMatchObject({ level: 2, status: "approved" });
    expect((await events(opened.chainId)).map((row) => row.name)).toEqual([
      "approval.requested",
      "approval.decided",
      "approval.requested",
      "approval.decided",
      "approval.resolved",
    ]);
  });

  it("§3 F7 a rejection ends the chain with reason and a rejected callback", async () => {
    const opened = await openRequired({
      actionType: "refund",
      requestedBy: users.cashier,
      amountIdr: 900_000,
    });
    const rejected = await decide(
      users.supervisor,
      opened.request.id,
      "rejected",
      {
        reason: "Bukti transfer tidak cocok.",
      },
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: "Bukti transfer tidak cocok.",
    });
    expect((await chain(opened.chainId)).length).toBe(1);
    expect((await events(opened.chainId)).at(-1)?.payload).toMatchObject({
      outcome: "rejected",
      level: 1,
      requiredLevels: 2,
    });
  });

  it("legend-y5q concurrent double approval of one level records exactly one decision", async () => {
    const opened = await openRequired({
      actionType: "refund",
      requestedBy: users.cashier,
      amountIdr: 750_000,
    });
    const results = await Promise.allSettled([
      decide(users.supervisor, opened.request.id),
      decide(users.supervisor2, opened.request.id),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((row) => row.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason).toMatchObject({
      code: "APPROVAL_REQUEST_NOT_PENDING",
    });
    const rows = await chain(opened.chainId);
    expect(rows.map((row) => [row.level, row.status])).toEqual([
      [1, "approved"],
      [2, "pending"],
    ]);
    expect(
      (await events(opened.chainId)).filter(
        (row) => row.name === "approval.decided",
      ),
    ).toHaveLength(1);
  });

  it("legend-y5q a replayed decision is idempotent and a reused key with another body is refused", async () => {
    const opened = await openRequired({
      actionType: "void",
      requestedBy: users.cashier,
    });
    const key = `decide-${randomUUID()}`;
    const first = await decide(
      users.supervisor,
      opened.request.id,
      "approved",
      {
        key,
      },
    );
    const replay = await decide(
      users.supervisor,
      opened.request.id,
      "approved",
      {
        key,
      },
    );
    expect(replay).toEqual(first);
    // Same approver, same decision and reason without a key: same answer.
    expect(await decide(users.supervisor, opened.request.id)).toEqual(first);
    await expect(
      decide(users.supervisor, opened.request.id, "rejected", { key }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      decide(users.supervisor2, opened.request.id),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_NOT_PENDING" });
    expect(
      (await events(opened.chainId)).filter(
        (row) => row.name === "approval.decided",
      ),
    ).toHaveLength(1);
  });

  it("legend-y5q create is idempotent per key and one object has one pending request", async () => {
    const target = objectId();
    const key = `open-${randomUUID()}`;
    const first = await openRequired({
      actionType: "void",
      requestedBy: users.cashier,
      objectId: target,
      idempotencyKey: key,
    });
    const replay = await openRequired({
      actionType: "void",
      requestedBy: users.cashier,
      objectId: target,
      idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.request.id).toBe(first.request.id);
    await expect(
      open({
        actionType: "void",
        requestedBy: users.cashier,
        objectId: target,
        idempotencyKey: key,
        requestReason: "Alasan lain untuk permintaan yang sama.",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      open({
        actionType: "void",
        requestedBy: users.cashier,
        objectId: target,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("legend-y5q a hand-made inbox request never blocks the module's own approval for the same object", async () => {
    const target = objectId();
    // The inbox lets a user pick any objectId; it opens first.
    const inbox = await openRequired({
      sourceModule: "inbox",
      actionType: "void",
      requestedBy: users.cashier,
      objectId: target,
    });
    const module = await openRequired({
      actionType: "void",
      requestedBy: users.cashier,
      objectId: target,
    });
    expect(module.chainId).not.toBe(inbox.chainId);
    // Still one pending request per (source module, action, object).
    await expect(
      open({
        sourceModule: "inbox",
        actionType: "void",
        requestedBy: users.cashier,
        objectId: target,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("legend-y5q a decision key reused on another level of the same chain is refused", async () => {
    const opened = await openRequired({
      actionType: "refund",
      requestedBy: users.cashier,
      amountIdr: 750_000,
    });
    const key = `decide-${randomUUID()}`;
    await decide(users.supervisor, opened.request.id, "approved", { key });
    const rows = await chain(opened.chainId);
    expect(rows.map((row) => [row.level, row.status])).toEqual([
      [1, "approved"],
      [2, "pending"],
    ]);
    await expect(
      decide(users.supervisor, rows[1]!.id, "approved", { key }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect((await chain(opened.chainId))[1]?.status).toBe("pending");
  });
});

/** Blocks until a cancellation is queued behind another transaction's row lock. */
async function waitForApprovalLockWaiter(): Promise<void> {
  // ~10 s budget: generous under CI load; the wait itself is not timing-based.
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await owner.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND state = 'active'
         AND wait_event_type = 'Lock' AND query ILIKE '%approval_requests%'`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the cancel never queued behind the sweep row lock");
}

describe("legend-y5q deadline and cancellation", () => {
  it("§3 F7 deadline escalation: an overdue level blocks the decision, the sweep expires it and calls back", async () => {
    const past = new Date(Date.now() - 20 * 60_000);
    const opened = await openRequired({
      actionType: "void",
      requestedBy: users.cashier,
      deadlineMinutes: 10,
      now: past,
    });
    await expect(
      decide(users.supervisor, opened.request.id),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
    // Before the sweep the inbox already reads it as expired (fail closed).
    const seen = await getApprovalRequest(
      tenant,
      users.supervisor,
      opened.request.id,
    );
    expect(seen.status).toBe("expired");
    const pendingInbox = await listApprovalRequests(tenant, users.supervisor, {
      limit: 100,
      status: "pending",
    });
    expect(pendingInbox.data.map((row) => row.id)).not.toContain(
      opened.request.id,
    );

    expect(await expireDueApprovalRequests(tenantWide)).toBeGreaterThanOrEqual(
      1,
    );
    expect((await chain(opened.chainId))[0]?.status).toBe("expired");
    for (const destination of ["cloud-sync", "notification"]) {
      const last = (await events(opened.chainId, destination)).at(-1);
      expect(last?.name).toBe("approval.resolved");
      expect(last?.payload).toMatchObject({
        outcome: "expired",
        decidedBy: null,
      });
    }
    expect(
      audits.some(
        (row) =>
          row.action === "approval.expired" &&
          row.objectId === opened.request.id &&
          row.actorType === "system",
      ),
    ).toBe(true);
    // A second sweep finds nothing new for this request; a late decision is refused.
    await expireDueApprovalRequests(tenantWide);
    expect(
      (await events(opened.chainId)).filter(
        (row) => row.name === "approval.resolved",
      ),
    ).toHaveLength(1);
    await expect(
      decide(users.supervisor, opened.request.id),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
    await expect(
      expireDueApprovalRequests(outletScope(bandung)),
    ).rejects.toThrow(/tenant-wide/);
  });

  it("legend-y5q a cancel racing the deadline sweep leaves one terminal outcome", async () => {
    // Two levels, the second already due: level 1 is approved on the server
    // clock (legend-1151: decide never skips it), then level 2 is made due.
    const opened = await openRequired({
      actionType: "refund",
      requestedBy: users.cashier,
      amountIdr: 750_000,
      deadlineMinutes: 10,
      now: new Date(),
    });
    await decide(users.supervisor, opened.request.id, "approved");
    const rows = await chain(opened.chainId);
    expect(rows.map((row) => [row.level, row.status])).toEqual([
      [1, "approved"],
      [2, "pending"],
    ]);
    const levelTwo = rows[1]!.id;
    await owner.query(
      `UPDATE approval_requests
         SET created_at = now() - interval '2 hours',
             deadline_at = now() - interval '1 minute'
       WHERE id = $1`,
      [levelTwo],
    );

    // The sweep holds the due row lock with "expired" uncommitted.
    const sweep = await owner.connect();
    try {
      await sweep.query("BEGIN");
      await sweep.query(
        `UPDATE approval_requests SET status = 'expired', updated_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [levelTwo],
      );
      // The module withdraws: it reads the chain (still pending from its
      // snapshot) and queues behind the sweep's row lock.
      const cancelling = withTenant(db, tenantWide, (tx) =>
        cancelApprovalRequest(tx, tenantWide, {
          chainId: opened.chainId,
          sourceModule: "payment",
          actorUserId: users.cashier,
        }),
      );
      await waitForApprovalLockWaiter();
      await sweep.query("COMMIT");
      expect(await cancelling).toBe("expired");
    } finally {
      await sweep.query("ROLLBACK").catch(() => undefined);
      sweep.release();
    }
    // The sweep's terminal outcome stands: no second resolved event.
    expect((await chain(opened.chainId))[1]?.status).toBe("expired");
    expect(
      (await events(opened.chainId)).filter(
        (row) => row.name === "approval.resolved",
      ),
    ).toHaveLength(0);
  });

  it("legend-y5q the source module cancels its own request, idempotently; another module cannot", async () => {
    const opened = await openRequired({
      actionType: "void",
      requestedBy: users.cashier,
    });
    const cancel = (sourceModule: string) =>
      withTenant(db, tenantWide, (tx) =>
        cancelApprovalRequest(tx, tenantWide, {
          chainId: opened.chainId,
          sourceModule,
          actorUserId: users.cashier,
        }),
      );
    await expect(cancel("purchasing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await cancel("payment")).toBe("cancelled");
    expect(await cancel("payment")).toBe("cancelled");
    expect(
      (await events(opened.chainId)).filter(
        (row) => row.name === "approval.resolved",
      ),
    ).toHaveLength(1);
    await expect(
      decide(users.supervisor, opened.request.id),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_NOT_PENDING" });
  });
});

describe("legend-y5q tenant and outlet isolation (TEN-01, TEN-03)", () => {
  it("TEN-01 tenant A never reads or decides tenant B approval requests", async () => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO approval_requests
         (id, tenant_id, chain_id, source_module, action_type, object_type, object_id,
          requested_by, source, level, required_levels, required_steps, request_reason, deadline_at)
       VALUES ($1, $2, $1, 'payment', 'void', 'order', $3, $4, 'user', 1, 1, '[]',
               'Permintaan tenant B', now() + interval '1 hour')`,
      [id, tenantB, randomUUID(), tenantBUser],
    );
    await expect(decide(users.hr, id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      getApprovalRequest(tenant, users.hr, id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      expect(
        (
          await client.query("SELECT id FROM approval_requests WHERE id = $1", [
            id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(
            "UPDATE approval_requests SET status = 'cancelled' WHERE id = $1",
            [id],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("TEN-03 an outlet scope sees neither another outlet's rows nor tenant-wide rows, and cannot write them", async () => {
    const atOther = await openRequired({
      actionType: "void",
      requestedBy: users.cashier,
      outletId: bandung2,
    });
    const tenantRow = await openRequired({
      actionType: "payroll",
      requestedBy: users.cashier,
      outletId: null,
      objectType: "payroll_run",
      sourceModule: "payroll",
    });
    const client = await appPool.connect();
    let seen: { rows: { id: string }[] };
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)`,
        [tenantId, JSON.stringify([bandung])],
      );
      seen = await client.query<{ id: string }>(
        "SELECT id FROM approval_requests WHERE id = ANY($1::uuid[])",
        [[atOther.request.id, tenantRow.request.id]],
      );
      // A tenant-wide row cannot be written under an outlet scope either.
      expect(
        (
          await client.query(
            "UPDATE approval_requests SET status = 'cancelled' WHERE id = $1",
            [tenantRow.request.id],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(seen.rows).toEqual([]);
    // Opening a tenant-wide or other-outlet request under an outlet scope fails.
    await expect(
      open(
        { actionType: "void", requestedBy: users.cashier, outletId: bandung2 },
        outletScope(bandung),
      ),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      open(
        {
          actionType: "payroll",
          requestedBy: users.cashier,
          outletId: null,
          objectType: "payroll_run",
        },
        outletScope(bandung),
      ),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
  });

  it("TEN-03 the database refuses a decision by the requester even for a privileged writer", async () => {
    const opened = await openRequired({
      actionType: "void",
      requestedBy: users.cashier,
    });
    await expect(
      owner.query(
        `UPDATE approval_requests SET status = 'approved', decided_by = requested_by,
           decided_at = now(), reason = 'Sendiri' WHERE id = $1`,
        [opened.request.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      owner.query(
        `INSERT INTO approval_requests
           (tenant_id, chain_id, source_module, action_type, object_type, object_id,
            requested_by, source, level, required_levels, required_steps, request_reason, deadline_at)
         VALUES ($1, $2, 'payment', 'void', 'order', $3, $4, 'user', 1, 1, '[]',
                 'Duplikat tertunda', now() + interval '1 hour')`,
        [tenantId, opened.chainId, opened.request.objectId, users.cashier],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
  });
});

describe("legend-y5q inbox HTTP API", () => {
  const unique = () => randomBytes(4).toString("hex");

  async function signedIn(
    templateKey: string,
    scope: { type: string; id?: string },
  ) {
    const client = agent(app);
    const email = await signUp(client, `Approval ${templateKey}`);
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    createdUserIds.push(userId);
    await assign(userId, templateKey, scope);
    await verifySessionMfa(email);
    return { client, userId };
  }

  it("AUTH-06 inbox endpoints: auth, origin, strict body, create, requester view, decision", async () => {
    expect((await agent(app).get("/api/approvals")).status).toBe(401);
    const cashier = await signedIn("cashier", { type: "outlet", id: bandung });
    const supervisor = await signedIn("supervisor", {
      type: "outlet",
      id: bandung,
    });
    const body = {
      actionType: "void",
      objectType: "order",
      objectId: randomUUID(),
      requestReason: `Salah input menu ${unique()}`,
      outletId: bandung,
    };
    expect(
      (await cashier.client.post("/api/approvals").send(body)).status,
    ).toBe(403);
    const strict = await cashier.client
      .post("/api/approvals")
      .set(originHeader)
      .send({ ...body, tenantId });
    expect(strict.status).toBe(422);
    const tenantWideAsk = await cashier.client
      .post("/api/approvals")
      .set(originHeader)
      .send({ ...body, outletId: undefined, objectId: randomUUID() });
    expect(tenantWideAsk.status).toBe(403);

    const key = `http-${randomUUID()}`;
    const created = await cashier.client
      .post("/api/approvals")
      .set(originHeader)
      .set("Idempotency-Key", key)
      .send(body);
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect(created.body.data).toMatchObject({
      status: "pending",
      requestedBy: cashier.userId,
      outletId: bandung,
      source: "user",
    });
    const replay = await cashier.client
      .post("/api/approvals")
      .set(originHeader)
      .set("Idempotency-Key", key)
      .send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(id);

    // The requester (no inbox permission) sees only its own requests.
    const own = await cashier.client.get(`/api/approvals/${id}`);
    expect(own.status).toBe(200);
    const ownList = await cashier.client.get("/api/approvals?limit=100");
    expect(ownList.status).toBe(200);
    expect(
      ownList.body.data.every(
        (row: { requestedBy: string }) => row.requestedBy === cashier.userId,
      ),
    ).toBe(true);

    const inbox = await supervisor.client.get(
      `/api/approvals?status=pending&actionType=void&limit=100`,
    );
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.map((row: { id: string }) => row.id)).toContain(id);

    const self = await cashier.client
      .post(`/api/approvals/${id}/decisions`)
      .set(originHeader)
      .send({ decision: "approved", reason: "Saya setujui sendiri" });
    expect(self.status).toBe(403);
    const decided = await supervisor.client
      .post(`/api/approvals/${id}/decisions`)
      .set(originHeader)
      .send({ decision: "approved", reason: "Salah input terkonfirmasi" });
    expect(decided.status).toBe(200);
    expect(decided.body.data).toMatchObject({
      status: "approved",
      decidedBy: supervisor.userId,
    });
    // An inbox request carries sourceModule "inbox": no module applies an effect.
    const resolved = (await events(id)).at(-1);
    expect(resolved?.payload).toMatchObject({
      sourceModule: "inbox",
      outcome: "approved",
    });
    const missing = await supervisor.client.get(
      `/api/approvals/${randomUUID()}`,
    );
    expect(missing.status).toBe(404);
  });
});
