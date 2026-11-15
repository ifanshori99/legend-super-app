// Payout 897 (cards legend-klr99 / legend-v2dco; design scratchpad b897/design.md
// F4; finding "backfill is unfair when the first 200 proofs cannot be processed"
// in docs/qa/second-opinion-payout-888-891.md). Written fail-first from the
// finding text and the CTO decision, not from the implementation.
//
// Rules proven here:
// - A sweep takes at most 200 targets. When the oldest 200 cannot be processed
//   (object missing, or a hash that conflicts), the next sweeps must still
//   reach the valid targets behind them (failing rows leave the window), and
//   the failing ones must be listed for finance. The gate stays closed (fail
//   closed): a new return proof is still refused while stuck targets remain.
// - A stuck target is listed with its reason (`unreadable`, `hash_conflict`),
//   as the finance exception kind `payout_proof_stuck`, for the own tenant only.
// - A stuck target whose object is fixed later is processed by a later sweep,
//   and its stuck row is marked resolved (no longer listed).
//
// Assumptions (the design names them, stated so they can be contested):
// - Table `payroll_payout_proof_backfill_stuck` with columns tenant_id,
//   evidence_key, reason ('unreadable' | 'hash_conflict' | 'legacy_duplicate' | 'shared_key' | 'bind_failed'),
//   attempts, next_attempt_at and resolved_at (null while unresolved).
// - The retry delay of a failing key is a data fact (`next_attempt_at`): the
//   tests bring a key back into the window by moving that column into the past,
//   not by passing a different clock.
// - The finance list is `listFinanceExceptions(scope, { from, to, kind })` with
//   kind `payout_proof_stuck`; an item is recognised by the evidence key that
//   appears in the serialized item (the field that holds it is not pinned).
// - "Targets" are legacy return claims (no fingerprint on the claim), built as
//   what migration 0382 left behind: hashes NULL and no evidence_files record,
//   written by the table owner with triggers off.
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { listFinanceExceptions } from "../services/accounting-finance-exceptions.service.ts";
import { uploadPayoutEvidence } from "../services/payroll-payout-evidence-upload.service.ts";
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import { bindHistoricalOperations } from "../services/payroll-payout-proof-backfill.service.ts";
import { runPayoutEvidenceBackfillSweep } from "../worker/payout-evidence-backfill.job.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
import {
  APP,
  BUDI,
  SITI,
  actorOf,
  bank,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("897backfill");
const PENDING = "PAYOUT_PROOF_FINGERPRINT_PENDING";
const STUCK = "payroll_payout_proof_backfill_stuck";
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const idOf = (row: Row) => row.id as string;

const storage = new FakeObjectStorage();
const store = () => ({ storage, context: W.scope() });
const lookup = (key: string) =>
  ({
    tenantId: W.tenantId,
    outletId: null,
    reference: "payout-897-backfill-test",
    key,
  }) as never;
const sweep = () =>
  runPayoutEvidenceBackfillSweep(W.scope(), new Date(), { storage });
const pdf = (label: string) =>
  validPdfBytes({ marker: `${label} ${randomUUID()}` });
const uploadTo = async (batchId: string, bytes: Uint8Array) =>
  (
    await uploadPayoutEvidence(W.scope(), batchId, bytes, {
      storage,
      scanner: new NoopMalwareScanner(),
    })
  ).evidenceKey;

/** A paid batch (Budi, Siti) to hang legacy claims on and to return from. */
async function paidBatch() {
  const slips = [bank(BUDI, 4_250_000), bank(SITI, 3_100_500)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(batchId, W.succeedItems(batchId, items));
  return { batchId, siti: await W.itemOfPerson(batchId, SITI) };
}

const usedKeys: string[] = [];
const foreignKeys: string[] = [];

/** A pre-0382 claim: hashes NULL, no evidence_files record. `ageSeconds` orders the claims. */
async function insertLegacyClaims(
  batchId: string,
  keys: string[],
  oldestAgeSeconds: number,
) {
  usedKeys.push(...keys);
  await W.asTenant(async (c) => {
    for (const [index, key] of keys.entries())
      await c.query(
        `INSERT INTO payroll_payout_return_claims
           (tenant_id, batch_id, evidence_key, item_set_hash, status, created_by, created_at)
         VALUES ($1, $2, $3, $4, 'open', 'legacy-897',
                 now() - ($5::int || ' seconds')::interval)`,
        [
          W.tenantId,
          batchId,
          key,
          sha256(Buffer.from(`897-set-${key}`)),
          oldestAgeSeconds - index,
        ],
      );
    await c.query(
      `DELETE FROM payroll_payout_evidence_files
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
      [W.tenantId, keys],
    );
  }, true);
}

const claimsWithHash = async (keys: string[]) =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM payroll_payout_return_claims
          WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])
            AND content_sha256 IS NOT NULL AND stored_sha256 IS NOT NULL`,
        [W.tenantId, keys],
      )
    )[0]!.n,
  );
const stuckRows = (keys: string[], unresolvedOnly = true) =>
  W.rowsOf(
    `SELECT evidence_key, reason, attempts, resolved_at FROM ${STUCK}
      WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])
        ${unresolvedOnly ? "AND resolved_at IS NULL" : ""}`,
    [W.tenantId, keys],
  );
const financeStuck = async () => {
  const day = (shift: number) =>
    new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);
  const result = await listFinanceExceptions(W.scope(), {
    from: day(-2),
    to: day(2),
    kind: "payout_proof_stuck",
  } as never);
  return JSON.stringify(result.items);
};
const missingKey = (batchId: string, label: string) =>
  `tenants/${W.tenantId}/payroll-payout/${batchId}/897-${label}-${randomUUID()}.pdf`;

afterEach(async () => {
  const keys = [...usedKeys];
  usedKeys.length = 0;
  const foreign = [...foreignKeys];
  foreignKeys.length = 0;
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM payroll_payout_return_claims
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
      [W.tenantId, keys],
    );
    await c.query(
      `DELETE FROM payroll_payout_evidence_files
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
      [W.tenantId, keys],
    );
    // The stuck table exists only once the feature does.
    const exists = (await c.query(`SELECT to_regclass('public.${STUCK}') AS t`))
      .rows[0]!.t;
    if (exists)
      await c.query(
        `DELETE FROM ${STUCK} WHERE evidence_key = ANY($1::text[])`,
        [[...keys, ...foreign]],
      );
  }, true);
});

// =========================================================================

describe("897 the backfill is fair when the oldest proofs cannot be processed (F4)", () => {
  it("[897-sweeps-reach-valid-targets] 250 targets, the oldest 200 unreadable: after 2 sweeps the 50 valid ones are fingerprinted, the 200 failing ones are listed as stuck, and the gate still holds", async () => {
    const { batchId, siti } = await paidBatch();
    const unreadable = Array.from({ length: 200 }, (_, i) =>
      missingKey(batchId, `gone-${i}`),
    );
    const valid: string[] = [];
    for (let i = 0; i < 50; i++)
      valid.push(await uploadTo(batchId, await pdf(`valid-${i}`)));
    // Oldest first: the unreadable ones fill the first 200 places of every sweep.
    await insertLegacyClaims(batchId, unreadable, 100_000);
    await insertLegacyClaims(batchId, valid, 50_000);

    await sweep();
    await sweep();

    expect(
      await claimsWithHash(valid),
      "the valid targets behind the 200 failing ones are reached",
    ).toBe(50);
    expect(await claimsWithHash(unreadable)).toBe(0);
    const stuck = await stuckRows(unreadable);
    expect(stuck, "every failing target is listed for finance").toHaveLength(
      200,
    );
    for (const row of stuck) {
      expect(row.reason).toBe("unreadable");
      expect(Number(row.attempts)).toBeGreaterThanOrEqual(1);
    }
    expect(await stuckRows(valid)).toHaveLength(0);

    // Fail closed: stuck targets keep the tenant's returns with a new proof held.
    const fresh = await uploadTo(batchId, await pdf("dana-kembali-baru"));
    const refused = await W.httpFailure(
      W.inTx((tx) =>
        returnManualItems(
          tx,
          actorOf(APP),
          batchId,
          {
            itemIds: [idOf(siti)],
            evidenceKey: fresh,
            note: "Bank mengembalikan dana, rekening tujuan ditutup",
          } as never,
          store(),
        ),
      ),
    );
    expect(refused, "held while stuck targets remain").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe(PENDING);
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("succeeded");
    usedKeys.push(fresh);
  });

  it("[897-hash-conflict-listed] two legacy proofs with identical bytes: one is fingerprinted, the other lands in the stuck list with reason hash_conflict and finance sees it for the own tenant only", async () => {
    const { batchId } = await paidBatch();
    const bytes = await pdf("dua-klaim-satu-berkas");
    const keyOne = await uploadTo(batchId, bytes);
    const keyTwo = await uploadTo(batchId, bytes);
    expect(keyTwo, "premise: a new key for the same bytes").not.toBe(keyOne);
    await insertLegacyClaims(batchId, [keyOne, keyTwo], 1_000);

    await sweep();
    await sweep();

    expect(
      await claimsWithHash([keyOne, keyTwo]),
      "exactly one claim can own the hash",
    ).toBe(1);
    const stuck = await stuckRows([keyOne, keyTwo]);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.reason).toBe("hash_conflict");
    const stuckKey = stuck[0]!.evidence_key as string;

    // The same row of ANOTHER tenant must stay out of this tenant's list.
    const foreignKey = missingKey(batchId, "foreign");
    foreignKeys.push(foreignKey);
    await W.asTenant(async (c) => {
      const columns = (
        await c.query(
          `SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
              AND is_generated = 'NEVER' ORDER BY ordinal_position`,
          [STUCK],
        )
      ).rows as { column_name: string; data_type: string }[];
      const values = (col: { column_name: string; data_type: string }) =>
        col.column_name === "tenant_id"
          ? `'${randomUUID()}'::uuid`
          : col.column_name === "evidence_key"
            ? `'${foreignKey}'`
            : col.column_name === "id" && col.data_type === "uuid"
              ? "gen_random_uuid()"
              : `"${col.column_name}"`;
      await c.query(
        `INSERT INTO ${STUCK} (${columns.map((x) => `"${x.column_name}"`).join(", ")})
         SELECT ${columns.map(values).join(", ")} FROM ${STUCK}
          WHERE tenant_id = $1 AND evidence_key = $2`,
        [W.tenantId, stuckKey],
      );
    }, true);

    const listed = await financeStuck();
    expect(listed, "finance sees the stuck proof").toContain(stuckKey);
    expect(listed, "another tenant's stuck proof is not listed").not.toContain(
      foreignKey,
    );
  });

  it("[897-resolved-clears-stuck] an object that becomes readable is fingerprinted by a later sweep and its stuck row is resolved (no longer listed)", async () => {
    const { batchId } = await paidBatch();
    const bytes = await pdf("objek-kembali");
    const key = await uploadTo(batchId, bytes);
    const content = Buffer.from(
      (await storage.get(W.scope(), lookup(key))).content as Uint8Array,
    );
    await insertLegacyClaims(batchId, [key], 1_000);
    await storage.delete(W.scope(), lookup(key));

    await sweep();
    expect(await claimsWithHash([key])).toBe(0);
    const stuck = await stuckRows([key]);
    expect(stuck, "the unreadable proof is listed").toHaveLength(1);
    expect(stuck[0]!.reason).toBe("unreadable");
    expect(await financeStuck()).toContain(key);

    // Finance restores the object; the retry delay has passed.
    await storage.put(W.scope(), {
      ...(lookup(key) as object),
      contentType: "application/pdf",
      content,
    } as never);
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE ${STUCK} SET next_attempt_at = now() - interval '1 minute'
            WHERE tenant_id = $1 AND evidence_key = $2`,
          [W.tenantId, key],
        ),
      true,
    );
    await sweep();

    expect(await claimsWithHash([key])).toBe(1);
    expect(
      await stuckRows([key]),
      "no unresolved stuck row is left",
    ).toHaveLength(0);
    const kept = await stuckRows([key], false);
    expect(kept, "the stuck row is kept").toHaveLength(1);
    expect(kept[0]!.resolved_at, "marked resolved").not.toBeNull();
    expect(await financeStuck()).not.toContain(key);
  });
});

// ----------------------------------------- review-fix round (P2-2, P3-1, P3-3)

const BINDINGS = "payroll_payout_proof_bindings";
const bindingsOf = (key: string) =>
  W.rowsOf(
    `SELECT kind, legacy_duplicate FROM ${BINDINGS} WHERE tenant_id = $1 AND evidence_key = $2`,
    [W.tenantId, key],
  );
const opKeysWithoutBinding = async () =>
  Number(
    (
      await W.inTx(async (tx) => {
        const { countFingerprintTargets } =
          await import("../services/payroll-payout-proof-fingerprint.service.ts");
        return countFingerprintTargets(tx, W.tenantId as never);
      })
    ).opKeysWithoutBinding,
  );

/**
 * An item returned (or proposed) before claims existed (pre-0381): the item
 * carries return_evidence_key, there is no claim row. Built as the table owner
 * with triggers off. The returned undo resets it, so no later test is held.
 */
async function legacyItemReturn(batchId: string, itemId: string, key: string) {
  usedKeys.push(key);
  await W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_disbursement_items
            SET return_evidence_key = $3, returned_by = 'legacy-897',
                return_note = 'Dana kembali sebelum klaim'
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, itemId, key],
      ),
    true,
  );
  return async () => {
    await W.asTenant(async (c) => {
      await c.query(
        `UPDATE payroll_disbursement_items
            SET return_evidence_key = NULL, returned_by = NULL, return_note = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, itemId],
      );
      await c.query(
        `DELETE FROM ${STUCK} WHERE tenant_id = $1 AND evidence_key = $2`,
        [W.tenantId, key],
      );
    }, true);
  };
}

describe("897 review fixes: phase 2 reaches every key the gate counts", () => {
  it("[897-legacy-item-return-bound] an item return key from before claims (no claim row) is bound by phase 2, so the gate stops counting it", async () => {
    const { batchId, siti } = await paidBatch();
    const key = await uploadTo(batchId, await pdf("item-lama"));
    const undo = await legacyItemReturn(batchId, idOf(siti), key);
    try {
      expect(await opKeysWithoutBinding(), "premise: the gate counts it").toBe(
        1,
      );
      const first = await sweep();
      await sweep();

      expect(await bindingsOf(key), "bound as a return").toEqual([
        expect.objectContaining({ kind: "return", legacy_duplicate: false }),
      ]);
      expect(await opKeysWithoutBinding()).toBe(0);
      // P3-1: the result of this very run is already recounted.
      expect(first.held.opKeysWithoutBinding).toBe(0);
    } finally {
      await undo();
    }
  });

  it("[897-binder-throw-listed] a binder that throws writes a stuck row for the key (listed for finance, backed off), and a later good run binds it and resolves the row", async () => {
    const { batchId, siti } = await paidBatch();
    const key = await uploadTo(batchId, await pdf("binder-gagal"));
    const undo = await legacyItemReturn(batchId, idOf(siti), key);
    try {
      const failed = await bindHistoricalOperations(W.scope(), new Date(), {
        binder: async () => {
          throw new Error("PAYOUT-35 guard mismatch");
        },
      });
      expect(failed.failed).toBeGreaterThanOrEqual(1);
      const stuck = await stuckRows([key]);
      expect(stuck, "the failing key is listed").toHaveLength(1);
      expect(stuck[0]!.reason).toBe("bind_failed");
      expect(Number(stuck[0]!.attempts)).toBeGreaterThanOrEqual(1);
      expect(await financeStuck()).toContain(key);
      expect(await bindingsOf(key)).toHaveLength(0);

      // 900 (F6): the failed key is backed off like phase 1; its retry time
      // passes before the good run.
      await W.asTenant(
        (c) =>
          c.query(
            `UPDATE ${STUCK} SET next_attempt_at = now() - interval '1 minute'
              WHERE tenant_id = $1 AND evidence_key = $2`,
            [W.tenantId, key],
          ),
        true,
      );
      await bindHistoricalOperations(W.scope(), new Date());
      expect(await bindingsOf(key)).toHaveLength(1);
      expect(await stuckRows([key]), "resolved once bound").toHaveLength(0);
    } finally {
      await undo();
    }
  });

  it("[897-log-no-keys] the job log carries counts only: a stuck key is not named in it (it stays on the finance list)", async () => {
    const { batchId } = await paidBatch();
    const key = missingKey(batchId, "log");
    await insertLegacyClaims(batchId, [key], 1_000);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await sweep();
      const logged = spy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged, "the held line is still written").toContain("stuck 1");
      expect(logged).not.toContain(key);
      expect(logged).not.toContain(W.tenantId);
    } finally {
      spy.mockRestore();
    }
    expect(await financeStuck()).toContain(key);
  });
});
