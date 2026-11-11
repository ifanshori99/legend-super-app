// Cross-tenant isolation for accounting journals and HRIS employees (bead
// legend-wwsa; PRD v1.7 TEN-01, TEN-02, TEN-03). Tenant A is the seeded Cafe
// Legend tenant, tenant B is a throwaway tenant (tenant-isolation-harness.ts).
// Per module: the real service with a context minted for one tenant, table
// level RLS as legend_app, and one authenticated HTTP request.
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import {
  getEmployee,
  listEmployees,
  revealEmployeePii,
  updateEmployeePii,
} from "../services/hris-employee.service";
import {
  getJournal,
  listJournals,
  reverseJournal,
} from "../services/accounting-journal.service";
import { agent, originHeader, signUp } from "./helpers";
import {
  asTenant,
  createAppPool,
  createOwnerPool,
  createSecondTenant,
  expectRowsIsolated,
  removeSecondTenant,
  requireDisposableDatabase,
  tenantAId,
  type SecondTenant,
} from "./tenant-isolation-harness";

requireDisposableDatabase();

const app = createApp();
const outletAId = cafeLegendPlatformFixtures.outlets[0].id;
const owner: Pool = createOwnerPool();
const appPool: Pool = createAppPool();
// The harness imports establishTenantContext from the non-server entry, which
// does not export it at runtime; build the context from core/server instead.
const tenantContext = (tenantId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
const ctxA = tenantContext(tenantAId);
const unique = () => randomBytes(4).toString("hex");

let tenantB: SecondTenant;
let ctxB: ScopedTenantContext;

const createdUsers: string[] = [];
const createdRoles: { tenantId: string; id: string }[] = [];
const createdEmployees: { tenantId: string; id: string }[] = [];
const createdEntities: { tenantId: string; id: string }[] = [];
const createdOutlets: { tenantId: string; id: string }[] = [];
const journalFixtures: JournalFixture[] = [];

type Client = ReturnType<typeof agent>;
type JournalFixture = {
  tenantId: string;
  legalEntityId: string;
  periodId: string;
  accountIds: string[];
  entryId: string;
  description: string;
};

/** Owner connection with the tenant GUCs set, so fixtures pass forced RLS. */
async function ownerTx<T>(
  tenantId: string,
  run: (client: import("pg").PoolClient) => Promise<T>,
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
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function grantRole(
  tenantId: string,
  userId: string,
  permissions: string[],
  outletScope?: string,
) {
  const roleId = randomUUID();
  createdRoles.push({ tenantId, id: roleId });
  await ownerTx(tenantId, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `Isolation ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant", "outlet"]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenantId,
        userId,
        roleId,
        outletScope ? "outlet" : "tenant",
        outletScope ?? null,
      ],
    );
  });
}

async function seedEmployee(tenantId: string, outletId: string) {
  const id = randomUUID();
  createdEmployees.push({ tenantId, id });
  await ownerTx(tenantId, (client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, NULL, $3, 'Karyawan Isolasi', $4, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenantId, `0000ISO${unique().toUpperCase()}`, outletId],
    ),
  );
  return id;
}

/** One balanced posted entry (two lines) on a fresh fiscal period and accounts. */
async function seedJournal(
  tenantId: string,
  legalEntityId: string,
): Promise<JournalFixture> {
  const cash = randomUUID();
  const revenue = randomUUID();
  const periodId = randomUUID();
  const description = `Isolation journal ${unique()}`;
  const entryId = await ownerTx(tenantId, async (client) => {
    await client.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $3, $4, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
              ($2, $3, $4, '4101', 'Penjualan', 'revenue', 'revenue')`,
      [cash, revenue, tenantId, legalEntityId],
    );
    await client.query(
      `INSERT INTO fiscal_periods (id, tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3, '2026-11')`,
      [periodId, tenantId, legalEntityId],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
          source_id, description, reversal_of, idempotency_key, request_fingerprint)
       VALUES ($1, $2, '2026-11-05', $3, 'sale', NULL, $4, NULL, $5, $6)
       RETURNING id`,
      [
        tenantId,
        legalEntityId,
        periodId,
        description,
        `iso-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const id = rows[0]!.id;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, 10000, 0), ($1, $2, $4, 2, 0, 10000)`,
      [tenantId, id, cash, revenue],
    );
    return id;
  });
  return {
    tenantId,
    legalEntityId,
    periodId,
    accountIds: [cash, revenue],
    entryId,
    description,
  };
}

/** A fresh legal entity in `tenantId` holding one posted journal entry. */
async function seedEntityJournal(tenantId: string): Promise<JournalFixture> {
  const entityId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [entityId, tenantId, `Isolation entity ${unique()}`],
  );
  createdEntities.push({ tenantId, id: entityId });
  const fixture = await seedJournal(tenantId, entityId);
  journalFixtures.push(fixture);
  return fixture;
}

/** A second outlet in tenant A, so an outlet-scoped reader has one to miss. */
async function seedOutletA(): Promise<string> {
  const id = randomUUID();
  createdOutlets.push({ tenantId: tenantAId, id });
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $3, 'Outlet A2 isolasi', address, opening_hours
       FROM outlets WHERE id = $2`,
    [id, outletAId, `ISO-${unique()}`.toUpperCase()],
  );
  return id;
}

/** Journals are append-only; replica mode lets the owner clean up fixtures. */
async function removeJournalFixtures(fixtures: JournalFixture[]) {
  if (fixtures.length === 0) return;
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const fixture of fixtures) {
      const args = [fixture.tenantId, fixture.legalEntityId];
      await client.query(
        "DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id IN (SELECT id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2)",
        args,
      );
      await client.query(
        "DELETE FROM app.journal_entry_seals WHERE tenant_id = $1 AND entry_id IN (SELECT id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2)",
        args,
      );
      await client.query(
        "DELETE FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
        args,
      );
      await client.query(
        "DELETE FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2",
        args,
      );
      await client.query(
        "DELETE FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2",
        args,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function employeeSnapshot(id: string): Promise<string> {
  const { rows } = await owner.query("SELECT * FROM employees WHERE id = $1", [
    id,
  ]);
  return JSON.stringify(rows[0] ?? null);
}

async function journalCount(entryId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE id = $1 OR reversal_of = $1",
    [entryId],
  );
  return Number(rows[0]!.n);
}

async function allEmployeeIds(
  context: ScopedTenantContext,
  actor: string,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listEmployees(context, actor, {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...page.data.map((employee) => employee.id));
    cursor = page.meta.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

let journalA: JournalFixture;
let journalB: JournalFixture;
// Own-journal controls: each reversal proves the caller can reverse its own
// entry, so the foreign denial cannot come from missing permission.
let reverseControlA: JournalFixture;
let reverseControlB: JournalFixture;
let reverseControlRouteA: JournalFixture;
let employeeA: string;
let employeeB: string;
let employeeOtherOutletA: string;
let actorA: { client: Client; userId: string };
let actorB: { client: Client; userId: string };
let actorOutletA: { client: Client; userId: string };

beforeAll(async () => {
  tenantB = await createSecondTenant(owner, "acchris");
  ctxB = tenantContext(tenantB.tenantId);

  journalA = await seedEntityJournal(tenantAId);
  journalB = await seedJournal(tenantB.tenantId, tenantB.legalEntityId);
  journalFixtures.push(journalB);
  reverseControlA = await seedEntityJournal(tenantAId);
  reverseControlB = await seedEntityJournal(tenantB.tenantId);
  reverseControlRouteA = await seedEntityJournal(tenantAId);

  const outletA2 = await seedOutletA();
  employeeA = await seedEmployee(tenantAId, outletAId);
  employeeOtherOutletA = await seedEmployee(tenantAId, outletA2);
  employeeB = await seedEmployee(tenantB.tenantId, tenantB.outletId);

  const permissions = [
    "accounting.journal.view",
    "accounting.journal.post",
    "hr.employee.view",
    "hr.employee.manage",
  ];
  actorA = await signedIn("Isolation A");
  await grantRole(tenantAId, actorA.userId, permissions);
  actorB = await signedIn("Isolation B");
  await grantRole(tenantB.tenantId, actorB.userId, permissions);
  // Reader limited to tenant A's first outlet (TEN-03).
  actorOutletA = await signedIn("Isolation Outlet A");
  await grantRole(
    tenantAId,
    actorOutletA.userId,
    ["hr.employee.view"],
    outletAId,
  );
}, 60_000);

afterAll(async () => {
  // Every step runs in its own try so one failure never skips the rest; the
  // first error is rethrown once the pools are closed.
  const errors: unknown[] = [];
  const step = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    // HRIS writes leave audit and idempotency rows that name the fixtures
    // (audit_logs rows reference the outlets); remove them first.
    const employeeIds = createdEmployees.map((employee) => employee.id);
    const tenantBId = tenantB?.tenantId ?? randomUUID();
    await step(async () => {
      // Audit rows are append-only; replica mode lets the owner remove ours.
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          `DELETE FROM audit_logs
            WHERE (tenant_id = $1 AND (outlet_id = ANY($2::uuid[])
                   OR EXISTS (SELECT 1 FROM unnest($3::text[]) AS e(id)
                               WHERE audit_logs.event::text LIKE '%' || e.id || '%')))
               OR tenant_id = $4`,
          [
            tenantAId,
            createdOutlets.map((outlet) => outlet.id),
            employeeIds,
            tenantBId,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
    await step(() =>
      owner.query(
        "DELETE FROM hris_idempotency WHERE key LIKE 'hris-iso-%' AND tenant_id = ANY($1::uuid[])",
        [[tenantAId, tenantBId]],
      ),
    );
    for (const employee of createdEmployees)
      await step(() =>
        ownerTx(employee.tenantId, (client) =>
          client.query(
            "DELETE FROM employees WHERE tenant_id = $1 AND id = $2",
            [employee.tenantId, employee.id],
          ),
        ),
      );
    for (const role of createdRoles)
      await step(() =>
        ownerTx(role.tenantId, async (client) => {
          await client.query(
            "DELETE FROM role_assignments WHERE tenant_id = $1 AND role_id = $2",
            [role.tenantId, role.id],
          );
          await client.query(
            "DELETE FROM roles WHERE tenant_id = $1 AND id = $2",
            [role.tenantId, role.id],
          );
        }),
      );
    await step(() => removeJournalFixtures(journalFixtures));
    for (const entity of createdEntities)
      await step(() =>
        owner.query(
          "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
          [entity.tenantId, entity.id],
        ),
      );
    for (const outlet of createdOutlets)
      await step(() =>
        owner.query("DELETE FROM outlets WHERE tenant_id = $1 AND id = $2", [
          outlet.tenantId,
          outlet.id,
        ]),
      );
    if (tenantB) await step(() => removeSecondTenant(owner, tenantB));
    if (createdUsers.length > 0)
      await step(() =>
        owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]),
      );
  } finally {
    await step(() => owner.end());
    await step(() => appPool.end());
  }
  if (errors.length > 0) throw errors[0];
}, 60_000);

describe("accounting journals tenant isolation", () => {
  const range = { from: "2026-01-01", to: "2026-12-31" } as never;
  const listQuery = (legalEntityId: string) => ({
    legalEntityId,
    ...(range as object),
    limit: 100,
  });

  it("TEN-01 service lists and reads only the actor tenant's journals", async () => {
    const own = await listJournals(
      ctxA,
      listQuery(journalA.legalEntityId) as never,
    );
    expect(own.data.map((entry) => entry.id)).toEqual([journalA.entryId]);

    await expect(
      listJournals(ctxA, listQuery(journalB.legalEntityId) as never),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      listJournals(ctxB, listQuery(journalA.legalEntityId) as never),
    ).rejects.toMatchObject({ status: 404 });

    expect((await getJournal(ctxA, journalA.entryId)).entry.id).toBe(
      journalA.entryId,
    );
    await expect(getJournal(ctxA, journalB.entryId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(getJournal(ctxB, journalA.entryId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("TEN-01 service cannot reverse another tenant's journal and leaves it untouched", async () => {
    const input = (reason: string) => ({
      entryDate: "2026-11-06",
      reason,
      idempotencyKey: `iso-${randomUUID()}`,
    });
    const actor = userIdSchema.parse(actorA.userId);
    const actorBId = userIdSchema.parse(actorB.userId);
    // Controls: both actors can reverse their own tenant's entry, so the
    // foreign denials below come from tenant scoping alone.
    await expect(
      reverseJournal(
        ctxA,
        reverseControlA.entryId,
        input("A reverses own"),
        actor,
      ),
    ).resolves.toBeDefined();
    await expect(
      reverseJournal(
        ctxB,
        reverseControlB.entryId,
        input("B reverses own"),
        actorBId,
      ),
    ).resolves.toBeDefined();
    expect(await journalCount(reverseControlA.entryId)).toBe(2);
    expect(await journalCount(reverseControlB.entryId)).toBe(2);

    await expect(
      reverseJournal(ctxA, journalB.entryId, input("A reverses B"), actor),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      reverseJournal(ctxB, journalA.entryId, input("B reverses A"), actorBId),
    ).rejects.toMatchObject({ status: 404 });
    // Only the original entries exist: no reversal was posted on either side.
    expect(await journalCount(journalA.entryId)).toBe(1);
    expect(await journalCount(journalB.entryId)).toBe(1);
  });

  it("TEN-01 RLS isolates accounting tables for legend_app", async () => {
    await expectRowsIsolated(
      appPool,
      {
        table: "journal_entries",
        updateSet: "description = description",
        tenantA: { tenantId: tenantAId, rowId: journalA.entryId },
        tenantB: { tenantId: tenantB.tenantId, rowId: journalB.entryId },
      },
      owner,
    );
    await expectRowsIsolated(
      appPool,
      {
        table: "chart_of_accounts",
        updateSet: "name = name",
        tenantA: { tenantId: tenantAId, rowId: journalA.accountIds[0]! },
        tenantB: { tenantId: tenantB.tenantId, rowId: journalB.accountIds[0]! },
      },
      owner,
    );
    await expectRowsIsolated(
      appPool,
      {
        table: "fiscal_periods",
        // 0317: legend_app may update only updated_at (status moves through
        // app.close_fiscal_period / app.reopen_fiscal_period); 0312: no DELETE.
        updateSet: "updated_at = updated_at",
        deleteRevoked: true,
        tenantA: { tenantId: tenantAId, rowId: journalA.periodId },
        tenantB: { tenantId: tenantB.tenantId, rowId: journalB.periodId },
      },
      owner,
    );
    // journal_lines has no single-column id: prove by entry.
    for (const [self, other] of [
      [journalA, journalB],
      [journalB, journalA],
    ] as const) {
      await asTenant(appPool, self.tenantId, async (client) => {
        const mine = await client.query(
          "SELECT 1 FROM journal_lines WHERE entry_id = $1",
          [self.entryId],
        );
        expect(mine.rowCount).toBe(2);
        const theirs = await client.query(
          "SELECT 1 FROM journal_lines WHERE entry_id = $1",
          [other.entryId],
        );
        expect(theirs.rowCount).toBe(0);
        const deleted = await client.query(
          "DELETE FROM journal_lines WHERE entry_id = $1",
          [other.entryId],
        );
        expect(deleted.rowCount).toBe(0);
      });
    }
  });

  it("TEN-01 route lists only the actor tenant's journals and hides another tenant's entry", async () => {
    const query = `from=2026-01-01&to=2026-12-31&limit=100`;
    const own = await actorA.client.get(
      `/api/accounting/journals?legalEntityId=${journalA.legalEntityId}&${query}`,
    );
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(
      (own.body.data as { id: string }[]).map((entry) => entry.id),
    ).toEqual([journalA.entryId]);

    // Own-row control: the same route answers 200 for the caller's own entry.
    const ownGet = await actorA.client.get(
      `/api/accounting/journals/${journalA.entryId}`,
    );
    expect(ownGet.status, JSON.stringify(ownGet.body)).toBe(200);
    expect(ownGet.body.data.entry.id).toBe(journalA.entryId);

    const foreignList = await actorA.client.get(
      `/api/accounting/journals?legalEntityId=${journalB.legalEntityId}&${query}`,
    );
    expect(foreignList.status).toBe(404);
    expect(JSON.stringify(foreignList.body)).not.toContain(journalB.entryId);

    const foreignGet = await actorA.client.get(
      `/api/accounting/journals/${journalB.entryId}`,
    );
    expect(foreignGet.status).toBe(404);
    expect(JSON.stringify(foreignGet.body)).not.toContain(journalB.description);

    const reversal = (reason: string) => ({
      entryDate: "2026-11-06",
      reason,
      idempotencyKey: `iso-${randomUUID()}`,
    });
    // Own-row control: the same actor and route reverse the caller's own entry.
    const ownReverse = await actorA.client
      .post(`/api/accounting/journals/${reverseControlRouteA.entryId}/reversal`)
      .set(originHeader)
      .send(reversal("route own reversal"));
    expect(ownReverse.status, JSON.stringify(ownReverse.body)).toBe(201);
    expect(await journalCount(reverseControlRouteA.entryId)).toBe(2);

    const foreignReverse = await actorA.client
      .post(`/api/accounting/journals/${journalB.entryId}/reversal`)
      .set(originHeader)
      .send(reversal("route cross-tenant reversal"));
    expect(foreignReverse.status).toBe(404);
    expect(await journalCount(journalB.entryId)).toBe(1);
  });
});

describe("HRIS employees tenant isolation", () => {
  // 16-digit NIKs; each write gets its own so blind-index uniqueness holds.
  let nikSeq = 0;
  const makeNik = () =>
    `33${String(Date.now()).slice(-8)}${String(++nikSeq).padStart(6, "0")}`;
  const nik = makeNik();

  it("TEN-01 service lists and reads only the actor tenant's employees", async () => {
    const idsA = await allEmployeeIds(ctxA, actorA.userId);
    expect(idsA).toContain(employeeA);
    expect(idsA).not.toContain(employeeB);
    const idsB = await allEmployeeIds(ctxB, actorB.userId);
    expect(idsB).toEqual([employeeB]);

    expect((await getEmployee(ctxA, actorA.userId, employeeA)).id).toBe(
      employeeA,
    );
    await expect(
      getEmployee(ctxA, actorA.userId, employeeB),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      getEmployee(ctxB, actorB.userId, employeeA),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("TEN-01 service cannot change or reveal another tenant's employee PII", async () => {
    const piiBody = (value: string) =>
      ({ nik: value, idempotencyKey: `hris-iso-${randomUUID()}` }) as never;
    // Controls: each actor changes and reveals PII of its own tenant's
    // employee, so the foreign denials below come from tenant scoping alone.
    const ownNikA = makeNik();
    const ownNikB = makeNik();
    await expect(
      updateEmployeePii(ctxA, actorA.userId, employeeA, piiBody(ownNikA)),
    ).resolves.toBeDefined();
    await expect(
      updateEmployeePii(ctxB, actorB.userId, employeeB, piiBody(ownNikB)),
    ).resolves.toBeDefined();
    await expect(
      revealEmployeePii(ctxA, actorA.userId, employeeA, ["nik"], "uji isolasi"),
    ).resolves.toBeDefined();
    await expect(
      revealEmployeePii(ctxB, actorB.userId, employeeB, ["nik"], "uji isolasi"),
    ).resolves.toBeDefined();

    const beforeA = await employeeSnapshot(employeeA);
    const beforeB = await employeeSnapshot(employeeB);
    await expect(
      updateEmployeePii(ctxA, actorA.userId, employeeB, piiBody(nik)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      updateEmployeePii(ctxB, actorB.userId, employeeA, piiBody(nik)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      revealEmployeePii(ctxA, actorA.userId, employeeB, ["nik"], "uji isolasi"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      revealEmployeePii(ctxB, actorB.userId, employeeA, ["nik"], "uji isolasi"),
    ).rejects.toMatchObject({ status: 404 });
    expect(await employeeSnapshot(employeeA)).toBe(beforeA);
    expect(await employeeSnapshot(employeeB)).toBe(beforeB);
  });

  it("TEN-01 RLS isolates employees for legend_app", async () => {
    await expectRowsIsolated(
      appPool,
      {
        table: "employees",
        updateSet: "full_name = full_name",
        tenantA: { tenantId: tenantAId, rowId: employeeA },
        tenantB: { tenantId: tenantB.tenantId, rowId: employeeB },
      },
      owner,
    );
  });

  it("TEN-01 route lists only the actor tenant's employees and hides another tenant's employee", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<Client["get"]>> = await actorA.client.get(
        `/api/hris/employees?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      seen.push(...(page.body.data as { id: string }[]).map((e) => e.id));
      cursor = page.body.meta.nextCursor as string | null;
    } while (cursor);
    expect(seen).toContain(employeeA);
    expect(seen).not.toContain(employeeB);

    // Own-row controls: the same routes succeed for the caller's own employee.
    const ownGet = await actorA.client.get(`/api/hris/employees/${employeeA}`);
    expect(ownGet.status, JSON.stringify(ownGet.body)).toBe(200);
    const ownPii = await actorA.client
      .put(`/api/hris/employees/${employeeA}/pii`)
      .set(originHeader)
      .send({ nik: makeNik(), idempotencyKey: `hris-iso-${randomUUID()}` });
    expect(ownPii.status, JSON.stringify(ownPii.body)).toBe(200);

    const foreignGet = await actorA.client.get(
      `/api/hris/employees/${employeeB}`,
    );
    expect(foreignGet.status).toBe(404);
    expect(JSON.stringify(foreignGet.body)).not.toContain("Karyawan Isolasi");

    const foreignPii = await actorA.client
      .put(`/api/hris/employees/${employeeB}/pii`)
      .set(originHeader)
      .send({ nik, idempotencyKey: `hris-iso-${randomUUID()}` });
    expect(foreignPii.status).toBe(404);
  });

  it("TEN-03 an outlet-scoped reader sees its own outlet's employee and not another outlet's", async () => {
    const userId = actorOutletA.userId;
    // Own outlet is visible; another outlet of the same tenant and another
    // tenant's employee are not.
    const ids = await allEmployeeIds(ctxA, userId);
    expect(ids).toContain(employeeA);
    expect(ids).not.toContain(employeeOtherOutletA);
    expect(ids).not.toContain(employeeB);
    expect((await getEmployee(ctxA, userId, employeeA)).id).toBe(employeeA);
    await expect(
      getEmployee(ctxA, userId, employeeOtherOutletA),
    ).rejects.toMatchObject({ status: 404 });

    const own = await actorOutletA.client.get(
      `/api/hris/employees/${employeeA}`,
    );
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const otherOutlet = await actorOutletA.client.get(
      `/api/hris/employees/${employeeOtherOutletA}`,
    );
    expect(otherOutlet.status).toBe(404);
    // The tenant-wide actor reads that same employee, so the 404 is outlet scope.
    const tenantWide = await actorA.client.get(
      `/api/hris/employees/${employeeOtherOutletA}`,
    );
    expect(tenantWide.status, JSON.stringify(tenantWide.body)).toBe(200);
  });
});
