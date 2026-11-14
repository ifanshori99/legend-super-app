// Test harness for the edge people snapshot (bead legend-tkycp, design
// docs/design/hris-edge-replication.md 3.3 and 9 T2). Cloud and edge normally
// share one test database, which cannot show what the edge does with its own
// older state. This creates a SECOND database on the same Postgres server:
// the same migrations, the restricted application login (RLS forced, as in
// production) and only the tenant, brand, legal entity and ONE outlet copied
// from the main test database. The "edge" is that database; the "cloud" is
// the snapshot object a test builds (or `buildEdgePeopleSnapshot` on the main
// database).
//
// Also here: builders for snapshot fixtures that pass `edgePeopleSnapshotSchema`.
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  edgePeopleSnapshotSchema,
  type EdgePeopleSnapshot,
} from "@starter/shared/edge/people-snapshot";
import { runMigrations } from "../../db/migration-session.ts";
import type { db } from "../../db/index.ts";
import { provisionRoles } from "../../db/provision-roles.ts";
import { createAppPool } from "../../db/role.ts";
import * as schema from "../../db/schema/index.ts";
import {
  mintEdgeCredential,
  parseEdgeCredential,
} from "../../edge/credential.ts";

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

export type EdgeTestDatabase = typeof db;
export type Row = Record<string, unknown>;

export type EdgeDatabase = {
  readonly name: string;
  /** Private test-only URLs for configuring a separate cloud before imports. */
  readonly ownerUrl: string;
  readonly appUrl: string;
  readonly tenantId: string;
  readonly outletId: string;
  /** Drizzle on the restricted application login: pass as `database`. */
  readonly database: EdgeTestDatabase;
  /** Superuser pool on the edge database, for seeding and assertions. */
  readonly owner: Pool;
  /** Rows of one query on the edge database (superuser, bypasses RLS). */
  rows(text: string, params?: unknown[]): Promise<Row[]>;
  /** Removes every people row, QR key and the sync state (not tenant/outlet). */
  resetPeople(): Promise<void>;
  /** Ends the pools and drops the database and the login. */
  cleanup(): Promise<void>;
};

function urlFor(base: string, db: string, user?: string, password?: string) {
  const url = new URL(base);
  url.pathname = `/${db}`;
  if (user !== undefined) url.username = user;
  if (password !== undefined) url.password = password;
  return url.toString();
}

/** Copies one row between databases with the same schema (row_to_json). */
async function copyRow(
  source: Pool,
  target: Pool,
  table: string,
  id: string,
): Promise<Row> {
  const found = await source.query<{ row: Row }>(
    `SELECT row_to_json(t) AS row FROM ${table} t WHERE id = $1`,
    [id],
  );
  const row = found.rows[0]?.row;
  if (!row)
    throw new Error(`Row ${id} of ${table} is missing in the main database`);
  const client = await target.connect();
  try {
    await client.query("BEGIN");
    // Foreign keys to tables that are not copied (regions, ...) are skipped.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO ${table} SELECT * FROM json_populate_record(NULL::${table}, $1::json)`,
      [JSON.stringify(row)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return row;
}

/** Clones an existing outlet of the main test database under a new id. */
export async function cloneMainOutlet(
  mainOwner: Pool,
  fromOutletId: string,
  label: string,
): Promise<string> {
  const id = randomUUID();
  await mainOwner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, $4, address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [id, `ED${id.slice(0, 8)}`.toUpperCase(), fromOutletId, label],
  );
  return id;
}

const PEOPLE_TABLES_FK_ORDER = [
  "session",
  "staff_pins",
  "attendance_logs",
  "shift_assignments",
  "role_assignments",
  "attendance_policies",
  "employees",
  "roles",
  "edge_attendance_qr_keys",
  "edge_people_sync_state",
  `"user"`,
] as const;

/**
 * Creates `edge_<rand>`: migrations, restricted login, and the tenant, brand,
 * legal entity and outlet rows of `outletId` copied from the main test
 * database (`STARTER_TEST_DATABASE_URL`). Slow (all migrations): call it in a
 * `beforeAll` with a long timeout.
 */
export async function createEdgeDatabase(input: {
  tenantId: string;
  outletId: string;
}): Promise<EdgeDatabase> {
  const adminBase = process.env.STARTER_TEST_DATABASE_URL;
  if (
    !adminBase ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error("Requires the disposable test database");
  const name = `edge_${randomBytes(6).toString("hex")}`;
  const login = `legend_runtime_${randomBytes(8).toString("hex")}`;
  const password = randomBytes(24).toString("hex");

  const main = new Pool({ connectionString: adminBase, max: 2 });
  await main.query(`CREATE DATABASE ${name}`);
  const ownerUrl = urlFor(adminBase, name);
  const owner = new Pool({ connectionString: ownerUrl, max: 4 });
  // DROP DATABASE ... WITH (FORCE) ends any session still open on the edge
  // database; an idle client then reports it. Nothing to handle: it is going.
  const ignoreIdleError = () => undefined;
  main.on("error", ignoreIdleError);
  owner.on("error", ignoreIdleError);
  let appPool: Pool | undefined;
  const appUrl = urlFor(adminBase, name, login, password);
  let released = false;

  const cleanup = async () => {
    if (released) return;
    released = true;
    await appPool?.end().catch(() => undefined);
    await owner.end().catch(() => undefined);
    try {
      await main.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await main.query(`DROP ROLE IF EXISTS ${login}`);
    } catch {
      // Best effort: a leftover database sits on a disposable server.
    }
    await main.end().catch(() => undefined);
  };

  try {
    await runMigrations(
      owner,
      migrationsFolder,
      { lockTimeout: "10s", statementTimeout: "0" },
      { edgeMode: true },
    );
    await provisionRoles({ adminUrl: ownerUrl, appUrl });
    appPool = createAppPool(appUrl, { max: 4 });
    appPool.on("error", ignoreIdleError);

    const outlet = await main.query<{
      brand_id: string | null;
      legal_entity_id: string | null;
    }>("SELECT brand_id, legal_entity_id FROM outlets WHERE id = $1", [
      input.outletId,
    ]);
    if (!outlet.rows[0])
      throw new Error("The outlet is missing in the main database");
    await copyRow(main, owner, "tenants", input.tenantId);
    if (outlet.rows[0].brand_id)
      await copyRow(main, owner, "brands", outlet.rows[0].brand_id);
    if (outlet.rows[0].legal_entity_id)
      await copyRow(
        main,
        owner,
        "legal_entities",
        outlet.rows[0].legal_entity_id,
      );
    await copyRow(main, owner, "outlets", input.outletId);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    name,
    ownerUrl,
    appUrl,
    tenantId: input.tenantId,
    outletId: input.outletId,
    database: drizzle(appPool, { schema }),
    owner,
    async rows(text, params = []) {
      return (await owner.query<Row>(text, params)).rows;
    },
    async resetPeople() {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        for (const table of PEOPLE_TABLES_FK_ORDER)
          await client.query(`DELETE FROM ${table}`);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    cleanup,
  };
}

// ------------------------------------------------------------------ claims

/**
 * The shared test database is cloud-style, so it carries modifiers_recipe_fk
 * (migration 0374). A real edge database does not, and startEdgeRuntime
 * refuses to boot with it (assertNoModifierRecipeFk). Tests that boot the edge
 * runtime on the shared database call this in beforeAll to simulate an edge
 * database, and call the returned function in afterAll to put the constraint
 * back for the files that run after them.
 */
export async function simulateEdgeModifierRecipeFk(db: {
  query(text: string): Promise<unknown>;
}): Promise<() => Promise<void>> {
  await db.query(
    "ALTER TABLE public.modifiers DROP CONSTRAINT IF EXISTS modifiers_recipe_fk",
  );
  return async () => {
    await db.query(
      `ALTER TABLE public.modifiers ADD CONSTRAINT modifiers_recipe_fk
         FOREIGN KEY (tenant_id, recipe_id) REFERENCES public.recipes (tenant_id, id)`,
    );
  };
}

/** The edge credential claims `applyEdgePeopleSnapshot` takes. */
export function edgeClaims(tenantId: string, outletId: string) {
  const { token } = mintEdgeCredential({
    tenantId,
    outletId,
    edgeNodeId: randomUUID(),
  });
  const claims = parseEdgeCredential(token);
  if (!claims) throw new Error("The test credential did not parse");
  return { claims, credential: token };
}

// --------------------------------------------------------------- snapshots

const WHEN = "2026-11-10T03:00:00.000Z";
const BUSINESS_DATE = "2026-11-12";

export function sealKey() {
  const { publicKey } = generateKeyPairSync("x25519");
  return {
    kid: "kid-test-1",
    publicKeyPem: publicKey
      .export({ type: "spki", format: "pem" })
      .toString()
      .trim(),
  };
}

/** Base64 of 32 random bytes: a QR day key. */
export const qrKey = (dayIndex: number) => ({
  dayIndex,
  key: randomBytes(32).toString("base64"),
});

/** Fixture rows for one (tenant, outlet) that pass the snapshot schema. */
export function peopleBuilders(scope: { tenantId: string; outletId: string }) {
  const user = (over: Row = {}): Row => {
    const id = (over.id as string | undefined) ?? randomUUID();
    return {
      id,
      name: `Staf ${id.slice(0, 8)}`,
      banned: false,
      createdAt: WHEN,
      updatedAt: WHEN,
      email: `${id}@edge.invalid`,
      emailVerified: false,
      ...over,
    };
  };
  const role = (over: Row = {}): Row => ({
    id: randomUUID(),
    tenantId: scope.tenantId,
    name: `Peran ${randomBytes(4).toString("hex")}`,
    isTemplate: false,
    templateKey: null,
    permissions: ["self.attendance.clock"],
    mfaRequired: false,
    allowedScopeTypes: ["tenant", "brand", "outlet"],
    createdAt: WHEN,
    updatedAt: WHEN,
    ...over,
  });
  const assignment = (userId: string, roleId: string, over: Row = {}): Row => ({
    id: randomUUID(),
    tenantId: scope.tenantId,
    userId,
    roleId,
    scope: { type: "outlet", id: scope.outletId },
    validFrom: WHEN,
    validUntil: null,
    // On the edge assignedBy is the assignee (design 3.2).
    assignedBy: userId,
    assignedAt: WHEN,
    ...over,
  });
  const employee = (userId: string, over: Row = {}): Row => ({
    id: randomUUID(),
    tenantId: scope.tenantId,
    userId,
    employeeNo: `EN-${randomBytes(3).toString("hex").toUpperCase()}`,
    fullName: `Karyawan ${userId.slice(0, 8)}`,
    // The cloud rewrites an employee of another home outlet to this outlet.
    homeOutletId: scope.outletId,
    employmentType: "pkwtt",
    joinDate: "2025-03-01",
    endDate: null,
    status: "active",
    ...over,
  });
  const shift = (
    employeeId: string,
    createdBy: string,
    over: Row = {},
  ): Row => ({
    id: randomUUID(),
    tenantId: scope.tenantId,
    outletId: scope.outletId,
    employeeId,
    shiftTemplateId: null,
    stationId: null,
    businessDate: BUSINESS_DATE,
    segments: [
      {
        startsAt: `${BUSINESS_DATE}T02:00:00.000Z`,
        endsAt: `${BUSINESS_DATE}T10:00:00.000Z`,
      },
    ],
    breakMinutes: 0,
    status: "published",
    source: "user",
    publishedAt: WHEN,
    createdBy,
    ...over,
  });
  const policy = (updatedBy: string, over: Row = {}): Row => ({
    id: randomUUID(),
    tenantId: scope.tenantId,
    outletId: scope.outletId,
    policy: {
      geofenceRadiusM: 100,
      outsideGeofenceAction: "flag",
      unboundDeviceAction: "flag",
      requireSelfie: true,
      requireDeviceBinding: false,
      allowRotatingQr: true,
      selfieRetentionDays: 30,
    },
    sampling: { rate: 0.1, flaggedAlways: true, minPerSupervisorPerWeek: 0 },
    updatedBy,
    createdAt: WHEN,
    updatedAt: WHEN,
    ...over,
  });
  /** Unvalidated: for the invalid-snapshot cases. */
  const rawSnapshot = (
    parts: Partial<Record<keyof EdgePeopleSnapshot, unknown>> = {},
  ) => ({
    users: [],
    roles: [],
    roleAssignments: [],
    employees: [],
    shiftAssignments: [],
    attendancePolicies: [],
    qrKeys: [],
    selfieSealKey: null,
    ...parts,
  });
  /** Validated with the shared schema, so a fixture bug fails here. */
  const snapshot = (
    parts: Partial<Record<keyof EdgePeopleSnapshot, unknown>> = {},
  ): EdgePeopleSnapshot => edgePeopleSnapshotSchema.parse(rawSnapshot(parts));
  return {
    user,
    role,
    assignment,
    employee,
    shift,
    policy,
    rawSnapshot,
    snapshot,
  };
}
