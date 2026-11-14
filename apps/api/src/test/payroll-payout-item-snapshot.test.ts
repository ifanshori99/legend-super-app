// Payout item bank snapshot (bead legend-2bl54; brief
// docs/briefs/731-payout-api-gaps-impl.md B and T). Written fail-first from the
// brief and the shared contract (PayrollDisbursementItemDto.accountHolderName /
// .maskedAccountNumber), not from the implementation.
//
// Rules proven here:
// - A bank item carries the payee name and `****` + last 4 digits of the
//   account, locked when the batch was created (columns
//   account_holder_name, masked_account_number on payroll_disbursement_items).
// - The full account number never appears in any batch JSON (detail, per-run
//   list) nor in the stored item row.
// - Changing the employee's bank account later changes neither value of an
//   existing batch; a batch of a run locked after the change shows the new one.
// - A direct UPDATE of either snapshot column is refused by the database.
// - A cash item has both values null.
//
// Assumptions (the brief is silent, stated so they can be contested):
// - accountHolderName is only asserted to be a non-empty string: whether it is
//   the employee's name or the bank-side holder name is the implementation's
//   choice (openPayeeBankSnapshot.accountHolder).
// - Column names are the ones in the brief (snake_case of the DTO fields).
// - Round 2 (T2): the trigger message carries the code `PAYOUT-24` (brief);
//   an account number that is not digits (the employee PII validator only asks
//   for 6-34 characters) cannot be masked, so `maskedAccountNumber` is null
//   while the name stays and the batch is still created (not a 4xx/5xx).
// - The direct-UPDATE refusal is asserted on a `prepared`-or-later item (the
//   batch is exported), where the brief says the columns are frozen absolutely
//   (the exception is only a snapshot swap while prepared/blocked).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  BUDI,
  CASHIER,
  SITI,
  ANDI,
  bank,
  cash,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("item-snapshot");
const BASE = "/api/hris/payroll/disbursement-batches";
const randomDigits = (length: number) =>
  Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
const lastFour = (account: string) => `****${account.slice(-4)}`;

const dbOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const grantedUsers: string[] = [];
afterAll(async () => {
  if (grantedUsers.length > 0)
    await dbOwner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [grantedUsers],
    );
  await dbOwner.end();
});

async function staff(permissions: string[]) {
  const client = agent(W.app);
  const email = await signUp(client, "Payout Snapshot");
  await verifySessionMfa(email);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  grantedUsers.push(userId);
  await W.grantRole(userId, permissions);
  return { client, userId };
}

type BatchBody = {
  id: string;
  items: {
    employeeId: string;
    channel: string;
    accountHolderName: string | null;
    maskedAccountNumber: string | null;
  }[];
};
async function fetchBatch(
  viewer: Awaited<ReturnType<typeof staff>>,
  batchId: string,
) {
  const res = await viewer.client.get(`${BASE}/${batchId}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { body: res.body.data as BatchBody, text: res.text };
}
const itemFor = (batch: BatchBody, employeeId: string) =>
  batch.items.find((i) => i.employeeId === employeeId)!;

async function bankRun(slips = [bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]) {
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.createBatch(runId);
  return { runId, batchId };
}

describe("legend-2bl54 item bank snapshot", () => {
  it("[2bl54-bank-item] a bank item shows the payee name and ****last4 in the batch detail and the per-run list", async () => {
    const viewer = await staff(["payroll.view"]);
    const { runId, batchId } = await bankRun();

    const { body } = await fetchBatch(viewer, batchId);
    expect(body.items).toHaveLength(2);
    for (const person of [BUDI, SITI]) {
      const item = itemFor(body, person.id);
      expect(item.channel).toBe("manual_bank");
      expect(item.maskedAccountNumber).toBe(lastFour(person.account));
      expect(typeof item.accountHolderName).toBe("string");
      expect((item.accountHolderName ?? "").trim().length).toBeGreaterThan(0);
    }

    const list = await viewer.client.get(
      `/api/hris/payroll/runs/${runId}/disbursement-batches`,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const listed = (list.body.data as BatchBody[]).find(
      (b) => b.id === batchId,
    )!;
    expect(itemFor(listed, BUDI.id).maskedAccountNumber).toBe(
      lastFour(BUDI.account),
    );
  });

  it("[2bl54-no-full-number] no full account number appears in any batch JSON (detail, per-run list, after export) nor in the stored item row", async () => {
    const viewer = await staff(["payroll.view"]);
    const slips = [
      bank(BUDI, 4_000_000),
      bank(SITI, 3_000_000),
      bank(ANDI, 1_000_000),
    ];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.exportedBatch(runId);
    const accounts = [BUDI, SITI, ANDI].map((p) => p.account);

    const detail = await fetchBatch(viewer, batchId);
    // Premise: the snapshot exists (otherwise "no full number" proves nothing).
    expect(itemFor(detail.body, SITI.id).maskedAccountNumber).toBe(
      lastFour(SITI.account),
    );
    const list = await viewer.client.get(
      `/api/hris/payroll/runs/${runId}/disbursement-batches`,
    );
    expect(list.status).toBe(200);
    for (const account of accounts) {
      expect(detail.text, "batch detail").not.toContain(account);
      expect(list.text, "per-run list").not.toContain(account);
    }
    for (const row of await W.itemsOf(batchId)) {
      expect(row.masked_account_number).toMatch(/^\*{4}[0-9]{4}$/);
      const stored = JSON.stringify(row);
      for (const account of accounts)
        expect(stored, "stored item row").not.toContain(account);
    }
  });

  it("[2bl54-cash-item] a cash item has accountHolderName and maskedAccountNumber null, in the DTO and in the row", async () => {
    const viewer = await staff(["payroll.view"]);
    const slips = [cash(CASHIER, 900_000)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.createBatch(runId, "cash");

    const { body } = await fetchBatch(viewer, batchId);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      channel: "cash",
      accountHolderName: null,
      maskedAccountNumber: null,
    });
    const rows = await W.itemsOf(batchId);
    // `toHaveProperty` so a missing column is a failure, not a pass on undefined.
    expect(rows[0]).toHaveProperty("account_holder_name", null);
    expect(rows[0]).toHaveProperty("masked_account_number", null);
  });

  it("[2bl54-trigger-frozen] a direct UPDATE of either snapshot column is refused by the database; the values stay", async () => {
    const slips = [bank(BUDI, 4_000_000), bank(SITI, 3_000_000)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.exportedBatch(runId);
    const [row] = (await W.itemsOf(batchId)).filter(
      (i: Row) => i.employee_id === BUDI.id,
    );
    expect(row, "premise: item exists").toBeDefined();
    expect(row!.masked_account_number, "premise: snapshot column filled").toBe(
      lastFour(BUDI.account),
    );

    for (const [column, value] of [
      ["masked_account_number", "****9999"],
      ["account_holder_name", "Orang Lain"],
    ] as const) {
      const error = await W.asTenant((c) =>
        c.query(
          `UPDATE payroll_disbursement_items SET ${column} = $2 WHERE id = $1`,
          [row!.id, value],
        ),
      ).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error, `${column} must not be updatable`).not.toBeNull();
      expect(
        String(error!.message),
        "refused by the guard, not by a missing column",
      ).not.toMatch(/does not exist/);
      expect(
        String(error!.message),
        "the freeze trigger answers with its own code",
      ).toContain("PAYOUT-24");
    }
    const after = (await W.itemsOf(batchId)).find(
      (i: Row) => i.id === row!.id,
    )!;
    expect(after.masked_account_number).toBe(row!.masked_account_number);
    expect(after.account_holder_name).toBe(row!.account_holder_name);
  });

  it("[2bl54-snapshot-after-account-change] changing the employee's account after the batch was made changes neither value; a run locked after the change shows the new account", async () => {
    const viewer = await staff(["payroll.view"]);
    const hr = await staff(["hr.employee.manage", "hr.employee.view"]);
    const { batchId } = await bankRun([bank(SITI, 3_000_000)]);
    const before = await fetchBatch(viewer, batchId);
    const first = itemFor(before.body, SITI.id);
    expect(first.maskedAccountNumber, "premise: snapshot exists").toBe(
      lastFour(SITI.account),
    );

    let newAccount = randomDigits(12);
    while (newAccount.slice(-4) === SITI.account.slice(-4))
      newAccount = randomDigits(12);
    const nik = randomDigits(16);
    const npwp = randomDigits(15);
    const put = await hr.client
      .put(`/api/hris/employees/${SITI.id}/pii`)
      .set(originHeader)
      .send({
        nik,
        npwp,
        bankAccount: newAccount,
        idempotencyKey: `payout-gl-${randomUUID()}`,
      });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const after = await fetchBatch(viewer, batchId);
    expect(itemFor(after.body, SITI.id)).toMatchObject({
      accountHolderName: first.accountHolderName,
      maskedAccountNumber: first.maskedAccountNumber,
    });
    expect(after.text).not.toContain(newAccount);

    // A new run locked after the change snapshots the new account.
    const next = await bankRun([bank(SITI, 2_000_000)]);
    const fresh = await fetchBatch(viewer, next.batchId);
    expect(itemFor(fresh.body, SITI.id).maskedAccountNumber).toBe(
      lastFour(newAccount),
    );
  });

  it("[2bl54-non-digit-account] an account number that is not digits gives maskedAccountNumber null; the name stays and the batch is created", async () => {
    const viewer = await staff(["payroll.view"]);
    const hr = await staff(["hr.employee.manage", "hr.employee.view"]);
    const odd = "BCA-XYZ-1234";
    const put = await hr.client
      .put(`/api/hris/employees/${ANDI.id}/pii`)
      .set(originHeader)
      .send({
        nik: randomDigits(16),
        npwp: randomDigits(15),
        bankAccount: odd,
        idempotencyKey: `payout-gl-${randomUUID()}`,
      });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const { batchId } = await bankRun([bank(ANDI, 1_500_000)]);
    const { body, text } = await fetchBatch(viewer, batchId);
    const item = itemFor(body, ANDI.id);
    expect(item.channel).toBe("manual_bank");
    expect(item.maskedAccountNumber).toBeNull();
    expect(typeof item.accountHolderName).toBe("string");
    expect((item.accountHolderName ?? "").trim().length).toBeGreaterThan(0);
    expect(text, "the raw value is never shown").not.toContain(odd);
    const [row] = await W.itemsOf(batchId);
    expect(row).toHaveProperty("masked_account_number", null);
    expect(row!.account_holder_name).toBeTruthy();
  });
});
