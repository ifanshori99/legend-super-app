// legend-52e52 (follow-up of legend-1164 card F, second opinion 1160): a source
// module that withdraws its approval request through the shared
// `cancelApprovalRequest` (refund, manual and recurring journal, profit-share
// distribution and registry, settlement import) may queue on the chain-head row
// lock. When it gets the lock only after the open level's deadline, the level
// has already lapsed: the outcome is "expired", never "cancelled".
//
// Expected behaviour (fail-safe: when in doubt, report the outcome that limits
// payment, and never abort a system caller):
// - queued before the deadline, lock released after it: the call returns
//   "expired" (it does not throw), the row is `expired`, the announced
//   outcomes never contain `cancelled`, no `approval.cancelled` audit row is
//   written (an `approval.expired` one is);
// - control: the same call with the lock released before the deadline returns
//   "cancelled" with exactly one cancelled outcome and one cancelled audit;
// - the expiry is stamped with the time after the lock grant (`updated_at`).
//
// Method (two connections + a barrier, no fixed sleeps), modelled on
// platform-approval-cancel-lock-time.test.ts: a second connection holds
// `FOR UPDATE` on the chain-head row without changing it. The module call
// (`cancelApprovalRequest` inside `withTenant`, exactly as modules call it)
// starts, and the test waits until PostgreSQL reports a backend blocked by that
// holder; only then does it wait, on a condition, for the real clock to pass
// the release point and commit the holder. Real services on the disposable
// PostgreSQL with RLS on.
//
// Assumptions: the spec text is the brief's decision, not a published contract.
// Chains are seeded with SQL like the sibling test (one level, chain id = row
// id) so no approval policy is needed; `source_module` is set to the module's
// real exported constant. The announced outcome is read from
// `approval.resolved` events. The audit action names `approval.cancelled` and
// `approval.expired` are taken from the brief.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { setAuditWriter, type AuditEntry } from "../services/audit-writer";
import { cancelApprovalRequest } from "../services/platform-approval.service";
import { REFUND_SOURCE_MODULE } from "../services/payment-refund.service";
import { JOURNAL_APPROVAL_SOURCE_MODULE } from "../services/accounting-journal-period-gate";
import { PROFIT_SHARE_APPROVAL_SOURCE_MODULE } from "../services/profit-share-approval";
import { RECONCILIATION_SOURCE_MODULE } from "../services/payment-admin-reconciliation.service";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const pg = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);

// Room between starting the call and the deadline, so it is reliably queued
// before it even on a loaded machine.
const DEADLINE_MARGIN_MS = 5_000;
// Hold time in the "inside the deadline" control.
const HOLD_MS = 1_500;
// Tolerance for clock drift between Node and the container, far below HOLD_MS.
const DRIFT_TOLERANCE_MS = 500;

type Case = {
  readonly label: string;
  readonly sourceModule: string;
  // Any action type the approval table accepts.
  readonly actionType: string;
  // Settlement import calls with actorUserId null (system): it must not abort.
  readonly actor: "user" | "system";
};

const CASES: readonly Case[] = [
  {
    label: "refund",
    sourceModule: REFUND_SOURCE_MODULE,
    actionType: "refund",
    actor: "user",
  },
  {
    label: "manual and recurring journal",
    sourceModule: JOURNAL_APPROVAL_SOURCE_MODULE,
    actionType: "expense",
    actor: "user",
  },
  {
    label: "profit-share distribution and registry",
    sourceModule: PROFIT_SHARE_APPROVAL_SOURCE_MODULE,
    actionType: "payroll",
    actor: "user",
  },
  {
    label: "settlement import (system caller)",
    sourceModule: RECONCILIATION_SOURCE_MODULE,
    actionType: "refund",
    actor: "system",
  },
];

const audits: AuditEntry[] = [];
const createdRequestIds: string[] = [];
let actorUserId: string;

/** A one-level pending request of `sourceModule`, deadline at `deadline`. */
async function seedPending(testCase: Case, deadline: Date): Promise<string> {
  const id = randomUUID();
  await pg.query(
    `INSERT INTO approval_requests
       (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type, object_id,
        requested_by, source, level, required_levels, required_steps, request_reason, deadline_at, created_at)
     VALUES ($1, $2, $3, $1, $4, $5, 'order', $6, $7, 'user', 1, 1, '[]',
             'Modul menarik permintaan persetujuan yang masih menunggu.', $8, now() - interval '2 hours')`,
    [
      id,
      tenantId,
      bandung,
      testCase.sourceModule,
      testCase.actionType,
      randomUUID(),
      actorUserId,
      deadline,
    ],
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

const auditsOf = (id: string, action: string) =>
  audits.filter((row) => row.objectId === id && row.action === action);

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
 * The module calls `cancelApprovalRequest` while another connection holds the
 * chain-head row. The call is queued behind that lock before `releaseWhen()` is
 * awaited and the lock is released. Returns the call's outcome and the clock
 * just before release.
 */
async function cancelQueuedBehindChainLock(options: {
  testCase: Case;
  chainId: string;
  /** The call must be queued before this boundary (setup guard). */
  boundary: Date;
  releaseWhen: () => boolean;
}) {
  const holder = await pg.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT id FROM approval_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, options.chainId],
    );
    const pid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    let settled = false;
    const cancelling = withTenant(db, tenantWide, (tx) =>
      cancelApprovalRequest(tx, tenantWide, {
        chainId: options.chainId,
        sourceModule: options.testCase.sourceModule,
        actorUserId: options.testCase.actor === "user" ? actorUserId : null,
      }),
    );
    void cancelling.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitFor(
      () => blockedBy(pid),
      "the module call to queue behind the chain-head lock",
    );
    expect(settled).toBe(false);
    if (Date.now() >= options.boundary.getTime())
      throw new Error("setup too slow: call queued after the boundary");
    await waitFor(options.releaseWhen, "the clock to pass the release point");
    const releasedAt = Date.now();
    await holder.query("COMMIT");
    return { outcome: await cancelling, releasedAt };
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
  actorUserId = randomUUID();
  await pg.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [
    actorUserId,
    "Modul pembatal waktu",
    `${actorUserId}@example.test`,
  ]);
});

afterAll(async () => {
  setAuditWriter(null);
  await pg.query("DELETE FROM approval_requests WHERE id = ANY($1::uuid[])", [
    createdRequestIds,
  ]);
  await pg.query(`DELETE FROM "user" WHERE id = $1`, [actorUserId]);
  await pg.end();
});

describe.each(CASES)(
  "legend-52e52 $label: a module withdrawal is judged with the time after the chain lock",
  (testCase) => {
    it("queued before the deadline but granted the lock after it, the call returns expired and never cancels", async () => {
      const deadline = new Date(Date.now() + DEADLINE_MARGIN_MS);
      const id = await seedPending(testCase, deadline);

      const { outcome } = await cancelQueuedBehindChainLock({
        testCase,
        chainId: id,
        boundary: deadline,
        releaseWhen: () => Date.now() > deadline.getTime() + 50,
      });

      expect(outcome).toBe("expired");
      expect((await rowOf(id)).status).toBe("expired");
      const outcomes = await resolvedOutcomes(id);
      expect(outcomes).not.toContain("cancelled");
      expect(auditsOf(id, "approval.cancelled")).toHaveLength(0);
      // A concurrent deadline sweep may announce the expiry first; never twice.
      expect(auditsOf(id, "approval.expired").length).toBeLessThanOrEqual(1);
    }, 60_000);

    it("control: released before the deadline, the call returns cancelled with one cancelled outcome and one audit", async () => {
      const id = await seedPending(
        testCase,
        new Date(Date.now() + 60 * 60_000),
      );
      const startedAt = Date.now();

      const { outcome } = await cancelQueuedBehindChainLock({
        testCase,
        chainId: id,
        boundary: new Date(startedAt + 60_000),
        releaseWhen: () => Date.now() >= startedAt + HOLD_MS,
      });

      expect(outcome).toBe("cancelled");
      expect((await rowOf(id)).status).toBe("cancelled");
      // The resolved event may fan out to more than one row; all are cancelled.
      const outcomes = await resolvedOutcomes(id);
      expect(outcomes.length).toBeGreaterThanOrEqual(1);
      expect(outcomes.every((outcome) => outcome === "cancelled")).toBe(true);
      expect(auditsOf(id, "approval.cancelled")).toHaveLength(1);
      expect(auditsOf(id, "approval.expired")).toHaveLength(0);
    }, 60_000);

    it("the expiry is stamped with the time after the lock, not the clock read before waiting", async () => {
      const deadline = new Date(Date.now() + DEADLINE_MARGIN_MS);
      const id = await seedPending(testCase, deadline);

      const { outcome, releasedAt } = await cancelQueuedBehindChainLock({
        testCase,
        chainId: id,
        boundary: deadline,
        releaseWhen: () => Date.now() > deadline.getTime() + 50,
      });

      expect(outcome).toBe("expired");
      // Assumption: updated_at records when the level was expired.
      expect((await rowOf(id)).updated_at.getTime()).toBeGreaterThanOrEqual(
        releasedAt - DRIFT_TOLERANCE_MS,
      );
    }, 60_000);
  },
);
