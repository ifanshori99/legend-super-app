// Payout proposal list for the second approver (bead legend-t58lr part 2;
// brief "Payout evidence hardening"). GET
// /api/hris/payroll/disbursement-batches/:id/resolution-proposals lists the
// items waiting for their second person: kind (resolve or return), proposed
// outcome, proof key, proposer and time. It needs payroll.disburse.approve and
// only reads: no batch, item or journal changes.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  BUDI,
  SITI,
  bank,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("proposal");
const BASE = "/api/hris/payroll/disbursement-batches";
const idOf = (row: Row) => row.id as string;

const store = new FakeObjectStorage();
const runtime: StorageRuntime = {
  storage: store,
  scanner: new NoopMalwareScanner(),
  fileSigner: async () => "https://signed.example.test/x",
  hrisDocumentSigner: async () => null,
};
const app = createApp({ storageRuntime: runtime });

const dbOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const grantedUsers: string[] = [];
const enrolledUsers: string[] = [];

type Staff = { client: ReturnType<typeof agent>; userId: string };
let first: Staff; // payroll.disburse.approve, real MFA challenge
let second: Staff; // a different person with the same rights
let viewer: Staff; // payroll.view only: must not read proof

/** Staff holding exactly these permissions; `challenged` skips the password step-up. */
async function staff(permissions: string[], challenged: boolean) {
  const client = agent(app);
  await signUp(client, "Payout Proposal");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  grantedUsers.push(userId);
  await W.grantRole(userId, permissions);
  const enrolled = await client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  enrolledUsers.push(userId);
  const { factorId, secretBase32 } = enrolled.body.data as {
    factorId: string;
    secretBase32: string;
  };
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  if (challenged) {
    await dbOwner.query(
      "UPDATE mfa_factors SET created_at = now() - interval '1 day', verified_at = now() - interval '1 day' WHERE id = $1",
      [factorId],
    );
    const again = await client
      .post("/api/auth/mfa/verify")
      .set(originHeader)
      .send({
        factorId,
        code: totpCode(secretBase32, totpStep(new Date()) + 1),
      });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  }
  return { client, userId } as Staff;
}

beforeAll(async () => {
  first = await staff(["payroll.view", "payroll.disburse.approve"], true);
  second = await staff(["payroll.view", "payroll.disburse.approve"], true);
  viewer = await staff(["payroll.view"], true);
});
afterAll(async () => {
  if (enrolledUsers.length > 0)
    await dbOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  if (grantedUsers.length > 0)
    await dbOwner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [grantedUsers],
    );
  await dbOwner.end();
});

// ---- Helpers --------------------------------------------------------------

const pdfBytes = () =>
  Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\nbukti ${randomUUID()}\n%%EOF\n`);

async function uploadProof(who: Staff, batchId: string) {
  const bytes = pdfBytes();
  const res = await who.client
    .post(`${BASE}/${batchId}/evidence`)
    .set(originHeader)
    .attach("file", bytes, {
      filename: "bukti.pdf",
      contentType: "application/pdf",
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    key: (res.body.data as { evidenceKey: string }).evidenceKey,
    bytes,
  };
}

async function exportedRun() {
  const slips = [bank(BUDI, 4_000_000), bank(SITI, 3_000_000)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  return { runId, batchId, items };
}

const resolveBody = (
  itemId: string,
  evidenceKey: string,
  outcome = "failed",
) => ({
  itemIds: [itemId],
  outcome,
  evidenceKey,
  note: "Bank menolak transfer, tidak ada dana keluar",
});
const postResolve = (
  who: Staff,
  batchId: string,
  itemId: string,
  evidenceKey: string,
  outcome = "failed",
) =>
  who.client
    .post(`${BASE}/${batchId}/resolve`)
    .set(originHeader)
    .send(resolveBody(itemId, evidenceKey, outcome));
const postReturn = (
  who: Staff,
  batchId: string,
  itemId: string,
  evidenceKey: string,
) =>
  who.client
    .post(`${BASE}/${batchId}/return`)
    .set(originHeader)
    .send({
      itemIds: [itemId],
      evidenceKey,
      note: "Bank mengembalikan dana, rekening tujuan ditutup",
    });
const moneyState = async (batchId: string) =>
  JSON.stringify({
    batch: (await W.batchById(batchId)).status,
    items: (await W.itemsOf(batchId)).map((i) => ({
      id: i.id,
      status: i.status,
      resolved_by: i.resolved_by,
      resolved_by_2: i.resolved_by_2,
      returned_by: i.returned_by,
      returned_by_2: i.returned_by_2,
    })),
    postings: (await W.postingsOf(batchId)).length,
  });

const BASE_PROPOSALS = (batchId: string) =>
  `${BASE}/${batchId}/resolution-proposals`;
const listProposals = (
  who: { client: ReturnType<typeof agent> },
  batchId: string,
) => who.client.get(BASE_PROPOSALS(batchId));

type Proposal = {
  itemId: string;
  employeeId: string;
  kind: string;
  outcome: string | null;
  evidenceKey: string | null;
  proposedBy: string;
  proposedAt: string;
};

describe("legend-t58lr proposal list for the second approver", () => {
  it("[t58lr-proposal-resolve] a first resolve step is listed with outcome, proof key, proposer and time; the second step removes it", async () => {
    const { batchId, items } = await exportedRun();
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    const empty = await listProposals(second, batchId);
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body.data).toEqual([]);

    const proof = await uploadProof(first, batchId);
    const step1 = await postResolve(
      first,
      batchId,
      idOf(siti),
      proof.key,
      "not_sent",
    );
    expect(step1.status, JSON.stringify(step1.body)).toBe(200);
    const before = await moneyState(batchId);

    const listed = await listProposals(second, batchId);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const data = listed.body.data as Proposal[];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      itemId: idOf(siti),
      employeeId: SITI.id,
      kind: "resolve",
      outcome: "not_sent",
      evidenceKey: proof.key,
      proposedBy: first.userId,
    });
    expect(Number.isNaN(Date.parse(data[0]!.proposedAt))).toBe(false);
    expect(await moneyState(batchId), "listing changes nothing").toBe(before);

    const step2 = await postResolve(
      second,
      batchId,
      idOf(siti),
      proof.key,
      "not_sent",
    );
    expect(step2.status, JSON.stringify(step2.body)).toBe(200);
    expect((await listProposals(second, batchId)).body.data).toEqual([]);
  });

  it("[t58lr-proposal-return] a first return step is listed as kind return with its proof, outcome null", async () => {
    const { batchId, items } = await exportedRun();
    await W.confirm(
      batchId,
      items.map((item, index) => ({
        itemId: idOf(item),
        result: "succeeded" as const,
        bankRef: `BCA-${batchId.slice(0, 8)}-${index}`,
      })),
    );
    const budi = await W.itemOfPerson(batchId, BUDI);
    const proof = await uploadProof(first, batchId);
    const step1 = await postReturn(first, batchId, idOf(budi), proof.key);
    expect(step1.status, JSON.stringify(step1.body)).toBe(200);

    const listed = await listProposals(second, batchId);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data as Proposal[]).toEqual([
      expect.objectContaining({
        itemId: idOf(budi),
        kind: "return",
        outcome: null,
        evidenceKey: proof.key,
        proposedBy: first.userId,
      }),
    ]);
  });

  it("[t58lr-proposal-guard] payroll.view alone gets 403, not signed in 401, an unknown batch 404, and none of them lists a proposal", async () => {
    const { batchId, items } = await exportedRun();
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    const proof = await uploadProof(first, batchId);
    await postResolve(first, batchId, idOf(siti), proof.key);

    const denied = await listProposals(viewer, batchId);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain(proof.key);
    const anonymous = await listProposals({ client: agent(app) }, batchId);
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(anonymous.body)).not.toContain(proof.key);
    const unknown = await listProposals(second, randomUUID());
    expect(unknown.status).toBe(404);
  });
});
