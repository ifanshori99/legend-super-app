// legend-1164 card F (second opinion 1160, finding P2, money-adjacent): a
// requester's cancel may queue on the chain-head row lock. It must be judged
// with the time AFTER that lock, not with a clock read before waiting for it.
//
// Contract (docs/contracts, `cancelApprovalRequest` in
// packages/shared/src/identity/endpoints.ts, and approval-cancel.test.ts):
//   POST /api/approvals/:requestId/cancel
//   - a pending request past its deadline is a 409 (CONFLICT), stays unresolved
//     and is never announced or audited as cancelled;
//   - a pending request inside its deadline is a 200 with status "cancelled",
//     one approval.resolved event with outcome "cancelled" and an audit row.
//
// Expected behaviour (fail-safe: when in doubt, refuse):
// - a cancel that started before the deadline, queued behind a lock on the
//   chain-head row and got the lock only after the deadline, is refused with
//   409 and rolled back: no `cancelled` status, no `cancelled` event, no
//   cancel audit;
// - control: the same cancel released before the deadline succeeds;
// - the cancel's transition time (`updated_at`) is the post-lock time.
//
// Method (two connections + a barrier, no fixed sleeps): a second connection
// holds `FOR UPDATE` on the chain-head row without changing it. The real HTTP
// cancel starts, and the test waits until PostgreSQL reports a backend blocked
// by exactly that holder; only then does it wait (on a condition) for the real
// clock to pass the release point and commit the holder. Real Express app,
// Better Auth, RBAC and PostgreSQL, like approval-cancel.test.ts.
//
// Assumptions: the spec only says "409 CONFLICT" for an expired request; the
// error body code is asserted as `error.code === "CONFLICT"`. The deadline is
// moved with SQL to a few seconds ahead. A sweep after the refusal may publish
// one `expired` outcome; only the absence of `cancelled` is asserted.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { setAuditWriter, type AuditEntry } from "../services/audit-writer";
import { originHeader, verifySessionMfa } from "./helpers";
import { staffWithRole, type Staff } from "./floor-test-helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const pg = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
// Room between starting the cancel and the deadline, so the call is reliably
// queued before it even on a loaded machine.
const DEADLINE_MARGIN_MS = 10_000;
// Hold time in the "inside the deadline" tests.
const HOLD_MS = 1_500;
// Tolerance for clock drift between Node and the container, far below HOLD_MS.
const DRIFT_TOLERANCE_MS = 500;

const audits: AuditEntry[] = [];
const createdUserIds: string[] = [];
const createdRequestIds: string[] = [];
let requester: Staff;

/** A one-level pending inbox request of `requester`, deadline at `deadline`. */
async function seedPending(deadline: Date): Promise<string> {
  const id = randomUUID();
  await pg.query(
    `INSERT INTO approval_requests
       (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type, object_id,
        requested_by, source, level, required_levels, required_steps, request_reason, deadline_at, created_at)
     VALUES ($1, $2, NULL, $1, 'inbox', 'void', 'order', $3, $4, 'user', 1, 1, '[]',
             'Pelanggan membatalkan pesanan sebelum dapur mulai.', $5, now() - interval '2 hours')`,
    [id, tenantId, randomUUID(), requester.userId, deadline],
  );
  createdRequestIds.push(id);
  return id;
}

type Row = { status: string; updated_at: Date };

async function rowOf(id: string): Promise<Row> {
  const { rows } = await pg.query<Row>(
    "SELECT status, updated_at FROM approval_requests WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function resolvedOutcomes(chainId: string): Promise<unknown[]> {
  const { rows } = await pg.query<{ outcome: unknown }>(
    `SELECT event->'payload'->'outcome' AS outcome FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = 'approval' AND aggregate_id = $2
        AND event->>'name' = 'approval.resolved'`,
    [tenantId, chainId],
  );
  return rows.map((row) => row.outcome);
}

const cancelAudits = (id: string) =>
  audits.filter(
    (row) => row.objectId === id && /cancel/i.test(String(row.action)),
  );

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

/** A backend is blocked by a lock that `holderPid` holds. */
async function blockedBy(holderPid: number): Promise<boolean> {
  const { rows } = await pg.query<{ waiting: number }>(
    `SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE $1 = ANY(pg_blocking_pids(pid))`,
    [holderPid],
  );
  return (rows[0]?.waiting ?? 0) > 0;
}

/**
 * The requester cancels over HTTP while another connection holds the
 * chain-head row. The cancel is queued behind that lock before `releaseWhen()`
 * is awaited and the lock is released. Returns the HTTP response and the clock
 * just before release.
 */
async function cancelQueuedBehindChainLock(options: {
  requestId: string;
  /** The cancel must be queued before this boundary (setup guard). */
  boundary: Date;
  releaseWhen: () => boolean;
}) {
  const holder = await pg.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT id FROM approval_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, options.requestId],
    );
    const pid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    let settled = false;
    const cancelling = requester.client
      .post(`/api/approvals/${options.requestId}/cancel`)
      .set(originHeader)
      .send({})
      .then((response) => response);
    void cancelling.finally(() => {
      settled = true;
    });
    await waitFor(
      () => blockedBy(pid),
      "the cancel to queue behind the chain-head lock",
    );
    expect(settled).toBe(false);
    if (Date.now() >= options.boundary.getTime())
      throw new Error("setup too slow: cancel queued after the boundary");
    await waitFor(options.releaseWhen, "the clock to pass the release point");
    const releasedAt = Date.now();
    await holder.query("COMMIT");
    return { response: await cancelling, releasedAt };
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter({
    record: async (entry) => {
      audits.push(entry);
    },
  });
  requester = await staffWithRole(app, {
    template: "cashier",
    scopeType: "outlet",
    scopeId: bandung,
    label: "Kasir pembatal waktu",
  });
  createdUserIds.push(requester.userId);
  await verifySessionMfa(requester.email);
});

afterAll(async () => {
  setAuditWriter(null);
  await pg.query("DELETE FROM approval_requests WHERE id = ANY($1::uuid[])", [
    createdRequestIds,
  ]);
  await pg.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await pg.end();
});

describe("legend-1164 a requester cancel is judged with the time after the chain lock", () => {
  it("a cancel that started before the deadline but waited on the chain lock past it is refused with 409 and never cancelled", async () => {
    const deadline = new Date(Date.now() + DEADLINE_MARGIN_MS);
    const id = await seedPending(deadline);

    const { response } = await cancelQueuedBehindChainLock({
      requestId: id,
      boundary: deadline,
      releaseWhen: () => Date.now() > deadline.getTime() + 50,
    });

    expect(
      response.status,
      `a late cancel must be refused: ${JSON.stringify(response.body)}`,
    ).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    // Rolled back: not cancelled, nothing announced or audited as cancelled.
    expect((await rowOf(id)).status).not.toBe("cancelled");
    expect(await resolvedOutcomes(id)).not.toContain("cancelled");
    expect(cancelAudits(id)).toHaveLength(0);
  });

  it("a cancel that waited on the chain lock but is still inside the deadline succeeds as cancelled", async () => {
    const id = await seedPending(new Date(Date.now() + 60 * 60_000));
    const startedAt = Date.now();

    const { response } = await cancelQueuedBehindChainLock({
      requestId: id,
      boundary: new Date(startedAt + 60_000),
      releaseWhen: () => Date.now() >= startedAt + HOLD_MS,
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({ id, status: "cancelled" });
    expect((await rowOf(id)).status).toBe("cancelled");
    const outcomes = await resolvedOutcomes(id);
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    expect(outcomes.every((outcome) => outcome === "cancelled")).toBe(true);
    expect(cancelAudits(id)).toHaveLength(1);
  });

  it("the cancel's transition time is the time after the lock, not the clock read before waiting", async () => {
    const id = await seedPending(new Date(Date.now() + 60 * 60_000));
    const startedAt = Date.now();

    const { response, releasedAt } = await cancelQueuedBehindChainLock({
      requestId: id,
      boundary: new Date(startedAt + 60_000),
      releaseWhen: () => Date.now() >= startedAt + HOLD_MS,
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    // Assumption: updated_at records when the request was cancelled.
    expect((await rowOf(id)).updated_at.getTime()).toBeGreaterThanOrEqual(
      releasedAt - DRIFT_TOLERANCE_MS,
    );
  });
});
