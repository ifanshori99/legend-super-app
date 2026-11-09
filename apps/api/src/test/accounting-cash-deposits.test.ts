// Cash deposits and undeposited-cash alerts — HTTP + service tests (bead
// legend-fnxl.5, WS-07; PRD v1.7 §3.19 Kas & Bank, ACC-05; TEN-01/02/03). Real
// Better Auth, RLS and PostgreSQL on the disposable test DB. The router is
// mounted on a small host app (same tenant resolver as the API, pinned to the
// seeded tenant); registering it in routes/index.ts is the engineer's step.
//
// Covers: record + audit, idempotent replay, the outlet/bank-account entity
// rule, auto match against an imported statement line, outlet isolation
// (outlet-scoped caller), tenant isolation (404), permissions (403), the
// listing window and cursor, and the ACC-05 alert boundary (absent at exactly
// `maxDaysUndeposited` days, present one day later; FIFO; floor at 0).

import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { Pool, type PoolClient } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { createApp } from "../app";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { createAccountingCashDepositsRouter } from "../routes/accounting-cash-deposits.routes";
import { createBankAccount } from "../services/accounting-bank-accounts.service";
import {
  createCashDeposit,
  listCashDeposits,
} from "../services/accounting-cash-deposits.service";
import { loadCashDepositPolicy } from "../services/accounting-finance-policy.service";
import { originHeader } from "./helpers";

const authApp = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const seedOutlet = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const otherTenantIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");
const actor = userIdSchema.parse(randomUUID());
const newNumber = () =>
  String(Math.floor(Math.random() * 9e11) + 1e11).padStart(12, "1");

const host = express();
host.use(
  "/api",
  tenantContext({
    required: false,
    resolveDomain: async () => null,
    verifyCredential: async () => null,
    fallback: async (req) => ({
      tenantId: req.get("x-test-tenant") ?? tenantId,
      brandId: null,
      source: "session" as const,
    }),
  }),
);
host.use("/api/accounting", createAccountingCashDepositsRouter());
host.use(notFound);
host.use(errorHandler);

const DEPOSITS = "/api/accounting/cash-deposits";
const ALERTS = "/api/accounting/cash-deposits/alerts";

function scope(tenant = tenantId): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function signedIn(): Promise<{ cookie: string; userId: string }> {
  const email = `cash-dep-${randomUUID()}@example.com`;
  const signUp = await request(authApp)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: "Cash deposits", email, password: "Test-password-123!" });
  if (signUp.status !== 200) throw new Error(`Sign-up ${signUp.status}`);
  const cookie = (signUp.headers["set-cookie"] as unknown as string[])
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = await request(authApp)
    .get("/api/auth/get-session")
    .set("Cookie", cookie);
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { cookie, userId };
}

async function assignTemplate(
  userId: string,
  templateKey: string,
  outletId: string | null = null,
) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role template`);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenantId, userId, rows[0].id, outletId ? "outlet" : "tenant", outletId],
  );
}

async function newEntity(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenantId, `Cash PT ${unique()}`],
  );
  return rows[0]!.id;
}

async function newGlAccount(entity: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts
       (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, $3, 'Bank', 'asset', 'cash_and_equivalents')
     RETURNING id`,
    [tenantId, entity, `11${Math.floor(Math.random() * 9000 + 1000)}`],
  );
  return rows[0]!.id;
}

async function newOutlet(entity: string, label: string): Promise<string> {
  const id = randomUUID();
  await asTenant((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, $2, $3, $4, 'Jl. Uji 1', 'Asia/Jakarta', opening_hours, 'active'
       FROM outlets WHERE tenant_id = $5 AND id = $6`,
      [
        id,
        entity,
        `C${unique()}`.toUpperCase().slice(0, 12),
        label,
        tenantId,
        seedOutlet,
      ],
    ),
  );
  return id;
}

async function newBankAccount(entity: string, gl: string): Promise<string> {
  const account = await createBankAccount(
    scope(),
    {
      legalEntityId: entity,
      bank: "BCA",
      accountName: "Kas Setoran",
      accountNumber: newNumber(),
      glAccountId: gl,
    },
    actor,
  );
  return account.id;
}

async function newTenant(): Promise<TenantId> {
  const id = randomUUID();
  otherTenantIds.push(id);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Cash deposits other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [id, `cashdep-${unique()}`, tenantId],
  );
  return tenantIdSchema.parse(id);
}

/** An unmatched statement line (own import) for the auto-match test. */
async function seedStatementLine(
  bankAccountId: string,
  postedOn: string,
  amountIdr: number,
): Promise<string> {
  const importId = randomUUID();
  const lineId = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO bank_statement_imports
         (id, tenant_id, bank_account_id, file_name, file_sha256, imported_by,
          line_count, duplicate_count, auto_matched_count, posted_from, posted_to)
       VALUES ($1, $2, $3, 'mutasi.csv', $4, $5, 1, 0, 0, $6, $6)`,
      [importId, tenantId, bankAccountId, "a".repeat(64), actor, postedOn],
    );
    await client.query(
      `INSERT INTO bank_statement_lines
         (id, tenant_id, bank_account_id, import_id, posted_on, amount_idr, description, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'SETORAN TUNAI', $7)`,
      [
        lineId,
        tenantId,
        bankAccountId,
        importId,
        postedOn,
        amountIdr,
        randomUUID(),
      ],
    );
  });
  return lineId;
}

let userSeq = 0;
async function seedUser(): Promise<string> {
  const id = randomUUID();
  userSeq += 1;
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, `Kasir ${userSeq}`, `${id}@example.com`],
  );
  createdUserIds.push(id);
  return id;
}

/**
 * A closed shift: expected = float + sales - refunds - out (the closed check
 * of pos_shifts). The drawer is counted exactly (variance 0) unless
 * `variance` (counted - expected) is given; a non-zero one needs a note.
 */
async function seedClosedShift(
  outletId: string,
  businessDate: string,
  amounts: {
    sales: number;
    refunds?: number;
    out?: number;
    float?: number;
    variance?: number;
  },
): Promise<void> {
  const cashierId = await seedUser();
  const approverId = await seedUser();
  const shiftId = randomUUID();
  const countId = randomUUID();
  const refunds = amounts.refunds ?? 0;
  const out = amounts.out ?? 0;
  const float = amounts.float ?? 0;
  const expected = float + amounts.sales - refunds - out;
  const variance = amounts.variance ?? 0;
  const counted = expected + variance;
  const closedAt = `${businessDate}T10:00:00Z`;
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO pos_shifts
         (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
          opened_at, opening_float_idr, cash_sales_idr, cash_refunds_idr, cash_out_idr,
          open_key, open_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10, $11, $12, $13)`,
      [
        shiftId,
        tenantId,
        outletId,
        randomUUID(),
        cashierId,
        businessDate,
        closedAt,
        float,
        amounts.sales,
        refunds,
        out,
        randomUUID(),
        "a".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO pos_shift_counts
         (id, tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
          counted_idr, expected_idr, variance_idr, submitted_by, submitted_at, forced,
          idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, 1, '[]'::jsonb, $5, $6, $9, $10, $7, now(), false, $8, $5)`,
      [
        countId,
        tenantId,
        outletId,
        shiftId,
        "b".repeat(64),
        counted,
        cashierId,
        randomUUID(),
        expected,
        variance,
      ],
    );
    await client.query(
      `UPDATE pos_shifts SET status = 'closed', expected_idr = $12, counted_idr = $3,
          variance_idr = $13, variance_note = $14, counts = '[]'::jsonb, count_id = $4,
          approved_by = $5, approval_request_id = $6, approval_override_id = $7,
          approved_at = $8, closed_at = $8, closed_by = $9, close_key = $10,
          close_fingerprint = $11, version = version + 1
        WHERE tenant_id = $1 AND id = $2`,
      [
        tenantId,
        shiftId,
        counted,
        countId,
        approverId,
        randomUUID(),
        randomUUID(),
        closedAt,
        cashierId,
        randomUUID(),
        "c".repeat(64),
        expected,
        variance,
        variance === 0 ? null : "Selisih hitung",
      ],
    );
  });
}

const addDays = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const depositBody = (
  outletId: string,
  bankAccountId: string,
  extra: Record<string, unknown> = {},
) => ({
  outletId,
  bankAccountId,
  amountIdr: 1_250_000,
  coversFrom: "2026-03-10",
  coversTo: "2026-03-10",
  depositedAt: "2026-03-11T05:00:00.000Z",
  slipReference: "SLIP-001",
  idempotencyKey: randomUUID(),
  ...extra,
});

const post = (cookie: string, body: unknown) =>
  request(host)
    .post(DEPOSITS)
    .set(originHeader)
    .set("Cookie", cookie)
    .send(body as object);
const list = (cookie: string, query: Record<string, string | number>) =>
  request(host).get(DEPOSITS).set("Cookie", cookie).query(query);
const alerts = (cookie: string, query: Record<string, string>) =>
  request(host).get(ALERTS).set("Cookie", cookie).query(query);

async function depositRows(bankAccountId: string) {
  const { rows } = await owner.query<{ id: string; status: string }>(
    "SELECT id, status FROM cash_deposits WHERE tenant_id = $1 AND bank_account_id = $2",
    [tenantId, bankAccountId],
  );
  return rows;
}

let finance: { cookie: string; userId: string };
let outletScoped: { cookie: string; userId: string };
let nobody: { cookie: string; userId: string };
let entity: string;
let otherEntity: string;
let outletA: string;
let outletB: string;
let outletAlert: string;
let outletOther: string;
let bank: string;
let bankMatch: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn();
  await assignTemplate(finance.userId, "finance");
  outletScoped = await signedIn();
  nobody = await signedIn();
  entity = await newEntity();
  otherEntity = await newEntity();
  const gl = await newGlAccount(entity);
  outletA = await newOutlet(entity, "Setoran A");
  outletB = await newOutlet(entity, "Setoran B");
  outletAlert = await newOutlet(entity, "Setoran Alert");
  outletOther = await newOutlet(otherEntity, "Setoran Lain");
  await assignTemplate(outletScoped.userId, "finance", outletB);
  bank = await newBankAccount(entity, gl);
  bankMatch = await newBankAccount(entity, gl);
});

afterAll(async () => {
  // Shifts are append-only (POS-03) and deposits/outlets hang off them or the
  // bank accounts, so the rows stay in the disposable DB; only identities go.
  if (otherTenantIds.length > 0)
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.end();
});

describe("legend-fnxl.5 cash deposits", () => {
  it("records a deposit: 201 DTO, row stored, audited with the actor", async () => {
    const body = depositBody(outletA, bank);
    const response = await post(finance.cookie, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data).toEqual({
      id: expect.any(String),
      tenantId,
      legalEntityId: entity,
      outletId: outletA,
      bankAccountId: bank,
      amountIdr: 1_250_000,
      coversFrom: "2026-03-10",
      coversTo: "2026-03-10",
      depositedAt: "2026-03-11T05:00:00.000Z",
      depositedBy: finance.userId,
      slipReference: "SLIP-001",
      bankStatementLineId: null,
      reconciliationCaseId: null,
      journalEntryId: null,
      status: "recorded",
    });
    const audit = await owner.query<{ event: Record<string, unknown> }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'accounting.cash_deposit.recorded'
          AND event->>'objectId' = $2`,
      [tenantId, response.body.data.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.event).toMatchObject({
      actorId: finance.userId,
      outletId: outletA,
    });
  });

  it("replays an idempotent key without a second row; another payload under the key is refused", async () => {
    const body = depositBody(outletA, bank, { amountIdr: 333_000 });
    const before = (await depositRows(bank)).length;
    const first = await post(finance.cookie, body);
    const replay = await post(finance.cookie, body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect((await depositRows(bank)).length).toBe(before + 1);

    const reused = await post(finance.cookie, { ...body, amountIdr: 444_000 });
    expect(reused.status).toBe(409);
    expect((await depositRows(bank)).length).toBe(before + 1);
  });

  it("replays after the bank account is deactivated: the original deposit comes back, not a refusal", async () => {
    const gl = await newGlAccount(entity);
    const closing = await newBankAccount(entity, gl);
    const body = depositBody(outletA, closing, { amountIdr: 271_000 });
    const first = await post(finance.cookie, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    await owner.query(
      "UPDATE bank_accounts SET is_active = false WHERE id = $1",
      [closing],
    );
    const replay = await post(finance.cookie, body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const fresh = await post(
      finance.cookie,
      depositBody(outletA, closing, { amountIdr: 272_000 }),
    );
    expect(fresh.status).toBe(400);
    expect((await depositRows(closing)).length).toBe(1);
  });

  it("refuses an outlet of another legal entity than the bank account (400) and bad bodies", async () => {
    const mismatch = await post(finance.cookie, depositBody(outletOther, bank));
    // CoreError VALIDATION_ERROR answers 400; zod body errors answer 422.
    expect(mismatch.status).toBe(400);
    const bad = await post(
      finance.cookie,
      depositBody(outletA, bank, {
        coversFrom: "2026-03-12",
        coversTo: "2026-03-11",
      }),
    );
    expect(bad.status).toBe(422);
    const foreign = await post(finance.cookie, {
      ...depositBody(outletA, bank),
      tenantId: randomUUID(),
    });
    expect(foreign.status).toBe(422);
  });

  it("auto-matches a deposit to an unmatched statement line of the same amount inside the tolerance", async () => {
    const lineId = await seedStatementLine(bankMatch, "2026-03-12", 750_000);
    const response = await post(
      finance.cookie,
      depositBody(outletA, bankMatch, {
        amountIdr: 750_000,
        depositedAt: "2026-03-11T05:00:00.000Z",
      }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data).toMatchObject({
      status: "matched",
      bankStatementLineId: lineId,
    });
    const line = await owner.query<{ match_status: string }>(
      "SELECT match_status FROM bank_statement_lines WHERE id = $1",
      [lineId],
    );
    expect(line.rows[0]!.match_status).toBe("auto_matched");
    const matches = await owner.query(
      "SELECT ref_type, ref_id, source FROM bank_statement_line_matches WHERE line_id = $1",
      [lineId],
    );
    expect(matches.rows).toEqual([
      {
        ref_type: "cash_deposit",
        ref_id: response.body.data.id,
        source: "auto",
      },
    ]);
  });

  it("does not auto-match when the amount differs", async () => {
    const lineId = await seedStatementLine(bankMatch, "2026-03-12", 810_000);
    const response = await post(
      finance.cookie,
      depositBody(outletA, bankMatch, { amountIdr: 800_000 }),
    );
    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe("recorded");
    const line = await owner.query<{ match_status: string }>(
      "SELECT match_status FROM bank_statement_lines WHERE id = $1",
      [lineId],
    );
    expect(line.rows[0]!.match_status).toBe("unmatched");
  });

  it("lists by entity and date window, newest first, and pages with a cursor", async () => {
    const entityB = await newEntity();
    const outletOnly = await newOutlet(entityB, "Setoran Daftar");
    const glB = await newGlAccount(entityB);
    const bankB = await newBankAccount(entityB, glB);
    for (const [day, amount] of [
      ["2026-04-01", 100_000],
      ["2026-04-02", 200_000],
      ["2026-04-03", 300_000],
    ] as const)
      expect(
        (
          await post(
            finance.cookie,
            depositBody(outletOnly, bankB, {
              amountIdr: amount,
              coversFrom: day,
              coversTo: day,
              depositedAt: `${day}T05:00:00.000Z`,
            }),
          )
        ).status,
      ).toBe(201);

    const all = await list(finance.cookie, {
      legalEntityId: entityB,
      from: "2026-04-01",
      to: "2026-04-30",
    });
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(
      all.body.data.map((row: { amountIdr: number }) => row.amountIdr),
    ).toEqual([300_000, 200_000, 100_000]);

    const window = await list(finance.cookie, {
      legalEntityId: entityB,
      from: "2026-04-02",
      to: "2026-04-02",
    });
    expect(
      window.body.data.map((row: { amountIdr: number }) => row.amountIdr),
    ).toEqual([200_000]);

    const firstPage = await list(finance.cookie, {
      legalEntityId: entityB,
      from: "2026-04-01",
      to: "2026-04-30",
      limit: 2,
    });
    expect(firstPage.body.data).toHaveLength(2);
    expect(firstPage.body.meta.nextCursor).toEqual(expect.any(String));
    const secondPage = await list(finance.cookie, {
      legalEntityId: entityB,
      from: "2026-04-01",
      to: "2026-04-30",
      limit: 2,
      cursor: firstPage.body.meta.nextCursor,
    });
    expect(
      secondPage.body.data.map((row: { amountIdr: number }) => row.amountIdr),
    ).toEqual([100_000]);
    expect(secondPage.body.meta.nextCursor).toBeNull();

    const badCursor = await list(finance.cookie, {
      legalEntityId: entityB,
      from: "2026-04-01",
      to: "2026-04-30",
      cursor: "not-a-cursor",
    });
    expect(badCursor.status).toBe(422);
  });

  describe("permissions and isolation", () => {
    it("a signed-in user without the permission gets 403 on all three routes", async () => {
      expect(
        (await post(nobody.cookie, depositBody(outletA, bank))).status,
      ).toBe(403);
      expect(
        (
          await list(nobody.cookie, {
            legalEntityId: entity,
            from: "2026-03-01",
            to: "2026-03-31",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await alerts(nobody.cookie, {
            legalEntityId: entity,
            asOf: "2026-03-31",
          })
        ).status,
      ).toBe(403);
    });

    it("an outlet-scoped user records and reads its own outlet only", async () => {
      const own = await post(
        outletScoped.cookie,
        depositBody(outletB, bank, { amountIdr: 555_000 }),
      );
      expect(own.status, JSON.stringify(own.body)).toBe(201);
      expect(own.body.data.depositedBy).toBe(outletScoped.userId);

      const foreign = await post(
        outletScoped.cookie,
        depositBody(outletA, bank),
      );
      expect(foreign.status).toBe(403);

      const query = {
        legalEntityId: entity,
        from: "2026-03-01",
        to: "2026-03-31",
      };
      const seen = await list(outletScoped.cookie, query);
      expect(seen.status, JSON.stringify(seen.body)).toBe(200);
      expect(seen.body.data.length).toBeGreaterThan(0);
      expect(
        seen.body.data.every(
          (row: { outletId: string }) => row.outletId === outletB,
        ),
      ).toBe(true);

      const asked = await list(outletScoped.cookie, {
        ...query,
        outletId: outletA,
      });
      expect(asked.status).toBe(403);

      // The finance user (tenant-wide) sees both outlets.
      const everything = await list(finance.cookie, query);
      const outlets = new Set(
        everything.body.data.map((row: { outletId: string }) => row.outletId),
      );
      expect(outlets.has(outletA)).toBe(true);
      expect(outlets.has(outletB)).toBe(true);
    });

    it("another tenant's context gets 404 for this tenant's outlet, bank account and entity", async () => {
      const other = await newTenant();
      await expect(
        createCashDeposit(scope(other), depositBody(outletA, bank), actor),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        listCashDeposits(scope(other), {
          legalEntityId: entity,
          from: "2026-03-01",
          to: "2026-03-31",
          limit: 10,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});

describe("legend-fnxl.5 undeposited cash alerts (ACC-05)", () => {
  const D1 = "2026-02-01";

  it("is absent at exactly maxDaysUndeposited days and present one day later (FIFO, refunds and petty cash netted)", async () => {
    const { maxDaysUndeposited } = await loadCashDepositPolicy(scope());
    // Two shifts the same day: 500k + 100k sales, 60k refunds, 40k petty cash.
    await seedClosedShift(outletAlert, D1, {
      sales: 500_000,
      refunds: 60_000,
      out: 40_000,
    });
    await seedClosedShift(outletAlert, D1, { sales: 100_000 });
    // Net cash of the day: 600_000 - 60_000 - 40_000 = 500_000.
    const query = (days: number) => ({
      legalEntityId: entity,
      outletId: outletAlert,
      asOf: addDays(D1, days),
    });

    const atLimit = await alerts(finance.cookie, query(maxDaysUndeposited));
    expect(atLimit.status, JSON.stringify(atLimit.body)).toBe(200);
    expect(atLimit.body).toEqual({ data: [] });

    const over = await alerts(finance.cookie, query(maxDaysUndeposited + 1));
    expect(over.body).toEqual({
      data: [
        {
          outletId: outletAlert,
          businessDate: D1,
          undepositedIdr: 500_000,
          daysOutstanding: maxDaysUndeposited + 1,
        },
      ],
    });

    // A deposit settles the oldest cash first; any status counts.
    const deposit = await post(
      finance.cookie,
      depositBody(outletAlert, bank, {
        amountIdr: 200_000,
        coversFrom: D1,
        coversTo: D1,
        depositedAt: `${addDays(D1, 1)}T05:00:00.000Z`,
      }),
    );
    expect(deposit.status).toBe(201);
    const partly = await alerts(finance.cookie, query(maxDaysUndeposited + 1));
    expect(partly.body.data).toEqual([
      expect.objectContaining({ businessDate: D1, undepositedIdr: 300_000 }),
    ]);

    // The rest settles it: no alert left.
    const rest = await post(
      finance.cookie,
      depositBody(outletAlert, bank, {
        amountIdr: 300_000,
        coversFrom: D1,
        coversTo: D1,
        depositedAt: `${addDays(D1, 1)}T06:00:00.000Z`,
      }),
    );
    expect(rest.status).toBe(201);
    const settled = await alerts(finance.cookie, query(maxDaysUndeposited + 1));
    expect(settled.body).toEqual({ data: [] });
  });

  it("floors a net-negative day at 0 and keeps open shifts out", async () => {
    const outlet = await newOutlet(entity, "Setoran Lantai");
    // Opening float 50k, petty cash out 50k: expected 0, net collection -50k.
    await seedClosedShift(outlet, "2026-02-10", {
      sales: 0,
      out: 50_000,
      float: 50_000,
    });
    const { maxDaysUndeposited } = await loadCashDepositPolicy(scope());
    const response = await alerts(finance.cookie, {
      legalEntityId: entity,
      outletId: outlet,
      asOf: addDays("2026-02-10", maxDaysUndeposited + 5),
    });
    expect(response.body).toEqual({ data: [] });
  });

  it("a short shift nets its variance: 50k short is not 50k undeposited forever, and an over shift adds", async () => {
    const outletShort = await newOutlet(entity, "Setoran Kurang");
    const outletOver = await newOutlet(entity, "Setoran Lebih");
    const day = "2026-02-12";
    // Sales 500k, drawer counted 450k: only 450k can ever be deposited.
    await seedClosedShift(outletShort, day, {
      sales: 500_000,
      variance: -50_000,
    });
    // Sales 200k, drawer counted 230k: 230k is in the safe.
    await seedClosedShift(outletOver, day, {
      sales: 200_000,
      variance: 30_000,
    });
    const { maxDaysUndeposited } = await loadCashDepositPolicy(scope());
    const asOf = addDays(day, maxDaysUndeposited + 1);
    const query = (outletId: string) => ({
      legalEntityId: entity,
      outletId,
      asOf,
    });
    const short = await alerts(finance.cookie, query(outletShort));
    expect(short.body.data).toEqual([
      expect.objectContaining({ businessDate: day, undepositedIdr: 450_000 }),
    ]);
    const over = await alerts(finance.cookie, query(outletOver));
    expect(over.body.data).toEqual([
      expect.objectContaining({ businessDate: day, undepositedIdr: 230_000 }),
    ]);
    // Depositing what was counted settles the short shift.
    const deposit = await post(
      finance.cookie,
      depositBody(outletShort, bank, {
        amountIdr: 450_000,
        coversFrom: day,
        coversTo: day,
        depositedAt: `${addDays(day, 1)}T05:00:00.000Z`,
      }),
    );
    expect(deposit.status).toBe(201);
    const settled = await alerts(finance.cookie, query(outletShort));
    expect(settled.body).toEqual({ data: [] });
  });

  it("an outlet-scoped caller sees its own outlet's alerts only", async () => {
    const { maxDaysUndeposited } = await loadCashDepositPolicy(scope());
    await seedClosedShift(outletB, "2026-02-20", { sales: 400_000 });
    const asOf = addDays("2026-02-20", maxDaysUndeposited + 1);
    const own = await alerts(outletScoped.cookie, {
      legalEntityId: entity,
      asOf,
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(
      own.body.data.every(
        (row: { outletId: string }) => row.outletId === outletB,
      ),
    ).toBe(true);
    expect(own.body.data.length).toBeGreaterThan(0);
    const foreign = await alerts(outletScoped.cookie, {
      legalEntityId: entity,
      outletId: outletAlert,
      asOf,
    });
    expect(foreign.status).toBe(403);
  });
});
