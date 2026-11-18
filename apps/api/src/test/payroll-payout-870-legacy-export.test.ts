// Second-opinion finding legend-yjbjb (P1): the legacy bank export
// (POST /api/hris/payroll/runs/:id/bank-transfer-files, permission
// payroll.lock only) let a user obtain a payment file with account numbers and
// net pay for a freshly locked run without any payout approval, and a mixed
// cash/bank run could be paid through that file while only the cash was ever
// settled in the books.
//
// Decision (final): the legacy creation endpoint is closed for every run:
// 409 code LEGACY_BANK_EXPORT_DISABLED, no file row. A payment instruction can
// only come out of an approved payout batch (payroll-payout-manual export).
// Listing and downloading archive files that already exist keep working.
//
// Assumptions:
// - "payroll.lock only" is a user whose role holds exactly ["payroll.lock"];
//   the refusal must come from the new rule (409 + code), not from 401/403/422.
// - The old tests H1 in payroll-payout-manual.test.ts (`[h1-legacy-*]`,
//   `[h1-batch-refused-with-bank-file]`, `[h1-db-*-trigger]`) expect the legacy
//   POST to answer 201; they encode the superseded behavior and the engineer
//   has to rewrite them (seed the archive file row directly instead).
// - The archive list endpoint needs payroll.view and returns the stored file
//   with a signed `fileUrl`.
// - This file builds its own app with an in-memory object store because the
//   shared payout fixture's store has no `put` (the legacy route writes the
//   file there); without it the base answers 500 instead of the old 201.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { ObjectStorage, StorageRequest } from "@starter/shared/adapters";
import { CoreError } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  ANDI,
  APP,
  APP2,
  BUDI,
  CASHIER,
  SITI,
  actorOf,
  bank,
  cash,
  installPayoutWorld,
} from "./payroll-payout-fixtures.ts";
import { exportManualBatch } from "../services/payroll-payout-manual.service.ts";

const W = installPayoutWorld("870legacy");

const FAKE_STORE = "https://legacy-export-store.example.test/object";
const stored = new Map<string, StorageRequest>();
const fakeStorage: ObjectStorage = {
  put: async (_context, input) => {
    stored.set(input.key, input);
    return { reference: input.reference, accepted: true };
  },
  get: async (_context, input) => {
    const found = stored.get(input.key);
    if (!found) throw new CoreError("NOT_FOUND", "Objek tidak ditemukan.");
    return found;
  },
  delete: async (_context, input) => {
    stored.delete(input.key);
  },
  signedGetUrl: async (_context, input) =>
    `${FAKE_STORE}?key=${encodeURIComponent(input.key)}&sig=fake`,
  publicUrl: async () => {
    throw new Error("a payroll bank file must not use a public URL");
  },
};
const storageRuntime: StorageRuntime = {
  storage: fakeStorage,
  scanner: new NoopMalwareScanner(),
  fileSigner: async () => null,
  hrisDocumentSigner: async () => null,
};
const app = createApp({ storageRuntime });

const users: string[] = [];
const roles: string[] = [];
const seededFileRuns: string[] = [];

async function clientWith(name: string, permissions: string[]) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  users.push(userId);
  const roleId = randomUUID();
  roles.push(roleId);
  await W.asTenant(async (c) => {
    await c.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        W.tenantId,
        `Legacy870 ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await c.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [W.tenantId, userId, roleId],
    );
  }, true);
  return client;
}

afterAll(async () => {
  await W.asTenant(async (c) => {
    await c.query(
      "DELETE FROM bank_transfer_files WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [W.tenantId, seededFileRuns],
    );
    await c.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'legacy870-%'",
      [W.tenantId],
    );
    await c.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [W.tenantId, users],
    );
    await c.query("DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)", [
      W.tenantId,
      roles,
    ]);
  }, true);
});

const path = (runId: string) =>
  `/api/hris/payroll/runs/${runId}/bank-transfer-files`;
type Client = ReturnType<typeof agent>;
const legacyExport = (client: Client, runId: string, format = "generic_csv") =>
  client
    .post(path(runId))
    .set(originHeader)
    .send({ format, idempotencyKey: `legacy870-${randomUUID()}` });
const fileCount = async (runId: string) =>
  Number(
    (
      await W.rowsOf(
        "SELECT count(*)::int AS n FROM bank_transfer_files WHERE tenant_id = $1 AND payroll_run_id = $2",
        [W.tenantId, runId],
      )
    )[0]!.n,
  );

describe("legend-yjbjb: the legacy bank export cannot produce a payment file", () => {
  it("[yjbjb-legacy-refused] a user with payroll.lock only, on a fresh locked run without any batch: 409 LEGACY_BANK_EXPORT_DISABLED and no file row", async () => {
    const locker = await clientWith("Legacy870 Locker", ["payroll.lock"]);
    const runId = await W.seedRun([
      bank(BUDI, 4_000_000),
      bank(SITI, 3_000_000),
    ]);

    const response = await legacyExport(locker, runId);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("LEGACY_BANK_EXPORT_DISABLED");
    expect(await fileCount(runId)).toBe(0);
    // Nothing was written to the object store for this run either.
    expect([...stored.keys()].filter((k) => k.includes(runId))).toEqual([]);

    // Replaying with another idempotency key changes nothing.
    const again = await legacyExport(locker, runId);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.code).toBe("LEGACY_BANK_EXPORT_DISABLED");
    expect(await fileCount(runId)).toBe(0);
  });

  it("[yjbjb-mixed-run-no-combination] mixed cash/bank run, cash already handed over, no approved bank batch: the legacy file is refused, so the bank part can only be paid through a batch, and the whole run settles once", async () => {
    const slips = [bank(BUDI, 3_000_000), cash(CASHIER, 2_000_000)];
    const locker = await clientWith("Legacy870 Mixed Locker", ["payroll.lock"]);
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);

    // Setup (legend-rvao9): the cash approve guard needs 1102 to cover the batch.
    await W.fundPettyCash(1_000_000_000);
    const cashBatch = await W.approvedBatch(runId, "cash");
    const [cashItem] = await W.itemsOf(cashBatch);
    await W.handover(cashBatch, [cashItem!.id as string], APP2);
    expect((await W.runRow(runId)).status).toBe("locked");

    // The old channel would hand out the bank file with no payout approval.
    const response = await legacyExport(locker, runId);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("LEGACY_BANK_EXPORT_DISABLED");
    expect(await fileCount(runId)).toBe(0);

    // The bank part goes through an approved batch and is settled in the books.
    const bankBatch = await W.exportedBatch(runId);
    const bankItems = await W.itemsOf(bankBatch);
    await W.confirm(bankBatch, W.succeedItems(bankBatch, bankItems));

    expect((await W.runRow(runId)).status).toBe("paid");
    const postings = [
      ...(await W.postingsOf(cashBatch)),
      ...(await W.postingsOf(bankBatch)),
    ];
    expect(postings.map((p) => p.kind)).toEqual(["settle", "settle"]);
    const journals = await Promise.all(
      postings.map((p) => W.journalByKey(p.journal_key as string)),
    );
    expect(journals).toEqual([
      {
        "2103": { debit: 2_000_000, credit: 0 },
        "1102": { debit: 0, credit: 2_000_000 },
      },
      {
        "2103": { debit: 3_000_000, credit: 0 },
        "1103": { debit: 0, credit: 3_000_000 },
      },
    ]);
  });

  it("[yjbjb-refused-with-cash-batch-only] a run that only has an approved cash batch still gets no legacy bank file", async () => {
    const locker = await clientWith("Legacy870 State Locker", ["payroll.lock"]);
    const cashOnly = await W.seedRun([
      bank(ANDI, 1_000_000),
      cash(CASHIER, 500_000),
    ]);
    // Setup (legend-rvao9): the cash approve guard needs 1102 to cover the batch.
    await W.fundPettyCash(1_000_000_000);
    await W.approvedBatch(cashOnly, "cash");
    const response = await legacyExport(locker, cashOnly);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("LEGACY_BANK_EXPORT_DISABLED");
    expect(await fileCount(cashOnly)).toBe(0);
  });

  it("[yjbjb-archive-still-readable] control: a file created before the cutover is still listed with a signed download URL for payroll.view", async () => {
    const viewer = await clientWith("Legacy870 Viewer", ["payroll.view"]);
    const runId = await W.seedRun([bank(BUDI, 1_234_000)]);
    seededFileRuns.push(runId);
    const objectKey = `tenants/${W.tenantId}/payroll/bank-transfer-files/${runId}/archive.csv`;
    const content = "rekening,jumlah\r\n123,1234000\r\n";
    stored.set(objectKey, {
      tenantId: W.tenantId,
      outletId: null,
      reference: "archive.csv",
      key: objectKey,
      contentType: "text/csv",
      content,
    } as StorageRequest);
    const fileId = randomUUID();
    await W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO bank_transfer_files
             (id, tenant_id, payroll_run_id, format, row_count, total_idr, checksum_sha256, object_key, created_by)
           VALUES ($1, $2, $3, 'generic_csv', 1, 1234000, $4, $5, $6)`,
          [
            fileId,
            W.tenantId,
            runId,
            createHash("sha256").update(content).digest("hex"),
            objectKey,
            randomUUID(),
          ],
        ),
      true,
    );

    const list = await viewer.get(path(runId));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const listed = (list.body.data as { id: string; fileUrl: string }[]).find(
      (file) => file.id === fileId,
    );
    expect(listed, "the archived file is listed").toBeDefined();
    const url = new URL(listed!.fileUrl);
    expect(`${url.origin}${url.pathname}`).toBe(FAKE_STORE);
    expect(url.searchParams.get("key")).toBe(objectKey);
  });

  it("[yjbjb-approved-batch-still-exports] control: only the approved manual_bank batch produces the payment file, with every net amount", async () => {
    const runId = await W.seedRun([
      bank(BUDI, 4_250_000),
      bank(SITI, 3_100_500),
    ]);
    const batchId = await W.approvedBatch(runId);
    const file = await W.inTx((tx) =>
      exportManualBatch(tx, actorOf(APP), batchId),
    );
    expect(file.content).toContain("4250000");
    expect(file.content).toContain("3100500");
    for (const item of await W.itemsOf(batchId))
      expect(item.status).toBe("exported");
    // The archive table stays untouched: the batch export is the only channel.
    expect(await fileCount(runId)).toBe(0);
  });
});
