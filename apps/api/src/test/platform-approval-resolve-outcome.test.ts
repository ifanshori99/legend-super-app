// resolveApprovalChainOutcome (sub-brief 100, approval expiry race): a source
// module that settles synchronously gets the chain outcome with the deadline
// applied under the chain head lock, so an inbox decision already in flight
// wins and the expiry is announced exactly once. Runs the real service on the
// disposable PostgreSQL (RLS on), like platform-approval.test.ts.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendAccessFixtures,
  type ApprovalActionType,
} from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext, TenantContext } from "@starter/shared/core";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { setAuditWriter, type AuditEntry } from "../services/audit-writer";
import {
  decideApprovalRequest,
  expireDueApprovalRequests,
  openApprovalRequest,
  resolveApprovalChainOutcome,
} from "../services/platform-approval.service";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const ACTION = "void";
const TWO_LEVEL_ACTION = "refund";
const ACTIONS = [ACTION, TWO_LEVEL_ACTION];
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const audits: AuditEntry[] = [];
const createdUserIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];
const users = {} as Record<"cashier" | "supervisor", string>;

const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const tenantWide: ScopedTenantContext = establishScopedTenantContext(tenant, {
  kind: "tenant",
});

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function createUser(name: string, templateKey: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, name, `${id}@example.test`],
  );
  createdUserIds.push(id);
  // Backdated: the container clock may drift from the Node clock.
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, id, await roleIdOf(templateKey), bandung],
  );
  return id;
}

async function openChain(options: {
  now: Date;
  sourceModule?: string;
  actionType?: ApprovalActionType;
}) {
  const result = await withTenant(db, tenantWide, (tx) =>
    openApprovalRequest(tx, tenantWide, {
      sourceModule: options.sourceModule ?? "payment",
      actionType: options.actionType ?? ACTION,
      objectType: "order",
      objectId: randomUUID(),
      amountIdr: null,
      outletId: bandung,
      source: "user",
      requestedBy: users.cashier,
      requestReason: "Pelanggan membatalkan pesanan sebelum dapur mulai.",
      deadlineMinutes: 10,
      now: options.now,
    }),
  );
  if (!result.required) throw new Error("expected an approval requirement");
  return result;
}

function resolve(chainId: string, now: Date, sourceModule = "payment") {
  return withTenant(db, tenantWide, (tx) =>
    resolveApprovalChainOutcome(tx, tenantWide, { chainId, sourceModule, now }),
  );
}

async function resolvedEvents(chainId: string) {
  const { rows } = await owner.query<{ payload: Record<string, unknown> }>(
    `SELECT event->'payload' AS payload FROM domain_event_outbox
     WHERE tenant_id = $1 AND aggregate_type = 'approval' AND aggregate_id = $2
       AND destination = 'cloud-sync' AND event->>'name' = 'approval.resolved'`,
    [tenantId, chainId],
  );
  return rows;
}

async function statusOf(chainId: string) {
  const { rows } = await owner.query<{ status: string }>(
    `SELECT status FROM approval_requests
     WHERE tenant_id = $1 AND chain_id = $2 ORDER BY level DESC LIMIT 1`,
    [tenantId, chainId],
  );
  return rows[0]?.status;
}

/** Blocks until a statement is queued behind another transaction's row lock. */
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
  throw new Error("resolve never queued behind the sweep row lock");
}

const expiredAudits = (requestId: string) =>
  audits.filter(
    (row) => row.action === "approval.expired" && row.objectId === requestId,
  );

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
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, $2, NULL, $3, 1)`,
    [tenantId, ACTION, await roleIdOf("supervisor")],
  );
  // Refunds: supervisor, then outlet manager (two levels).
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, $2, NULL, $3, 1), ($1, $2, NULL, $4, 2)`,
    [
      tenantId,
      TWO_LEVEL_ACTION,
      await roleIdOf("supervisor"),
      await roleIdOf("outlet_manager"),
    ],
  );
  users.cashier = await createUser("Kasir resolve", "cashier");
  users.supervisor = await createUser("Supervisor resolve", "supervisor");
});

afterAll(async () => {
  setAuditWriter(null);
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

describe("resolveApprovalChainOutcome", () => {
  it("stays pending inside the deadline and writes nothing", async () => {
    const opened = await openChain({ now: new Date() });
    expect(await resolve(opened.chainId, new Date())).toBe("pending");
    expect(await statusOf(opened.chainId)).toBe("pending");
    expect(await resolvedEvents(opened.chainId)).toHaveLength(0);
    expect(expiredAudits(opened.request.id)).toHaveLength(0);
  });

  it("expires a level past its deadline once, with the event and audit", async () => {
    const past = new Date(Date.now() - 20 * 60_000);
    const opened = await openChain({ now: past });
    expect(await resolve(opened.chainId, new Date())).toBe("expired");
    expect(await statusOf(opened.chainId)).toBe("expired");
    const events = await resolvedEvents(opened.chainId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      outcome: "expired",
      decidedBy: null,
      requestId: opened.request.id,
    });
    expect(expiredAudits(opened.request.id)).toHaveLength(1);
    expect(expiredAudits(opened.request.id)[0]).toMatchObject({
      actorType: "system",
    });
    // A second call sees the ended chain and does not announce again.
    expect(await resolve(opened.chainId, new Date())).toBe("expired");
    expect(await resolvedEvents(opened.chainId)).toHaveLength(1);
    expect(expiredAudits(opened.request.id)).toHaveLength(1);
    // A late inbox decision is refused.
    await expect(
      decideApprovalRequest(
        tenant,
        users.supervisor,
        opened.request.id,
        { decision: "approved", reason: "Sesuai bukti transaksi." },
        { mfaVerified: true, idempotencyKey: null },
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
  });

  it("does not emit twice when the sweep already expired the level", async () => {
    const past = new Date(Date.now() - 20 * 60_000);
    const opened = await openChain({ now: past });
    await expireDueApprovalRequests(tenantWide);
    expect(await statusOf(opened.chainId)).toBe("expired");
    expect(await resolvedEvents(opened.chainId)).toHaveLength(1);
    expect(expiredAudits(opened.request.id)).toHaveLength(1);
    expect(await resolve(opened.chainId, new Date())).toBe("expired");
    expect(await resolvedEvents(opened.chainId)).toHaveLength(1);
    expect(expiredAudits(opened.request.id)).toHaveLength(1);
  });

  it("reports approved for a chain already approved, even past the deadline", async () => {
    const opened = await openChain({ now: new Date() });
    await decideApprovalRequest(
      tenant,
      users.supervisor,
      opened.request.id,
      { decision: "approved", reason: "Sesuai bukti transaksi." },
      { mfaVerified: true, idempotencyKey: null },
    );
    const later = new Date(Date.now() + 60 * 60_000);
    expect(await resolve(opened.chainId, later)).toBe("approved");
    expect(await statusOf(opened.chainId)).toBe("approved");
    expect(expiredAudits(opened.request.id)).toHaveLength(0);
  });

  it("answers notFound for a source module that did not open the chain", async () => {
    const opened = await openChain({ now: new Date() });
    await expect(
      resolve(opened.chainId, new Date(), "hris"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("waits for a sweep holding the open level and reports expired without a second event", async () => {
    // Two levels: level 1 approved in the past, level 2 already due.
    // legend-1151: decide never skips the server clock, so level 1 is approved
    // now and level 2 is then moved past its deadline.
    const opened = await openChain({
      now: new Date(),
      actionType: TWO_LEVEL_ACTION,
    });
    await decideApprovalRequest(
      tenant,
      users.supervisor,
      opened.request.id,
      { decision: "approved", reason: "Sesuai bukti transaksi." },
      { mfaVerified: true, idempotencyKey: null },
    );
    const { rows } = await owner.query<{ id: string; status: string }>(
      `SELECT id, status FROM approval_requests
       WHERE tenant_id = $1 AND chain_id = $2 ORDER BY level`,
      [tenantId, opened.chainId],
    );
    expect(rows.map((row) => row.status)).toEqual(["approved", "pending"]);
    const levelTwo = rows[1]!.id;
    await owner.query(
      `UPDATE approval_requests
         SET created_at = now() - interval '2 hours',
             deadline_at = now() - interval '1 minute'
       WHERE id = $1`,
      [levelTwo],
    );
    const eventsBefore = (await resolvedEvents(opened.chainId)).length;

    // The sweep locks the due row (not the chain head) and expires it,
    // uncommitted, emitting nothing here.
    const sweep = await owner.connect();
    try {
      await sweep.query("BEGIN");
      await sweep.query(
        `SELECT id FROM approval_requests WHERE id = $1 FOR UPDATE`,
        [levelTwo],
      );
      await sweep.query(
        `UPDATE approval_requests SET status = 'expired', updated_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [levelTwo],
      );
      // resolve locks the head, reads level 2 pending, and queues on its
      // conditional UPDATE behind the sweep's row lock.
      let settled = false;
      const resolving = resolve(opened.chainId, new Date()).finally(() => {
        settled = true;
      });
      await waitForApprovalLockWaiter();
      expect(settled).toBe(false);
      await sweep.query("COMMIT");
      expect(await resolving).toBe("expired");
    } finally {
      await sweep.query("ROLLBACK").catch(() => undefined);
      sweep.release();
    }
    expect(await statusOf(opened.chainId)).toBe("expired");
    expect(await resolvedEvents(opened.chainId)).toHaveLength(eventsBefore);
    expect(expiredAudits(levelTwo)).toHaveLength(0);
  });
});
