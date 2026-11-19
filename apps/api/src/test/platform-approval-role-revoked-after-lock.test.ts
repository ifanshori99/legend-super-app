// legend-k8g62 (brief 1164 card C, money/access, fail-closed): the approver's
// role and scope must be judged AFTER the chain-head row lock, not only before.
//
// Expected behaviour (from the card; when in doubt, refuse):
// - an approver whose role assignment is revoked (row removed, or window
//   closed) while the decision waits on the chain lock is refused, and the
//   level stays pending with no decision recorded;
// - an approver whose assignment is moved to another outlet (scope no longer
//   covers the request's outlet) while waiting is refused the same way;
// - control: with no change during the wait the same decision succeeds, so
//   the refusals above are caused by the revocation and not by the setup.
//
// Method: another connection holds `FOR UPDATE` on the level-1 row and, inside
// that same transaction, changes the approver's assignment. The decision starts
// (its first check sees the old, committed assignment), queues behind the lock,
// and the holder commits. Only the post-lock state differs from the pre-lock
// state. The wait polls for a lock waiter; it is not a fixed sleep. Runs the
// real service on the disposable PostgreSQL, like
// platform-approval-post-lock-time.test.ts.
//
// Assumptions: the refusal has no documented code, so only "rejects, level
// stays pending, nothing announced as approved" is asserted. Revocation is
// modelled as DELETE of the assignment (and, separately, as a closed
// window); scope loss as moving the assignment to another outlet.
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
import { setAuditWriter } from "../services/audit-writer";
import {
  decideApprovalRequest,
  openApprovalRequest,
} from "../services/platform-approval.service";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const bandung2 = cafeLegendAccessFixtures.outletIds.bandung2;
const ONE_LEVEL = "void";
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUserIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];
let cashierId = "";

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

async function createUser(
  name: string,
  templateKey: string,
): Promise<{ userId: string; assignmentId: string }> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, name, `${id}@example.test`],
  );
  createdUserIds.push(id);
  // Backdated: the container clock may drift from the Node clock.
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', NULL, $2)
     RETURNING id`,
    [tenantId, id, await roleIdOf(templateKey), bandung],
  );
  return { userId: id, assignmentId: rows[0]!.id };
}

async function openChain(actionType: ApprovalActionType) {
  const result = await withTenant(db, tenantWide, (tx) =>
    openApprovalRequest(tx, tenantWide, {
      sourceModule: "payment",
      actionType,
      objectType: "order",
      objectId: randomUUID(),
      amountIdr: null,
      outletId: bandung,
      source: "user",
      requestedBy: cashierId,
      requestReason: "Pelanggan membatalkan pesanan sebelum dapur mulai.",
      deadlineMinutes: 60,
      now: new Date(),
    }),
  );
  if (!result.required) throw new Error("expected an approval requirement");
  return result;
}

type LevelRow = {
  status: string;
  decided_at: Date | null;
  decided_by: string | null;
};

async function levels(chainId: string): Promise<LevelRow[]> {
  const { rows } = await owner.query<LevelRow>(
    `SELECT status, decided_at, decided_by
     FROM approval_requests WHERE tenant_id = $1 AND chain_id = $2
     ORDER BY level`,
    [tenantId, chainId],
  );
  return rows;
}

async function resolvedOutcomes(chainId: string): Promise<unknown[]> {
  const { rows } = await owner.query<{ outcome: unknown }>(
    `SELECT event->'payload'->'outcome' AS outcome FROM domain_event_outbox
     WHERE tenant_id = $1 AND aggregate_type = 'approval' AND aggregate_id = $2
       AND event->>'name' = 'approval.resolved'`,
    [tenantId, chainId],
  );
  return rows.map((row) => row.outcome);
}

async function waitFor(
  condition: () => Promise<boolean> | boolean,
  what: string,
): Promise<void> {
  // ~15 s budget; the wait is on a condition, not a fixed delay.
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function lockWaiterPresent(): Promise<boolean> {
  const { rows } = await owner.query<{ waiting: number }>(
    `SELECT count(*)::int AS waiting FROM pg_stat_activity
     WHERE datname = current_database() AND state = 'active'
       AND wait_event_type = 'Lock' AND query ILIKE '%approval_requests%'`,
  );
  return (rows[0]?.waiting ?? 0) > 0;
}

/**
 * The decision starts while the holder owns the level-1 row lock; the holder
 * changes the approver's access inside its own transaction (invisible to the
 * decision until commit), then commits so the decision proceeds.
 */
async function decideWhileAccessChanges(options: {
  chainId: string;
  requestId: string;
  userId: string;
  changeAccess: (holder: {
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
  }) => Promise<void>;
}) {
  const holder = await owner.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      `SELECT id FROM approval_requests
       WHERE tenant_id = $1 AND chain_id = $2 AND level = 1 FOR UPDATE`,
      [tenantId, options.chainId],
    );
    let settled = false;
    const deciding = decideApprovalRequest(
      tenant,
      options.userId,
      options.requestId,
      { decision: "approved", reason: "Sesuai bukti transaksi." },
      { mfaVerified: true, idempotencyKey: null },
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    void deciding.finally(() => {
      settled = true;
    });
    await waitFor(lockWaiterPresent, "the decision to queue behind the lock");
    expect(settled).toBe(false);
    await options.changeAccess(holder);
    await holder.query("COMMIT");
    return await deciding;
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
}

async function expectRefusedAndPending(
  chainId: string,
  outcome: { ok: boolean },
) {
  expect(outcome.ok).toBe(false);
  const [level] = await levels(chainId);
  expect(level?.status).toBe("pending");
  expect(level?.decided_by).toBeNull();
  expect(level?.decided_at).toBeNull();
  expect(await resolvedOutcomes(chainId)).not.toContain("approved");
}

beforeAll(async () => {
  setAuditWriter({ record: async () => undefined });
  savedPolicies = (
    await owner.query(
      `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = $2`,
      [tenantId, ONE_LEVEL],
    )
  ).rows;
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = $2`,
    [tenantId, ONE_LEVEL],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, $2, NULL, $3, 1)`,
    [tenantId, ONE_LEVEL, await roleIdOf("supervisor")],
  );
  cashierId = (await createUser("Kasir cabut-peran", "cashier")).userId;
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query(
    `DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = $2`,
    [tenantId, ONE_LEVEL],
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

describe("legend-k8g62 approver access is judged again after the chain lock", () => {
  it("control: an approver whose access does not change while waiting on the lock can approve", async () => {
    const approver = await createUser("Supervisor tetap", "supervisor");
    const opened = await openChain(ONE_LEVEL);
    const outcome = await decideWhileAccessChanges({
      chainId: opened.chainId,
      requestId: opened.request.id,
      userId: approver.userId,
      changeAccess: async () => undefined,
    });
    expect(outcome.ok).toBe(true);
    const [level] = await levels(opened.chainId);
    expect(level?.status).toBe("approved");
    expect(level?.decided_by).toBe(approver.userId);
  });

  it("an approver whose role assignment was removed while waiting on the lock is refused and the request stays pending", async () => {
    const approver = await createUser("Supervisor dicabut", "supervisor");
    const opened = await openChain(ONE_LEVEL);
    const outcome = await decideWhileAccessChanges({
      chainId: opened.chainId,
      requestId: opened.request.id,
      userId: approver.userId,
      changeAccess: async (holder) => {
        await holder.query("DELETE FROM role_assignments WHERE id = $1", [
          approver.assignmentId,
        ]);
      },
    });
    await expectRefusedAndPending(opened.chainId, outcome);
  });

  it("an approver whose assignment window was closed while waiting on the lock is refused and the request stays pending", async () => {
    const approver = await createUser("Supervisor berakhir", "supervisor");
    const opened = await openChain(ONE_LEVEL);
    const outcome = await decideWhileAccessChanges({
      chainId: opened.chainId,
      requestId: opened.request.id,
      userId: approver.userId,
      changeAccess: async (holder) => {
        // valid_until is exclusive and must stay >= valid_from.
        await holder.query(
          "UPDATE role_assignments SET valid_until = valid_from WHERE id = $1",
          [approver.assignmentId],
        );
      },
    });
    await expectRefusedAndPending(opened.chainId, outcome);
  });

  it("an approver whose scope was moved to another outlet while waiting on the lock is refused and the request stays pending", async () => {
    const approver = await createUser("Supervisor pindah", "supervisor");
    const opened = await openChain(ONE_LEVEL);
    const outcome = await decideWhileAccessChanges({
      chainId: opened.chainId,
      requestId: opened.request.id,
      userId: approver.userId,
      changeAccess: async (holder) => {
        await holder.query(
          "UPDATE role_assignments SET scope_id = $2 WHERE id = $1",
          [approver.assignmentId, bandung2],
        );
      },
    });
    await expectRefusedAndPending(opened.chainId, outcome);
  });
});
