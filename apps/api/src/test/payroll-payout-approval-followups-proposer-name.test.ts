// The proposal list names the proposer (bead legend-eszso, brief "payout
// approval followups", card 3). Written fail-first from the brief, not from the
// implementation.
//
// GET /api/hris/payroll/disbursement-batches/:id/resolution-proposals now adds
// `proposedByName: string | null` to every proposal (resolve and return). It is
// the proposer's account name, but ONLY for a person who holds a role
// assignment in the caller's tenant; for anyone else it is null, and the name
// must not appear anywhere in the response. `proposedBy` (the id) is unchanged.
//
// Assumptions (the brief leaves them open):
// - "Outside the tenant" is made by removing the proposer's role assignment of
//   this tenant after the first step (the person left the tenant): the proposal
//   stays listed, with proposedByName null and the name nowhere in the body.
// - The account name is the one given at sign-up; each proposer gets a unique
//   one so a leak is detectable.
// - Why these tests fail today: the DTO has no `proposedByName`.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
import {
  BUDI,
  SITI,
  bank,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("proposer-name");
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

type Staff = {
  client: ReturnType<typeof agent>;
  userId: string;
  name: string;
};
let second: Staff;

/** An approver (real MFA challenge, no password step-up) with a unique name. */
async function staff(label: string): Promise<Staff> {
  const name = `${label} ${randomUUID().slice(0, 8)}`;
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  grantedUsers.push(userId);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
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
  return { client, userId, name };
}

beforeAll(async () => {
  second = await staff("Penyetuju Dua");
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

async function uploadProof(who: Staff, batchId: string) {
  const res = await who.client
    .post(`${BASE}/${batchId}/evidence`)
    .set(originHeader)
    .attach(
      "file",
      Buffer.from(await validPdfBytes({ marker: `bukti ${randomUUID()}` })),
      { filename: "bukti.pdf", contentType: "application/pdf" },
    );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body.data as { evidenceKey: string }).evidenceKey;
}

async function exportedRun() {
  const slips = [bank(BUDI, 4_000_000), bank(SITI, 3_000_000)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  return { runId, batchId };
}

async function proposeResolve(who: Staff, batchId: string) {
  const siti = await W.itemOfPerson(batchId, SITI);
  const key = await uploadProof(who, batchId);
  const res = await who.client
    .post(`${BASE}/${batchId}/resolve`)
    .set(originHeader)
    .send({
      itemIds: [idOf(siti)],
      outcome: "failed",
      evidenceKey: key,
      note: "Bank menolak transfer, tidak ada dana keluar",
    });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return idOf(siti);
}

const listProposals = (who: Staff, batchId: string) =>
  who.client.get(`${BASE}/${batchId}/resolution-proposals`);

type Proposal = {
  itemId: string;
  kind: string;
  proposedBy: string;
  proposedByName?: string | null;
};

describe("legend-eszso the proposal list names the proposer", () => {
  it("[eszso-name-resolve] a resolve proposal carries the proposer's name for a colleague of the same tenant, and the id is unchanged", async () => {
    const { batchId } = await exportedRun();
    const first = await staff("Penyetuju Satu");
    const itemId = await proposeResolve(first, batchId);

    const listed = await listProposals(second, batchId);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const data = listed.body.data as Proposal[];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      itemId,
      kind: "resolve",
      proposedBy: first.userId,
      proposedByName: first.name,
    });
  });

  it("[eszso-name-return] a return proposal carries the proposer's name too", async () => {
    const { batchId } = await exportedRun();
    const first = await staff("Penyetuju Tiga");
    const items = (await W.itemsOf(batchId)).filter(
      (i) => i.status === "exported",
    );
    await W.confirm(
      batchId,
      items.map((item, index) => ({
        itemId: idOf(item),
        result: "succeeded" as const,
        bankRef: `BCA-${batchId.slice(0, 8)}-${index}`,
        evidenceKey: undefined,
      })),
    );
    const budi = await W.itemOfPerson(batchId, BUDI);
    const key = await uploadProof(first, batchId);
    const step1 = await first.client
      .post(`${BASE}/${batchId}/return`)
      .set(originHeader)
      .send({
        itemIds: [idOf(budi)],
        evidenceKey: key,
        bankRef: `TRX${randomUUID().slice(0, 8)}`,
        note: "Bank mengembalikan dana, rekening tujuan ditutup",
      });
    expect(step1.status, JSON.stringify(step1.body)).toBe(200);

    const listed = await listProposals(second, batchId);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data as Proposal[]).toEqual([
      expect.objectContaining({
        itemId: idOf(budi),
        kind: "return",
        proposedBy: first.userId,
        proposedByName: first.name,
      }),
    ]);
  });

  it("[eszso-name-outside-tenant] a proposer with no role assignment in this tenant is listed with proposedByName null and the name appears nowhere in the response", async () => {
    const { batchId } = await exportedRun();
    const first = await staff("Penyetuju Luar");
    const itemId = await proposeResolve(first, batchId);
    // The proposer leaves the tenant after the first step.
    await dbOwner.query("DELETE FROM role_assignments WHERE user_id = $1", [
      first.userId,
    ]);

    const listed = await listProposals(second, batchId);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const data = listed.body.data as Proposal[];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ itemId, proposedBy: first.userId });
    expect(data[0]).toHaveProperty("proposedByName", null);
    expect(JSON.stringify(listed.body)).not.toContain(first.name);
  });
});
