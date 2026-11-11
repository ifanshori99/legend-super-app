// PBJT monthly recap CSV export (bead in4m, CTO decision option 3; brief
// docs/briefs/in4m-pbjt-export.md). Fail-first: `exportPbjtMonthlyRecap`,
// `pbjtRecapToCsv`, `pbjtExportFileName`, the export schemas and the
// `tax_report_exports` table do not exist yet.
//
// Written from the brief and the shared contract only. Assumptions:
// - `exportPbjtMonthlyRecap` is exported from services/tax.service (the brief's
//   first choice); the call is (runtime, context, actorUserId, body, now).
// - `rowCount` counts recap rows (one per rule code), not CSV lines.
// - The audit row has event.action "tax.pbjt_export.created" and
//   event.objectId = the export id (same shape as tax_rule.published).
// - The CSV header is exactly "code,rate,transactions,gross,base,service,tax"
//   (the brief calls them fixed English labels). The label of the total row is
//   not pinned: only its numeric cells are asserted.
// - A bad period fails as a 422 (HttpError) or a ZodError (the route maps it).
// - Other tenant / other outlet is refused with 403 (404 accepted for tenants).
// - A DB failure is forced with a BEFORE INSERT trigger on tax_report_exports
//   that raises for one idempotency key.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  type BusinessDate,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  calculateTax,
  cafeLegendTaxFixtures,
  pbjtExportFileName,
  pbjtExportRequestSchema,
  pbjtExportResultSchema,
  pbjtRecapToCsv,
  type PbjtMonthlyRecap,
} from "@starter/shared/tax";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { exportPbjtMonthlyRecap } from "../services/tax-pbjt-export.service";
import {
  getPbjtMonthlyRecap,
  recordTaxSnapshots,
} from "../services/tax.service";

const seeded = cafeLegendPlatformFixtures.tenant;
const [outletA, outletB] = cafeLegendPlatformFixtures.outlets;
const taxFixtures = cafeLegendTaxFixtures;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");

const tenantB = randomUUID() as TenantId;
const admin = randomUUID(); // tenant-wide: manage
const noManage = randomUUID(); // tenant-wide: config only
const managerA = randomUUID(); // manage on outlet A only
const managerB = randomUUID(); // manage on outlet B only
const adminOfB = randomUUID(); // tenant B admin
const allUsers = [admin, noManage, managerA, managerB, adminOfB];

// Periods no other test file writes (the suite shares one database).
const P_MAIN = "2051-01";
const P_LINK_FINAL = "2051-02";
const P_LINK_DRAFT = "2051-03";
const P_FAIL = "2051-04";
const P_HISTORY = "2051-05";
const P_EMPTY = "2051-06";
const P_REPLAY = "2051-07";
const P_PERM = "2051-08";
const P_BAD = "2051-09";

function tenantContext(tenantId: TenantId) {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}
function outletContext(tenantId: TenantId, outletId: string) {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
}

// ---- Fake storage ------------------------------------------------------------

type PutInput = {
  tenantId: string;
  outletId?: string | null;
  key: string;
  reference?: string;
  contentType?: string;
  visibility?: string;
  content: string;
};

/** Records uploads, tracks live files (puts minus deletes), signs URLs freshly. */
class RecordingStorage extends FakeObjectStorage {
  puts: PutInput[] = [];
  files = new Map<string, string>();
  signed = 0;
  override async put(
    ...args: Parameters<FakeObjectStorage["put"]>
  ): ReturnType<FakeObjectStorage["put"]> {
    const result = await super.put(...args);
    const input = args[1] as unknown as Omit<PutInput, "content"> & {
      content: string | Uint8Array;
    };
    const content =
      typeof input.content === "string"
        ? input.content
        : new TextDecoder().decode(input.content);
    this.puts.push({ ...input, content });
    this.files.set(input.key, content);
    return result;
  }
  override async delete(
    ...args: Parameters<FakeObjectStorage["delete"]>
  ): Promise<void> {
    await super.delete(...args);
    this.files.delete((args[1] as unknown as { key: string }).key);
  }
  override async signedGetUrl(
    ...args: Parameters<FakeObjectStorage["signedGetUrl"]>
  ): Promise<string> {
    return `${await super.signedGetUrl(...args)}&sig=${++this.signed}`;
  }
}

const makeRuntime = () => {
  const storage = new RecordingStorage();
  return { storage, runtime: { storage } };
};

// ---- Database helpers --------------------------------------------------------

async function asTenantOwner<T>(
  tenantId: string,
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

async function grantRole(
  tenantId: string,
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      roleId,
      tenantId,
      `Pbjt export ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope.type]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

const sourceIds: string[] = [];
// Rows this file inserts outside the service, removed in afterAll.
const reportIds: string[] = [];
const extraEntityIds: string[] = [];
const taxPerBill = calculateTax(taxFixtures.privateRoomBill, {
  taxRules: taxFixtures.taxRules,
  serviceChargeRules: taxFixtures.serviceChargeRules,
  settings: taxFixtures.settings,
}).taxes.reduce((total, entry) => total + entry.taxIdr, 0);

/** Records `bills` PBJT bills on outlet B in `period`; returns the tax total. */
async function seedBills(period: string, bills = 2): Promise<number> {
  const context = tenantContext(seeded.id);
  const result = calculateTax(taxFixtures.privateRoomBill, {
    taxRules: taxFixtures.taxRules,
    serviceChargeRules: taxFixtures.serviceChargeRules,
    settings: taxFixtures.settings,
  });
  for (let i = 0; i < bills; i += 1) {
    const sourceId = randomUUID();
    sourceIds.push(sourceId);
    await withTenant(db, context, (tx) =>
      recordTaxSnapshots(tx, context, {
        sourceType: "order",
        sourceId,
        outletId: outletB.id,
        businessDate: `${period}-15` as BusinessDate,
        result,
      }),
    );
  }
  return taxPerBill * bills;
}

const outletEntity = async (outletId: string) =>
  (
    await owner.query<{ legal_entity_id: string }>(
      "SELECT legal_entity_id FROM outlets WHERE id = $1",
      [outletId],
    )
  ).rows[0]!.legal_entity_id;

async function insertTaxReport(
  entity: string,
  period: string,
  status: "draft" | "final",
  amountIdr: number,
) {
  const id = randomUUID();
  reportIds.push(id);
  const filed = status !== "draft";
  await asTenantOwner(seeded.id, (client) =>
    client.query(
      `INSERT INTO tax_reports
         (id, tenant_id, legal_entity_id, type, period, amount_idr, lines, status,
          generated_by, finalized_by, finalized_at, revision_no, fiscal_period_version)
       VALUES ($1, $2, $3, 'pbjt', $4, $5, '[]'::jsonb, $6, $7, $8,
               ${filed ? "now()" : "NULL"}, ${filed ? "0" : "NULL"}, 1)`,
      [
        id,
        seeded.id,
        entity,
        period,
        amountIdr,
        status,
        admin,
        filed ? admin : null,
      ],
    ),
  );
  return id;
}

const taxReportRow = (id: string) =>
  asTenantOwner(
    seeded.id,
    async (client) =>
      (
        await client.query(
          "SELECT to_jsonb(r) AS row FROM tax_reports r WHERE id = $1",
          [id],
        )
      ).rows[0]!.row,
  );

type ExportRow = {
  id: string;
  tax_report_id: string | null;
  outlet_id: string;
  legal_entity_id: string;
  type: string;
  period: string;
  format: string;
  amount_idr: string;
  row_count: number;
  file_key: string;
  file_name: string;
  idempotency_key: string;
  generated_by: string;
};

const exportRows = (period: string, outletId: string = outletB.id) =>
  asTenantOwner(
    seeded.id,
    async (client) =>
      (
        await client.query<ExportRow>(
          `SELECT * FROM tax_report_exports
          WHERE tenant_id = $1 AND outlet_id = $2 AND period = $3
          ORDER BY generated_at, id`,
          [seeded.id, outletId, period],
        )
      ).rows,
  );

const auditCount = (exportId: string) =>
  asTenantOwner(seeded.id, async (client) =>
    Number(
      (
        await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM audit_logs
            WHERE tenant_id = $1 AND event->>'action' = 'tax.pbjt_export.created'
              AND event->>'objectId' = $2`,
          [seeded.id, exportId],
        )
      ).rows[0]!.n,
    ),
  );

const auditAfter = (exportId: string) =>
  asTenantOwner(seeded.id, async (client) =>
    (
      await client.query<{ after: Record<string, unknown> }>(
        `SELECT event->'maskedChanges'->'after' AS after FROM audit_logs
          WHERE tenant_id = $1 AND event->>'action' = 'tax.pbjt_export.created'
            AND event->>'objectId' = $2`,
        [seeded.id, exportId],
      )
    ).rows.map((row) => row.after),
  );

// ---- Service + CSV helpers -----------------------------------------------------

const exportIt = (
  runtime: { storage: RecordingStorage },
  context: ReturnType<typeof tenantContext>,
  user: string,
  body: Record<string, unknown>,
  now = new Date("2051-02-01T03:00:00Z"),
) =>
  (
    exportPbjtMonthlyRecap as unknown as (
      ...args: unknown[]
    ) => ReturnType<typeof exportPbjtMonthlyRecap>
  )(runtime, context, user, body, now);

const bodyFor = (period: string, key = `exp-${randomUUID()}`) => ({
  outletId: outletB.id,
  period,
  idempotencyKey: key,
});

const recapOf = (period: string) =>
  getPbjtMonthlyRecap(
    tenantContext(seeded.id),
    admin as never,
    {
      outletId: outletB.id,
      period,
    } as never,
  );

async function errorOf(run: Promise<unknown>) {
  try {
    await run;
    return null;
  } catch (error) {
    return error as { status?: number; code?: string; name?: string };
  }
}

/** Minimal RFC 4180 reader: quoted cells may hold commas, quotes and CR/LF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const HEADER = [
  "code",
  "rate",
  "transactions",
  "gross",
  "base",
  "service",
  "tax",
];

// ---- Setup -----------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Pbjt export tenant B', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantB, `pbjtx-${tenantB}`, adminOfB],
  );
  for (const id of allUsers)
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Pbjt export', $2)`,
      [id, `${id}@example.test`],
    );
  await grantRole(
    seeded.id,
    admin,
    ["org.tax_config.manage", "accounting.tax_report.manage"],
    { type: "tenant" },
  );
  await grantRole(seeded.id, noManage, ["org.tax_config.manage"], {
    type: "tenant",
  });
  await grantRole(seeded.id, managerA, ["accounting.tax_report.manage"], {
    type: "outlet",
    id: outletA.id,
  });
  await grantRole(seeded.id, managerB, ["accounting.tax_report.manage"], {
    type: "outlet",
    id: outletB.id,
  });
  await grantRole(tenantB, adminOfB, ["accounting.tax_report.manage"], {
    type: "tenant",
  });
});

afterAll(async () => {
  await asTenantOwner(seeded.id, async (client) => {
    // Filed tax reports are locked by a trigger; the FK-free replica role lets
    // this cleanup delete them. Order is still exports, reports, entities.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM tax_report_exports WHERE tenant_id = $1 AND period LIKE '2051-%'",
      [seeded.id],
    );
    await client.query(
      "DELETE FROM tax_reports WHERE tenant_id = $1 AND id = ANY($2)",
      [seeded.id, reportIds],
    );
    await client.query(
      "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = ANY($2)",
      [seeded.id, extraEntityIds],
    );
    await client.query(
      "DELETE FROM tax_snapshots WHERE tenant_id = $1 AND source_id = ANY($2)",
      [seeded.id, sourceIds],
    );
    await client.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      allUsers,
    ]);
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND name LIKE 'Pbjt export %'",
      [seeded.id],
    );
  });
  await asTenantOwner(tenantB, async (client) => {
    await client.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
      tenantB,
    ]);
    await client.query("DELETE FROM roles WHERE tenant_id = $1", [tenantB]);
  });
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [allUsers]);
  await owner.end();
});

// ================================================================================

describe("in4m pbjtRecapToCsv (pure, shared)", () => {
  const recap = (rows: Partial<PbjtMonthlyRecap["rows"][number]>[]) => {
    const full = rows.map((row, i) => ({
      taxRuleCode: `PBJT-${i}`,
      rateBp: 1000,
      transactionCount: 3 + i,
      grossSalesIdr: 100_000 + i,
      taxBaseIdr: 90_000 + i,
      serviceChargeIdr: 5_000 + i,
      taxIdr: 9_000 + i,
      ...row,
    }));
    return {
      tenantId: seeded.id,
      outletId: outletB.id,
      period: "2051-01",
      regionCode: null,
      generatedAt: "2051-02-01T00:00:00.000Z",
      rows: full,
      totalTaxBaseIdr: full.reduce((s, r) => s + r.taxBaseIdr, 0),
      totalTaxIdr: full.reduce((s, r) => s + r.taxIdr, 0),
    } as unknown as PbjtMonthlyRecap;
  };

  it("renders a header, one line per recap row and a total row, CRLF, no BOM", () => {
    const input = recap([{}, { taxRuleCode: "PBJT-X" }]);
    const csv = pbjtRecapToCsv(input);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    const lines = parseCsv(csv);
    expect(lines).toHaveLength(1 + input.rows.length + 1);
    expect(lines[0]).toEqual(HEADER);
    input.rows.forEach((row, i) =>
      expect(lines[i + 1]).toEqual([
        row.taxRuleCode,
        String(row.rateBp),
        String(row.transactionCount),
        String(row.grossSalesIdr),
        String(row.taxBaseIdr),
        String(row.serviceChargeIdr),
        String(row.taxIdr),
      ]),
    );
    const total = lines.at(-1)!;
    expect(total).toHaveLength(7);
    expect(total[0]).not.toBe("");
    expect(total[2]).toBe(
      String(input.rows.reduce((s, r) => s + r.transactionCount, 0)),
    );
    expect(total[3]).toBe(
      String(input.rows.reduce((s, r) => s + r.grossSalesIdr, 0)),
    );
    expect(total[4]).toBe(String(input.totalTaxBaseIdr));
    expect(total[5]).toBe(
      String(input.rows.reduce((s, r) => s + r.serviceChargeIdr, 0)),
    );
    expect(total[6]).toBe(String(input.totalTaxIdr));
  });

  it("an empty recap is the header plus a zero total row", () => {
    const lines = parseCsv(pbjtRecapToCsv(recap([])));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(HEADER);
    expect(lines[1]![4]).toBe("0");
    expect(lines[1]![6]).toBe("0");
  });

  it("guards formula-injection cells with a leading apostrophe", () => {
    const csv = pbjtRecapToCsv(
      recap([
        { taxRuleCode: "=SUM(1)" },
        { taxRuleCode: "+CMD" },
        { taxRuleCode: "-CMD" },
        { taxRuleCode: "@CMD" },
        { taxRuleCode: "\tCMD" },
        { taxRuleCode: "\rCMD" },
        { taxRuleCode: "SAFE-1" },
      ]),
    );
    const cells = parseCsv(csv)
      .slice(1, 8)
      .map((line) => line[0]);
    expect(cells).toEqual([
      "'=SUM(1)",
      "'+CMD",
      "'-CMD",
      "'@CMD",
      "'\tCMD",
      "'\rCMD",
      "SAFE-1",
    ]);
  });

  it("names the file pbjt-<period>-<first 8 of outlet id>.csv", () => {
    expect(pbjtExportFileName("2051-01", outletB.id)).toBe(
      `pbjt-2051-01-${outletB.id.slice(0, 8)}.csv`,
    );
  });
});

describe("in4m export request/result contract", () => {
  it("accepts a valid request and rejects a bad period or extra keys", () => {
    const ok = {
      outletId: outletB.id,
      period: "2051-01",
      idempotencyKey: randomUUID(),
    };
    expect(pbjtExportRequestSchema.safeParse(ok).success).toBe(true);
    for (const period of ["2051-13", "2051-1", "205101", "2051-00", ""])
      expect(pbjtExportRequestSchema.safeParse({ ...ok, period }).success).toBe(
        false,
      );
    expect(pbjtExportRequestSchema.safeParse({ ...ok, extra: 1 }).success).toBe(
      false,
    );
    expect(
      pbjtExportRequestSchema.safeParse({ ...ok, idempotencyKey: undefined })
        .success,
    ).toBe(false);
  });
});

describe("in4m exportPbjtMonthlyRecap", () => {
  it("exports a CSV whose total equals the recap total and the stored row", async () => {
    const expectedTax = await seedBills(P_MAIN, 2);
    const { storage, runtime } = makeRuntime();
    const body = bodyFor(P_MAIN);
    const result = await exportIt(
      runtime,
      tenantContext(seeded.id),
      admin,
      body,
    );
    const parsed = pbjtExportResultSchema.parse(result);
    const recap = await recapOf(P_MAIN);

    expect(recap.rows.length).toBeGreaterThan(0);
    expect(recap.totalTaxIdr).toBe(expectedTax);
    expect(parsed.outletId).toBe(outletB.id);
    expect(parsed.period).toBe(P_MAIN);
    expect(parsed.amountIdr).toBe(recap.totalTaxIdr);
    expect(parsed.rowCount).toBe(recap.rows.length);
    expect(parsed.fileName).toBe(pbjtExportFileName(P_MAIN, outletB.id));
    expect(parsed.fileKey).toBe(
      `tax-report-exports/${parsed.exportId}/${parsed.fileName}`,
    );
    expect(parsed.downloadUrl).toMatch(/^https?:\/\//);
    expect(Date.parse(parsed.expiresAt)).toBeGreaterThan(Date.now());
    expect(parsed.taxReportId).toBeNull(); // no filed report in this period

    // Stored file == the shared CSV of the recap, rendered once.
    expect(storage.puts).toHaveLength(1);
    const put = storage.puts[0]!;
    expect(put.key).toBe(parsed.fileKey);
    expect(put.tenantId).toBe(seeded.id);
    expect(put.outletId).toBe(outletB.id);
    expect(put.reference).toBe(parsed.exportId);
    expect(put.contentType).toBe("text/csv; charset=utf-8");
    expect(put.visibility ?? "private").toBe("private");
    expect(put.content).toBe(pbjtRecapToCsv(recap));

    // Rows in the file match the recap rows; the total row matches the totals.
    const lines = parseCsv(put.content);
    expect(lines[0]).toEqual(HEADER);
    expect(lines).toHaveLength(recap.rows.length + 2);
    recap.rows.forEach((row, i) =>
      expect(lines[i + 1]).toEqual([
        row.taxRuleCode,
        String(row.rateBp),
        String(row.transactionCount),
        String(row.grossSalesIdr),
        String(row.taxBaseIdr),
        String(row.serviceChargeIdr),
        String(row.taxIdr),
      ]),
    );
    const total = lines.at(-1)!;
    expect(Number(total[6])).toBe(recap.totalTaxIdr);
    expect(Number(total[4])).toBe(recap.totalTaxBaseIdr);

    // One history row, same amount as the CSV total and the recap.
    const rows = await exportRows(P_MAIN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: parsed.exportId,
      type: "pbjt",
      period: P_MAIN,
      format: "csv",
      row_count: recap.rows.length,
      file_key: parsed.fileKey,
      file_name: parsed.fileName,
      idempotency_key: body.idempotencyKey,
      generated_by: admin,
      legal_entity_id: await outletEntity(outletB.id),
    });
    expect(Number(rows[0]!.amount_idr)).toBe(recap.totalTaxIdr);
    expect(Number(total[6])).toBe(Number(rows[0]!.amount_idr));
    expect(await auditCount(parsed.exportId)).toBe(1);
    // The audit row keeps the amount readable (not [REDACTED]).
    const [auditAfterRow] = await auditAfter(parsed.exportId);
    expect(auditAfterRow).toMatchObject({
      period: P_MAIN,
      amountIdr: recap.totalTaxIdr,
      rowCount: recap.rows.length,
    });
    expect(auditAfterRow!.amountIdr).toBe(Number(rows[0]!.amount_idr));
  });

  it("idempotent replay returns the same export with a fresh URL and no new file", async () => {
    await seedBills(P_REPLAY, 1);
    const { storage, runtime } = makeRuntime();
    const body = bodyFor(P_REPLAY);
    const first = await exportIt(
      runtime,
      tenantContext(seeded.id),
      admin,
      body,
    );
    const second = await exportIt(
      runtime,
      tenantContext(seeded.id),
      admin,
      body,
    );

    expect(second.exportId).toBe(first.exportId);
    expect(second.fileKey).toBe(first.fileKey);
    expect(second.amountIdr).toBe(first.amountIdr);
    expect(second.downloadUrl).not.toBe(first.downloadUrl);
    expect(pbjtExportResultSchema.safeParse(second).success).toBe(true);
    expect(storage.puts).toHaveLength(1);
    expect(storage.files.size).toBe(1);
    expect(await exportRows(P_REPLAY)).toHaveLength(1);
    expect(await auditCount(first.exportId)).toBe(1);
  });

  it("a new idempotency key is a new history row and a new file", async () => {
    await seedBills(P_HISTORY, 1);
    const { storage, runtime } = makeRuntime();
    const first = await exportIt(
      runtime,
      tenantContext(seeded.id),
      admin,
      bodyFor(P_HISTORY),
    );
    const second = await exportIt(
      runtime,
      tenantContext(seeded.id),
      admin,
      bodyFor(P_HISTORY),
    );
    expect(second.exportId).not.toBe(first.exportId);
    expect(second.fileKey).not.toBe(first.fileKey);
    expect(second.amountIdr).toBe(first.amountIdr);
    expect(storage.files.size).toBe(2);
    const rows = await exportRows(P_HISTORY);
    expect(rows.map((row) => row.id).sort()).toEqual(
      [first.exportId, second.exportId].sort(),
    );
  });

  it("links to the current non-draft pbjt tax report of the outlet's legal entity and leaves it unchanged", async () => {
    await seedBills(P_LINK_FINAL, 1);
    const entity = await outletEntity(outletB.id);
    const reportId = await insertTaxReport(
      entity,
      P_LINK_FINAL,
      "final",
      12_345,
    );
    const before = await taxReportRow(reportId);
    const { runtime } = makeRuntime();
    const result = await exportIt(
      runtime,
      tenantContext(seeded.id),
      admin,
      bodyFor(P_LINK_FINAL),
    );
    expect(result.taxReportId).toBe(reportId);
    const rows = await exportRows(P_LINK_FINAL);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tax_report_id).toBe(reportId);
    // The CSV amount is the recap total, never the filed report's amount.
    expect(Number(rows[0]!.amount_idr)).toBe(taxPerBill);
    expect(Number(rows[0]!.amount_idr)).not.toBe(12_345);
    expect(await taxReportRow(reportId)).toEqual(before);
  });

  it("leaves tax_report_id null for a draft, another legal entity, or no report", async () => {
    const entity = await outletEntity(outletB.id);
    // Draft only for this entity+period.
    const draftId = await insertTaxReport(entity, P_LINK_DRAFT, "draft", 999);
    // A filed report for the same period but a different legal entity.
    const otherEntity = randomUUID();
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, true)",
      [otherEntity, seeded.id, `Pbjt export other ${unique()}`],
    );
    extraEntityIds.push(otherEntity);
    await insertTaxReport(otherEntity, P_LINK_DRAFT, "final", 555);
    const draftBefore = await taxReportRow(draftId);

    const { runtime } = makeRuntime();
    const withDraft = await exportIt(
      runtime,
      tenantContext(seeded.id),
      admin,
      bodyFor(P_LINK_DRAFT),
    );
    expect(withDraft.taxReportId).toBeNull();
    const none = await exportIt(
      runtime,
      tenantContext(seeded.id),
      admin,
      bodyFor(P_EMPTY),
    );
    expect(none.taxReportId).toBeNull();
    expect((await exportRows(P_LINK_DRAFT))[0]!.tax_report_id).toBeNull();
    expect((await exportRows(P_EMPTY))[0]!.tax_report_id).toBeNull();
    expect(await taxReportRow(draftId)).toEqual(draftBefore);
  });

  it("an empty period exports the header and a zero total, amount 0", async () => {
    const { storage, runtime } = makeRuntime();
    const result = await exportIt(
      runtime,
      tenantContext(seeded.id),
      admin,
      bodyFor(P_EMPTY),
    );
    expect(result.amountIdr).toBe(0);
    expect(result.rowCount).toBe(0);
    const lines = parseCsv([...storage.files.values()][0]!);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(HEADER);
    expect(lines[1]![4]).toBe("0");
    expect(lines[1]![6]).toBe("0");
    expect(Number((await exportRows(P_EMPTY)).at(-1)!.amount_idr)).toBe(0);
  });

  it("an outlet-scoped manager can export its own outlet", async () => {
    const { runtime } = makeRuntime();
    const result = await exportIt(
      runtime,
      outletContext(seeded.id, outletB.id),
      managerB,
      bodyFor(P_PERM),
    );
    expect(pbjtExportResultSchema.safeParse(result).success).toBe(true);
  });

  it("refuses a bad period with 422 and stores nothing", async () => {
    const { storage, runtime } = makeRuntime();
    for (const period of ["2051-13", "2051-1", "not-a-period"]) {
      const error = await errorOf(
        exportIt(runtime, tenantContext(seeded.id), admin, bodyFor(period)),
      );
      expect(error, period).not.toBeNull();
      if (error?.status !== undefined) expect(error.status).toBe(422);
      else expect(error?.name).toBe("ZodError");
    }
    expect(storage.puts).toHaveLength(0);
    expect(await exportRows(P_BAD)).toHaveLength(0);
  });

  it("removes the stored file when the database insert fails", async () => {
    const failKey = `fail-${randomUUID()}`;
    const name = `pbjt_export_fail_${unique()}`;
    await owner.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.idempotency_key = '${failKey}' THEN
           RAISE EXCEPTION 'forced pbjt export insert failure';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await owner.query(
      `CREATE TRIGGER ${name} BEFORE INSERT ON tax_report_exports
         FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    try {
      const { storage, runtime } = makeRuntime();
      const error = await errorOf(
        exportIt(runtime, tenantContext(seeded.id), admin, {
          ...bodyFor(P_FAIL),
          idempotencyKey: failKey,
        }),
      );
      expect(error).not.toBeNull();
      expect(storage.files.size).toBe(0);
      expect(await exportRows(P_FAIL)).toHaveLength(0);
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS ${name} ON tax_report_exports`);
      await owner.query(`DROP FUNCTION IF EXISTS ${name}()`);
    }
  });
});

describe("in4m export permission and isolation", () => {
  const expectRefused = async (
    run: Promise<unknown>,
    storage: RecordingStorage,
    statuses: number[],
  ) => {
    const before = (await exportRows(P_PERM)).length;
    const error = await errorOf(run);
    expect(error).not.toBeNull();
    expect(statuses).toContain(error!.status);
    expect(storage.puts).toHaveLength(0);
    expect((await exportRows(P_PERM)).length).toBe(before);
  };

  it("denies a user without accounting.tax_report.manage (403)", async () => {
    const { storage, runtime } = makeRuntime();
    await expectRefused(
      exportIt(runtime, tenantContext(seeded.id), noManage, bodyFor(P_PERM)),
      storage,
      [403],
    );
  });

  it("denies a manager of another outlet (403)", async () => {
    const { storage, runtime } = makeRuntime();
    await expectRefused(
      exportIt(
        runtime,
        outletContext(seeded.id, outletA.id),
        managerA,
        bodyFor(P_PERM),
      ),
      storage,
      [403],
    );
  });

  it("refuses another tenant's user for this tenant's outlet", async () => {
    const { storage, runtime } = makeRuntime();
    await expectRefused(
      exportIt(runtime, tenantContext(tenantB), adminOfB, bodyFor(P_PERM)),
      storage,
      [403, 404],
    );
  });
});

describe("in4m tax_report_exports table guard", () => {
  it("exists with FORCE RLS and no UPDATE/DELETE/TRUNCATE for legend_app", async () => {
    const { rows } = await owner.query<{
      force: boolean;
      rls: boolean;
      upd: boolean;
      del: boolean;
      trunc: boolean;
      ins: boolean;
    }>(
      `SELECT c.relforcerowsecurity AS force, c.relrowsecurity AS rls,
              has_table_privilege('legend_app', c.oid, 'UPDATE') AS upd,
              has_table_privilege('legend_app', c.oid, 'DELETE') AS del,
              has_table_privilege('legend_app', c.oid, 'TRUNCATE') AS trunc,
              has_table_privilege('legend_app', c.oid, 'INSERT') AS ins
         FROM pg_class c
        WHERE c.oid = to_regclass('public.tax_report_exports')`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      force: true,
      rls: true,
      upd: false,
      del: false,
      trunc: false,
      ins: true,
    });
  });
});
