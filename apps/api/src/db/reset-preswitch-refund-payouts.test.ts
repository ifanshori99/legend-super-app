// legend-d21p: the one-off reset of approved refunds that the pre-switch build
// claimed (payout_attempts > 0) without ever sending. Real PostgreSQL as the
// migration owner, the same connection the script uses. Each test builds its
// own rows; the switch-evidence guard counts every refund in the database, so
// afterEach removes them. The script sees the whole database, and the shared
// test database holds refund rows from other test files, so the script runs on
// its own connection where a temp view named payment_refunds shadows the table
// and exposes only the refunds of this file's intents (idempotency key rps-*).
// A second temp view limits tenants to the fixture tenant: the test connection
// bypasses RLS, so with N tenants in the database every refund would be read
// once per tenant and the counts would be N times too high.
// The script's selection and guards run unchanged on those rows. audit_logs is append-only (app.guard_audit_log), so
// audit rows stay and each test reads only those of its own refund ids.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  parseCutoff,
  parseIdsFile,
  PreswitchResetAborted,
  PreswitchResetUsageError,
  RESET_ACTION,
  RESET_REASON,
  run,
} from "./reset-preswitch-refund-payouts";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletId = outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
/** One connection: the temp view below lives and dies with it (pg_temp is searched first). */
const scoped = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
  idleTimeoutMillis: 0,
});
const now = new Date("2026-11-09T10:00:00.000Z");
/** Deploy time of 5316426a in the tests; seeded rows default to before it. */
const cutoff = new Date(now.getTime() - 60 * 60_000);
const logs: string[] = [];
const log = (line: string) => logs.push(line);
type Extra = { touchedBefore?: Date; ids?: string[] };
/** Apply with the cutoff and, by default, every refund this test seeded as --ids. */
const apply = (
  env: Record<string, string | undefined> = {},
  extra: Extra = {},
) =>
  run({
    pool: scoped,
    apply: true,
    env,
    now,
    log,
    touchedBefore: cutoff,
    ids: [...refundIds],
    ...extra,
  });
const dryRun = (
  env: Record<string, string | undefined> = {},
  extra: Extra = {},
) => run({ pool: scoped, apply: false, env, now, log, ...extra });

const linkIds: string[] = [];
beforeAll(async () => {
  await scoped.query(
    `CREATE TEMP VIEW tenants AS SELECT * FROM public.tenants WHERE id = '${tenantId}'`,
  );
  await scoped.query(
    `CREATE TEMP VIEW payment_refunds AS
       SELECT * FROM public.payment_refunds
       WHERE payment_intent_id IN (
         SELECT id FROM public.payment_intents WHERE idempotency_key LIKE 'rps-%')`,
  );
});

const intentIds: string[] = [];
let refundIds: string[] = [];

afterEach(async () => {
  logs.length = 0;
  refundIds = [];
  await inTenant(async (client) => {
    await client.query(
      "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
  });
});

afterAll(async () => {
  await inTenant(async (client) => {
    await client.query(
      "DELETE FROM payment_intents WHERE id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
      linkIds,
    ]);
  });
  await scoped.end();
  await owner.end();
});

/** Owner connections are subject to FORCE RLS: install the tenant like withTenant. */
async function inTenant<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Seed = {
  status?: string;
  providerRef?: string | null;
  pendingPolls?: number;
  attempts?: number;
  lastError?: string | null;
  claimedUntil?: Date | null;
  failureReason?: string | null;
  updatedAt?: Date;
};

async function seedRefund(seed: Seed = {}) {
  const linkId = randomUUID();
  const intentId = randomUUID();
  const refundId = randomUUID();
  linkIds.push(linkId);
  intentIds.push(intentId);
  refundIds.push(refundId);
  const {
    status = "approved",
    providerRef = null,
    pendingPolls = 0,
    attempts = 3,
    lastError = "SERVICE_UNAVAILABLE",
    claimedUntil = null,
    failureReason = null,
    updatedAt = new Date(now.getTime() - 2 * 60 * 60_000),
  } = seed;
  await inTenant(async (client) => {
    await client.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, 100000, 100000, 100000, 'system:test')`,
      [
        linkId,
        tenantId,
        outletId,
        randomBytes(32).toString("hex"),
        `RPS-${linkId.slice(0, 8)}`,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', 100000, $5, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now(), $6)`,
      [
        intentId,
        tenantId,
        outletId,
        linkId,
        `rps-${intentId}`,
        `pay-${intentId}`,
      ],
    );
    await client.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                    requested_by, approved_by, decided_at, provider_ref, payout_pending_polls,
                                    payout_attempts, last_payout_error, payout_claimed_until, payout_claim_token,
                                    failure_reason, updated_at)
       VALUES ($1, $2, $3, $4, 20000, 'Uji reset', $5, 'system:test', 'system:approver', now(), $6, $7, $8, $9, $10, $11,
               $12, $13)`,
      [
        refundId,
        tenantId,
        outletId,
        intentId,
        status,
        providerRef,
        pendingPolls,
        attempts,
        lastError,
        claimedUntil,
        claimedUntil ? randomUUID() : null,
        failureReason,
        updatedAt,
      ],
    );
  });
  return refundId;
}

async function refundRow(id: string) {
  return inTenant(async (client) => {
    const { rows } = await client.query(
      `SELECT payout_attempts, last_payout_error, payout_claimed_until, payout_claim_token, updated_at
       FROM payment_refunds WHERE id = $1`,
      [id],
    );
    return rows[0] as {
      payout_attempts: number;
      last_payout_error: string | null;
      payout_claimed_until: Date | null;
      payout_claim_token: string | null;
      updated_at: Date;
    };
  });
}

async function auditRows() {
  return inTenant(async (client) => {
    const { rows } = await client.query(
      "SELECT outlet_id, event FROM audit_logs WHERE event->>'action' = $1 AND event->>'objectId' = ANY($2::text[])",
      [RESET_ACTION, refundIds],
    );
    return rows as {
      outlet_id: string;
      event: { objectId: string; maskedChanges: unknown } & Record<
        string,
        unknown
      >;
    }[];
  });
}

describe("legend-d21p reset of pre-switch refund payouts", () => {
  it("selects only rows that match every criterion", async () => {
    const hit = await seedRefund();
    const manual = await seedRefund({ lastError: "MANUAL_RECONCILIATION" });
    const misses = [
      await seedRefund({ providerRef: "refund-ref-1" }),
      await seedRefund({ pendingPolls: 1 }),
      await seedRefund({ attempts: 0 }),
      await seedRefund({ lastError: "NOT_FOUND" }),
      await seedRefund({ lastError: null }),
      await seedRefund({ status: "completed" }),
      await seedRefund({
        claimedUntil: new Date(now.getTime() + 60_000),
      }),
    ];

    // The provider_ref and pending-poll rows are switch evidence: dry-run warns.
    const result = await dryRun();

    expect(result.candidates.map((row) => row.id).sort()).toEqual(
      [hit, manual].sort(),
    );
    for (const id of misses)
      expect(result.candidates.map((row) => row.id)).not.toContain(id);
    expect(result.switchEvidence).toBe(2);
    expect(logs.some((line) => line.startsWith("WARNING"))).toBe(true);
  });

  it("dry-run writes nothing", async () => {
    const id = await seedRefund({ attempts: 8 });
    const before = await refundRow(id);

    const result = await dryRun();

    expect(result.reset).toBe(0);
    expect(result.candidates.map((row) => row.id)).toEqual([id]);
    expect(logs.join("\n")).toContain(id);
    expect(await refundRow(id)).toEqual(before);
    expect(await auditRows()).toHaveLength(0);
  });

  it("apply resets the rows, keeps the quarantine flag, and audits each one", async () => {
    const plain = await seedRefund({ attempts: 3 });
    const exhausted = await seedRefund({
      attempts: 8,
      lastError: "MANUAL_RECONCILIATION",
    });
    const quarantined = await seedRefund({
      attempts: 1,
      lastError: "PAYOUT_QUARANTINED",
      claimedUntil: new Date(now.getTime() - 60_000),
    });
    const untouched = await seedRefund({ lastError: "NOT_FOUND" });
    const untouchedBefore = await refundRow(untouched);

    const result = await apply();

    expect(result.reset).toBe(3);
    for (const id of [plain, exhausted]) {
      const row = await refundRow(id);
      expect(row.payout_attempts).toBe(0);
      expect(row.last_payout_error).toBeNull();
    }
    const quarantineRow = await refundRow(quarantined);
    expect(quarantineRow.payout_attempts).toBe(0);
    expect(quarantineRow.last_payout_error).toBe("PAYOUT_QUARANTINED");
    expect(quarantineRow.payout_claimed_until).toBeNull();
    expect(quarantineRow.payout_claim_token).toBeNull();
    expect(quarantineRow.updated_at).toEqual(now);
    expect(await refundRow(untouched)).toEqual(untouchedBefore);

    const audits = await auditRows();
    expect(audits).toHaveLength(result.reset);
    const byObject = new Map(audits.map((row) => [row.event.objectId, row]));
    expect([...byObject.keys()].sort()).toEqual(
      [plain, exhausted, quarantined].sort(),
    );
    const exhaustedAudit = byObject.get(exhausted)!;
    expect(exhaustedAudit.outlet_id).toBe(outletId);
    expect(exhaustedAudit.event).toMatchObject({
      action: RESET_ACTION,
      actorType: "system",
      objectType: "payment_refund",
      reason: RESET_REASON,
      maskedChanges: {
        before: { payoutAttempts: 8, lastPayoutError: "MANUAL_RECONCILIATION" },
        after: { payoutAttempts: 0, lastPayoutError: null },
      },
    });
    expect(byObject.get(quarantined)!.event.maskedChanges).toEqual({
      before: { payoutAttempts: 1, lastPayoutError: "PAYOUT_QUARANTINED" },
      after: { payoutAttempts: 0, lastPayoutError: "PAYOUT_QUARANTINED" },
    });
  });

  it("a second apply finds nothing and writes nothing", async () => {
    await seedRefund();
    expect((await apply()).reset).toBe(1);
    const auditsAfterFirst = await auditRows();

    const second = await apply();

    expect(second.candidates).toHaveLength(0);
    expect(second.reset).toBe(0);
    expect(await auditRows()).toEqual(auditsAfterFirst);
  });

  it("guard 1: aborts apply while DOIT_REFUNDS_ENABLED is on, writes nothing", async () => {
    const id = await seedRefund();
    const before = await refundRow(id);

    for (const value of ["true", "1"])
      await expect(apply({ DOIT_REFUNDS_ENABLED: value })).rejects.toThrow(
        PreswitchResetAborted,
      );

    expect(await refundRow(id)).toEqual(before);
    expect(await auditRows()).toHaveLength(0);
    // A dry-run only warns.
    const result = await dryRun({ DOIT_REFUNDS_ENABLED: "true" });
    expect(result.reset).toBe(0);
    expect(logs.some((line) => line.includes("DOIT_REFUNDS_ENABLED"))).toBe(
      true,
    );
  });

  it("guard 2: aborts apply when a refund shows the switch was ever on, writes nothing", async () => {
    const id = await seedRefund();
    await seedRefund({ status: "completed", providerRef: "refund-ref-2" });
    const before = await refundRow(id);

    await expect(apply()).rejects.toThrow(PreswitchResetAborted);

    expect(await refundRow(id)).toEqual(before);
    expect(await auditRows()).toHaveLength(0);
  });

  it("guard 2: DOIT error codes and provider declines also abort apply", async () => {
    const evidence: Seed[] = [
      { lastError: "DOIT_HTTP_502" },
      { lastError: "VALIDATION_ERROR" },
      { lastError: "IDEMPOTENCY_KEY_REUSED" },
      {
        status: "failed",
        failureReason: "provider_declined",
        attempts: 0,
        lastError: null,
      },
    ];
    for (const seed of evidence) {
      const id = await seedRefund();
      await seedRefund(seed);
      const before = await refundRow(id);

      await expect(apply()).rejects.toThrow(PreswitchResetAborted);

      expect(await refundRow(id)).toEqual(before);
      expect(await auditRows()).toHaveLength(0);
      await inTenant((client) =>
        client.query("DELETE FROM payment_refunds WHERE id = ANY($1::uuid[])", [
          refundIds,
        ]),
      );
      refundIds = [];
    }
    // The underscore is escaped: DOITX is not DOIT_ evidence.
    await seedRefund({ status: "completed", lastError: "DOITXHTTP" });
    expect((await dryRun()).switchEvidence).toBe(0);
  });

  it("cutoff: a row updated after --touched-before is not reset", async () => {
    const before = await seedRefund();
    const after = await seedRefund({
      updatedAt: new Date(cutoff.getTime() + 60_000),
    });
    const afterRow = await refundRow(after);

    const result = await apply();

    expect(result.reset).toBe(1);
    expect(result.candidates.map((row) => row.id)).toEqual([before]);
    expect(result.skipped).toEqual([after]);
    expect(await refundRow(after)).toEqual(afterRow);
    expect((await auditRows()).map((row) => row.event.objectId)).toEqual([
      before,
    ]);
  });

  it("--ids: a row outside the file is not reset, a listed row that no longer matches is skipped", async () => {
    const listed = await seedRefund();
    const outside = await seedRefund();
    const stale = await seedRefund({ lastError: null, attempts: 0 });
    const outsideRow = await refundRow(outside);
    const staleRow = await refundRow(stale);

    const result = await apply({}, { ids: [listed, stale] });

    expect(result.reset).toBe(1);
    expect(result.skipped).toEqual([stale]);
    expect(logs.some((line) => line.includes(`SKIPPED refund=${stale}`))).toBe(
      true,
    );
    expect(await refundRow(outside)).toEqual(outsideRow);
    expect(await refundRow(stale)).toEqual(staleRow);
    expect((await refundRow(listed)).payout_attempts).toBe(0);
    expect((await auditRows()).map((row) => row.event.objectId)).toEqual([
      listed,
    ]);
  });

  it("dry-run prints amount, decision time and an id list; warns without a cutoff", async () => {
    const id = await seedRefund();

    await dryRun({}, { touchedBefore: cutoff });
    expect(logs.join("\n")).toMatch(
      new RegExp(`refund=${id} amountIdr=20000 decidedAt=\\d{4}-`),
    );
    expect(logs).toContain(id);
    expect(logs.some((line) => line.includes("no cutoff"))).toBe(false);

    logs.length = 0;
    await dryRun();
    expect(logs.some((line) => line.includes("no cutoff"))).toBe(true);
  });

  it("rejects apply without cutoff or ids, a future cutoff, and bad input", async () => {
    const id = await seedRefund();
    const before = await refundRow(id);

    await expect(apply({}, { touchedBefore: undefined })).rejects.toThrow(
      PreswitchResetUsageError,
    );
    await expect(apply({}, { ids: undefined })).rejects.toThrow(
      PreswitchResetUsageError,
    );
    const future = new Date(now.getTime() + 60_000);
    await expect(apply({}, { touchedBefore: future })).rejects.toThrow(
      PreswitchResetUsageError,
    );
    await expect(dryRun({}, { touchedBefore: future })).rejects.toThrow(
      PreswitchResetUsageError,
    );
    await expect(
      apply({}, { touchedBefore: new Date("nope") }),
    ).rejects.toThrow(PreswitchResetUsageError);
    expect(await refundRow(id)).toEqual(before);
    expect(await auditRows()).toHaveLength(0);

    expect(() => parseCutoff("2026-11-09 03:00")).toThrow(
      PreswitchResetUsageError,
    );
    expect(() => parseCutoff("2026-11-09T03:00:00")).toThrow(
      PreswitchResetUsageError,
    );
    expect(() => parseCutoff("2026-11-31T00:00:00Z")).toThrow(
      PreswitchResetUsageError,
    );
    expect(() => parseCutoff("2026-02-30T00:00:00+07:00")).toThrow(
      PreswitchResetUsageError,
    );
    expect(parseCutoff("2026-11-09T01:00:00+07:00").toISOString()).toBe(
      "2026-11-08T18:00:00.000Z",
    );
    expect(parseCutoff("2026-11-09T10:00:00+07:00").toISOString()).toBe(
      "2026-11-09T03:00:00.000Z",
    );
    expect(parseIdsFile(`# reviewed\n\n${id}\n${id.toUpperCase()}\n`)).toEqual([
      id,
    ]);
    expect(() => parseIdsFile(`${id}\nnot-a-uuid\n`)).toThrow(
      PreswitchResetUsageError,
    );
    expect(() => parseIdsFile("# none\n")).toThrow(PreswitchResetUsageError);
  });
});
