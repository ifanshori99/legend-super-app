// Shared fixtures for the Kas & Bank entry and petty cash API tests (bead
// legend-4961). Not a test file: imported by accounting-cash-bank-entries.test.ts
// and accounting-petty-cash.test.ts. Everything is seeded as the migration
// owner on the disposable PostgreSQL database. Each importing test file gets
// its own module instance (vitest isolates files), so each builds its own
// legal entity, chart, mappings, periods, outlets and bank accounts and never
// sees the other file's rows.
import { randomBytes, randomUUID } from "node:crypto";
import type { Express } from "express";
import { Pool, type PoolClient } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { createBankAccount } from "../../services/accounting-bank-accounts.service.ts";
import { agent, signUp } from "../helpers.ts";

export const tenantId = cafeLegendPlatformFixtures.tenant.id;
export const brandId = cafeLegendPlatformFixtures.brand.id;

export const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});
/** The restricted runtime login (RLS and column grants apply). */
export const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});

export const short = () => randomBytes(3).toString("hex");
export const key = () => `k-${randomUUID()}`;
const actor = userIdSchema.parse(randomUUID());
const newNumber = () =>
  String(Math.floor(Math.random() * 9e11) + 1e11).padStart(12, "1");

export function scopeOf(tenant: string = tenantId): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

// ---- sessions --------------------------------------------------------------

const createdUserIds: string[] = [];
export type Session = { client: ReturnType<typeof agent>; userId: string };
export type Grant = { role: string; outletId: string | null };

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role template`);
  return rows[0].id;
}

/** A real Better Auth session with role assignments of the Cafe Legend tenant. */
export async function signedIn(
  app: Express,
  name: string,
  grants: Grant[],
): Promise<Session> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  for (const grant of grants)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenantId,
        userId,
        await roleIdOf(grant.role),
        grant.outletId === null ? "tenant" : "outlet",
        grant.outletId,
      ],
    );
  return { client, userId };
}

// ---- accounting world ------------------------------------------------------

export type World = {
  entityId: string;
  /** GL account ids by name. */
  gl: {
    pettyCash: string;
    pettyExpense: string;
    bankA: string;
    bankB: string;
    /** A cash_and_equivalents account that is NOT a bank GL (invalid counter). */
    cashDrawer: string;
    expense: string;
    revenue: string;
  };
  bankAccountA: string;
  bankAccountB: string;
  /** A second legal entity of the same tenant with its own bank account. */
  otherEntityId: string;
  otherBankAccount: string;
  /** Another tenant with its own entity and bank account. */
  foreign: { tenantId: string; entityId: string; bankAccountId: string };
};

async function insertAccount(
  entityId: string,
  tenant: string,
  code: string,
  name: string,
  type: string,
  group: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenant, entityId, code, name, type, group],
  );
  return rows[0]!.id;
}

async function insertEntity(tenant: string, label: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenant, `${label} ${short()}`],
  );
  return rows[0]!.id;
}

async function openPeriods(entityId: string): Promise<void> {
  const now = new Date();
  for (const shift of [-2, -1, 0, 1]) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, 1),
    );
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantId, entityId, period],
    );
  }
}

async function bankAccountFor(
  tenant: string,
  entityId: string,
  gl: string,
): Promise<string> {
  const account = await createBankAccount(
    scopeOf(tenant),
    {
      legalEntityId: entityId,
      bank: "BCA",
      accountName: `Kas Bank ${short()}`,
      accountNumber: newNumber(),
      glAccountId: gl,
    },
    actor,
  );
  return account.id;
}

export async function makeBankAccount(
  entityId: string,
  gl: string,
): Promise<string> {
  return bankAccountFor(tenantId, entityId, gl);
}

/**
 * A fresh legal entity with a chart, the posting role mappings (petty_cash,
 * petty_purchase_expense, bank -> bankA), open fiscal periods and two bank
 * accounts on different GL accounts.
 */
export async function makeWorld(): Promise<World> {
  const entityId = await insertEntity(tenantId, "Entity CB");
  const acct = (
    code: string,
    name: string,
    type: string,
    group: string,
    entity = entityId,
  ) => insertAccount(entity, tenantId, code, name, type, group);
  const gl = {
    pettyCash: await acct("1102", "Kas Kecil", "asset", "cash_and_equivalents"),
    bankA: await acct(
      "1103",
      "Bank Operasional",
      "asset",
      "cash_and_equivalents",
    ),
    bankB: await acct("1104", "Bank Cadangan", "asset", "cash_and_equivalents"),
    cashDrawer: await acct("1101", "Kas Laci", "asset", "cash_and_equivalents"),
    expense: await acct(
      "6101",
      "Beban Listrik",
      "expense",
      "operating_expense",
    ),
    pettyExpense: await acct(
      "5104",
      "Pembelian Langsung (Kas Kecil)",
      "expense",
      "cogs",
    ),
    revenue: await acct("4901", "Pendapatan Lain", "revenue", "other_income"),
  };
  for (const [role, account] of [
    ["petty_cash", gl.pettyCash],
    ["petty_purchase_expense", gl.pettyExpense],
    // Mapped to bank A on purpose: a topup from bank B must still hit bank B's
    // own GL, not this mapping.
    ["bank", gl.bankA],
  ] as const)
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entityId, role, account],
    );
  await openPeriods(entityId);

  const otherEntityId = await insertEntity(tenantId, "Entity CB lain");
  const otherGl = await acct(
    "1103",
    "Bank Lain",
    "asset",
    "cash_and_equivalents",
    otherEntityId,
  );

  // Another tenant (copy of the seeded tenant's plan and limits).
  const foreignTenant = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Cash bank other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [foreignTenant, `cbfx-${short()}`, tenantId],
  );
  const foreignEntity = await insertEntity(foreignTenant, "Entity asing");
  const foreignGl = await insertAccount(
    foreignEntity,
    foreignTenant,
    "1103",
    "Bank Asing",
    "asset",
    "cash_and_equivalents",
  );

  return {
    entityId,
    gl,
    bankAccountA: await makeBankAccount(entityId, gl.bankA),
    bankAccountB: await makeBankAccount(entityId, gl.bankB),
    otherEntityId,
    otherBankAccount: await makeBankAccount(otherEntityId, otherGl),
    foreign: {
      tenantId: foreignTenant,
      entityId: foreignEntity,
      bankAccountId: await bankAccountFor(
        foreignTenant,
        foreignEntity,
        foreignGl,
      ),
    },
  };
}

/** A fresh active outlet under the world's entity (own petty cash fund). */
export async function makeOutlet(entityId: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', '04:00', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
    [
      id,
      tenantId,
      brandId,
      entityId,
      `CB-${short()}`.toUpperCase(),
      `Outlet CB ${short()}`,
    ],
  );
  return id;
}

// ---- reads (as the migration owner, bypassing RLS) -------------------------

/** UTC calendar date `days` before today: never in the entity's future. */
export function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export type JournalLineRow = {
  accountId: string;
  debit: number;
  credit: number;
};

export async function journalLinesOf(
  entryId: string,
): Promise<JournalLineRow[]> {
  const { rows } = await owner.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
    [tenantId, entryId],
  );
  return rows.map((row) => ({
    accountId: row.account_id,
    debit: Number(row.debit),
    credit: Number(row.credit),
  }));
}

export function lineOf(
  lines: JournalLineRow[],
  accountId: string,
): { debit: number; credit: number } | undefined {
  const found = lines.find((line) => line.accountId === accountId);
  return found && { debit: found.debit, credit: found.credit };
}

export async function journalsByKey(
  entityId: string,
  idempotencyKey: string,
): Promise<{ id: string; source_type: string; outlet_id: string | null }[]> {
  const { rows } = await owner.query<{
    id: string;
    source_type: string;
    outlet_id: string | null;
  }>(
    "SELECT id, source_type, outlet_id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3",
    [tenantId, entityId, idempotencyKey],
  );
  return rows;
}

export async function journalCount(
  entityId: string,
  sourceTypes: string[],
): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_type = ANY($3::text[])",
    [tenantId, entityId, sourceTypes],
  );
  return Number(rows[0]!.n);
}

export async function auditActionsFor(objectId: string): Promise<string[]> {
  const { rows } = await owner.query<{ action: string }>(
    `SELECT event->>'action' AS action FROM audit_logs
      WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
    [tenantId, objectId],
  );
  return rows.map((row) => row.action);
}

/** Runs `run` as the migration owner with the tenant GUCs set (rolled back). */
export async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/** Runs `run` as the restricted runtime login `legend_app` (rolled back). */
export async function asRuntime<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

export async function closeKit(): Promise<void> {
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
  await owner.end();
  await appPool.end();
}
