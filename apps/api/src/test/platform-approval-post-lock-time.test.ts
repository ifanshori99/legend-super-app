// legend-ijy8u (brief 1137 card 2, money-adjacent): a decision that waited on
// the chain-head row lock must be judged with the time AFTER the lock, not the
// time taken when the call started.
//
// Expected behaviour (from the card, fail-safe: when in doubt, refuse):
// - a level whose deadline passed while the decision queued behind the lock is
//   refused as expired (APPROVAL_REQUEST_EXPIRED), never approved;
// - an approver whose role assignment ended while queued is refused;
// - a next level opened by that decision is stamped with post-lock time.
//
// Method: another connection holds `FOR UPDATE` on the level-1 row, the
// decision starts (no `now` option, so the service takes the real clock),
// queues behind the lock, and we release it only after the real clock passed
// the boundary. The waits poll a condition (lock waiter present, clock past
// the boundary); they are not fixed sleeps. Runs the real service on the
// disposable PostgreSQL, like platform-approval-resolve-outcome.test.ts.
//
// Assumptions: the refusal for an ended role assignment has no documented
// code, so only "rejects and the request stays pending" is asserted. The
// minimum caller-chosen deadline is 5 minutes, so the boundary is placed by
// backdating the opening `now`.
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
  getApprovalRequest,
  openApprovalRequest,
} from "../services/platform-approval.service";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const ONE_LEVEL = "void";
const TWO_LEVEL = "refund";
const ACTIONS = [ONE_LEVEL, TWO_LEVEL];
const MIN_DEADLINE_MS = 5 * 60_000;
// Room between opening and the decision call, so the call's own clock is
// reliably before the boundary even on a loaded machine.
const BOUNDARY_MARGIN_MS = 6_000;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
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

async function createUser(
  name: string,
  templateKey: string,
  validUntil: Date | null = null,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, name, `${id}@example.test`],
  );
  createdUserIds.push(id);
  // Backdated: the container clock may drift from the Node clock.
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $5, $2)`,
    [tenantId, id, await roleIdOf(templateKey), bandung, validUntil],
  );
  return id;
}

async function openChain(options: {
  now: Date;
  actionType: ApprovalActionType;
  deadlineMinutes: number;
}) {
  const result = await withTenant(db, tenantWide, (tx) =>
    openApprovalRequest(tx, tenantWide, {
      sourceModule: "payment",
      actionType: options.actionType,
      objectType: "order",
      objectId: randomUUID(),
      amountIdr: null,
      outletId: bandung,
      source: "user",
      requestedBy: users.cashier,
      requestReason: "Pelanggan membatalkan pesanan sebelum dapur mulai.",
      deadlineMinutes: options.deadlineMinutes,
      now: options.now,
    }),
  );
  if (!result.required) throw new Error("expected an approval requirement");
  return result;
}

/** One-level chain whose deadline lies `BOUNDARY_MARGIN_MS` after real now. */
function openChainDueSoon(actionType: ApprovalActionType) {
  return openChain({
    now: new Date(Date.now() - MIN_DEADLINE_MS + BOUNDARY_MARGIN_MS),
    actionType,
    deadlineMinutes: 5,
  });
}

type LevelRow = {
  id: string;
  level: number;
  status: string;
  created_at: Date;
  deadline_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
};

async function levels(chainId: string): Promise<LevelRow[]> {
  const { rows } = await owner.query<LevelRow>(
    `SELECT id, level, status, created_at, deadline_at, decided_at, decided_by
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

/**
 * A decision refused as expired after the lock: the throw rolls the
 * transaction back, so the stored level stays 'pending' until the sweep
 * (same as the y5q precedent in platform-approval.test.ts), but no decision
 * is recorded, nothing was announced as approved, and reads fail closed as
 * expired.
 */
async function expectRefusedAsExpired(
  chainId: string,
  requestId: string,
  outcome: { ok: boolean; error?: unknown },
) {
  expect(outcome.ok).toBe(false);
  expect(outcome.error).toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
  const [level] = await levels(chainId);
  expect(["approved", "rejected"]).not.toContain(level?.status);
  expect(level?.decided_by).toBeNull();
  expect(level?.decided_at).toBeNull();
  expect(await resolvedOutcomes(chainId)).not.toContain("approved");
  const seen = await getApprovalRequest(tenant, users.supervisor, requestId);
  expect(seen.status).toBe("expired");
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
 * Starts a decision with the real clock, queues it behind a lock on the
 * chain's level-1 row, keeps the lock until `releaseWhen()` is true, then
 * releases it. Returns the settled outcome and the clock just before the
 * release (the post-lock time is at or after it).
 */
async function decideQueuedBehindLock(options: {
  chainId: string;
  requestId: string;
  userId: string;
  decision: "approved" | "rejected";
  /** Explicit caller clock, as production callers (hris-leave, inventory-count) pass. */
  now?: Date;
  /** The call's own clock must be before this boundary (setup guard). */
  boundary: Date;
  releaseWhen: () => boolean;
}) {
  const holder = await owner.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      `SELECT id FROM approval_requests
       WHERE tenant_id = $1 AND chain_id = $2 AND level = 1 FOR UPDATE`,
      [tenantId, options.chainId],
    );
    const calledAt = Date.now();
    if (calledAt >= options.boundary.getTime())
      throw new Error("setup too slow: call started after the boundary");
    let settled = false;
    const deciding = decideApprovalRequest(
      tenant,
      options.userId,
      options.requestId,
      { decision: options.decision, reason: "Sesuai bukti transaksi." },
      { mfaVerified: true, idempotencyKey: null, now: options.now },
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    void deciding.finally(() => {
      settled = true;
    });
    await waitFor(lockWaiterPresent, "the decision to queue behind the lock");
    expect(settled).toBe(false);
    await waitFor(options.releaseWhen, "the clock to pass the release point");
    const releasedAt = Date.now();
    await holder.query("COMMIT");
    return { outcome: await deciding, releasedAt };
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
}

beforeAll(async () => {
  setAuditWriter({ record: async () => undefined });
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
    [tenantId, ONE_LEVEL, await roleIdOf("supervisor")],
  );
  // Refunds: supervisor, then outlet manager (two levels).
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, $2, NULL, $3, 1), ($1, $2, NULL, $4, 2)`,
    [
      tenantId,
      TWO_LEVEL,
      await roleIdOf("supervisor"),
      await roleIdOf("outlet_manager"),
    ],
  );
  users.cashier = await createUser("Kasir post-lock", "cashier");
  users.supervisor = await createUser("Supervisor post-lock", "supervisor");
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

describe("legend-ijy8u approval decisions use the time after the chain lock", () => {
  it("an approval that started before the deadline but waited on the lock past it is refused as expired (fail closed) and never approved", async () => {
    const opened = await openChainDueSoon(ONE_LEVEL);
    const deadline = (await levels(opened.chainId))[0]!.deadline_at;
    const { outcome } = await decideQueuedBehindLock({
      chainId: opened.chainId,
      requestId: opened.request.id,
      userId: users.supervisor,
      decision: "approved",
      boundary: deadline,
      releaseWhen: () => Date.now() > deadline.getTime() + 50,
    });
    await expectRefusedAsExpired(opened.chainId, opened.request.id, outcome);
  });

  it("a rejection that waited on the lock past the deadline is also refused as expired and never recorded as a decision", async () => {
    // Assumption: an expired level accepts no decision of any kind, so a late
    // reject gets the same APPROVAL_REQUEST_EXPIRED as a late approve.
    const opened = await openChainDueSoon(ONE_LEVEL);
    const deadline = (await levels(opened.chainId))[0]!.deadline_at;
    const { outcome } = await decideQueuedBehindLock({
      chainId: opened.chainId,
      requestId: opened.request.id,
      userId: users.supervisor,
      decision: "rejected",
      boundary: deadline,
      releaseWhen: () => Date.now() > deadline.getTime() + 50,
    });
    await expectRefusedAsExpired(opened.chainId, opened.request.id, outcome);
  });

  it("an approval called with an explicit now before the deadline that waited on the lock past it is refused as expired and never approved", async () => {
    // Production callers pass `now` themselves; the wait on the lock must
    // still count, so the decision is judged after the wait.
    const opened = await openChainDueSoon(ONE_LEVEL);
    const deadline = (await levels(opened.chainId))[0]!.deadline_at;
    const { outcome } = await decideQueuedBehindLock({
      chainId: opened.chainId,
      requestId: opened.request.id,
      userId: users.supervisor,
      decision: "approved",
      now: new Date(),
      boundary: deadline,
      releaseWhen: () => Date.now() > deadline.getTime() + 50,
    });
    await expectRefusedAsExpired(opened.chainId, opened.request.id, outcome);
  });

  it("an approver whose role assignment ended while the decision waited on the lock is refused and the request stays pending", async () => {
    const validUntil = new Date(Date.now() + BOUNDARY_MARGIN_MS);
    const shortLived = await createUser(
      "Supervisor sementara",
      "supervisor",
      validUntil,
    );
    // Long deadline: only the approver's role window closes during the wait.
    const opened = await openChain({
      now: new Date(),
      actionType: ONE_LEVEL,
      deadlineMinutes: 60,
    });
    const { outcome } = await decideQueuedBehindLock({
      chainId: opened.chainId,
      requestId: opened.request.id,
      userId: shortLived,
      decision: "approved",
      boundary: validUntil,
      releaseWhen: () => Date.now() > validUntil.getTime() + 50,
    });
    expect(outcome.ok).toBe(false);
    const [level] = await levels(opened.chainId);
    expect(level?.status).toBe("pending");
    expect(level?.decided_at).toBeNull();
  });

  it("an approval that waited on the lock but is still inside the deadline succeeds, and the next level is stamped with the post-lock time", async () => {
    const opened = await openChain({
      now: new Date(),
      actionType: TWO_LEVEL,
      deadlineMinutes: 60,
    });
    const startedAt = Date.now();
    const { outcome, releasedAt } = await decideQueuedBehindLock({
      chainId: opened.chainId,
      requestId: opened.request.id,
      userId: users.supervisor,
      decision: "approved",
      boundary: new Date(startedAt + 60_000),
      // Long enough that a pre-lock clock is clearly earlier than post-lock.
      releaseWhen: () => Date.now() >= startedAt + 1_500,
    });
    expect(outcome.ok).toBe(true);
    const rows = await levels(opened.chainId);
    expect(rows.map((row) => row.status)).toEqual(["approved", "pending"]);
    // The decision and the level it opens happened after the lock was
    // released, so neither may carry the earlier pre-lock clock.
    expect(rows[0]!.decided_at!.getTime()).toBeGreaterThanOrEqual(releasedAt);
    expect(rows[1]!.created_at.getTime()).toBeGreaterThanOrEqual(releasedAt);
  });
});
