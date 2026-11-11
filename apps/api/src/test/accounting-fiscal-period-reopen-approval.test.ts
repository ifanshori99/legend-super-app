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
             'approved', $4, $5, now())
     RETURNING id`,
    [tenantId, fx.entity, fx.jan, requestedBy, decidedBy],
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
