// legend-1151 (brief 1151, finding P1 of second opinion 1148, money-adjacent):
// a caller-supplied `options.now` must never let a decision be judged with an
// older clock than the server's. Production callers (inventory-count,
// hris-attendance-correction, hris-leave, ...) take `now` BEFORE their own
// pre-checks and pass it on, so the deadline can pass before the decision
// function is even entered.
//
// Expected behaviour (CTO decision, fail-safe, the later time wins):
// - the check time is the MAXIMUM of the caller's `now` and the server clock
//   read after the locks; the server clock is never skipped because `now` is
//   given;
// - a level whose deadline passed before the call is refused as expired
//   (APPROVAL_REQUEST_EXPIRED), never approved, with no decision recorded;
// - an approver whose role assignment ended before the call is refused;
// - `decided_at` is the check time, not the caller's stale clock;
// - a caller `now` LATER than the server clock still counts (tests and
//   callers may simulate a later time), so such a level is expired.
//
// Method: open a one-level chain whose deadline is a few seconds ahead, take
// the caller's `now` while it is still before the deadline, wait on a
// condition (real clock past the deadline) and only then call the decision
// with the stale `now`. No lock is involved: the staleness is purely the
// caller's. Runs the real service on the disposable PostgreSQL, like
// platform-approval-post-lock-time.test.ts.
//
// Assumptions: the refusal for an ended role assignment has no documented
// code, so only "rejects and the request stays pending" is asserted. The
// minimum caller-chosen deadline is 5 minutes, so the boundary is placed by
// backdating the opening `now`. A late reject gets APPROVAL_REQUEST_EXPIRED
// like a late approve (same assumption as platform-approval-post-lock-time).
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
const ACTIONS = [ONE_LEVEL];
const MIN_DEADLINE_MS = 5 * 60_000;
// Room between opening and taking the caller's `now`, so that `now` is
// reliably before the boundary even on a loaded machine.
const BOUNDARY_MARGIN_MS = 6_000;
// How stale the caller's clock is in the "decided_at" test. Far larger than
// any plausible clock drift between Node and the container.
const STALE_MS = 60_000;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
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
  deadline_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
};

async function levels(chainId: string): Promise<LevelRow[]> {
  const { rows } = await owner.query<LevelRow>(
    `SELECT id, level, status, deadline_at, decided_at, decided_by
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

type Outcome = { ok: boolean; error?: unknown };

/**
 * A decision refused as expired: the throw rolls the transaction back, so the
 * stored level stays 'pending' until the sweep (same as the precedent in
 * platform-approval-post-lock-time.test.ts), but no decision is recorded,
 * nothing was announced as approved, and reads fail closed as expired.
 */
async function expectRefusedAsExpired(
  chainId: string,
  requestId: string,
  outcome: Outcome,
  options: { readsAsExpired?: boolean } = {},
) {
  expect(outcome.ok).toBe(false);
  expect(outcome.error).toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
  const [level] = await levels(chainId);
  expect(["approved", "rejected"]).not.toContain(level?.status);
  expect(level?.decided_by).toBeNull();
  expect(level?.decided_at).toBeNull();
  expect(await resolvedOutcomes(chainId)).not.toContain("approved");
  // Reads use the real clock, so only a deadline really in the past reads
  // as expired (not one passed only by a caller's later `now`).
  if (options.readsAsExpired ?? true) {
    const seen = await getApprovalRequest(tenant, users.supervisor, requestId);
    expect(seen.status).toBe("expired");
  }
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

/** Decides with an explicit caller `now`, exactly as a module caller does. */
async function decideWithCallerNow(options: {
  requestId: string;
  userId: string;
  decision: "approved" | "rejected";
  now: Date;
}): Promise<Outcome & { value?: unknown }> {
  return decideApprovalRequest(
    tenant,
    options.userId,
    options.requestId,
    { decision: options.decision, reason: "Sesuai bukti transaksi." },
    { mfaVerified: true, idempotencyKey: null, now: options.now },
  ).then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

/**
 * Opens a chain due in a few seconds, takes the caller's `now` before the
 * deadline, then waits (on the real clock) until the deadline has passed.
 */
async function chainPastDeadlineWithStaleNow(actionType: ApprovalActionType) {
  const opened = await openChainDueSoon(actionType);
  const deadline = (await levels(opened.chainId))[0]!.deadline_at;
  const callerNow = new Date();
  if (callerNow.getTime() >= deadline.getTime())
    throw new Error("setup too slow: caller now is not before the deadline");
  await waitFor(
    () => Date.now() > deadline.getTime() + 50,
    "the real clock to pass the deadline",
  );
  return { opened, deadline, callerNow };
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
  users.cashier = await createUser("Kasir now-lama", "cashier");
  users.supervisor = await createUser("Supervisor now-lama", "supervisor");
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

describe("legend-1151 a stale caller `now` never overrides the server clock", () => {
  it("an approval whose caller `now` is before the deadline but whose call enters after the deadline is refused as expired and never approved", async () => {
    const { opened, callerNow } =
      await chainPastDeadlineWithStaleNow(ONE_LEVEL);
    const outcome = await decideWithCallerNow({
      requestId: opened.request.id,
      userId: users.supervisor,
      decision: "approved",
      now: callerNow,
    });
    await expectRefusedAsExpired(opened.chainId, opened.request.id, outcome);
  });

  it("a rejection with a stale caller `now` after the deadline is also refused as expired and never recorded", async () => {
    const { opened, callerNow } =
      await chainPastDeadlineWithStaleNow(ONE_LEVEL);
    const outcome = await decideWithCallerNow({
      requestId: opened.request.id,
      userId: users.supervisor,
      decision: "rejected",
      now: callerNow,
    });
    await expectRefusedAsExpired(opened.chainId, opened.request.id, outcome);
  });

  it("an approver whose role assignment ended before the call is refused even though the caller `now` is still inside the role window", async () => {
    const validUntil = new Date(Date.now() + BOUNDARY_MARGIN_MS);
    const shortLived = await createUser(
      "Supervisor sementara now-lama",
      "supervisor",
      validUntil,
    );
    // Long deadline: only the approver's role window closes.
    const opened = await openChain({
      now: new Date(),
      actionType: ONE_LEVEL,
      deadlineMinutes: 60,
    });
    const callerNow = new Date();
    if (callerNow.getTime() >= validUntil.getTime())
      throw new Error("setup too slow: caller now is not before the end");
    await waitFor(
      () => Date.now() > validUntil.getTime() + 50,
      "the real clock to pass the end of the role assignment",
    );
    const outcome = await decideWithCallerNow({
      requestId: opened.request.id,
      userId: shortLived,
      decision: "approved",
      now: callerNow,
    });
    expect(outcome.ok).toBe(false);
    const [level] = await levels(opened.chainId);
    expect(level?.status).toBe("pending");
    expect(level?.decided_at).toBeNull();
    expect(level?.decided_by).toBeNull();
  });

  it("a decision inside the deadline with a stale caller `now` is recorded with the server time, not the stale caller time", async () => {
    // Opened earlier than the stale `now`, so that `now` is a valid time
    // for the level (not before its creation).
    const opened = await openChain({
      now: new Date(Date.now() - 2 * STALE_MS),
      actionType: ONE_LEVEL,
      deadlineMinutes: 60,
    });
    const staleNow = new Date(Date.now() - STALE_MS);
    const outcome = await decideWithCallerNow({
      requestId: opened.request.id,
      userId: users.supervisor,
      decision: "approved",
      now: staleNow,
    });
    expect(outcome.ok, JSON.stringify(outcome.error)).toBe(true);
    const [level] = await levels(opened.chainId);
    expect(level?.status).toBe("approved");
    expect(level?.decided_by).toBe(users.supervisor);
    // decided_at is the check time: at least half the staleness later than
    // the caller's clock (the server clock was read at the call).
    expect(level!.decided_at!.getTime()).toBeGreaterThanOrEqual(
      staleNow.getTime() + STALE_MS / 2,
    );
  });

  it("a caller `now` later than the server clock still counts: past the deadline it is refused as expired (the later time wins)", async () => {
    // Regression guard of the "maximum" rule: this already holds today and
    // must keep holding after the fix.
    const opened = await openChain({
      now: new Date(),
      actionType: ONE_LEVEL,
      deadlineMinutes: 60,
    });
    const deadline = (await levels(opened.chainId))[0]!.deadline_at;
    const outcome = await decideWithCallerNow({
      requestId: opened.request.id,
      userId: users.supervisor,
      decision: "approved",
      now: new Date(deadline.getTime() + 60_000),
    });
    await expectRefusedAsExpired(opened.chainId, opened.request.id, outcome, {
      readsAsExpired: false,
    });
  });
});
