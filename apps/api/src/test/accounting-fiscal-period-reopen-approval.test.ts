// Finding 1 (P1) of the ledger-guards second opinion (brief "Butir 1"): a closed
// fiscal period must not be reopened without an approved, unused reopen request
// decided by someone other than the requester.
//
// The hole: the application role `legend_app` can UPDATE fiscal_periods
// directly, and the transition trigger only checks `version = old.version + 1`.
// A raw UPDATE of status/version therefore reopens (or closes) a period with no
// approval at all.
//
// Decision under test: legend_app has no UPDATE privilege on the transition
// columns (status, version, closed_by, closed_at). Transitions only go through
// the services (which call a SECURITY DEFINER database function that checks the
// approval). The function name is not part of the contract, so these tests
// drive the legal path through the services only.
//
// Assumptions (the brief does not pin these down):
// - A refused raw UPDATE by legend_app is a plain privilege error, SQLSTATE
//   42501 (column-level UPDATE revoked). The tests check the refusal and that
//   the period row is untouched.
// - "No-op" statements such as `SET status = status` need the column privilege
//   too, so they prove the column grant is gone without depending on the
//   FISCAL_PERIOD_TRANSITION trigger (which would answer 23514 first for real
//   flips without a version bump).
// - The migration owner stays allowed to write raw SQL (test setup, forged
//   fixtures); only the application role is locked.
// - Requester != approver and approver != closer are enforced by the services
//   (APPROVER_IS_REQUESTER / APPROVER_IS_CLOSER); an approved request row that
//   was forged by the owner with requester == approver gives no right to reopen.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userIdSchema } from "@starter/shared/core";
import {
  approvePeriodReopen,
  closeFiscalPeriod,
  requestPeriodReopen,
} from "../services/accounting-period-close.service";
import {
  REOPEN_SQL,
  CLOSE_SQL,
  approver,
  closer,
  ensureUsers,
  failure,
  key,
  makeFixture,
  owner,
  periodRow,
  reopener,
  tenantId,
  tenantScope,
  withAppRole,
  withOwner,
  type Fx,
} from "./accounting-ledger-guard-test-helpers";

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await ensureUsers();
});

afterAll(async () => {
  await owner.end();
});

const closeViaService = (periodId: string, expectedVersion: number) =>
  closeFiscalPeriod(
    tenantScope(),
    periodId,
    { expectedVersion, idempotencyKey: key("close") },
    userIdSchema.parse(closer),
  );

const requestViaService = (periodId: string, reason: string) =>
  requestPeriodReopen(
    tenantScope(),
    periodId,
    { reason },
    userIdSchema.parse(reopener),
  );

const approveViaService = (requestId: string, actor: string) =>
  approvePeriodReopen(
    tenantScope(),
    requestId,
    { note: null },
    userIdSchema.parse(actor),
  );

/** A fresh fixture whose January period is closed through the service. */
async function closedJanuary(): Promise<Fx> {
  const fx = await makeFixture();
  await closeViaService(fx.jan, 1);
  return fx;
}

/** An approved request row forged by the owner (no service, no reopen). */
async function forgeApprovedRequest(
  fx: Fx,
  requestedBy: string,
  decidedBy: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO period_reopen_requests
       (tenant_id, legal_entity_id, fiscal_period_id, period, reason, status,
        requested_by, decided_by, decided_at)
     VALUES ($1, $2, $3, '2025-01', 'Dipalsukan (reopen approval test)',
             'approved', $4, $5, $6)
     RETURNING id`,
    // The app clock, like the services: closed_at and decided_at must compare.
    [tenantId, fx.entity, fx.jan, requestedBy, decidedBy, new Date()],
  );
  return rows[0]!.id;
}

const expectRefused = (error: Error & { code?: string }) =>
  expect(error.code).toBe("42501");

describe("ACC-02 legend_app has no direct UPDATE on the period transition columns", () => {
  it.each(["status", "version", "closed_by", "closed_at"])(
    "ACC-02 UPDATE of fiscal_periods.%s by legend_app is refused (permission denied)",
    async (column) => {
      const fx = await makeFixture();
      const before = await periodRow(fx.jan);
      const error = await failure(
        withAppRole((client) =>
          client.query(
            `UPDATE fiscal_periods SET ${column} = ${column} WHERE id = $1`,
            [fx.jan],
          ),
        ),
      );
      expectRefused(error);
      expect(await periodRow(fx.jan)).toEqual(before);
    },
  );

  it("ACC-02 a legal-looking raw close (status flip with version + 1) by legend_app is refused", async () => {
    const fx = await makeFixture();
    const before = await periodRow(fx.jan);
    const error = await failure(
      withAppRole((client) => client.query(CLOSE_SQL, [fx.jan, closer])),
    );
    expectRefused(error);
    expect(await periodRow(fx.jan)).toEqual(before);
  });
});

describe("ACC-02 a closed period cannot be reopened without an approved, unused request", () => {
  it("ACC-02 raw reopen by legend_app with no request at all is refused and the period stays closed", async () => {
    const fx = await closedJanuary();
    const before = await periodRow(fx.jan);
    expect(before.status).toBe("closed");

    const error = await failure(
      withAppRole((client) => client.query(REOPEN_SQL, [fx.jan, reopener])),
    );
    expectRefused(error);
    expect(await periodRow(fx.jan)).toEqual(before);
  });

  it("ACC-02 raw reopen while the request is only pending (not approved) is refused", async () => {
    const fx = await closedJanuary();
    await requestViaService(fx.jan, "Koreksi kas (menunggu persetujuan)");
    const before = await periodRow(fx.jan);

    const error = await failure(
      withAppRole((client) => client.query(REOPEN_SQL, [fx.jan, reopener])),
    );
    expectRefused(error);
    expect(await periodRow(fx.jan)).toEqual(before);
    expect(before.status).toBe("closed");
  });

  it("ACC-02 raw reopen is refused even when an approved request row exists (transitions only go through the approval service)", async () => {
    const fx = await closedJanuary();
    await forgeApprovedRequest(fx, reopener, approver);
    const before = await periodRow(fx.jan);

    const error = await failure(
      withAppRole((client) => client.query(REOPEN_SQL, [fx.jan, reopener])),
    );
    expectRefused(error);
    expect(await periodRow(fx.jan)).toEqual(before);
  });

  it("ACC-02 a forged approved request whose requester is also the approver gives no right to reopen", async () => {
    const fx = await closedJanuary();
    await forgeApprovedRequest(fx, reopener, reopener);
    const before = await periodRow(fx.jan);

    const error = await failure(
      withAppRole((client) => client.query(REOPEN_SQL, [fx.jan, reopener])),
    );
    expectRefused(error);
    expect(await periodRow(fx.jan)).toEqual(before);
  });

  it("ACC-02 the requester cannot approve their own request through the service; the period stays closed", async () => {
    const fx = await closedJanuary();
    const request = await requestViaService(
      fx.jan,
      "Koreksi sewa (peminta = penyetuju)",
    );
    const before = await periodRow(fx.jan);

    await expect(approveViaService(request.id, reopener)).rejects.toThrow();
    expect(await periodRow(fx.jan)).toEqual(before);
    expect((await periodRow(fx.jan)).status).toBe("closed");
  });

  it("ACC-02 an approval that was already used cannot reopen the period a second time", async () => {
    const fx = await closedJanuary();
    const request = await requestViaService(
      fx.jan,
      "Koreksi pendapatan (satu kali pakai)",
    );
    await approveViaService(request.id, approver);
    const reopened = await periodRow(fx.jan);
    expect(reopened.status).toBe("open");
    expect(reopened.version).toBe(3);

    // Close again through the service, then try to reuse the spent approval.
    await closeViaService(fx.jan, reopened.version);
    const closedAgain = await periodRow(fx.jan);
    expect(closedAgain.status).toBe("closed");

    await expect(approveViaService(request.id, approver)).rejects.toThrow();
    const rawError = await failure(
      withAppRole((client) => client.query(REOPEN_SQL, [fx.jan, reopener])),
    );
    expectRefused(rawError);
    expect(await periodRow(fx.jan)).toEqual(closedAgain);
  });
});

describe("ACC-02 the legal close and reopen path still works", () => {
  it("ACC-02 close, request, approve by another person: the period is open again with the version raised one step per transition", async () => {
    const fx = await makeFixture();
    const closed = await closeViaService(fx.jan, 1);
    expect(closed.status).toBe("closed");
    expect((await periodRow(fx.jan)).version).toBe(2);

    const request = await requestViaService(
      fx.jan,
      `Koreksi kas Januari ${randomUUID().slice(0, 8)}`,
    );
    const approved = await approveViaService(request.id, approver);
    expect(approved.request.status).toBe("approved");

    const reopened = await periodRow(fx.jan);
    expect(reopened.status).toBe("open");
    expect(reopened.version).toBe(3);
    expect(reopened.closed_by).toBeNull();
  });
});

const REOPEN_FN = "select app.reopen_fiscal_period($1, $2, $3, $4, now())";
const CLOSE_FN = "select app.close_fiscal_period($1, $2, $3, now())";

describe("ACC-02 the database functions check the transition themselves", () => {
  it("ACC-02 reopen function: requester = approver is refused at function level and the period stays closed", async () => {
    const fx = await closedJanuary();
    const requestId = await forgeApprovedRequest(fx, reopener, reopener);
    const before = await periodRow(fx.jan);

    const error = await failure(
      withAppRole((client) =>
        client.query(REOPEN_FN, [tenantId, fx.jan, requestId, reopener]),
      ),
    );
    expect(error.code).toBe("23514");
    expect(error.message).toMatch(/REOPEN_SELF_APPROVAL/);
    expect(await periodRow(fx.jan)).toEqual(before);
  });

  it("ACC-02 reopen function: a pending request gives no right to reopen", async () => {
    const fx = await closedJanuary();
    const request = await requestViaService(
      fx.jan,
      "Koreksi (fungsi, pending)",
    );
    const before = await periodRow(fx.jan);

    const error = await failure(
      withAppRole((client) =>
        client.query(REOPEN_FN, [tenantId, fx.jan, request.id, approver]),
      ),
    );
    expect(error.code).toBe("23514");
    expect(error.message).toMatch(/REOPEN_NOT_APPROVED/);
    expect(await periodRow(fx.jan)).toEqual(before);
  });

  it("ACC-02 reopen function: the approver must be the acting user", async () => {
    const fx = await closedJanuary();
    const requestId = await forgeApprovedRequest(fx, reopener, approver);
    const before = await periodRow(fx.jan);

    const error = await failure(
      withAppRole((client) =>
        client.query(REOPEN_FN, [tenantId, fx.jan, requestId, reopener]),
      ),
    );
    expect(error.code).toBe("23514");
    expect(error.message).toMatch(/REOPEN_NOT_APPROVED/);
    expect(await periodRow(fx.jan)).toEqual(before);
  });

  it("ACC-02 reopen function: whoever closed the period cannot be the approver", async () => {
    const fx = await closedJanuary();
    const requestId = await forgeApprovedRequest(fx, reopener, closer);
    const before = await periodRow(fx.jan);

    const error = await failure(
      withAppRole((client) =>
        client.query(REOPEN_FN, [tenantId, fx.jan, requestId, closer]),
      ),
    );
    expect(error.code).toBe("23514");
    expect(error.message).toMatch(/REOPEN_SELF_APPROVAL/);
    expect(await periodRow(fx.jan)).toEqual(before);
  });

  it("ACC-02 reopen function: a valid approved request reopens once; the same approval cannot reopen the next close", async () => {
    const fx = await closedJanuary();
    const requestId = await forgeApprovedRequest(fx, reopener, approver);

    await withAppRole((client) =>
      client.query(REOPEN_FN, [tenantId, fx.jan, requestId, approver]),
    );
    const reopened = await periodRow(fx.jan);
    expect(reopened.status).toBe("open");
    expect(reopened.version).toBe(3);
    expect(reopened.reopened_by).toBe(approver);

    // A second call on the open period is refused.
    const open = await failure(
      withAppRole((client) =>
        client.query(REOPEN_FN, [tenantId, fx.jan, requestId, approver]),
      ),
    );
    expect(open.code).toBe("23514");

    // Closed again, the spent approval is older than the new close.
    await closeViaService(fx.jan, reopened.version);
    const closedAgain = await periodRow(fx.jan);
    const reuse = await failure(
      withAppRole((client) =>
        client.query(REOPEN_FN, [tenantId, fx.jan, requestId, approver]),
      ),
    );
    expect(reuse.code).toBe("23514");
    expect(reuse.message).toMatch(/REOPEN_APPROVAL_USED/);
    expect(await periodRow(fx.jan)).toEqual(closedAgain);
  });

  it("ACC-02 reopen function: a tenant other than the session tenant is refused", async () => {
    const fx = await closedJanuary();
    const requestId = await forgeApprovedRequest(fx, reopener, approver);
    const before = await periodRow(fx.jan);

    const error = await failure(
      withAppRole((client) =>
        client.query(REOPEN_FN, [randomUUID(), fx.jan, requestId, approver]),
      ),
    );
    expect(error.code).toBe("42501");
    expect(await periodRow(fx.jan)).toEqual(before);
  });

  it("ACC-02 close function: a close without a snapshot of the next version is refused", async () => {
    const fx = await makeFixture();
    const before = await periodRow(fx.jan);

    const error = await failure(
      withAppRole((client) =>
        client.query(CLOSE_FN, [tenantId, fx.jan, closer]),
      ),
    );
    expect(error.code).toBe("23514");
    expect(error.message).toMatch(/FISCAL_PERIOD_TRANSITION/);
    expect(await periodRow(fx.jan)).toEqual(before);
  });
});

/** An open transaction as legend_app on its own connection (tenant set). */
async function appTransaction(isolation: "READ COMMITTED" | "REPEATABLE READ") {
  const client = await owner.connect();
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await client.query("SET LOCAL ROLE legend_app");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenantId],
  );
  // The first statement fixes a REPEATABLE READ snapshot.
  await client.query("SELECT status FROM fiscal_periods WHERE id IS NOT NULL");
  return client;
}

describe("ACC-02 one approval is one reopen (hard consumed marker, no clock)", () => {
  it("ACC-02 legend_app cannot UPDATE period_reopen_requests.consumed_at (only the reopen function sets it)", async () => {
    const fx = await closedJanuary();
    const requestId = await forgeApprovedRequest(fx, reopener, approver);
    const error = await failure(
      withAppRole((client) =>
        client.query(
          "UPDATE period_reopen_requests SET consumed_at = NULL WHERE id = $1",
          [requestId],
        ),
      ),
    );
    expect(error.code).toBe("42501");
    const { rows } = await owner.query(
      "SELECT consumed_at FROM period_reopen_requests WHERE id = $1",
      [requestId],
    );
    expect(rows[0].consumed_at).toBeNull();
  });

  it("ACC-02 the reopen function stamps consumed_at; the stamped approval is refused even with decided_at = closed_at and a frozen clock", async () => {
    const fx = await makeFixture();
    const frozen = new Date("2026-11-03T03:00:00Z");
    await closeFiscalPeriod(
      tenantScope(),
      fx.jan,
      { expectedVersion: 1, idempotencyKey: key("close") },
      userIdSchema.parse(closer),
      frozen,
    );
    // decided_at equals closed_at exactly: a clock comparison cannot tell them apart.
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO period_reopen_requests
         (tenant_id, legal_entity_id, fiscal_period_id, period, reason, status,
          requested_by, decided_by, decided_at)
       VALUES ($1, $2, $3, '2025-01', 'Dipalsukan (jam beku)', 'approved', $4, $5, $6)
       RETURNING id`,
      [tenantId, fx.entity, fx.jan, reopener, approver, frozen],
    );
    const requestId = rows[0]!.id;

    await withAppRole((client) =>
      client.query(REOPEN_FN, [tenantId, fx.jan, requestId, approver]),
    );
    const consumed = await owner.query(
      "SELECT consumed_at FROM period_reopen_requests WHERE id = $1",
      [requestId],
    );
    expect(consumed.rows[0].consumed_at).not.toBeNull();

    // Same frozen clock for the second close.
    const reopened = await periodRow(fx.jan);
    await closeFiscalPeriod(
      tenantScope(),
      fx.jan,
      { expectedVersion: reopened.version, idempotencyKey: key("close") },
      userIdSchema.parse(closer),
      frozen,
    );
    const closedAgain = await periodRow(fx.jan);
    expect(closedAgain.status).toBe("closed");

    const reuse = await failure(
      withAppRole((client) =>
        client.query(REOPEN_FN, [tenantId, fx.jan, requestId, approver]),
      ),
    );
    expect(reuse.code).toBe("23514");
    expect(reuse.message).toMatch(/REOPEN_APPROVAL_USED/);
    expect(await periodRow(fx.jan)).toEqual(closedAgain);
  });

  it.each(["READ COMMITTED", "REPEATABLE READ"] as const)(
    "ACC-02 two %s connections using the same approval at once: exactly one reopens",
    async (isolation) => {
      const fx = await closedJanuary();
      const requestId = await forgeApprovedRequest(fx, reopener, approver);
      const before = await periodRow(fx.jan);

      const first = await appTransaction(isolation);
      const second = await appTransaction(isolation);
      try {
        await first.query(REOPEN_FN, [tenantId, fx.jan, requestId, approver]);
        // The second call waits on the locks the first one holds.
        const racing = second
          .query(REOPEN_FN, [tenantId, fx.jan, requestId, approver])
          .then(
            () => undefined,
            (error: Error & { code?: string }) => error,
          );
        await new Promise((resolve) => setTimeout(resolve, 300));
        await first.query("COMMIT");
        const error = await racing;
        expect(error).toBeDefined();
        expect(["23514", "40001"]).toContain(error?.code);
        await second.query("ROLLBACK").catch(() => undefined);
      } finally {
        await first.query("ROLLBACK").catch(() => undefined);
        first.release();
        second.release();
      }

      const after = await periodRow(fx.jan);
      expect(after.status).toBe("open");
      expect(after.version).toBe(before.version + 1);
    },
  );
});

const stripComments = (text: string) => text.replace(/--.*$/gm, "").trim();
const migration0317 = readFileSync(
  resolve(
    import.meta.dirname,
    "../../drizzle/0273_fiscal_period_transition_fn.sql",
  ),
  "utf8",
);
const consumedBackfill = migration0317
  .split("--> statement-breakpoint")
  .map(stripComments)
  .find((statement) =>
    /^UPDATE\s+public\.period_reopen_requests[\s\S]*consumed_at\s*=\s*decided_at/i.test(
      statement,
    ),
  );

describe("ACC-02 approvals that predate 0273 are already used", () => {
  it("ACC-02 the 0273 backfill marks an old approved request (consumed_at NULL) consumed, so it cannot reopen a later close", async () => {
    // Before 0273 every approval reopened the period at once, so every old
    // approved row is spent. The migration already ran in the test database;
    // an old row is simulated by an approved row with consumed_at NULL, and
    // the backfill statement of the migration file itself is run on that row.
    expect(consumedBackfill).toBeDefined();
    const fx = await closedJanuary();
    const requestId = await forgeApprovedRequest(fx, reopener, approver);
    const unscoped = consumedBackfill!.replace(/;\s*$/, "");
    expect(unscoped).toMatch(/\bWHERE\b/i);
    await withOwner(async (client) => {
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      // Scoped to the one row: parallel test files share the tenant.
      await client.query(`${unscoped} AND id = $1`, [requestId]);
    });
    const { rows } = await owner.query(
      "SELECT consumed_at, decided_at FROM period_reopen_requests WHERE id = $1",
      [requestId],
    );
    expect(rows[0].consumed_at).not.toBeNull();
    expect(rows[0].consumed_at).toEqual(rows[0].decided_at);

    const error = await failure(
      withAppRole((client) =>
        client.query(REOPEN_FN, [tenantId, fx.jan, requestId, approver]),
      ),
    );
    expect(error.message).toMatch(/REOPEN_APPROVAL_USED/);
  });
});

describe("ACC-02 legend_app cannot forge or rewrite reopen requests", () => {
  const insertRequest = (fx: Fx, status: string, decidedBy: string | null) =>
    withAppRole((client) =>
      client.query(
        `INSERT INTO period_reopen_requests
           (tenant_id, legal_entity_id, fiscal_period_id, period, reason, status,
            requested_by, decided_by, decided_at)
         VALUES ($1, $2, $3, '2025-01', 'Dipalsukan lewat legend_app', $4, $5, $6,
                 CASE WHEN $6::text IS NULL THEN NULL ELSE now() END)
         RETURNING id`,
        [tenantId, fx.entity, fx.jan, status, reopener, decidedBy],
      ),
    );

  it("ACC-02 a raw INSERT of an already approved request is refused and the period stays closed", async () => {
    const fx = await closedJanuary();
    const before = await periodRow(fx.jan);
    const error = await failure(insertRequest(fx, "approved", approver));
    expect(error.code).toBe("23514");
    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM period_reopen_requests WHERE fiscal_period_id = $1",
      [fx.jan],
    );
    expect(rows[0].n).toBe(0);
    expect(await periodRow(fx.jan)).toEqual(before);
  });

  it("ACC-02 a raw INSERT with consumed_at set is refused", async () => {
    const fx = await closedJanuary();
    const error = await failure(
      withAppRole((client) =>
        client.query(
          `INSERT INTO period_reopen_requests
             (tenant_id, legal_entity_id, fiscal_period_id, period, reason, status,
              requested_by, consumed_at)
           VALUES ($1, $2, $3, '2025-01', 'consumed_at palsu', 'pending', $4, now())`,
          [tenantId, fx.entity, fx.jan, reopener],
        ),
      ),
    );
    expect(error.code).toBe("23514");
  });

  it("ACC-02 a raw pending -> approved by the requester himself is refused", async () => {
    const fx = await closedJanuary();
    const request = await requestViaService(fx.jan, "Koreksi (UPDATE mentah)");
    const error = await failure(
      withAppRole((client) =>
        client.query(
          `UPDATE period_reopen_requests
              SET status = 'approved', decided_by = requested_by, decided_at = now()
            WHERE id = $1`,
          [request.id],
        ),
      ),
    );
    expect(error.code).toBe("23514");
    const { rows } = await owner.query(
      "SELECT status FROM period_reopen_requests WHERE id = $1",
      [request.id],
    );
    expect(rows[0].status).toBe("pending");
  });

  it("ACC-02 a decided request cannot be rewritten by legend_app (approved -> pending, decided_by swapped)", async () => {
    const fx = await closedJanuary();
    const requestId = await forgeApprovedRequest(fx, reopener, reopener);
    const back = await failure(
      withAppRole((client) =>
        client.query(
          "UPDATE period_reopen_requests SET decided_by = $2 WHERE id = $1",
          [requestId, approver],
        ),
      ),
    );
    expect(back.code).toBe("23514");
    const { rows } = await owner.query(
      "SELECT decided_by FROM period_reopen_requests WHERE id = $1",
      [requestId],
    );
    expect(rows[0].decided_by).toBe(reopener);
  });

  it("ACC-02 the legal paths still work for legend_app: request, reject by another, and a second request after it", async () => {
    const fx = await closedJanuary();
    const first = await requestViaService(fx.jan, "Koreksi (ditolak)");
    const rejected = await withAppRole((client) =>
      client.query(
        `UPDATE period_reopen_requests
            SET status = 'rejected', decided_by = $2, decided_at = now()
          WHERE id = $1 RETURNING status`,
        [first.id, approver],
      ),
    );
    expect(rows0(rejected).status).toBe("rejected");
    const cancelled = await requestViaService(fx.jan, "Koreksi (dibatalkan)");
    const result = await withAppRole((client) =>
      client.query(
        "UPDATE period_reopen_requests SET status = 'cancelled' WHERE id = $1 RETURNING status",
        [cancelled.id],
      ),
    );
    expect(rows0(result).status).toBe("cancelled");
  });
});

const rows0 = (result: { rows: { status: string }[] }) => result.rows[0]!;

describe("ACC-02 the reopen function reopens only the latest closed period", () => {
  it("ACC-02 reopen function: a later closed period of the same legal entity refuses the reopen of an earlier one", async () => {
    const fx = await closedJanuary();
    await closeViaService(fx.feb, 1);
    const requestId = await forgeApprovedRequest(fx, reopener, approver);
    const before = await periodRow(fx.jan);

    const error = await failure(
      withAppRole((client) =>
        client.query(REOPEN_FN, [tenantId, fx.jan, requestId, approver]),
      ),
    );
    expect(error.code).toBe("23514");
    expect(error.message).toMatch(/REOPEN_OUT_OF_ORDER/);
    expect(await periodRow(fx.jan)).toEqual(before);
    const { rows } = await owner.query(
      "SELECT consumed_at FROM period_reopen_requests WHERE id = $1",
      [requestId],
    );
    expect(rows[0].consumed_at).toBeNull();
  });
});

// Production logs in as legend_runtime_<hex>, a member of legend_app, without
// SET ROLE: current_user is the login, never the group name.
const RUNTIME_LOGIN = "legend_runtime_0000000000000000";

async function withRuntimeLogin<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${RUNTIME_LOGIN}`);
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe("ACC-02 the request guard also holds for a legend_runtime_<hex> login (member of legend_app)", () => {
  beforeAll(async () => {
    await owner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_LOGIN}') THEN
          CREATE ROLE ${RUNTIME_LOGIN} NOLOGIN IN ROLE legend_app;
        END IF;
      END $$`);
  });
  afterAll(async () => {
    await owner.query(`DROP ROLE IF EXISTS ${RUNTIME_LOGIN}`);
  });

  it("ACC-02 a raw INSERT of an already approved request is refused for the runtime login", async () => {
    const fx = await closedJanuary();
    const error = await failure(
      withRuntimeLogin((client) =>
        client.query(
          `INSERT INTO period_reopen_requests
             (tenant_id, legal_entity_id, fiscal_period_id, period, reason, status,
              requested_by, decided_by, decided_at)
           VALUES ($1, $2, $3, '2025-01', 'Dipalsukan (runtime login)', 'approved',
                   $4, $5, now())`,
          [tenantId, fx.entity, fx.jan, reopener, approver],
        ),
      ),
    );
    expect(error.code).toBe("23514");
    expect(error.message).toMatch(/REOPEN_REQUEST_FORGED/);
  });

  it("ACC-02 a decided request cannot be rewritten by the runtime login", async () => {
    const fx = await closedJanuary();
    const requestId = await forgeApprovedRequest(fx, reopener, reopener);
    const error = await failure(
      withRuntimeLogin((client) =>
        client.query(
          "UPDATE period_reopen_requests SET decided_by = $2 WHERE id = $1",
          [requestId, approver],
        ),
      ),
    );
    expect(error.code).toBe("23514");
    expect(error.message).toMatch(/REOPEN_REQUEST_FORGED/);
  });

  it("ACC-02 the runtime login still reopens through the function after a legal approval", async () => {
    const fx = await closedJanuary();
    const request = await requestViaService(fx.jan, "Koreksi (runtime login)");
    await withRuntimeLogin((client) =>
      client.query(
        `UPDATE period_reopen_requests
            SET status = 'approved', decided_by = $2, decided_at = now()
          WHERE id = $1`,
        [request.id, approver],
      ),
    );
    await withRuntimeLogin((client) =>
      client.query(REOPEN_FN, [tenantId, fx.jan, request.id, approver]),
    );
    expect((await periodRow(fx.jan)).status).toBe("open");
  });
});

describe("ACC-02 the transition functions lock the legal entity first (same order as the services)", () => {
  it("ACC-02 reopen of January and close of February at once: the second waits for the entity lock and sees the first", async () => {
    const fx = await closedJanuary();
    const requestId = await forgeApprovedRequest(fx, reopener, approver);
    // The close service writes this snapshot before the close function runs.
    await owner.query(
      `INSERT INTO fiscal_period_snapshots
         (tenant_id, legal_entity_id, fiscal_period_id, period, version, taken_by, taken_at)
       VALUES ($1, $2, $3, '2025-02', 2, $4, now())`,
      [tenantId, fx.entity, fx.feb, closer],
    );

    const reopening = await appTransaction("READ COMMITTED");
    const closing = await appTransaction("READ COMMITTED");
    try {
      await reopening.query(REOPEN_FN, [tenantId, fx.jan, requestId, approver]);
      const racing = closing.query(CLOSE_FN, [tenantId, fx.feb, closer]).then(
        () => undefined,
        (error: Error & { code?: string }) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await reopening.query("COMMIT");
      const error = await racing;
      expect(error?.code).toBe("23514");
      expect(error?.message).toMatch(/FISCAL_PERIOD_TRANSITION/);
      await closing.query("ROLLBACK").catch(() => undefined);
    } finally {
      await reopening.query("ROLLBACK").catch(() => undefined);
      reopening.release();
      closing.release();
    }
    expect((await periodRow(fx.jan)).status).toBe("open");
    expect((await periodRow(fx.feb)).status).toBe("open");
  });
});
