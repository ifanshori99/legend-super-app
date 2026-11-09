// Backfill test for migration 0177 (legend-pszrm): the three UPDATE statements
// that link legacy core_storage_objects rows (no owner, no source kind) to the
// employment contract, employee document or leave request that references them.
// The statements are read from the .sql file at runtime, so the test always
// checks the shipped SQL, not a copy.
//
// The shared test database is already migrated past 0177, so the columns exist
// and every seeded row is "legacy" (null owner/kind/source) by construction.
// Everything (seed, UPDATEs, assertions) runs in ONE owner transaction that is
// rolled back at the end: nothing is left behind, and the UPDATEs (which have
// no tenant filter of their own) never persist a change to rows of other suites.
//
// Assumptions:
// - The disposable server's user is a superuser (same as
//   contract-tax-scheme-migration.test.ts), so `SET LOCAL session_replication_role
//   = replica` lets us seed employees, contracts, documents and leave requests
//   without building the whole FK chain (positions, leave types, users).
// - "One source row per object, earliest first" means: contracts by created_at,
//   documents by uploaded_at, leave requests by requested_at. Across the three
//   statements the file order wins (contract, then document, then leave),
//   because each statement only fills objects whose source_id is still null.
// - Matching a leave attachment_key to an object id is case-insensitive
//   (the SQL lower()s the key).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  createOwnerPool,
  requireDisposableDatabase,
} from "./tenant-isolation-harness.ts";

const migrationFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle/0177_storage_object_owner.sql",
);
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendPlatformFixtures.outlets[0].id;

/** The UPDATE statements of the migration, in file order, comments removed. */
function backfillStatements(): string[] {
  return readFileSync(migrationFile, "utf8")
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((sql) => /^UPDATE\s+core_storage_objects\b/i.test(sql));
}

const owner = createOwnerPool();

interface Row {
  source_kind: string | null;
  source_id: string | null;
  owner_user_id: string | null;
}

describe("migration 0177 backfill of core_storage_objects owner and source", () => {
  const statements = backfillStatements();
  const tag = randomUUID().slice(0, 8);
  const id = () => randomUUID();

  // Employees: two with a login account, one without.
  const userOne = `backfill-user-1-${tag}`;
  const userTwo = `backfill-user-2-${tag}`;
  const empOne = id();
  const empTwo = id();
  const empNoUser = id();

  // Objects.
  const objTwiceReferenced = id(); // contracts c1 (earlier) + c2, and document
  const objDocTwice = id(); // two documents, earlier one wins
  const objDocOnly = id();
  const objLeave = id();
  const objNoUser = id(); // contract of an employee with no login
  const objNonDocument = id(); // purpose 'selfie', referenced by all three
  const objAlreadyLinked = id(); // already has a source, referenced by all three
  const objUnreferenced = id();

  // Source rows.
  const contractEarly = id();
  const contractLate = id();
  const contractNoUser = id();
  const docOnly = id();
  const docEarly = id();
  const docLate = id();
  const docOnTwiceReferenced = id();
  const leaveId = id();
  const alreadyLinkedSourceId = id();

  const legacyOwner = (name: string) => `legacy-owner-${name}-${tag}`;
  const rows = new Map<string, Row>();

  async function seedObject(
    client: PoolClient,
    objectId: string,
    spec: {
      purpose?: string;
      owner?: string | null;
      kind?: string | null;
      sourceId?: string | null;
    } = {},
  ) {
    await client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          owner_user_id, source_kind, source_id)
       VALUES ($1, $2, $3, $4, $5, 'application/pdf', 1024, $6, $7, $8)`,
      [
        tenantId,
        outletId,
        objectId,
        spec.purpose ?? "document",
        `backfill-${tag}/${objectId}.pdf`,
        spec.owner ?? null,
        spec.kind ?? null,
        spec.sourceId ?? null,
      ],
    );
  }

  async function seedEmployee(
    client: PoolClient,
    employeeId: string,
    userId: string | null,
    n: number,
  ) {
    await client.query(
      `INSERT INTO employees
         (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
          employment_type, join_date)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2024-01-01')`,
      [
        employeeId,
        tenantId,
        userId,
        `BF${tag.toUpperCase()}${n}`,
        `Backfill ${n}`,
        outletId,
      ],
    );
  }

  async function seedContract(
    client: PoolClient,
    contractId: string,
    employeeId: string,
    objectId: string,
    createdAt: string,
  ) {
    await client.query(
      `INSERT INTO employment_contracts
         (id, tenant_id, employee_id, type, tax_scheme, start_date,
          reminder_days_before, status, file_object_id, created_at)
       VALUES ($1, $2, $3, 'pkwtt', 'gross', '2024-01-01', 30, 'active', $4, $5)`,
      [contractId, tenantId, employeeId, objectId, createdAt],
    );
  }

  async function seedDocument(
    client: PoolClient,
    documentId: string,
    employeeId: string,
    objectId: string,
    uploadedAt: string,
  ) {
    await client.query(
      `INSERT INTO employee_documents
         (id, tenant_id, employee_id, type, storage_object_id, uploaded_at)
       VALUES ($1, $2, $3, 'ktp', $4, $5)`,
      [documentId, tenantId, employeeId, objectId, uploadedAt],
    );
  }

  async function seedLeave(
    client: PoolClient,
    requestId: string,
    employeeId: string,
    attachmentKey: string,
  ) {
    await client.query(
      `INSERT INTO leave_requests
         (id, tenant_id, outlet_id, employee_id, leave_type_id, period_year,
          start_date, end_date, days, attachment_key, requested_by, requested_at)
       VALUES ($1, $2, $3, $4, $5, 2031, '2031-03-20', '2031-03-20', 1, $6,
               $7, '2031-03-01T00:00:00Z')`,
      [requestId, tenantId, outletId, employeeId, id(), attachmentKey, userOne],
    );
  }

  async function snapshot(client: PoolClient) {
    const ids = [
      objTwiceReferenced,
      objDocTwice,
      objDocOnly,
      objLeave,
      objNoUser,
      objNonDocument,
      objAlreadyLinked,
      objUnreferenced,
    ];
    const result = await client.query<Row & { id: string }>(
      `SELECT id::text AS id, source_kind, source_id::text AS source_id, owner_user_id
         FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenantId, ids],
    );
    rows.clear();
    for (const row of result.rows) rows.set(row.id, row);
    expect(rows.size, "all seeded objects are visible").toBe(ids.length);
  }

  let beforeBackfill: Map<string, Row>;
  let afterFirstRun: Map<string, Row>;
  let afterSecondRun: Map<string, Row>;

  beforeAll(async () => {
    requireDisposableDatabase();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await client.query("SET LOCAL session_replication_role = replica");

      await seedEmployee(client, empOne, userOne, 1);
      await seedEmployee(client, empTwo, userTwo, 2);
      await seedEmployee(client, empNoUser, null, 3);

      await seedObject(client, objTwiceReferenced, {
        owner: legacyOwner("twice"),
      });
      await seedObject(client, objDocTwice, { owner: legacyOwner("doctwice") });
      await seedObject(client, objDocOnly, { owner: legacyOwner("doconly") });
      await seedObject(client, objLeave, { owner: legacyOwner("leave") });
      await seedObject(client, objNoUser, { owner: legacyOwner("nouser") });
      await seedObject(client, objNonDocument, {
        purpose: "selfie",
        owner: legacyOwner("selfie"),
      });
      await seedObject(client, objAlreadyLinked, {
        owner: legacyOwner("linked"),
        kind: "expense",
        sourceId: alreadyLinkedSourceId,
      });
      await seedObject(client, objUnreferenced, {
        owner: legacyOwner("unreferenced"),
      });

      // One object referenced twice by contracts (employee one's is older)
      // and a third time by a document of employee two.
      await seedContract(
        client,
        contractEarly,
        empOne,
        objTwiceReferenced,
        "2024-02-01T00:00:00Z",
      );
      await seedContract(
        client,
        contractLate,
        empTwo,
        objTwiceReferenced,
        "2024-03-01T00:00:00Z",
      );
      await seedDocument(
        client,
        docOnTwiceReferenced,
        empTwo,
        objTwiceReferenced,
        "2024-01-01T00:00:00Z",
      );
      // Contract of an employee without a login account.
      await seedContract(
        client,
        contractNoUser,
        empNoUser,
        objNoUser,
        "2024-02-01T00:00:00Z",
      );
      // Documents.
      await seedDocument(
        client,
        docOnly,
        empOne,
        objDocOnly,
        "2024-05-01T00:00:00Z",
      );
      await seedDocument(
        client,
        docLate,
        empTwo,
        objDocTwice,
        "2024-06-01T00:00:00Z",
      );
      await seedDocument(
        client,
        docEarly,
        empOne,
        objDocTwice,
        "2024-04-01T00:00:00Z",
      );
      // Leave request; key stored upper-case on purpose.
      await seedLeave(client, leaveId, empTwo, objLeave.toUpperCase());

      // Non-document object and already-linked object, each referenced from
      // all three source tables.
      for (const objectId of [objNonDocument, objAlreadyLinked]) {
        await seedContract(
          client,
          id(),
          empOne,
          objectId,
          "2024-02-01T00:00:00Z",
        );
        await seedDocument(
          client,
          id(),
          empOne,
          objectId,
          "2024-02-01T00:00:00Z",
        );
        await seedLeave(client, id(), empOne, objectId);
      }

      await snapshot(client);
      beforeBackfill = new Map(rows);

      for (const sql of statements) await client.query(sql);
      await snapshot(client);
      afterFirstRun = new Map(rows);

      // Running the migration statements again must change nothing.
      for (const sql of statements) await client.query(sql);
      await snapshot(client);
      afterSecondRun = new Map(rows);
    } finally {
      // Roll back the whole fixture: seed, backfill and all.
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }, 60_000);

  afterAll(async () => {
    // Positive proof of cleanup: the rollback left no seeded object behind.
    const left = await owner.query(
      `SELECT 1 FROM core_storage_objects WHERE object_key LIKE $1`,
      [`backfill-${tag}/%`],
    );
    await owner.end();
    expect(left.rowCount).toBe(0);
  });

  it("finds exactly the three backfill UPDATE statements in the migration file", () => {
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("'employment_contract'");
    expect(statements[1]).toContain("'employee_document'");
    expect(statements[2]).toContain("'leave_request'");
  });

  it("starts from legacy rows: every seeded object has no kind and no source", () => {
    for (const [objectId, row] of beforeBackfill) {
      if (objectId === objAlreadyLinked) continue;
      expect([objectId, row.source_kind, row.source_id]).toEqual([
        objectId,
        null,
        null,
      ]);
    }
  });

  it("links a contract file to its contract and the employee's login account", () => {
    const row = afterFirstRun.get(objTwiceReferenced)!;
    expect(row.source_kind).toBe("employment_contract");
    expect(row.owner_user_id).toBe(userOne);
    // Never the later contract, never the document that also references it.
    expect(row.source_id).toBe(contractEarly);
    expect(row.source_id).not.toBe(contractLate);
    expect(row.source_id).not.toBe(docOnTwiceReferenced);
  });

  it("links an employee document to the document and its employee's login", () => {
    expect(afterFirstRun.get(objDocOnly)).toMatchObject({
      source_kind: "employee_document",
      source_id: docOnly,
      owner_user_id: userOne,
    });
  });

  it("uses the earliest document when two documents reference one object", () => {
    expect(afterFirstRun.get(objDocTwice)).toMatchObject({
      source_kind: "employee_document",
      source_id: docEarly,
      owner_user_id: userOne,
    });
  });

  it("links a leave attachment (key matched case-insensitively) to the leave request and requester", () => {
    expect(afterFirstRun.get(objLeave)).toMatchObject({
      source_kind: "leave_request",
      source_id: leaveId,
      owner_user_id: userTwo,
    });
  });

  it("keeps the stored owner when the employee has no login account", () => {
    expect(afterFirstRun.get(objNoUser)).toMatchObject({
      source_kind: "employment_contract",
      source_id: contractNoUser,
      owner_user_id: legacyOwner("nouser"),
    });
  });

  it("leaves a non-document object untouched even when all three tables reference it", () => {
    expect(afterFirstRun.get(objNonDocument)).toEqual(
      beforeBackfill.get(objNonDocument),
    );
    expect(afterFirstRun.get(objNonDocument)).toMatchObject({
      source_kind: null,
      source_id: null,
      owner_user_id: legacyOwner("selfie"),
    });
  });

  it("leaves an already-linked object untouched", () => {
    expect(afterFirstRun.get(objAlreadyLinked)).toEqual({
      ...beforeBackfill.get(objAlreadyLinked),
      source_kind: "expense",
      source_id: alreadyLinkedSourceId,
      owner_user_id: legacyOwner("linked"),
    });
  });

  it("leaves an object nothing references untouched", () => {
    expect(afterFirstRun.get(objUnreferenced)).toMatchObject({
      source_kind: null,
      source_id: null,
      owner_user_id: legacyOwner("unreferenced"),
    });
  });

  it("is idempotent: a second run changes no row", () => {
    expect(afterSecondRun).toEqual(afterFirstRun);
  });
});
