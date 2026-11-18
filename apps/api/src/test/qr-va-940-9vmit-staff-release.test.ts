// legend-9vmit (brief 9vmit, test-writer 3): staff release of a `bank_transfer`
// code, and the database rules of payment_va_releases after the migration that
// adds `kind` (staff | guest_method_change).
//
// Contract used (written from the brief, not from the code):
// - Q93 is unchanged: POST /api/outlets/:outletId/pos/orders/:orderId/va/release
//   needs a supervisor approval (action "void", object = the order, value >=
//   the code amount, one use) and now >= expires_at + 30 min. What changes is
//   that a `bank_transfer` code (including an "orphan": a code a refused call
//   kept, status failed, provider_final_at NULL) is releasable like a VA code.
//   QRIS stays refused (409 VA_RELEASE_NOT_ELIGIBLE).
// - A staff release writes a payment_va_releases row with kind 'staff' and
//   released_by, approved_by, override_id all filled.
// - payment_va_releases.kind text not null default 'staff', check in
//   ('staff','guest_method_change'). CHECK: kind 'staff' needs released_by,
//   approved_by and override_id non-null; kind 'guest_method_change' needs
//   approved_by and override_id NULL (reason is filled by the existing reason
//   check). unique (tenant, override_id) stays; NULL override ids may repeat.
//
// Assumptions:
// - The guest QR path only offers qris and va, so a bank_transfer code is made
//   by issuing a real VA code through the guest API and then rewriting that
//   intent to method bank_transfer (with valid bank_transfer instructions) in
//   SQL; an orphan additionally gets status failed and an ":orphan:" key.
// - Time moves by shifting payment_intents.expires_at into the past (as the
//   existing VA release tests do).
// - A missing approval is a 4xx (422 validation or 403/400); a wrong or too
//   small approval is VOID_APPROVAL_REQUIRED.
// - Money paid on a released bank_transfer code is parked as unallocated funds
//   once and never settles the bill (same Q93/VA rule); the verified amount is
//   the code amount.
// - A CHECK violation is Postgres error 23514, a unique violation 23505. A
//   guest_method_change row is inserted with released_by NULL (the guest is not
//   staff); the brief makes released_by nullable and does not constrain it.
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-940-9vmit-staff-release.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid, uuidToUlid } from "@starter/shared/core";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
  type ManagerApproval,
  type ProviderAnswer,
} from "./pos-qris-hold-test-helpers.ts";
import {
  evidenceRows,
  outboxCountOf,
  releaseKit,
} from "./qris-hold-so885-d-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000 });

const RELEASE_AFTER_MIN = 30;
const REASON = "Bank tidak menjawab status transfer lebih dari sehari";
const AUDIT_ACTION = "payment_va_code.force_released";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;
beforeAll(async () => {
  fx = await holdFixture("qr-va-940-9vmit-staff-release");
  enableVaBank(fx.gateway);
  setPaymentGateway(fx.gateway);
  kit = releaseKit(fx);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

type Opened = Awaited<ReturnType<typeof openCode>>;

// ----------------------------------------------------------------- fixtures

function idForms(id: string): string[] {
  const forms = [id];
  for (const convert of [ulidToUuid, uuidToUlid]) {
    try {
      forms.push(String(convert(id as never)));
    } catch {
      /* not that form */
    }
  }
  return forms;
}

const uuidFormOf = (id: string): string =>
  idForms(id).find((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(x))!;

function replace(
  guest: Awaited<ReturnType<HoldFixture["newGuest"]>>,
  orderId: string,
  method: "qris" | "va",
) {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(method === "va" ? { bankCode: "bmri" } : {}),
    idempotencyKey: randomUUID(),
  });
}

/** A guest order with one VA or QRIS code issued (201). */
async function openCode(method: "va" | "qris" = "va") {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const res = await replace(guest, order.id, method);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const intentId = res.body.data.id as string;
  const { rows } = await owner.query<{
    amount: number;
    provider_ref: string;
    payment_link_id: string;
  }>(
    `SELECT amount_idr::int AS amount, provider_ref,
            payment_link_id::text AS payment_link_id
       FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, intentId],
  );
  return {
    guest,
    order,
    intentId,
    amount: rows[0]!.amount,
    providerRef: rows[0]!.provider_ref,
    linkId: rows[0]!.payment_link_id,
  };
}

/** A bank_transfer code: the VA intent rewritten as a transfer code. */
async function openBankTransfer(): Promise<Opened> {
  const code = await openCode("va");
  await owner.query(
    `UPDATE payment_intents
        SET method = 'bank_transfer', instructions = $3::jsonb
      WHERE tenant_id=$1 AND id=$2`,
    [
      fx.tenant.tenantId,
      code.intentId,
      JSON.stringify({
        method: "bank_transfer",
        channelCode: "bmri",
        channelName: "Mandiri",
        accountNumber: "1234567890",
        accountHolder: "Cafe Legend",
        uniqueCode: "123",
        transferTotalIdr: code.amount + 123,
      }),
    ],
  );
  return code;
}

/** An orphan: a refused code the service kept (failed, provider not final). */
async function openOrphanBankTransfer(): Promise<Opened> {
  const code = await openBankTransfer();
  await owner.query(
    `UPDATE payment_intents
        SET status = 'failed', provider_final_at = NULL,
            idempotency_key = idempotency_key || ':orphan:' || gen_random_uuid()::text
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, code.intentId],
  );
  return code;
}

/** Expiry `minutes` in the past (status untouched unless given). */
async function lapse(
  code: Opened,
  minutes: number,
  status?: "pending" | "expired" | "failed",
) {
  await owner.query(
    `UPDATE payment_intents
        SET expires_at = now() - $3::int * interval '1 minute',
            status = coalesce($4, status)
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, code.intentId, minutes, status ?? null],
  );
}

const releaseUrl = (orderId: string) => `${fx.base}/${orderId}/va/release`;

function postRelease(
  code: Opened,
  approval: ManagerApproval,
  extra: Record<string, unknown> = {},
) {
  return fx.post(releaseUrl(code.order.id), {
    paymentIntentId: code.intentId,
    ...approval,
    idempotencyKey: randomUUID(),
    reason: REASON,
    ...extra,
  });
}

const approvalFor = (code: Opened, order: { id: string } = code.order) =>
  kit.managerApproval(order.id, code.amount);

async function releaseRows(intentId: string) {
  const { rows } = await owner.query<{
    kind: string;
    reason: string;
    released_by: string | null;
    approved_by: string | null;
    override_id: string | null;
    status: string;
  }>(
    `SELECT kind, reason, released_by::text AS released_by,
            approved_by::text AS approved_by, override_id::text AS override_id,
            status
       FROM payment_va_releases
      WHERE tenant_id=$1 AND payment_intent_id=$2
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentId],
  );
  return rows;
}

async function auditRows(code: Opened) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id=$1 AND event->>'action'=$2 AND event::text LIKE $3`,
    [fx.tenant.tenantId, AUDIT_ACTION, `%${code.intentId}%`],
  );
  return rows;
}

async function intentRow(intentId: string) {
  const { rows } = await owner.query<{
    status: string;
    provider_final_at: Date | null;
  }>(
    "SELECT status, provider_final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!;
}

async function paidIdr(linkId: string) {
  const { rows } = await owner.query<{ paid: number }>(
    "SELECT paid_idr::int AS paid FROM payment_links WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, linkId],
  );
  return rows[0]!.paid;
}

function expectError(
  res: Awaited<ReturnType<HoldFixture["post"]>>,
  status: number,
  code?: string,
) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  if (code) expect(res.body.error.code).toBe(code);
}

async function expectNothingReleased(code: Opened) {
  expect(await releaseRows(code.intentId)).toEqual([]);
  expect(await auditRows(code)).toEqual([]);
  expect((await intentRow(code.intentId)).provider_final_at).toBeNull();
}

/** Release a lapsed code with a fresh approval; expects 200. */
async function releaseOk(
  code: Opened,
  status: "pending" | "expired" | "failed",
  provider: ProviderAnswer = { rawStatus: "01" },
) {
  fx.gateway.script(code.intentId, provider);
  await lapse(code, RELEASE_AFTER_MIN + 1, status);
  const approval = await approvalFor(code);
  const res = await postRelease(code, approval);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { approval, res };
}

async function expectStaffRow(code: Opened, approval: ManagerApproval) {
  const rows = await releaseRows(code.intentId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    kind: "staff",
    status: "open",
    reason: REASON,
  });
  expect(idForms(fx.staff.userId)).toContain(rows[0]!.released_by);
  expect(idForms(approval.approvedBy)).toContain(rows[0]!.approved_by);
  expect(idForms(approval.overrideId)).toContain(rows[0]!.override_id);
  expect(await auditRows(code)).toHaveLength(1);
  // A release is not a provider-final answer: the queue still has to ask.
  expect((await intentRow(code.intentId)).provider_final_at).toBeNull();
}

// ------------------------------------------- staff release of bank_transfer

describe("legend-9vmit staff releases a bank_transfer code (Q93 unchanged)", () => {
  it.each<{
    label: string;
    status: "pending" | "expired" | "failed";
    orphan: boolean;
  }>([
    {
      label: "orphan bank_transfer (failed, provider not final)",
      status: "failed",
      orphan: true,
    },
    {
      label: "pending bank_transfer past its 30 minute expiry",
      status: "pending",
      orphan: false,
    },
    {
      label: "expired bank_transfer, provider not final",
      status: "expired",
      orphan: false,
    },
  ])(
    "legend-9vmit $label: released with approval, one staff row, one audit row, not final",
    async ({ status, orphan }) => {
      const code = orphan
        ? await openOrphanBankTransfer()
        : await openBankTransfer();
      const { approval } = await releaseOk(code, status);
      await expectStaffRow(code, approval);
      // The bill is untouched by a release.
      expect(await paidIdr(code.linkId)).toBe(0);
      expect(await unallocatedFunds(fx, code.intentId)).toEqual([]);
    },
  );

  it("legend-9vmit a VA code is still released the same way and its row is kind staff", async () => {
    const code = await openCode("va");
    const { approval } = await releaseOk(code, "expired");
    await expectStaffRow(code, approval);
  });

  it("legend-9vmit money paid later on a released bank_transfer code is parked once and never pays the bill", async () => {
    const code = await openBankTransfer();
    await releaseOk(code, "pending");

    const failure = await confirmPayment(
      fx.context,
      code.intentId,
      {
        source: "verified_webhook",
        method: "bank_transfer",
        amountIdr: code.amount,
        providerRef: code.providerRef,
        at: new Date().toISOString(),
      },
      { type: "system" },
      new Date(),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure, "paid after release is refused").toMatchObject({
      decisionCode: "BILL_CLOSED",
    });
    const funds = await unallocatedFunds(fx, code.intentId);
    expect(funds).toHaveLength(1);
    expect(funds[0]!.amountIdr).toBe(code.amount);
    expect(await evidenceRows(fx, code.intentId)).toHaveLength(1);
    expect(
      await outboxCountOf(fx, "payment.funds_unallocated", code.intentId),
    ).toBe(1);
    expect(await paidIdr(code.linkId), "the bill is not paid by it").toBe(0);
  });
});

describe("legend-9vmit refusals: approval and 30 minute rule still apply to bank_transfer", () => {
  it("legend-9vmit a wrong or too small approval is VOID_APPROVAL_REQUIRED, nothing released", async () => {
    const code = await openBankTransfer();
    const other = await openBankTransfer();
    fx.gateway.script(code.intentId, { rawStatus: "01" });
    await lapse(code, RELEASE_AFTER_MIN + 1, "expired");

    const wrongObject = await approvalFor(other);
    const refused = await postRelease(code, wrongObject);
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(refused.status).toBeLessThan(500);
    expect(refused.body.error.code).toBe("VOID_APPROVAL_REQUIRED");

    const tooSmall = await kit.managerApproval(code.order.id, code.amount - 1);
    expectError(
      await postRelease(code, tooSmall),
      refused.status,
      "VOID_APPROVAL_REQUIRED",
    );
    await expectNothingReleased(code);

    // The refused calls spent nothing: a right approval releases it.
    const approval = await approvalFor(code);
    expect((await postRelease(code, approval)).status).toBe(200);
  });

  it("legend-9vmit without any approval the release is refused (4xx), nothing released", async () => {
    const code = await openBankTransfer();
    fx.gateway.script(code.intentId, { rawStatus: "01" });
    await lapse(code, RELEASE_AFTER_MIN + 1, "expired");
    const res = await fx.post(releaseUrl(code.order.id), {
      paymentIntentId: code.intentId,
      idempotencyKey: randomUUID(),
      reason: REASON,
    });
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await expectNothingReleased(code);
  });

  it("legend-9vmit before expires_at + 30 min it is refused (409 VA_RELEASE_NOT_ELIGIBLE); one minute later it is released", async () => {
    const code = await openBankTransfer();
    fx.gateway.script(code.intentId, { rawStatus: "01" });

    // Still inside the lifetime of the code.
    expectError(
      await postRelease(code, await approvalFor(code)),
      409,
      "VA_RELEASE_NOT_ELIGIBLE",
    );
    // 29 minutes after expiry: one minute short.
    await lapse(code, RELEASE_AFTER_MIN - 1, "expired");
    expectError(
      await postRelease(code, await approvalFor(code)),
      409,
      "VA_RELEASE_NOT_ELIGIBLE",
    );
    await expectNothingReleased(code);

    // The refusals were about time only: at 31 minutes the same code goes.
    await lapse(code, RELEASE_AFTER_MIN + 1, "expired");
    const approval = await approvalFor(code);
    expect((await postRelease(code, approval)).status).toBe(200);
    await expectStaffRow(code, approval);
  });

  it("legend-9vmit an orphan bank_transfer inside the 30 minute window is refused too", async () => {
    const code = await openOrphanBankTransfer();
    fx.gateway.script(code.intentId, { rawStatus: "01" });
    await lapse(code, RELEASE_AFTER_MIN - 1, "failed");
    expectError(
      await postRelease(code, await approvalFor(code)),
      409,
      "VA_RELEASE_NOT_ELIGIBLE",
    );
    await expectNothingReleased(code);
  });

  it("legend-9vmit a QRIS code is still not releasable (409 VA_RELEASE_NOT_ELIGIBLE)", async () => {
    const qris = await openCode("qris");
    fx.gateway.script(qris.intentId, { error: "5xx" });
    await lapse(qris, RELEASE_AFTER_MIN + 1, "expired");
    expectError(
      await postRelease(qris, await approvalFor(qris)),
      409,
      "VA_RELEASE_NOT_ELIGIBLE",
    );
    expect(await releaseRows(qris.intentId)).toEqual([]);
    expect(await auditRows(qris)).toEqual([]);
  });

  it("legend-9vmit a bank_transfer code the provider already declared final is not releasable", async () => {
    const code = await openBankTransfer();
    fx.gateway.script(code.intentId, { error: "5xx" });
    await lapse(code, RELEASE_AFTER_MIN + 1, "expired");
    await owner.query(
      "UPDATE payment_intents SET provider_final_at = now() WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, code.intentId],
    );
    expectError(
      await postRelease(code, await approvalFor(code)),
      409,
      "VA_RELEASE_NOT_ELIGIBLE",
    );
    expect(await releaseRows(code.intentId)).toEqual([]);
  });
});

// ------------------------------------------------- CHECK constraints (SQL)

describe("legend-9vmit payment_va_releases kind and CHECK constraints", () => {
  type Row = {
    kind?: string | null;
    releasedBy?: string | null;
    approvedBy?: string | null;
    overrideId?: string | null;
    reason?: string;
  };

  /** Insert straight into the table; rejects with the Postgres error. */
  async function insertRow(code: Opened, row: Row) {
    const withKind = row.kind !== undefined;
    return owner.query(
      `INSERT INTO payment_va_releases
         (tenant_id, id, outlet_id, payment_intent_id, order_id, reason,
          released_by, approved_by, override_id, status, attempts, next_check_at
          ${withKind ? ", kind" : ""})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', 0,
               now() + interval '1 day' ${withKind ? ", $10" : ""})`,
      [
        fx.tenant.tenantId,
        randomUUID(),
        fx.tenant.outletId,
        code.intentId,
        uuidFormOf(code.order.id),
        row.reason ?? "Alasan uji constraint",
        row.releasedBy ?? null,
        row.approvedBy ?? null,
        row.overrideId ?? null,
        ...(withKind ? [row.kind] : []),
      ],
    );
  }

  const staffFields = () => ({
    releasedBy: "seed-staff",
    approvedBy: "seed-manager",
    overrideId: randomUUID(),
  });

  async function expectCheckViolation(promise: Promise<unknown>) {
    await expect(promise).rejects.toMatchObject({ code: CHECK_VIOLATION });
  }

  it("legend-9vmit a kind staff row with released_by, approved_by and override_id is accepted", async () => {
    const code = await openCode("va");
    await insertRow(code, { kind: "staff", ...staffFields() });
    const rows = await releaseRows(code.intentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("staff");
  });

  it("legend-9vmit a row without kind defaults to staff", async () => {
    const code = await openCode("va");
    await insertRow(code, staffFields());
    expect((await releaseRows(code.intentId))[0]!.kind).toBe("staff");
  });

  it("legend-9vmit a kind staff row without approved_by is refused by a CHECK", async () => {
    const code = await openCode("va");
    await expectCheckViolation(
      insertRow(code, { kind: "staff", ...staffFields(), approvedBy: null }),
    );
    expect(await releaseRows(code.intentId)).toEqual([]);
  });

  it("legend-9vmit a kind staff row without override_id is refused by a CHECK", async () => {
    const code = await openCode("va");
    await expectCheckViolation(
      insertRow(code, { kind: "staff", ...staffFields(), overrideId: null }),
    );
    expect(await releaseRows(code.intentId)).toEqual([]);
  });

  it("legend-9vmit a kind staff row without released_by is refused by a CHECK", async () => {
    const code = await openCode("va");
    await expectCheckViolation(
      insertRow(code, { kind: "staff", ...staffFields(), releasedBy: null }),
    );
    expect(await releaseRows(code.intentId)).toEqual([]);
  });

  it("legend-9vmit a row without kind and without approval is refused (the default kind is staff)", async () => {
    const code = await openCode("va");
    await expectCheckViolation(
      insertRow(code, { ...staffFields(), approvedBy: null, overrideId: null }),
    );
    expect(await releaseRows(code.intentId)).toEqual([]);
  });

  it("legend-9vmit a guest_method_change row with no approval and no override is accepted", async () => {
    const code = await openCode("va");
    await insertRow(code, { kind: "guest_method_change" });
    const rows = await releaseRows(code.intentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "guest_method_change",
      approved_by: null,
      override_id: null,
      status: "open",
    });
  });

  it("legend-9vmit a guest_method_change row with approved_by is refused by a CHECK", async () => {
    const code = await openCode("va");
    await expectCheckViolation(
      insertRow(code, { kind: "guest_method_change", approvedBy: "seed-man" }),
    );
    expect(await releaseRows(code.intentId)).toEqual([]);
  });

  it("legend-9vmit a guest_method_change row with override_id is refused by a CHECK", async () => {
    const code = await openCode("va");
    await expectCheckViolation(
      insertRow(code, {
        kind: "guest_method_change",
        overrideId: randomUUID(),
      }),
    );
    expect(await releaseRows(code.intentId)).toEqual([]);
  });

  it("legend-9vmit an unknown kind is refused by a CHECK", async () => {
    const code = await openCode("va");
    await expectCheckViolation(
      insertRow(code, { kind: "something_else", ...staffFields() }),
    );
    await expectCheckViolation(insertRow(code, { kind: "" }));
    expect(await releaseRows(code.intentId)).toEqual([]);
  });

  it("legend-9vmit two guest_method_change rows of different intents with override_id NULL are both accepted", async () => {
    const first = await openCode("va");
    const second = await openCode("va");
    await insertRow(first, { kind: "guest_method_change" });
    await insertRow(second, { kind: "guest_method_change" });
    expect(await releaseRows(first.intentId)).toHaveLength(1);
    expect(await releaseRows(second.intentId)).toHaveLength(1);
  });

  it("legend-9vmit the unique rules stay: one row per intent, one row per override_id", async () => {
    const first = await openCode("va");
    const second = await openCode("va");
    const shared = randomUUID();
    await insertRow(first, {
      kind: "staff",
      ...staffFields(),
      overrideId: shared,
    });
    // A second row for the same intent.
    await expect(
      insertRow(first, { kind: "guest_method_change" }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    // The same override used for another intent.
    await expect(
      insertRow(second, {
        kind: "staff",
        ...staffFields(),
        overrideId: shared,
      }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    expect(await releaseRows(second.intentId)).toEqual([]);
  });
});
