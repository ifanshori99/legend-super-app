import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";
// Migration test for 0217_profit_share with pre-existing shareholder documents.
// Before 0217, shareholder_documents.profit_entity_id (0072) was an opaque uuid
// placeholder with no table behind it, so a database that already holds a
// legitimate document must still upgrade: 0217 backfills a profit_entities row
// per legacy id (keeping the id, so no document is rewritten or deleted) and
// only then adds the foreign keys. A tenant that has documents but no legal
// entity at all cannot be mapped and must fail with a clear message. The
// scratch databases live on the disposable test server and are dropped in
// afterAll; the shared test database and the real journal are never touched.
import { randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
const firstProfitShareIdx = 217;

function urlFor(database: string) {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  return url.toString();
}

// Refuse to create databases on anything but the disposable test server.
function assertDisposableServer() {
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error(
      "Run this suite through pnpm test so it gets the disposable PostgreSQL server.",
    );
}

// Temp copy of the migrations with the journal cut before 0217 (cut by idx, so
// it does not depend on position). The real folder and journal stay untouched.
function copyMigrationsBefore0217(lastIdx = firstProfitShareIdx - 1) {
  const dir = mkdtempSync(join(tmpdir(), "legend-mig-pre0217-"));
  const before = join(dir, "drizzle");
  cpSync(drizzleFolder, before, { recursive: true });
  const journalPath = join(before, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return { dir, before };
}

type Tenant = { id: string; brandId: string };

async function makeTenant(scratch: Pool): Promise<Tenant> {
  const id = randomUUID();
  const brandId = randomUUID();
  await scratch.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji 0217', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-0217-${id.slice(0, 8)}`,
      JSON.stringify({ modules: ["accounting"], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 50,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await scratch.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, id],
  );
  return { id, brandId };
}

async function makeLegalEntity(scratch: Pool, tenant: Tenant, name: string) {
  const id = randomUUID();
  await scratch.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [id, tenant.id, name],
  );
  return id;
}

async function makeOutlet(
  scratch: Pool,
  tenant: Tenant,
  legalEntityId: string,
  code: string,
) {
  const id = randomUUID();
  await scratch.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet 0217', 'Jl. 0217', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [id, tenant.id, tenant.brandId, legalEntityId, code],
  );
  return id;
}

// One uploaded file plus the document that points at it, both carrying the
// legacy profit_entity_id.
async function makeDocument(
  scratch: Pool,
  tenant: Tenant,
  legacyEntityId: string,
  createdAt: string,
  uploader: string,
) {
  const fileKey = `docs/${randomUUID()}.pdf`;
  await scratch.query(
    `INSERT INTO shareholder_document_files (tenant_id, profit_entity_id, file_key, content_type, size_bytes, uploaded_by, created_at)
     VALUES ($1, $2, $3, 'application/pdf', 1024, $4, $5)`,
    [tenant.id, legacyEntityId, fileKey, uploader, createdAt],
  );
  await scratch.query(
    `INSERT INTO shareholder_documents (tenant_id, profit_entity_id, kind, title, file_key, visibility, created_by, created_at)
     VALUES ($1, $2, 'other', 'Dokumen lama', $3, 'management', $4, $5)`,
    [tenant.id, legacyEntityId, fileKey, uploader, createdAt],
  );
  return fileKey;
}

describe("0217_profit_share on a database that already holds shareholder documents", () => {
  const scratchName = `ps0217_docs_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let scratch: Pool;
  let workDir: string;

  let tenant: Tenant;
  let legalEntityA: string;
  let legalEntityB: string;
  let outletId: string;
  let randomLegacyId: string;
  let outletFileKey: string;
  let randomFileKey: string;

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${scratchName}`);
    scratch = new Pool({ connectionString: urlFor(scratchName), max: 2 });
    const copy = copyMigrationsBefore0217();
    workDir = copy.dir;
    await migrate(drizzle(scratch), { migrationsFolder: copy.before });

    tenant = await makeTenant(scratch);
    // Two legal entities: the earliest one is the fallback home of an
    // unmapped legacy id, the second proves "earliest" is what gets picked.
    legalEntityA = await makeLegalEntity(scratch, tenant, "PT Pertama");
    legalEntityB = await makeLegalEntity(scratch, tenant, "PT Kedua");
    outletId = await makeOutlet(scratch, tenant, legalEntityB, "OUT-A");
    randomLegacyId = randomUUID();
    // The outlet-id document is the later upload; the random-id one is first.
    randomFileKey = await makeDocument(
      scratch,
      tenant,
      randomLegacyId,
      "2026-01-05T00:00:00Z",
      "uploader-random",
    );
    outletFileKey = await makeDocument(
      scratch,
      tenant,
      outletId,
      "2026-02-05T00:00:00Z",
      "uploader-outlet",
    );
  }, 180_000);

  afterAll(async () => {
    if (scratch) await endTestPool(scratch);
    if (admin) {
      try {
        await dropTestDatabase(admin, scratchName);
      } finally {
        await endTestPool(admin);
      }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("starts before 0217 with legacy documents in place", async () => {
    const exists = await scratch.query(
      "SELECT to_regclass('public.profit_entities') AS name",
    );
    expect(exists.rows[0].name).toBeNull();
    const docs = await scratch.query(
      "SELECT count(*)::int AS n FROM shareholder_documents",
    );
    expect(docs.rows[0].n).toBe(2);
  });

  it("applies the full migration folder on top without error", async () => {
    await expect(
      migrate(drizzle(scratch), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
  }, 180_000);

  it("keeps every document and file untouched", async () => {
    const docs = await scratch.query(
      `SELECT file_key, profit_entity_id FROM shareholder_documents ORDER BY created_at`,
    );
    // Order-insensitive: rows seeded back to back share a created_at window.
    expect(docs.rows).toHaveLength(2);
    expect(docs.rows).toEqual(
      expect.arrayContaining([
        { file_key: randomFileKey, profit_entity_id: randomLegacyId },
        { file_key: outletFileKey, profit_entity_id: outletId },
      ]),
    );
    const files = await scratch.query(
      `SELECT file_key, profit_entity_id FROM shareholder_document_files ORDER BY created_at`,
    );
    expect(files.rows).toHaveLength(2);
    expect(files.rows).toEqual(
      expect.arrayContaining([
        { file_key: randomFileKey, profit_entity_id: randomLegacyId },
        { file_key: outletFileKey, profit_entity_id: outletId },
      ]),
    );
  });

  it("backfills a profit entity per legacy id, keeping the id", async () => {
    const rows = await scratch.query(
      `SELECT id, type, outlet_id, legal_entity_id, is_active, name, created_by
         FROM profit_entities WHERE tenant_id = $1 ORDER BY type`,
      [tenant.id],
    );
    expect(rows.rows).toHaveLength(2);
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));

    // Legacy id equal to an outlet id: an outlet profit entity, kept active.
    expect(byId[outletId]).toMatchObject({
      type: "outlet",
      outlet_id: outletId,
      legal_entity_id: null,
      is_active: true,
      created_by: "uploader-outlet",
    });

    // Opaque legacy id: attached to the earliest legal entity, inactive, and
    // named after the first 8 characters of the legacy id.
    expect(byId[randomLegacyId]).toMatchObject({
      type: "legal_entity",
      legal_entity_id: legalEntityA,
      outlet_id: null,
      is_active: false,
      name: `Entitas lama ${randomLegacyId.slice(0, 8)}`,
      created_by: "uploader-random",
    });
  });

  it("holds the profit_entity_id foreign keys on both tables", async () => {
    const fks = await scratch.query(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('shareholder_documents_profit_entity_fk', 'shareholder_document_files_profit_entity_fk')
          AND convalidated`,
    );
    expect(fks.rows).toHaveLength(2);
    await expect(
      scratch.query(
        `INSERT INTO shareholder_document_files (tenant_id, profit_entity_id, file_key, content_type, size_bytes, uploaded_by)
         VALUES ($1, $2, 'docs/orphan.pdf', 'application/pdf', 1, 'x')`,
        [tenant.id, randomUUID()],
      ),
    ).rejects.toThrow(/profit_entity_fk/);
  });

  it("restores forced RLS on the document tables", async () => {
    const flags = await scratch.query(
      `SELECT relname, relforcerowsecurity FROM pg_class
        WHERE oid IN ('public.shareholder_documents'::regclass, 'public.shareholder_document_files'::regclass)
        ORDER BY relname`,
    );
    expect(flags.rows).toEqual([
      { relname: "shareholder_document_files", relforcerowsecurity: true },
      { relname: "shareholder_documents", relforcerowsecurity: true },
    ]);
  });
});

describe("0217_profit_share when a tenant has documents but no legal entity", () => {
  const scratchName = `ps0217_noent_${randomBytes(6).toString("hex")}`;
  let admin: Pool;
  let scratch: Pool;
  let workDir: string;

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${scratchName}`);
    scratch = new Pool({ connectionString: urlFor(scratchName), max: 2 });
    const copy = copyMigrationsBefore0217();
    workDir = copy.dir;
    await migrate(drizzle(scratch), { migrationsFolder: copy.before });
    const tenant = await makeTenant(scratch);
    await makeDocument(
      scratch,
      tenant,
      randomUUID(),
      "2026-01-05T00:00:00Z",
      "uploader",
    );
  }, 180_000);

  afterAll(async () => {
    if (scratch) await endTestPool(scratch);
    if (admin) {
      try {
        await dropTestDatabase(admin, scratchName);
      } finally {
        await endTestPool(admin);
      }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("fails with a clear message instead of orphaning the documents", async () => {
    await expect(
      migrate(drizzle(scratch), { migrationsFolder: drizzleFolder }),
    ).rejects.toThrow(/no legal entity/);
  }, 180_000);
});

// A plain (non-superuser) table owner is how production migrates (0068). Once
// it has lost BYPASSRLS, FORCE ROW LEVEL SECURITY applies to it, and with no
// app.tenant_id set the backfill's read of outlets and legal_entities would
// raise 42501 unless 0217 lifts FORCE on them first. Older migrations still
// need BYPASSRLS (migrator-role.ts), so the owner starts with it, migrates up
// to 0216, and gives it up before 0217 and everything after it run.
describe("0217_profit_share with a non-superuser table owner", () => {
  const ownerRole = `ps0217_owner_${randomBytes(6).toString("hex")}`;
  const ownerPassword = randomBytes(16).toString("hex");
  const scratchName = `ps0217_own_${randomBytes(6).toString("hex")}`;
  let admin: Pool; // superuser, default database
  let adminInScratch: Pool; // superuser, the owner's database
  let owner: Pool; // the plain table owner, the migrator
  let workDir: string;
  let tenant: Tenant;
  let legalEntityA: string;
  let outletId: string;
  let randomLegacyId: string;

  beforeAll(async () => {
    assertDisposableServer();
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    // Generated names and hex passwords: interpolation into DDL is safe.
    await admin.query(
      `CREATE ROLE ${ownerRole} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER BYPASSRLS CREATEROLE NOCREATEDB`,
    );
    // legend_payout (drizzle/0644) is cluster-wide and already exists, created by
    // the bootstrap superuser; the migrator manages it through ADMIN OPTION only,
    // as provisionMigrator gives it in production (db/migrator-role.ts).
    await admin.query(
      `GRANT legend_payout TO ${ownerRole} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
    );
    await admin.query(`CREATE DATABASE ${scratchName} OWNER ${ownerRole}`);
    adminInScratch = new Pool({
      connectionString: urlFor(scratchName),
      max: 2,
    });
    const ownerUrl = new URL(urlFor(scratchName));
    ownerUrl.username = ownerRole;
    ownerUrl.password = ownerPassword;
    owner = new Pool({ connectionString: ownerUrl.toString(), max: 1 });
    const copy = copyMigrationsBefore0217();
    workDir = copy.dir;
    await migrate(drizzle(owner), { migrationsFolder: copy.before });

    tenant = await makeTenant(adminInScratch);
    legalEntityA = await makeLegalEntity(adminInScratch, tenant, "PT Pertama");
    const legalEntityB = await makeLegalEntity(
      adminInScratch,
      tenant,
      "PT Kedua",
    );
    outletId = await makeOutlet(adminInScratch, tenant, legalEntityB, "OUT-O");
    randomLegacyId = randomUUID();
    await makeDocument(
      adminInScratch,
      tenant,
      randomLegacyId,
      "2026-01-05T00:00:00Z",
      "uploader-random",
    );
    await makeDocument(
      adminInScratch,
      tenant,
      outletId,
      "2026-02-05T00:00:00Z",
      "uploader-outlet",
    );
    await admin.query(`ALTER ROLE ${ownerRole} NOBYPASSRLS`);
  }, 180_000);

  afterAll(async () => {
    if (owner) await endTestPool(owner);
    if (adminInScratch) await endTestPool(adminInScratch);
    if (admin) {
      try {
        await dropTestDatabase(admin, scratchName);
        await admin.query(`DROP ROLE IF EXISTS ${ownerRole}`);
      } finally {
        await endTestPool(admin);
      }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("is a plain owner: not a superuser and without BYPASSRLS", async () => {
    const role = await admin.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
      [ownerRole],
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("applies the full folder (0217 through the latest) for that owner without 42501", async () => {
    await expect(
      migrate(drizzle(owner), { migrationsFolder: drizzleFolder }),
    ).resolves.not.toThrow();
  }, 180_000);

  it("backfills the legacy ids and restores forced RLS on the tables the migrations lifted", async () => {
    const rows = await adminInScratch.query(
      `SELECT id, type, legal_entity_id FROM profit_entities WHERE tenant_id = $1`,
      [tenant.id],
    );
    expect(rows.rows).toHaveLength(2);
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
    expect(byId[outletId]).toMatchObject({ type: "outlet" });
    expect(byId[randomLegacyId]).toMatchObject({
      type: "legal_entity",
      legal_entity_id: legalEntityA,
    });
    const flags = await adminInScratch.query(
      `SELECT relname, relforcerowsecurity FROM pg_class
        WHERE oid IN ('public.outlets'::regclass, 'public.legal_entities'::regclass,
                      'public.shareholders'::regclass, 'public.distribution_lines'::regclass)
        ORDER BY relname`,
    );
    expect(flags.rows).toEqual([
      { relname: "distribution_lines", relforcerowsecurity: true },
      { relname: "legal_entities", relforcerowsecurity: true },
      { relname: "outlets", relforcerowsecurity: true },
      { relname: "shareholders", relforcerowsecurity: true },
    ]);
  });
});
