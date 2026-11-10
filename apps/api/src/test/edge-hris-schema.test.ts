// Schema acceptance for migration 0227 (bead legend-hwn02, card C1; design
// docs/design/hris-edge-replication.md sections 5, 6.1, 8): the four tables
// edge_people_sync_state, edge_attendance_qr_keys, edge_selfie_uploads and
// edge_received_selfies, the attendance method 'outlet_device', the QR key
// source that reads edge_attendance_qr_keys, and the edge runtime table list.
// Real PostgreSQL; fixtures are written by the migration owner, every
// isolation check runs as the restricted legend_app login.
//
// Assumptions (from the design and the card brief, not from implementation):
// - Tenant RLS and outlet RLS apply to all four tables, edge_received_selfies
//   (cloud side) included: it has outlet_id NOT NULL like edge_received_events
//   (architect review of C1, TEN-03; outlet-rls.test.ts demands it).
// - A row naming another tenant, or an outlet outside the session scope, is
//   rejected on insert with SQLSTATE 42501.
// - edge_received_selfies is append-only: UPDATE and DELETE fail with 42501 and
//   a message that contains "append-only" (like edge_received_events).
// - CHECK violations are SQLSTATE 23514, key/PK violations 23505.
// - The QR key source returns null for a missing key; it never throws.
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { EDGE_REQUIRED_TABLES } from "../edge/runtime.ts";
import { edgeTableQrKeySource } from "../services/hris-attendance-qr.ts";
import {
  asTenant,
  createAppPool,
  createOwnerPool,
  createSecondTenant,
  removeSecondTenant,
  requireDisposableDatabase,
  tenantAId,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

requireDisposableDatabase();

const owner: Pool = createOwnerPool();
const appPool: Pool = createAppPool();
const outletBaseId = cafeLegendPlatformFixtures.outlets[0].id;
const unique = () => randomBytes(4).toString("hex");

const NEW_TABLES = [
  "edge_people_sync_state",
  "edge_attendance_qr_keys",
  "edge_selfie_uploads",
  "edge_received_selfies",
] as const;
type NewTable = (typeof NEW_TABLES)[number];

type Query = [text: string, params: unknown[]];

/** One fixture row position: tenant, outlet, the edge node of that outlet. */
interface Place {
  tenantId: string;
  outletId: string;
  nodeId: string;
}

/** INSERT for one row of one new table. Defaults are left to the database. */
function insertRow(
  table: NewTable,
  place: Place,
  options: { objectId?: string; dayIndex?: number } = {},
): Query {
  const objectId = options.objectId ?? randomUUID();
  const dayIndex = options.dayIndex ?? 20_400;
  switch (table) {
    case "edge_people_sync_state":
      return [
        `INSERT INTO edge_people_sync_state
           (tenant_id, outlet_id, snapshot_etag, snapshot_generated_at, applied_at,
            last_checked_at, selfie_seal_kid, selfie_seal_public_key)
         VALUES ($1, $2, '"etag-1"', now(), now(), now(), 'kid-1', 'pem-1')`,
        [place.tenantId, place.outletId],
      ];
    case "edge_attendance_qr_keys":
      return [
        `INSERT INTO edge_attendance_qr_keys (tenant_id, outlet_id, day_index, key)
         VALUES ($1, $2, $3, $4)`,
        [place.tenantId, place.outletId, dayIndex, randomBytes(32)],
      ];
    case "edge_selfie_uploads":
      return [
        `INSERT INTO edge_selfie_uploads
           (tenant_id, object_id, outlet_id, file_path, sealed_sha256, sealed_bytes, seal_kid)
         VALUES ($1, $2, $3, $4, $5, 2048, 'kid-1')`,
        [
          place.tenantId,
          objectId,
          place.outletId,
          `selfies/${objectId}.lss1`,
          randomBytes(32),
        ],
      ];
    case "edge_received_selfies":
      return [
        `INSERT INTO edge_received_selfies
           (tenant_id, object_id, outlet_id, edge_node_id, sealed_sha256, state)
         VALUES ($1, $2, $3, $4, $5, 'stored')`,
        [
          place.tenantId,
          objectId,
          place.outletId,
          place.nodeId,
          randomBytes(32),
        ],
      ];
  }
}

/** A statement that only touches rows of this table, for "foreign row" checks. */
const UPDATE_SET: Record<NewTable, string> = {
  edge_people_sync_state: "snapshot_etag = snapshot_etag",
  edge_attendance_qr_keys: "received_at = received_at",
  edge_selfie_uploads: "attempts = attempts",
  edge_received_selfies: "received_at = received_at",
};

let tenantB: SecondTenant;
let outletA2: string;
let outletA3: string;
let employeeA2: string;
let placeA2: Place; // tenant A, outlet A2
let placeA3: Place; // tenant A, outlet A3
let placeB: Place; // tenant B
const createdOutlets: string[] = [];
const createdNodes: { tenantId: string; id: string }[] = [];
const createdTenants: SecondTenant[] = [];

/** Owner connection with the tenant GUCs set, so fixtures pass forced RLS. */
async function ownerTx<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
  options: { replica?: boolean; rollback?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (options.replica)
      await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query(options.rollback ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Runs statements in order as the owner and rolls back; resolves to the last result. */
function attempt(tenantId: string, statements: Query[]) {
  return ownerTx(
    tenantId,
    async (client) => {
      let last: QueryResult | undefined;
      for (const [text, params] of statements)
        last = await client.query(text, params);
      return last!;
    },
    { rollback: true },
  );
}

async function seedOutlet(): Promise<string> {
  const id = randomUUID();
  createdOutlets.push(id);
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $3, 'Outlet skema edge HRIS', address, opening_hours
       FROM outlets WHERE id = $2`,
    [id, outletBaseId, `EHS-${unique()}`.toUpperCase()],
  );
  return id;
}

async function seedNode(tenantId: string, outletId: string): Promise<string> {
  const id = randomUUID();
  createdNodes.push({ tenantId, id });
  await ownerTx(tenantId, (client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, label, credential_hash)
       VALUES ($1, $2, $3, 'primary', 'Mini PC uji skema', $4)`,
      [id, tenantId, outletId, randomBytes(32).toString("hex")],
    ),
  );
  return id;
}

const outletScope = (tenantId: string, outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

/** Outlet ids of the fixture rows a session can see in `table`. */
async function visibleOutlets(
  client: PoolClient,
  table: NewTable,
): Promise<string[]> {
  const result = await client.query<{ outlet_id: string }>(
    `SELECT outlet_id::text AS outlet_id FROM ${table}
      WHERE outlet_id = ANY($1::uuid[]) ORDER BY 1`,
    [[placeA2.outletId, placeA3.outletId, placeB.outletId]],
  );
  return result.rows.map((row) => row.outlet_id);
}

const sorted = (ids: string[]) => [...ids].sort();

afterAll(async () => {
  const errors: unknown[] = [];
  const step = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  // Only rows of the outlets this file created; replica mode lets the owner
  // clear the append-only table.
  const outletIds = [
    ...createdOutlets,
    ...createdTenants.map((t) => t.outletId),
  ];
  for (const tenantId of [tenantAId, ...createdTenants.map((t) => t.tenantId)])
    await step(() =>
      ownerTx(
        tenantId,
        async (client) => {
          for (const table of NEW_TABLES)
            await client.query(
              `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])`,
              [tenantId, outletIds],
            );
        },
        { replica: true },
      ),
    );
  for (const node of createdNodes)
    await step(() =>
      ownerTx(
        node.tenantId,
        (client) =>
          client.query(
            "DELETE FROM edge_nodes WHERE tenant_id = $1 AND id = $2",
            [node.tenantId, node.id],
          ),
        { replica: true },
      ),
    );
  if (employeeA2)
    await step(() =>
      ownerTx(tenantAId, (client) =>
        client.query("DELETE FROM employees WHERE tenant_id = $1 AND id = $2", [
          tenantAId,
          employeeA2,
        ]),
      ),
    );
  for (const outletId of createdOutlets)
    await step(() =>
      owner.query("DELETE FROM outlets WHERE tenant_id = $1 AND id = $2", [
        tenantAId,
        outletId,
      ]),
    );
  for (const tenant of createdTenants)
    await step(() => removeSecondTenant(owner, tenant));
  await step(() => appPool.end());
  await step(() => owner.end());
  if (errors.length > 0) throw errors[0];
}, 90_000);

describe("HRIS edge schema: objects exist", () => {
  it.each(NEW_TABLES)("table %s exists", async (table) => {
    const result = await owner.query<{ found: string | null }>(
      "SELECT to_regclass($1)::text AS found",
      [`public.${table}`],
    );
    expect(result.rows[0]?.found).not.toBeNull();
  });

  it.each([
    ["edge_people_sync_state", ["tenant_id", "outlet_id"]],
    ["edge_attendance_qr_keys", ["tenant_id", "outlet_id", "day_index"]],
    ["edge_selfie_uploads", ["tenant_id", "object_id"]],
    ["edge_received_selfies", ["tenant_id", "object_id"]],
  ] as const)("table %s has primary key %j", async (table, columns) => {
    const result = await owner.query<{ attname: string }>(
      `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = to_regclass($1) AND i.indisprimary
        ORDER BY array_position(i.indkey::int2[], a.attnum)`,
      [`public.${table}`],
    );
    expect(result.rows.map((row) => row.attname)).toEqual([...columns]);
  });

  it("edge_selfie_uploads has an index on (state, next_attempt_at)", async () => {
    const result = await owner.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'edge_selfie_uploads'",
    );
    expect(
      result.rows.some((row) =>
        /\(state, next_attempt_at\)/.test(row.indexdef),
      ),
    ).toBe(true);
  });
});

describe("HRIS edge schema: rows, constraints and isolation", () => {
  beforeAll(async () => {
    tenantB = await createSecondTenant(owner, "edgehris");
    createdTenants.push(tenantB);
    outletA2 = await seedOutlet();
    outletA3 = await seedOutlet();
    placeA2 = {
      tenantId: tenantAId,
      outletId: outletA2,
      nodeId: await seedNode(tenantAId, outletA2),
    };
    placeA3 = {
      tenantId: tenantAId,
      outletId: outletA3,
      nodeId: await seedNode(tenantAId, outletA3),
    };
    placeB = {
      tenantId: tenantB.tenantId,
      outletId: tenantB.outletId,
      nodeId: await seedNode(tenantB.tenantId, tenantB.outletId),
    };
    employeeA2 = randomUUID();
    await ownerTx(tenantAId, (client) =>
      client.query(
        `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status)
         VALUES ($1, $2, $3, 'Karyawan Skema Edge', $4, 'pkwtt', '2025-03-01', 'active')`,
        [employeeA2, tenantAId, `0000EHS${unique().toUpperCase()}`, outletA2],
      ),
    );
    // One row per table at each place; positive controls for every check below.
    for (const place of [placeA2, placeA3, placeB])
      await ownerTx(place.tenantId, async (client) => {
        for (const table of NEW_TABLES) {
          const [text, params] = insertRow(table, place);
          await client.query(text, params);
        }
      });
  }, 60_000);

  describe("tenant isolation as legend_app", () => {
    it.each(NEW_TABLES)(
      "%s: each tenant reads only its own rows",
      async (table) => {
        // Positive control: the owner sees the rows of all three places.
        const truth = await owner.query(
          `SELECT 1 FROM ${table} WHERE outlet_id = ANY($1::uuid[])`,
          [[placeA2.outletId, placeA3.outletId, placeB.outletId]],
        );
        expect(truth.rowCount).toBe(3);
        await asTenant(appPool, tenantAId, async (client) => {
          expect(sorted(await visibleOutlets(client, table))).toEqual(
            sorted([placeA2.outletId, placeA3.outletId]),
          );
        });
        await asTenant(appPool, tenantB.tenantId, async (client) => {
          expect(await visibleOutlets(client, table)).toEqual([
            placeB.outletId,
          ]);
        });
      },
    );

    it.each(Object.keys(UPDATE_SET) as (keyof typeof UPDATE_SET)[])(
      "%s: a tenant cannot update or delete another tenant's row",
      async (table) => {
        await asTenant(appPool, tenantAId, async (client) => {
          const updated = await client.query(
            `UPDATE ${table} SET ${UPDATE_SET[table]} WHERE outlet_id = $1`,
            [placeB.outletId],
          );
          expect(updated.rowCount).toBe(0);
          const deleted = await client.query(
            `DELETE FROM ${table} WHERE outlet_id = $1`,
            [placeB.outletId],
          );
          expect(deleted.rowCount).toBe(0);
        });
      },
    );

    it.each(NEW_TABLES)(
      "%s: a session without a tenant sees nothing",
      async (table) => {
        await asTenant(appPool, null, async (client) => {
          let rowCount: number | null = null;
          try {
            rowCount = (
              await client.query(
                `SELECT 1 FROM ${table} WHERE outlet_id = ANY($1::uuid[])`,
                [[placeA2.outletId, placeB.outletId]],
              )
            ).rowCount;
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (!["22P02", "42501", "42704"].includes(code ?? "")) throw error;
            rowCount = 0;
          }
          expect(rowCount).toBe(0);
        });
      },
    );

    it.each(NEW_TABLES)(
      "%s: a tenant cannot write a row that names another tenant",
      async (table) => {
        await asTenant(appPool, tenantAId, async (client) => {
          const [text, params] = insertRow(table, placeB);
          await expect(client.query(text, params)).rejects.toMatchObject({
            code: "42501",
          });
        });
      },
    );

    it.each(NEW_TABLES)(
      "%s: a tenant can write its own row (positive control)",
      async (table) => {
        await asTenant(appPool, tenantAId, async (client) => {
          // edge_people_sync_state has one fixed row per outlet and the
          // fixture already seeded it: replace it, then write it again.
          if (table === "edge_people_sync_state")
            await client.query(
              "DELETE FROM edge_people_sync_state WHERE outlet_id = $1",
              [placeA2.outletId],
            );
          const [text, params] = insertRow(table, placeA2, {
            dayIndex: 20_999,
          });
          await expect(client.query(text, params)).resolves.toMatchObject({
            rowCount: 1,
          });
        });
      },
    );
  });

  describe("outlet isolation as legend_app", () => {
    const outletTables = [
      "edge_people_sync_state",
      "edge_attendance_qr_keys",
      "edge_selfie_uploads",
      "edge_received_selfies",
    ] as const;

    it.each(outletTables)(
      "%s: a session scoped to outlet A2 sees and changes only outlet A2",
      async (table) => {
        await asTenant(
          appPool,
          tenantAId,
          async (client) => {
            expect(await visibleOutlets(client, table)).toEqual([outletA2]);
            const updated = await client.query(
              `UPDATE ${table} SET ${UPDATE_SET[table]} WHERE outlet_id = $1`,
              [outletA3],
            );
            expect(updated.rowCount).toBe(0);
            const deleted = await client.query(
              `DELETE FROM ${table} WHERE outlet_id = $1`,
              [outletA3],
            );
            expect(deleted.rowCount).toBe(0);
          },
          [outletA2],
        );
      },
    );

    it.each(outletTables)(
      "%s: a session scoped to outlet A2 cannot write a row into outlet A3",
      async (table) => {
        await asTenant(
          appPool,
          tenantAId,
          async (client) => {
            const [text, params] = insertRow(table, placeA3, {
              dayIndex: 20_998,
            });
            await expect(client.query(text, params)).rejects.toMatchObject({
              code: "42501",
            });
          },
          [outletA2],
        );
      },
    );
  });

  describe("primary keys and unique shape", () => {
    it("edge_people_sync_state: one row per tenant and outlet", async () => {
      const [text, params] = insertRow("edge_people_sync_state", placeA2);
      await expect(attempt(tenantAId, [[text, params]])).rejects.toMatchObject({
        code: "23505",
      });
    });

    it("edge_people_sync_state: a nullable-state row is accepted for a fresh outlet", async () => {
      // A row that has never synced carries only the key; every other column is nullable.
      const outletId = placeA2.outletId;
      await expect(
        attempt(tenantAId, [
          [
            "DELETE FROM edge_people_sync_state WHERE tenant_id = $1 AND outlet_id = $2",
            [tenantAId, outletId],
          ],
          [
            "INSERT INTO edge_people_sync_state (tenant_id, outlet_id) VALUES ($1, $2)",
            [tenantAId, outletId],
          ],
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
    });

    it("edge_attendance_qr_keys: one key per tenant, outlet and day, other days allowed", async () => {
      const [dup, dupParams] = insertRow("edge_attendance_qr_keys", placeA2, {
        dayIndex: 20_400,
      });
      await expect(
        attempt(tenantAId, [[dup, dupParams]]),
      ).rejects.toMatchObject({
        code: "23505",
      });
      const [next, nextParams] = insertRow("edge_attendance_qr_keys", placeA2, {
        dayIndex: 20_401,
      });
      await expect(
        attempt(tenantAId, [[next, nextParams]]),
      ).resolves.toMatchObject({
        rowCount: 1,
      });
    });

    it("edge_attendance_qr_keys: received_at defaults to now", async () => {
      const result = await attempt(tenantAId, [
        insertRow("edge_attendance_qr_keys", placeA2, { dayIndex: 20_402 }),
        [
          "SELECT received_at FROM edge_attendance_qr_keys WHERE tenant_id = $1 AND outlet_id = $2 AND day_index = 20402",
          [tenantAId, outletA2],
        ],
      ]);
      expect(result.rows[0]?.received_at).toBeInstanceOf(Date);
    });

    it.each(["edge_selfie_uploads", "edge_received_selfies"] as const)(
      "%s: one row per tenant and object id, whichever outlet",
      async (table) => {
        const objectId = randomUUID();
        await expect(
          attempt(tenantAId, [
            insertRow(table, placeA2, { objectId }),
            insertRow(table, placeA3, { objectId }),
          ]),
        ).rejects.toMatchObject({ code: "23505" });
      },
    );
  });

  describe("value checks", () => {
    it.each([0, 16, 31, 33, 64])(
      "edge_attendance_qr_keys rejects a key of %i bytes",
      async (length) => {
        await expect(
          attempt(tenantAId, [
            [
              `INSERT INTO edge_attendance_qr_keys (tenant_id, outlet_id, day_index, key)
               VALUES ($1, $2, 20500, $3)`,
              [tenantAId, outletA2, randomBytes(length)],
            ],
          ]),
        ).rejects.toMatchObject({ code: "23514" });
      },
    );

    it("edge_attendance_qr_keys accepts a key of exactly 32 bytes", async () => {
      await expect(
        attempt(tenantAId, [
          insertRow("edge_attendance_qr_keys", placeA2, { dayIndex: 20_500 }),
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
    });

    it("edge_selfie_uploads defaults to state pending with 0 attempts", async () => {
      const result = await attempt(tenantAId, [
        insertRow("edge_selfie_uploads", placeA2, { objectId: randomUUID() }),
        [
          `SELECT state, attempts FROM edge_selfie_uploads
            WHERE tenant_id = $1 AND outlet_id = $2 AND attempts = 0 AND state = 'pending'`,
          [tenantAId, outletA2],
        ],
      ]);
      expect(result.rowCount).toBeGreaterThanOrEqual(1);
    });

    it.each(["pending", "uploaded", "rejected", "expired"])(
      "edge_selfie_uploads accepts state %s",
      async (state) => {
        const objectId = randomUUID();
        const [text, params] = insertRow("edge_selfie_uploads", placeA2, {
          objectId,
        });
        await expect(
          attempt(tenantAId, [
            [text, params],
            [
              "UPDATE edge_selfie_uploads SET state = $3 WHERE tenant_id = $1 AND object_id = $2",
              [tenantAId, objectId, state],
            ],
          ]),
        ).resolves.toMatchObject({ rowCount: 1 });
      },
    );

    it.each(["done", "PENDING", "", "stored"])(
      "edge_selfie_uploads rejects state %j",
      async (state) => {
        const objectId = randomUUID();
        const [text, params] = insertRow("edge_selfie_uploads", placeA2, {
          objectId,
        });
        await expect(
          attempt(tenantAId, [
            [text, params],
            [
              "UPDATE edge_selfie_uploads SET state = $3 WHERE tenant_id = $1 AND object_id = $2",
              [tenantAId, objectId, state],
            ],
          ]),
        ).rejects.toMatchObject({ code: "23514" });
      },
    );

    it.each(["stored", "discarded"])(
      "edge_received_selfies accepts state %s",
      async (state) => {
        await expect(
          attempt(tenantAId, [
            [
              `INSERT INTO edge_received_selfies
                 (tenant_id, object_id, outlet_id, edge_node_id, sealed_sha256, state)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                tenantAId,
                randomUUID(),
                outletA2,
                placeA2.nodeId,
                randomBytes(32),
                state,
              ],
            ],
          ]),
        ).resolves.toMatchObject({ rowCount: 1 });
      },
    );

    it.each(["pending", "uploaded", "", "Stored"])(
      "edge_received_selfies rejects state %j",
      async (state) => {
        await expect(
          attempt(tenantAId, [
            [
              `INSERT INTO edge_received_selfies
                 (tenant_id, object_id, outlet_id, edge_node_id, sealed_sha256, state)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                tenantAId,
                randomUUID(),
                outletA2,
                placeA2.nodeId,
                randomBytes(32),
                state,
              ],
            ],
          ]),
        ).rejects.toMatchObject({ code: "23514" });
      },
    );
  });

  describe("edge_received_selfies is append-only", () => {
    it("rejects UPDATE of an existing row", async () => {
      await expect(
        attempt(tenantAId, [
          [
            "UPDATE edge_received_selfies SET state = 'discarded' WHERE tenant_id = $1 AND outlet_id = $2",
            [tenantAId, outletA2],
          ],
        ]),
      ).rejects.toMatchObject({ code: "42501", message: /append-only/ });
    });

    it("rejects DELETE of an existing row", async () => {
      await expect(
        attempt(tenantAId, [
          [
            "DELETE FROM edge_received_selfies WHERE tenant_id = $1 AND outlet_id = $2",
            [tenantAId, outletA2],
          ],
        ]),
      ).rejects.toMatchObject({ code: "42501", message: /append-only/ });
    });

    it("rejects UPDATE and DELETE as legend_app too, and the row is unchanged", async () => {
      await asTenant(appPool, tenantAId, async (client) => {
        await client.query("SAVEPOINT before_update");
        await expect(
          client.query(
            "UPDATE edge_received_selfies SET state = 'discarded' WHERE outlet_id = $1",
            [outletA2],
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT before_update");
        await expect(
          client.query(
            "DELETE FROM edge_received_selfies WHERE outlet_id = $1",
            [outletA2],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });
      const row = await owner.query<{ state: string }>(
        "SELECT state FROM edge_received_selfies WHERE tenant_id = $1 AND outlet_id = $2",
        [tenantAId, outletA2],
      );
      expect(row.rows.map((r) => r.state)).toEqual(["stored"]);
    });

    it("still accepts INSERT", async () => {
      await expect(
        attempt(tenantAId, [insertRow("edge_received_selfies", placeA2)]),
      ).resolves.toMatchObject({ rowCount: 1 });
    });
  });

  describe("attendance_logs method outlet_device", () => {
    const insertLog = (method: string): Query => {
      const id = ulidToUuid(createUlid());
      return [
        `INSERT INTO attendance_logs
           (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
            geo_distance_m, validity, flag_reasons, business_date, client_event_id, review_status)
         VALUES ($1, $2, $3, $4, 'in', $5, now(), now(), NULL, 'valid', '[]', '2041-06-10', $6, 'none')`,
        [id, tenantAId, outletA2, employeeA2, method, createUlid()],
      ];
    };

    it("accepts method outlet_device", async () => {
      await expect(
        attempt(tenantAId, [insertLog("outlet_device")]),
      ).resolves.toMatchObject({ rowCount: 1 });
    });

    it("still accepts the earlier methods", async () => {
      for (const method of ["selfie_geo", "rotating_qr", "manual_correction"])
        await expect(
          attempt(tenantAId, [insertLog(method)]),
        ).resolves.toMatchObject({ rowCount: 1 });
    });

    it("still rejects an unknown method", async () => {
      await expect(
        attempt(tenantAId, [insertLog("telepathy")]),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "attendance_logs_method_check",
      });
    });
  });
});

describe("edgeTableQrKeySource reads edge_attendance_qr_keys", () => {
  const DAY = 20_700;
  let tenantId: string;
  let outletId: string;
  let otherOutletId: string;
  let other: SecondTenant;
  let storedKey: Buffer;
  let storedKeyDayAfter: Buffer;

  beforeAll(async () => {
    tenantId = tenantAId;
    outletId = await seedOutlet();
    otherOutletId = await seedOutlet();
    other = await createSecondTenant(owner, "qrsource");
    createdTenants.push(other);
    storedKey = randomBytes(32);
    storedKeyDayAfter = randomBytes(32);
    await ownerTx(tenantId, async (client) => {
      for (const [dayIndex, key] of [
        [DAY, storedKey],
        [DAY + 1, storedKeyDayAfter],
      ] as const)
        await client.query(
          `INSERT INTO edge_attendance_qr_keys (tenant_id, outlet_id, day_index, key)
           VALUES ($1, $2, $3, $4)`,
          [tenantId, outletId, dayIndex, key],
        );
    });
  }, 60_000);

  const lookup = (
    scope: ScopedTenantContext,
    askTenant: string,
    askOutlet: string,
    dayIndex: number,
  ) =>
    withTenant(db, scope, (tx) =>
      edgeTableQrKeySource(tx).dayKey(askTenant, askOutlet, dayIndex),
    );

  it("returns the stored 32-byte key for the right tenant, outlet and day", async () => {
    const key = await lookup(
      outletScope(tenantId, outletId),
      tenantId,
      outletId,
      DAY,
    );
    expect(key).not.toBeNull();
    expect(Buffer.from(key!).equals(storedKey)).toBe(true);
    const next = await lookup(
      outletScope(tenantId, outletId),
      tenantId,
      outletId,
      DAY + 1,
    );
    expect(Buffer.from(next!).equals(storedKeyDayAfter)).toBe(true);
  });

  it("returns null for a day without a key", async () => {
    expect(
      await lookup(
        outletScope(tenantId, outletId),
        tenantId,
        outletId,
        DAY + 2,
      ),
    ).toBeNull();
    expect(
      await lookup(
        outletScope(tenantId, outletId),
        tenantId,
        outletId,
        DAY - 1,
      ),
    ).toBeNull();
  });

  it("returns null for another outlet of the same tenant", async () => {
    expect(
      await lookup(
        outletScope(tenantId, otherOutletId),
        tenantId,
        otherOutletId,
        DAY,
      ),
    ).toBeNull();
    // Even a session that may see both outlets gets nothing for the wrong outlet.
    const tenantWide = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    expect(await lookup(tenantWide, tenantId, otherOutletId, DAY)).toBeNull();
    expect((await lookup(tenantWide, tenantId, outletId, DAY))?.length).toBe(
      32,
    );
  });

  it("returns null when the transaction belongs to another tenant", async () => {
    const otherScope = outletScope(other.tenantId, other.outletId);
    // Asking for tenant A's ids from tenant B's transaction: RLS hides the row.
    expect(await lookup(otherScope, tenantId, outletId, DAY)).toBeNull();
    // Asking with tenant B's id and tenant A's outlet finds nothing either.
    expect(await lookup(otherScope, other.tenantId, outletId, DAY)).toBeNull();
    expect(
      await lookup(
        outletScope(tenantId, outletId),
        other.tenantId,
        outletId,
        DAY,
      ),
    ).toBeNull();
  });
});

describe("EDGE_REQUIRED_TABLES", () => {
  it("includes edge_attendance_qr_keys so a missing migration stops the edge at start", () => {
    expect(EDGE_REQUIRED_TABLES).toContain("edge_attendance_qr_keys");
  });
});
