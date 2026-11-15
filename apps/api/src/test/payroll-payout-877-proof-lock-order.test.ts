// Payout GL 877, item B (bead legend-1t65x #2): two manual confirmations that
// share the same two proof files, taken in opposite order, must not deadlock.
//
// Rule (from the brief, not from the implementation): a confirmation takes a
// lock per proof fingerprint; the locks must be taken in one fixed order, so
// two concurrent confirmations over the same two files serialize instead of
// failing with PostgreSQL 40P01 (deadlock detected). One of the two may lose
// with a legitimate 409 (the proof file was already used by the other
// batch); a deadlock or a 500 is a bug.
//
// Assumptions (stated so they can be contested):
// - The proof fingerprint is a hash of the file CONTENT (re-upload reuse
//   check), so the same file uploaded under two batch paths shares a
//   fingerprint. The fixture store returns empty content for every key, which
//   would make every file identical; this test supplies a store whose content
//   is the file name, so "bukti-a" and "bukti-b" are two distinct files that
//   both batches reference.
// - A legitimate refusal is HttpError status 409.
// - Deterministic test: the lock key looks like `payout-proof:<tenant>:<sha>`
//   (per the brief) and is taken with tx.execute. The sha is the 64-hex SHA-256
//   of the file content. Locks must be taken in ascending sha order (string
//   order of the hex), each sha exactly once. The recording test runs the
//   confirmation inside a transaction that is rolled back on purpose, so the
//   same two files can be confirmed twice in opposite order.
// - The fingerprint is the SHA-256 stored at upload time in
//   `payroll_payout_evidence_files` (table comment in the schema); the fixtures
//   do not write it, so this test seeds one row per proof file with the
//   SHA-256 of the file name (the content of the content store below). Without
//   that row a proof is "legacy" and takes no lock.
// - Each round uses fresh file names so earlier rounds cannot cause reuse
//   refusals in later ones.
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { ObjectStorage } from "@starter/shared/adapters";
import { confirmManualItems } from "../services/payroll-payout-manual.service.ts";
import type { Tx } from "../services/hris-access.ts";
import {
  APP2,
  BUDI,
  SITI,
  actorOf,
  bank,
  evidenceKeyFor,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("877-proof-lock-order");

const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ROUNDS = 6;

/** Proof store whose file content is the file name (see assumptions). */
const contentStore = () => {
  const base = W.proofs();
  const storage = {
    async get(_context: unknown, input: { key: string; tenantId: string }) {
      const name = input.key.slice(input.key.lastIndexOf("/") + 1);
      return {
        ...input,
        contentType: "application/pdf",
        content: Buffer.from(name),
      };
    },
  } as unknown as ObjectStorage;
  return { storage, context: base.context };
};

async function exportedBatchWithTwoItems() {
  const slips = [bank(BUDI, BUDI_NET), bank(SITI, SITI_NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  return { batchId, items };
}

const pickItem = (items: Row[], person: { id: string }) =>
  items.find((i) => i.employee_id === person.id)!;

type Failure = {
  status?: number;
  code?: string;
  message?: string;
  cause?: { code?: string; message?: string };
};
/** drizzle wraps the driver error, so the PostgreSQL code sits on `cause`. */
const isDeadlock = (reason: unknown) => {
  const e = reason as Failure;
  return (
    e?.code === "40P01" ||
    e?.cause?.code === "40P01" ||
    /deadlock/i.test(`${e?.message} ${e?.cause?.message}`)
  );
};
const describeFailure = (reason: unknown) => {
  const e = reason as Failure;
  return `status=${e?.status} code=${e?.code} cause=${e?.cause?.code}/${e?.cause?.message} message=${e?.message}`;
};

const sha256 = (name: string) =>
  createHash("sha256").update(Buffer.from(name)).digest("hex");

const seededBatches = new Set<string>();

/** Records the upload fingerprint of one proof file, as a real upload would. */
async function seedFingerprint(batchId: string, file: string) {
  seededBatches.add(batchId);
  await W.asTenant(
    (client) =>
      client.query(
        `INSERT INTO payroll_payout_evidence_files
           (tenant_id, batch_id, evidence_key, content_sha256, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          W.tenantId,
          batchId,
          evidenceKeyFor(W.tenantId, batchId, file),
          sha256(file),
          APP2,
        ],
      ),
    true,
  );
}

afterAll(async () => {
  if (seededBatches.size === 0) return;
  await W.asTenant(
    (client) =>
      client.query(
        "DELETE FROM payroll_payout_evidence_files WHERE tenant_id = $1 AND batch_id = ANY($2)",
        [W.tenantId, [...seededBatches]],
      ),
    true,
  );
});

/** Flattens a drizzle SQL object (text chunks and bound values) to a string. */
const flatten = (node: unknown): string => {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  if (typeof node === "object") {
    const o = node as { queryChunks?: unknown; value?: unknown; sql?: unknown };
    if (o.queryChunks) return flatten(o.queryChunks);
    if (o.sql) return flatten(o.sql);
    if (o.value !== undefined) return flatten(o.value);
  }
  return "";
};

class Rollback extends Error {}

/** Runs one confirmation, records the proof-lock shas in call order, rolls back. */
async function recordedProofLocks(
  batchId: string,
  results: Parameters<typeof W.confirm>[1],
  store: ReturnType<typeof contentStore>,
) {
  const recorded: string[] = [];
  try {
    await W.inTx(async (tx) => {
      const spy = new Proxy(tx as object, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "execute" || typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const text = flatten(args[0]);
            if (text.includes("payout-proof:")) {
              expect(text, "lock key must carry the tenant").toContain(
                W.tenantId,
              );
              const sha = text.match(/[0-9a-f]{64}/)?.[0];
              expect(sha, `lock key must carry a sha: ${text}`).toBeTruthy();
              recorded.push(sha!);
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as Tx;
      await confirmManualItems(
        spy,
        actorOf(APP2),
        batchId,
        { results } as never,
        store,
      );
      throw new Rollback("keep the files unused for the next confirmation");
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return recorded;
}

describe("payout 877 B: proof lock order", () => {
  it("[877-proof-lock-order-recorded] proof locks are taken once per file, in ascending sha order, whatever the file order", async () => {
    const batch = await exportedBatchWithTwoItems();
    const store = contentStore();
    for (const file of ["bukti-rec-a.pdf", "bukti-rec-b.pdf"])
      await seedFingerprint(batch.batchId, file);
    const resultsFor = ([fileOne, fileTwo]: [string, string]) => [
      {
        itemId: pickItem(batch.items, BUDI).id as string,
        result: "succeeded" as const,
        bankRef: "BCA-REC-1",
        evidenceKey: evidenceKeyFor(W.tenantId, batch.batchId, fileOne),
      },
      {
        itemId: pickItem(batch.items, SITI).id as string,
        result: "succeeded" as const,
        bankRef: "BCA-REC-2",
        evidenceKey: evidenceKeyFor(W.tenantId, batch.batchId, fileTwo),
      },
    ];
    const forward = await recordedProofLocks(
      batch.batchId,
      resultsFor(["bukti-rec-a.pdf", "bukti-rec-b.pdf"]),
      store,
    );
    const reversed = await recordedProofLocks(
      batch.batchId,
      resultsFor(["bukti-rec-b.pdf", "bukti-rec-a.pdf"]),
      store,
    );
    const expected = [
      sha256("bukti-rec-a.pdf"),
      sha256("bukti-rec-b.pdf"),
    ].sort();

    expect(forward, "one lock per distinct proof file").toHaveLength(2);
    expect(new Set(forward).size, "each sha locked once").toBe(2);
    expect(reversed).toHaveLength(2);
    expect(new Set(reversed).size).toBe(2);
    expect(forward, "locks ascending by sha (A,B order)").toEqual(expected);
    expect(reversed, "locks ascending by sha (B,A order)").toEqual(expected);
    expect(reversed, "same lock order in both orders").toEqual(forward);
  }, 60_000);

  it("[877-proof-lock-order] two simultaneous confirmations over the same two proof files in opposite order never deadlock", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const fileA = `bukti-a-${round}.pdf`;
      const fileB = `bukti-b-${round}.pdf`;
      const first = await exportedBatchWithTwoItems();
      const second = await exportedBatchWithTwoItems();
      const store = contentStore();
      for (const batch of [first, second])
        for (const file of [fileA, fileB])
          await seedFingerprint(batch.batchId, file);
      const keyOf = (batchId: string, file: string) =>
        evidenceKeyFor(W.tenantId, batchId, file);
      const resultsOf = (
        batch: { batchId: string; items: Row[] },
        [fileOne, fileTwo]: [string, string],
      ) => [
        {
          itemId: pickItem(batch.items, BUDI).id as string,
          result: "succeeded" as const,
          bankRef: `BCA-${round}-${batch.batchId.slice(0, 8)}-1`,
          evidenceKey: keyOf(batch.batchId, fileOne),
        },
        {
          itemId: pickItem(batch.items, SITI).id as string,
          result: "succeeded" as const,
          bankRef: `BCA-${round}-${batch.batchId.slice(0, 8)}-2`,
          evidenceKey: keyOf(batch.batchId, fileTwo),
        },
      ];

      // The first batch lists A then B, the second B then A.
      const outcomes = await Promise.allSettled([
        W.confirm(
          first.batchId,
          resultsOf(first, [fileA, fileB]),
          undefined,
          store,
        ),
        W.confirm(
          second.batchId,
          resultsOf(second, [fileB, fileA]),
          undefined,
          store,
        ),
      ]);

      for (const outcome of outcomes) {
        if (outcome.status !== "rejected") continue;
        const e = outcome.reason as Failure;
        const detail = `round ${round}: ${describeFailure(outcome.reason)}`;
        expect(isDeadlock(outcome.reason), `deadlock detected, ${detail}`).toBe(
          false,
        );
        expect(e.status, `must be a legitimate 409, ${detail}`).toBe(409);
      }
      expect(
        outcomes.some((o) => o.status === "fulfilled"),
        `round ${round}: at least one confirmation must succeed`,
      ).toBe(true);
    }
  }, 120_000);
});
