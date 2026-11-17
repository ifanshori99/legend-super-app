// Reconciliation cases — HTTP + service tests (bead legend-fnxl.6, WS-07; PRD
// v1.7 §3.19 Kas & Bank, ACC-04 "setiap selisih menjadi kasus dengan PIC";
// TEN-01/02/03). Runs the real Better Auth, RLS and PostgreSQL against the
// disposable test DB.
//
// The router is exercised through a small host app that installs the same
// tenant resolver as the API, pinned to the seeded tenant. Mounting the router
// in routes/index.ts is the engineer's step, so this file does not depend on
// it. Fixtures (entities, bank accounts, lines, deposits, journals) are seeded
// straight into the tables through the owner pool; every test owns a fresh
// legal entity.

import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { reconciliationCaseSchema } from "@starter/shared/accounting";
import { createApp } from "../app";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { createAccountingBankReconCasesRouter } from "../routes/accounting-bank-recon-cases.routes";
import { putFinancePolicy } from "../services/accounting-finance-policy.service";
import {
  getReconciliationCase,
  listReconciliationCases,
  actOnReconciliationCase,
} from "../services/accounting-bank-recon-cases.service";
import { originHeader } from "./helpers";

const authApp = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const outletB = cafeLegendPlatformFixtures.outlets[1].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUserIds: string[] = [];
const otherTenantIds: string[] = [];
const createdEntityIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");
const BASE = "/api/accounting/reconciliation-cases";

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
host.use("/api/accounting", createAccountingBankReconCasesRouter());
host.use(notFound);
host.use(errorHandler);

function scope(
  outlets?: string[],
  tenant: string = tenantId,
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    outlets
      ? {
          kind: "outlets",
          outletIds: outlets.map((id) => outletIdSchema.parse(id)),
        }
      : { kind: "tenant" },
  );
}

type User = { cookie: string; userId: string };

async function signedIn(template: string | null): Promise<User> {
  const email = `bank-case-${randomUUID()}@example.com`;
  const signUp = await request(authApp)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name: "Bank case", email, password: "Test-password-123!" });
  if (signUp.status !== 200) throw new Error(`Sign-up ${signUp.status}`);
  const cookie = (signUp.headers["set-cookie"] as unknown as string[])
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = await request(authApp)
    .get("/api/auth/get-session")
    .set("Cookie", cookie);
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  if (template) {
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
      [tenantId, template],
    );
    if (!rows[0]) throw new Error(`No ${template} role template`);
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
      [tenantId, userId, rows[0].id],
    );
  }
  return { cookie, userId };
}

// ---------------------------------------------------------------- fixtures

type Entity = {
  id: string;
  glAccountId: string;
  revenueAccountId: string;
  periodId: string;
  bankAccountId: string;
  importId: string;
};

async function seedEntity(): Promise<Entity> {
  const id = randomUUID();
  const glAccountId = randomUUID();
  const revenueAccountId = randomUUID();
  const periodId = randomUUID();
  const bankAccountId = randomUUID();
  const importId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [id, tenantId, `Bank case entity ${unique()}`],
  );
  createdEntityIds.push(id);
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $3, $4, '1102', 'Bank', 'asset', 'cash_and_equivalents'),
            ($2, $3, $4, '4101', 'Penjualan', 'revenue', 'revenue')`,
    [glAccountId, revenueAccountId, tenantId, id],
  );
  await owner.query(
    "INSERT INTO fiscal_periods (id, tenant_id, legal_entity_id, period) VALUES ($1, $2, $3, '2026-11')",
    [periodId, tenantId, id],
  );
  await owner.query(
    `INSERT INTO bank_accounts
       (id, tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
        account_number_hmac, account_number_last4, account_number_key_version, gl_account_id, created_by)
     VALUES ($1, $2, $3, 'BCA', 'Rekening utama', $4, $5, '1234', 1, $6, 'seed')`,
    [
      bankAccountId,
      tenantId,
      id,
      randomBytes(32),
      randomBytes(32).toString("hex"),
      glAccountId,
    ],
  );
  await owner.query(
    `INSERT INTO bank_statement_imports
       (id, tenant_id, bank_account_id, file_name, file_sha256, imported_by, line_count, duplicate_count, auto_matched_count)
     VALUES ($1, $2, $3, 'seed.csv', $4, 'seed', 0, 0, 0)`,
    [importId, tenantId, bankAccountId, randomBytes(32).toString("hex")],
  );
  return {
    id,
    glAccountId,
    revenueAccountId,
    periodId,
    bankAccountId,
    importId,
  };
}

async function seedLine(
  entity: Entity,
  status: "unmatched" | "excluded" | "auto_matched" = "unmatched",
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO bank_statement_lines
       (id, tenant_id, bank_account_id, import_id, posted_on, amount_idr, description,
        dedupe_key, match_status, excluded_reason)
     VALUES ($1, $2, $3, $4, '2026-11-05', 10000, 'Setoran', $5, $6, $7)`,
    [
      id,
      tenantId,
      entity.bankAccountId,
      entity.importId,
      `k-${id}`,
      status,
      status === "excluded" ? "Biaya admin" : null,
    ],
  );
  return id;
}

async function seedDeposit(
  entity: Entity,
  status: "recorded" | "matched" = "recorded",
): Promise<string> {
  const id = randomUUID();
  const lineId = status === "matched" ? await seedLine(entity) : null;
  await owner.query(
    `INSERT INTO cash_deposits
       (id, tenant_id, legal_entity_id, outlet_id, bank_account_id, amount_idr, covers_from,
        covers_to, deposited_at, deposited_by, status, bank_statement_line_id)
     VALUES ($1, $2, $3, $4, $5, 10000, '2026-11-04', '2026-11-04', now(), 'seed', $6, $7)`,
    [id, tenantId, entity.id, outletA, entity.bankAccountId, status, lineId],
  );
  return id;
}

/** A posted entry debiting the bank account `debit` rupiah (credit revenue). */
async function seedJournal(
  entity: Entity,
  debit: number,
  options: { reversalOf?: string; entityId?: string } = {},
): Promise<string> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const entityId = options.entityId ?? entity.id;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
          description, reversal_of, idempotency_key, request_fingerprint)
       VALUES ($1, $2, '2026-11-05', $3, $4, 'Penyesuaian selisih', $5, $6, $7)
       RETURNING id`,
      [
        tenantId,
        entityId,
        entity.periodId,
        options.reversalOf ? "reversal" : "manual",
        options.reversalOf ?? null,
        `case-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const id = rows[0]!.id;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [tenantId, id, entity.glAccountId, entity.revenueAccountId, debit],
    );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function newTenant() {
  const id = tenantIdSchema.parse(randomUUID());
  otherTenantIds.push(id);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Bank case other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [id, `bcase-${unique()}`, tenantId],
  );
  return id;
}

// ----------------------------------------------------------------- helpers

const post = (user: User, path: string, body: unknown) =>
  request(host)
    .post(path)
    .set(originHeader)
    .set("Cookie", user.cookie)
    .send(body as object);
const get = (user: User, path: string) =>
  request(host).get(path).set("Cookie", user.cookie);

type OpenBody = {
  legalEntityId: string;
  outletId?: string | null;
  type?: string;
  differenceIdr?: number;
  ownerId: string;
  refs: { type: string; id: string }[];
  idempotencyKey?: string;
};
const openCase = (user: User, body: OpenBody) =>
  post(user, BASE, {
    outletId: null,
    type: "bank_statement",
    differenceIdr: 10_000,
    idempotencyKey: `open-${randomUUID()}`,
    ...body,
  });
const act = (user: User, caseId: string, body: unknown) =>
  post(user, `${BASE}/${caseId}/actions`, body);

async function events(caseId: string) {
  const { rows } = await owner.query<{
    seq: number;
    action: string;
    actor_id: string;
    from_status: string | null;
    to_status: string;
    from_owner_id: string | null;
    to_owner_id: string;
    note: string | null;
  }>(
    `SELECT seq, action, actor_id, from_status, to_status, from_owner_id, to_owner_id, note
       FROM bank_reconciliation_case_events WHERE case_id = $1 ORDER BY seq`,
    [caseId],
  );
  return rows;
}

async function lineRow(id: string) {
  const { rows } = await owner.query<{
    match_status: string;
    reconciliation_case_id: string | null;
    version: number;
    status_changed_by: string | null;
  }>(
    "SELECT match_status, reconciliation_case_id, version, status_changed_by FROM bank_statement_lines WHERE id = $1",
    [id],
  );
  return rows[0]!;
}

async function depositRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    reconciliation_case_id: string | null;
  }>("SELECT status, reconciliation_case_id FROM cash_deposits WHERE id = $1", [
    id,
  ]);
  return rows[0]!;
}

/** Opens a case over one fresh unmatched line, owned by `pic`. */
async function openOnLine(user: User, pic: User, entity?: Entity) {
  const ent = entity ?? (await seedEntity());
  const lineId = await seedLine(ent);
  const response = await openCase(user, {
    legalEntityId: ent.id,
    ownerId: pic.userId,
    refs: [{ type: "bank_statement_line", id: lineId }],
  });
  expect(response.status).toBe(201);
  return { entity: ent, lineId, caseId: response.body.data.id as string };
}

// legend-fnxl.9: the case due-days come from the tenant finance policy
// (reconciliationPolicy.caseDueDays), written through the real service.
async function setCaseDueDays(days: number, tenant: string = tenantId) {
  await putFinancePolicy(
    scope(undefined, tenant),
    {
      cashDepositPolicy: { maxDaysUndeposited: 2 },
      matchingPolicy: { dateToleranceDays: 2 },
      reconciliationPolicy: { caseDueDays: days },
    },
    finance.userId as never,
  );
}
async function clearPolicy() {
  await owner.query("DELETE FROM finance_policies WHERE tenant_id = $1", [
    tenantId,
  ]);
}
const dueDaysOf = (data: { dueAt: string; openedAt: string }) =>
  (Date.parse(data.dueAt) - Date.parse(data.openedAt)) / 86_400_000;

let finance: User;
let finance2: User;
let nobody: User;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn("finance");
  finance2 = await signedIn("finance");
  nobody = await signedIn(null);
});

afterAll(async () => {
  await clearPolicy();
  // Journals are append-only and FKs point both ways: replica mode lets the
  // owner remove the fixtures in one go.
  if (createdEntityIds.length > 0) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const args = [tenantId, createdEntityIds];
      const byEntity = "tenant_id = $1 AND legal_entity_id = ANY($2::uuid[])";
      await client.query(
        `DELETE FROM bank_statement_lines WHERE tenant_id = $1 AND bank_account_id IN
           (SELECT id FROM bank_accounts WHERE ${byEntity})`,
        args,
      );
      await client.query(
        `DELETE FROM bank_statement_imports WHERE tenant_id = $1 AND bank_account_id IN
           (SELECT id FROM bank_accounts WHERE ${byEntity})`,
        args,
      );
      await client.query(`DELETE FROM cash_deposits WHERE ${byEntity}`, args);
      await client.query(
        `DELETE FROM bank_reconciliation_case_events WHERE tenant_id = $1 AND case_id IN
           (SELECT id FROM bank_reconciliation_cases WHERE ${byEntity})`,
        args,
      );
      await client.query(
        `DELETE FROM bank_reconciliation_cases WHERE ${byEntity}`,
        args,
      );
      await client.query(`DELETE FROM bank_accounts WHERE ${byEntity}`, args);
      await client.query(
        `DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id IN
           (SELECT id FROM journal_entries WHERE ${byEntity})`,
        args,
      );
      await client.query(
        `DELETE FROM app.journal_entry_seals WHERE tenant_id = $1 AND entry_id IN
           (SELECT id FROM journal_entries WHERE ${byEntity})`,
        args,
      );
      await client.query(`DELETE FROM journal_entries WHERE ${byEntity}`, args);
      await client.query(`DELETE FROM fiscal_periods WHERE ${byEntity}`, args);
      await client.query(
        `DELETE FROM chart_of_accounts WHERE ${byEntity}`,
        args,
      );
      await client.query(
        "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, createdEntityIds],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  if (otherTenantIds.length > 0)
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  if (createdUserIds.length > 0) {
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
  }
  await owner.end();
});

describe("legend-fnxl.6 reconciliation cases (ACC-04)", () => {
  it("opens a case: unmatched line goes in_case, recorded deposit goes discrepancy, event 1 is open, due in 7 days", async () => {
    const entity = await seedEntity();
    const lineId = await seedLine(entity);
    const depositId = await seedDeposit(entity);
    const response = await openCase(finance, {
      legalEntityId: entity.id,
      type: "cash_deposit",
      differenceIdr: -5_000,
      ownerId: finance2.userId,
      refs: [
        { type: "bank_statement_line", id: lineId },
        { type: "cash_deposit", id: depositId },
      ],
    });
    expect(response.status).toBe(201);
    const data = reconciliationCaseSchema.parse(response.body.data);
    expect(data).toMatchObject({
      legalEntityId: entity.id,
      outletId: null,
      type: "cash_deposit",
      differenceIdr: -5_000,
      ownerId: finance2.userId,
      status: "open",
      resolvedBy: null,
      adjustmentJournalEntryId: null,
    });
    const days =
      (Date.parse(data.dueAt) - Date.parse(data.openedAt)) / 86_400_000;
    expect(days).toBeCloseTo(7, 5);

    expect(await lineRow(lineId)).toMatchObject({
      match_status: "in_case",
      reconciliation_case_id: data.id,
      version: 2,
      status_changed_by: finance.userId,
    });
    expect(await depositRow(depositId)).toEqual({
      status: "discrepancy",
      reconciliation_case_id: data.id,
    });
    expect(await events(data.id)).toEqual([
      {
        seq: 1,
        action: "open",
        actor_id: finance.userId,
        from_status: null,
        to_status: "open",
        from_owner_id: null,
        to_owner_id: finance2.userId,
        note: null,
      },
    ]);
    const audit = await owner.query(
      `SELECT 1 FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'accounting.reconciliation_case.opened'
          AND event->>'objectId' = $2`,
      [tenantId, data.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("refuses bad refs and rolls everything back: matched/excluded line, other entity, deposit not recorded, duplicate ref, PIC without a role", async () => {
    const entity = await seedEntity();
    const other = await seedEntity();
    const fresh = await seedLine(entity);
    const matched = await seedLine(entity, "auto_matched");
    const excluded = await seedLine(entity, "excluded");
    const foreign = await seedLine(other);
    const matchedDeposit = await seedDeposit(entity, "matched");
    const open = (refs: OpenBody["refs"], ownerId = finance2.userId) =>
      openCase(finance, { legalEntityId: entity.id, ownerId, refs });

    const alreadyMatched = await open([
      { type: "bank_statement_line", id: fresh },
      { type: "bank_statement_line", id: matched },
    ]);
    expect(alreadyMatched.status).toBe(409);
    expect(alreadyMatched.body.error.code).toBe(
      "STATEMENT_LINE_ALREADY_MATCHED",
    );

    const excludedLine = await open([
      { type: "bank_statement_line", id: excluded },
    ]);
    expect(excludedLine.status).toBe(409);
    expect(excludedLine.body.error.code).toBe("INVALID_TRANSITION");

    const wrongEntity = await open([
      { type: "bank_statement_line", id: foreign },
    ]);
    expect(wrongEntity.status).toBe(404);

    const depositState = await open([
      { type: "cash_deposit", id: matchedDeposit },
    ]);
    expect(depositState.status).toBe(409);
    expect(depositState.body.error.code).toBe("INVALID_TRANSITION");

    const twice = await open([
      { type: "bank_statement_line", id: fresh },
      { type: "bank_statement_line", id: fresh },
    ]);
    expect(twice.status).toBe(422);

    const noRole = await open(
      [{ type: "bank_statement_line", id: fresh }],
      nobody.userId,
    );
    expect(noRole.status).toBe(422);

    expect(await lineRow(fresh)).toMatchObject({
      match_status: "unmatched",
      reconciliation_case_id: null,
      version: 1,
    });
    const { rowCount } = await owner.query(
      "SELECT 1 FROM bank_reconciliation_cases WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, entity.id],
    );
    expect(rowCount).toBe(0);
  });

  it("a line already in a case cannot join a second one", async () => {
    const { entity, lineId } = await openOnLine(finance, finance2);
    const again = await openCase(finance, {
      legalEntityId: entity.id,
      ownerId: finance.userId,
      refs: [{ type: "bank_statement_line", id: lineId }],
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("STATEMENT_LINE_ALREADY_MATCHED");
  });

  it("refuses a journal that is already matched to a statement line", async () => {
    const entity = await seedEntity();
    const journalId = await seedJournal(entity, 10_000);
    const matchedLine = await seedLine(entity, "auto_matched");
    await owner.query(
      `INSERT INTO bank_statement_line_matches
         (tenant_id, bank_account_id, line_id, ref_type, ref_id, amount_idr, source, matched_by)
       VALUES ($1, $2, $3, 'journal_entry', $4, 10000, 'auto', 'seed')`,
      [tenantId, entity.bankAccountId, matchedLine, journalId],
    );
    const response = await openCase(finance, {
      legalEntityId: entity.id,
      ownerId: finance2.userId,
      refs: [{ type: "journal_entry", id: journalId }],
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("STATEMENT_LINE_ALREADY_MATCHED");
    const { rowCount } = await owner.query(
      "SELECT 1 FROM bank_reconciliation_cases WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, entity.id],
    );
    expect(rowCount).toBe(0);
  });

  it("opening is idempotent: same key + body replays one case, same key + other body is refused", async () => {
    const entity = await seedEntity();
    const lineId = await seedLine(entity);
    const key = `open-${randomUUID()}`;
    const body = {
      legalEntityId: entity.id,
      ownerId: finance2.userId,
      refs: [{ type: "bank_statement_line", id: lineId }],
      idempotencyKey: key,
    };
    const first = await openCase(finance, body);
    expect(first.status).toBe(201);
    const replay = await openCase(finance, body);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const { rows } = await owner.query<{ idempotency_key: string | null }>(
      "SELECT idempotency_key FROM bank_reconciliation_cases WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, entity.id],
    );
    expect(rows).toEqual([{ idempotency_key: key }]);

    const other = await openCase(finance, { ...body, differenceIdr: 20_000 });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("every action writes exactly one event row with actor, from/to status and owner; reassign logs both owners", async () => {
    const { caseId } = await openOnLine(finance, finance);

    const started = await act(finance2, caseId, { type: "start" });
    expect(started.status).toBe(200);
    expect(started.body.data).toMatchObject({
      status: "in_progress",
      ownerId: finance.userId,
    });

    const reassigned = await act(finance, caseId, {
      type: "reassign",
      ownerId: finance2.userId,
    });
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.data).toMatchObject({
      status: "in_progress",
      ownerId: finance2.userId,
    });

    const resolved = await act(finance2, caseId, {
      type: "resolve",
      note: "Selisih biaya admin bank",
    });
    expect(resolved.status).toBe(200);
    const data = reconciliationCaseSchema.parse(resolved.body.data);
    expect(data).toMatchObject({
      status: "resolved",
      resolvedBy: finance2.userId,
      resolutionNote: "Selisih biaya admin bank",
      adjustmentJournalEntryId: null,
    });

    expect(await events(caseId)).toEqual([
      expect.objectContaining({ seq: 1, action: "open" }),
      {
        seq: 2,
        action: "start",
        actor_id: finance2.userId,
        from_status: "open",
        to_status: "in_progress",
        from_owner_id: finance.userId,
        to_owner_id: finance.userId,
        note: null,
      },
      {
        seq: 3,
        action: "reassign",
        actor_id: finance.userId,
        from_status: "in_progress",
        to_status: "in_progress",
        from_owner_id: finance.userId,
        to_owner_id: finance2.userId,
        note: null,
      },
      {
        seq: 4,
        action: "resolve",
        actor_id: finance2.userId,
        from_status: "in_progress",
        to_status: "resolved",
        from_owner_id: finance2.userId,
        to_owner_id: finance2.userId,
        note: "Selisih biaya admin bank",
      },
    ]);
  });

  it("a resolved case refuses every further action and writes no event; start twice and reassign to a user without a role are refused", async () => {
    const { caseId } = await openOnLine(finance, finance);
    expect((await act(finance, caseId, { type: "start" })).status).toBe(200);
    const twice = await act(finance, caseId, { type: "start" });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("INVALID_TRANSITION");

    const noRole = await act(finance, caseId, {
      type: "reassign",
      ownerId: nobody.userId,
    });
    expect(noRole.status).toBe(422);

    expect(
      (await act(finance, caseId, { type: "resolve", note: "Sudah beres" }))
        .status,
    ).toBe(200);
    for (const body of [
      { type: "start" },
      { type: "reassign", ownerId: finance2.userId },
      { type: "resolve", note: "Lagi" },
    ]) {
      const refused = await act(finance, caseId, body);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("INVALID_TRANSITION");
    }
    expect((await events(caseId)).map((event) => event.action)).toEqual([
      "open",
      "start",
      "resolve",
    ]);
  });

  it("two simultaneous starts: one wins, the other is refused, one event", async () => {
    const { caseId } = await openOnLine(finance, finance);
    const [a, b] = await Promise.all([
      act(finance, caseId, { type: "start" }),
      act(finance2, caseId, { type: "start" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await events(caseId)).map((event) => event.seq)).toEqual([1, 2]);
  });

  it("write-off validates the adjustment journal (entity, reversal, amount, reuse) and books nothing", async () => {
    const { entity, caseId } = await openOnLine(finance, finance);
    const other = await seedEntity();
    const writeOff = (adjustmentJournalEntryId: string) =>
      act(finance, caseId, {
        type: "write_off",
        note: "Selisih dihapuskan",
        adjustmentJournalEntryId,
      });

    const missing = await writeOff(randomUUID());
    expect(missing.status).toBe(404);

    const foreignEntity = await writeOff(await seedJournal(other, 10_000));
    expect(foreignEntity.status).toBe(422);
    expect(foreignEntity.body.error.code).toBe("ACCOUNT_ENTITY_MISMATCH");

    const wrongAmount = await writeOff(await seedJournal(entity, 9_000));
    expect(wrongAmount.status).toBe(422);
    expect(wrongAmount.body.error.code).toBe("POSTING_AMOUNTS_MISMATCH");

    const reversed = await seedJournal(entity, 10_000);
    const reversal = await seedJournal(entity, 10_000, {
      reversalOf: reversed,
    });
    for (const id of [reversed, reversal]) {
      const refused = await writeOff(id);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("JOURNAL_ALREADY_REVERSED");
    }

    const depositJournal = await seedJournal(entity, 10_000);
    const deposit = await seedDeposit(entity);
    await owner.query(
      "UPDATE cash_deposits SET journal_entry_id = $1 WHERE id = $2",
      [depositJournal, deposit],
    );
    const usedByDeposit = await writeOff(depositJournal);
    expect(usedByDeposit.status).toBe(409);
    expect(usedByDeposit.body.error.code).toBe("CONFLICT");

    const matchedJournal = await seedJournal(entity, 10_000);
    const matchedLine = await seedLine(entity, "auto_matched");
    await owner.query(
      `INSERT INTO bank_statement_line_matches
         (tenant_id, bank_account_id, line_id, ref_type, ref_id, amount_idr, source, matched_by)
       VALUES ($1, $2, $3, 'journal_entry', $4, 10000, 'auto', 'seed')`,
      [tenantId, entity.bankAccountId, matchedLine, matchedJournal],
    );
    const usedByMatch = await writeOff(matchedJournal);
    expect(usedByMatch.status).toBe(409);
    expect(usedByMatch.body.error.code).toBe("CONFLICT");

    // Nothing changed so far.
    expect((await events(caseId)).map((event) => event.action)).toEqual([
      "open",
    ]);

    const good = await seedJournal(entity, 10_000);
    const done = await writeOff(good);
    expect(done.status).toBe(200);
    const data = reconciliationCaseSchema.parse(done.body.data);
    expect(data).toMatchObject({
      status: "written_off",
      adjustmentJournalEntryId: good,
      resolvedBy: finance.userId,
    });
    const journals = await owner.query(
      "SELECT 1 FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_type = 'manual'",
      [tenantId, entity.id],
    );
    expect(journals.rowCount).toBe(5); // seeded by this test, none posted by the action
    expect((await events(caseId)).at(-1)).toMatchObject({
      action: "write_off",
      from_status: "open",
      to_status: "written_off",
    });

    // The same journal cannot write off a second case.
    const second = await openOnLine(finance, finance, entity);
    const reused = await act(finance, second.caseId, {
      type: "write_off",
      note: "Lagi",
      adjustmentJournalEntryId: good,
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("CONFLICT");
  });

  it("GET one and list: filters, newest first, cursor pages without gaps or repeats", async () => {
    const entity = await seedEntity();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1)
      ids.push((await openOnLine(finance, finance, entity)).caseId);
    await act(finance, ids[0]!, { type: "start" });

    const one = await get(finance, `${BASE}/${ids[1]}`);
    expect(one.status).toBe(200);
    expect(reconciliationCaseSchema.parse(one.body.data).id).toBe(ids[1]);

    const query = `legalEntityId=${entity.id}`;
    const first = await get(finance, `${BASE}?${query}&limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.data.map((row: { id: string }) => row.id)).toEqual([
      ids[2],
      ids[1],
    ]);
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));
    const second = await get(
      finance,
      `${BASE}?${query}&limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`,
    );
    expect(second.body.data.map((row: { id: string }) => row.id)).toEqual([
      ids[0],
    ]);
    expect(second.body.meta.nextCursor).toBeNull();

    const inProgress = await get(
      finance,
      `${BASE}?${query}&status=in_progress`,
    );
    expect(inProgress.body.data.map((row: { id: string }) => row.id)).toEqual([
      ids[0],
    ]);
    expect(
      (await get(finance, `${BASE}?${query}&cursor=not-a-cursor`)).status,
    ).toBe(422);
  });

  it("outlet visibility: an outlet-scoped caller sees only its outlet's cases; entity-level cases need tenant scope", async () => {
    const { rows } = await owner.query<{ legal_entity_id: string }>(
      "SELECT legal_entity_id FROM outlets WHERE id = $1",
      [outletA],
    );
    const entityId = rows[0]!.legal_entity_id;
    const outletCase = await openCase(finance, {
      legalEntityId: entityId,
      outletId: outletA,
      type: "gateway_settlement",
      ownerId: finance.userId,
      refs: [{ type: "gateway_settlement", id: randomUUID() }],
    });
    expect(outletCase.status).toBe(201);
    const entityCase = await openCase(finance, {
      legalEntityId: entityId,
      type: "gateway_settlement",
      ownerId: finance.userId,
      refs: [{ type: "gateway_settlement", id: randomUUID() }],
    });
    expect(entityCase.status).toBe(201);
    const outletCaseId = outletCase.body.data.id as string;
    const entityCaseId = entityCase.body.data.id as string;
    const listFor = (outlets: string[]) =>
      listReconciliationCases(scope(outlets), {
        legalEntityId: entityId,
        limit: 50,
      });

    const seesA = (await listFor([outletA])).data.map((row) => row.id);
    expect(seesA).toContain(outletCaseId);
    expect(seesA).not.toContain(entityCaseId);
    expect((await listFor([outletB])).data.map((row) => row.id)).not.toContain(
      outletCaseId,
    );

    await expect(
      getReconciliationCase(scope([outletA]), outletCaseId),
    ).resolves.toMatchObject({ id: outletCaseId });
    await expect(
      getReconciliationCase(scope([outletB]), outletCaseId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      getReconciliationCase(scope([outletA]), entityCaseId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      actOnReconciliationCase(
        scope([outletB]),
        outletCaseId,
        { type: "start" },
        finance.userId as never,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((await events(outletCaseId)).length).toBe(1);
  });

  it("permission: no role is 403 on every route; tenant isolation: another tenant's case is 404", async () => {
    const { entity, caseId } = await openOnLine(finance, finance);
    expect(
      (await get(nobody, `${BASE}?legalEntityId=${entity.id}`)).status,
    ).toBe(403);
    expect((await get(nobody, `${BASE}/${caseId}`)).status).toBe(403);
    expect(
      (
        await openCase(nobody, {
          legalEntityId: entity.id,
          ownerId: finance.userId,
          refs: [{ type: "gateway_settlement", id: randomUUID() }],
        })
      ).status,
    ).toBe(403);
    expect((await act(nobody, caseId, { type: "start" })).status).toBe(403);
    expect((await events(caseId)).length).toBe(1);

    const other = await newTenant();
    await expect(
      getReconciliationCase(scope(undefined, other), caseId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      actOnReconciliationCase(
        scope(undefined, other),
        caseId,
        { type: "start" },
        finance.userId as never,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      listReconciliationCases(scope(undefined, other), {
        legalEntityId: entity.id,
        limit: 10,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await events(caseId)).length).toBe(1);
  });

  // ---------------------------------------------------------------- legend-fnxl.9
  it("fnxl.9 dueAt follows the tenant policy: 14 days when the tenant set 14", async () => {
    await clearPolicy();
    try {
      await setCaseDueDays(14);
      const { caseId } = await openOnLine(finance, finance);
      const data = reconciliationCaseSchema.parse(
        (await get(finance, `${BASE}/${caseId}`)).body.data,
      );
      expect(dueDaysOf(data)).toBeCloseTo(14, 5);
    } finally {
      await clearPolicy();
    }
  });

  it("fnxl.9 with no policy row the default stays 7 days", async () => {
    await clearPolicy();
    const { caseId } = await openOnLine(finance, finance);
    const data = reconciliationCaseSchema.parse(
      (await get(finance, `${BASE}/${caseId}`)).body.data,
    );
    expect(dueDaysOf(data)).toBeCloseTo(7, 5);
  });

  it("fnxl.9 boundaries 1 and 60 are honoured", async () => {
    await clearPolicy();
    try {
      await setCaseDueDays(1);
      const one = await openOnLine(finance, finance);
      expect(
        dueDaysOf(
          reconciliationCaseSchema.parse(
            (await get(finance, `${BASE}/${one.caseId}`)).body.data,
          ),
        ),
      ).toBeCloseTo(1, 5);
      await setCaseDueDays(60);
      const sixty = await openOnLine(finance, finance);
      expect(
        dueDaysOf(
          reconciliationCaseSchema.parse(
            (await get(finance, `${BASE}/${sixty.caseId}`)).body.data,
          ),
        ),
      ).toBeCloseTo(60, 5);
    } finally {
      await clearPolicy();
    }
  });

  it("fnxl.9 a case already open keeps its dueAt when the policy changes later", async () => {
    await clearPolicy();
    try {
      const { caseId } = await openOnLine(finance, finance); // default 7
      const before = (await get(finance, `${BASE}/${caseId}`)).body.data;
      await setCaseDueDays(30);
      const after = (await get(finance, `${BASE}/${caseId}`)).body.data;
      expect(after.dueAt).toBe(before.dueAt);
      expect(dueDaysOf(reconciliationCaseSchema.parse(after))).toBeCloseTo(
        7,
        5,
      );
      // Acting on the case does not re-derive the due date either.
      expect((await act(finance, caseId, { type: "start" })).status).toBe(200);
      const started = (await get(finance, `${BASE}/${caseId}`)).body.data;
      expect(started.dueAt).toBe(before.dueAt);
      // A case opened afterwards does use the new policy.
      const next = await openOnLine(finance, finance);
      expect(
        dueDaysOf(
          reconciliationCaseSchema.parse(
            (await get(finance, `${BASE}/${next.caseId}`)).body.data,
          ),
        ),
      ).toBeCloseTo(30, 5);
    } finally {
      await clearPolicy();
    }
  });

  it("fnxl.9 another tenant's policy does not change this tenant's due date", async () => {
    await clearPolicy();
    const other = await newTenant();
    try {
      await setCaseDueDays(45, other);
      const { caseId } = await openOnLine(finance, finance);
      expect(
        dueDaysOf(
          reconciliationCaseSchema.parse(
            (await get(finance, `${BASE}/${caseId}`)).body.data,
          ),
        ),
      ).toBeCloseTo(7, 5);
    } finally {
      await owner.query("DELETE FROM finance_policies WHERE tenant_id = $1", [
        other,
      ]);
    }
  });
});
