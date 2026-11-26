// Schema acceptance for migration 0529 (1271 F1; docs/briefs/1271-edge-failover-cards.md,
// docs/design/edge-cloud-failover.md W1, N1, N2): outlet_failover_windows,
// receipt_sequences.series and the failover_window_id keys of pos_orders and
// pos_shifts. Real PostgreSQL. Every case runs in one owner transaction that is
// rolled back, so nothing is left behind; isolation runs as legend_app.
//
// Assumptions (from the brief, not from the implementation):
// - At most one `active`/`returning` window per outlet (23505); a closed or
//   cancelled one does not block a new one.
// - Status moves forward only and a window is never deleted (42501).
// - `F1`..`F9999` is the failover series' prefix and only its prefix; a
//   failover run is never edge-bound (23514).
// - The migration aborts when a run already uses an `F<number>` prefix.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { OutletId, TenantId } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  activeFailoverWindow,
  windowTouchesDate,
} from "../services/edge-failover-window.ts";
import type { Tx } from "../services/permission-resolver.ts";
import {
  createOwnerPool,
  requireDisposableDatabase,
  tenantAId,
} from "./tenant-isolation-harness.ts";

requireDisposableDatabase();

const owner: Pool = createOwnerPool();
const outletBaseId = cafeLegendPlatformFixtures.outlets[0].id;
const hex = () => randomBytes(4).toString("hex");

afterAll(async () => {
  await owner.end();
});

interface Place {
  client: PoolClient;
  outletId: string;
  nodeId: string;
  userId: string;
}

/** One rolled-back owner transaction with a fresh outlet, edge node and user. */
async function inRollback(run: (place: Place) => Promise<void>): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantAId],
    );
    const outletId = randomUUID();
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $3, 'Outlet uji failover', address, opening_hours
         FROM outlets WHERE id = $2`,
      [outletId, outletBaseId, `EFS-${hex()}`.toUpperCase()],
    );
    const nodeId = randomUUID();
    await client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, label, credential_hash)
       VALUES ($1, $2, $3, 'primary', 'Mini PC uji failover', $4)`,
      [nodeId, tenantAId, outletId, randomBytes(32).toString("hex")],
    );
    const userId = `efs-${hex()}`;
    await client.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Manajer uji', $2)`,
      [userId, `${userId}@example.test`],
    );
    await run({ client, outletId, nodeId, userId });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** Runs `text` in a savepoint and returns the SQLSTATE it failed with (null = ok). */
async function sqlState(
  client: PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<string | null> {
  await client.query("SAVEPOINT probe");
  try {
    await client.query(text, params);
    await client.query("RELEASE SAVEPOINT probe");
    return null;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT probe");
    return (error as { code?: string }).code ?? "unknown";
  }
}

async function insertWindow(
  place: Place,
  values: { status?: string; key?: string; actor?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const status = values.status ?? "active";
  const ended = status !== "active";
  await place.client.query(
    `INSERT INTO outlet_failover_windows
       (id, tenant_id, outlet_id, edge_node_id, status, reason, idempotency_key,
        activated_by, business_date_from, business_date_to, return_started_at,
        closed_at, cancelled_at, return_started_by, cancelled_by)
     VALUES ($1, $2, $3, $4, $5, 'Mini PC mati', $6, $7, '2026-11-26',
        $8::date, $9::timestamptz, $10::timestamptz, $11::timestamptz,
        CASE WHEN $9::timestamptz IS NULL THEN NULL ELSE $12 END,
        CASE WHEN $11::timestamptz IS NULL THEN NULL ELSE $12 END)`,
    [
      id,
      tenantAId,
      place.outletId,
      place.nodeId,
      status,
      values.key ?? `fo-${hex()}`,
      values.actor ?? place.userId,
      ended ? "2026-11-26" : null,
      status === "returning" || status === "closed"
        ? "2026-11-26T05:00:00Z"
        : null,
      status === "closed" ? "2026-11-26T06:00:00Z" : null,
      status === "cancelled" ? "2026-11-26T04:00:00Z" : null,
      values.actor ?? place.userId,
    ],
  );
  return id;
}

async function insertSequence(
  place: Place,
  values: {
    series?: string;
    prefix: string;
    deviceId?: string;
    edgeNodeId?: string | null;
  },
): Promise<string | null> {
  return sqlState(
    place.client,
    `INSERT INTO receipt_sequences
       (tenant_id, outlet_id, device_id, prefix, series, edge_node_id, edge_instance_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      tenantAId,
      place.outletId,
      values.deviceId ?? randomUUID(),
      values.prefix,
      values.series ?? "device",
      values.edgeNodeId ?? null,
      values.edgeNodeId ? randomUUID() : null,
    ],
  );
}

const moveTo = (place: Place, id: string, set: string) =>
  sqlState(
    place.client,
    `UPDATE outlet_failover_windows SET ${set} WHERE id = $1`,
    [id],
  );

describe("1271 F1 outlet_failover_windows", () => {
  it("W1: one active or returning window per outlet; a closed one does not block", async () => {
    await inRollback(async (place) => {
      const first = await insertWindow(place);
      expect(
        await sqlState(
          place.client,
          `INSERT INTO outlet_failover_windows
             (tenant_id, outlet_id, edge_node_id, reason, idempotency_key, activated_by, business_date_from)
           VALUES ($1, $2, $3, 'Kedua kali', 'fo-second', $4, '2026-11-26')`,
          [tenantAId, place.outletId, place.nodeId, place.userId],
        ),
      ).toBe("23505");
      expect(
        await moveTo(
          place,
          first,
          "status = 'returning', return_started_at = now(), return_started_by = activated_by, business_date_to = '2026-11-26'",
        ),
      ).toBeNull();
      // Still open while returning.
      expect(
        await sqlState(
          place.client,
          `INSERT INTO outlet_failover_windows
             (tenant_id, outlet_id, edge_node_id, reason, idempotency_key, activated_by, business_date_from)
           VALUES ($1, $2, $3, 'Kedua kali', 'fo-second', $4, '2026-11-26')`,
          [tenantAId, place.outletId, place.nodeId, place.userId],
        ),
      ).toBe("23505");
      expect(
        await moveTo(place, first, "status = 'closed', closed_at = now()"),
      ).toBeNull();
      await insertWindow(place);
      // The read helper returns the open one only.
      const tx = drizzle(place.client) as unknown as Tx;
      const open = await activeFailoverWindow(
        tx,
        tenantAId as TenantId,
        place.outletId as OutletId,
      );
      expect(open?.status).toBe("active");
      expect(open?.id).not.toBe(first);
      expect(windowTouchesDate(open!, "2026-11-26")).toBe(true);
      expect(windowTouchesDate(open!, "2026-11-25")).toBe(false);
    });
  });

  it("status moves forward only, a final window never changes, and none is deleted", async () => {
    await inRollback(async (place) => {
      const id = await insertWindow(place);
      // active -> closed skips returning.
      expect(
        await moveTo(
          place,
          id,
          "status = 'closed', return_started_at = now(), return_started_by = activated_by, closed_at = now(), business_date_to = '2026-11-26'",
        ),
      ).toBe("42501");
      // Identity is fixed.
      expect(await moveTo(place, id, "reason = 'Alasan lain'")).toBe("42501");
      expect(await moveTo(place, id, "override = true")).toBe("42501");
      expect(
        await moveTo(
          place,
          id,
          "status = 'returning', return_started_at = now(), return_started_by = activated_by, business_date_to = '2026-11-26', closing_event_id = gen_random_uuid()",
        ),
      ).toBeNull();
      // returning -> active goes backwards; set-once fields keep their value.
      expect(
        await moveTo(
          place,
          id,
          "status = 'active', return_started_at = NULL, business_date_to = NULL",
        ),
      ).toBe("42501");
      expect(
        await moveTo(place, id, "closing_event_id = gen_random_uuid()"),
      ).toBe("42501");
      expect(
        await moveTo(place, id, "status = 'closed', closed_at = now()"),
      ).toBeNull();
      expect(await moveTo(place, id, "updated_at = now()")).toBe("42501");
      expect(
        await sqlState(
          place.client,
          "DELETE FROM outlet_failover_windows WHERE id = $1",
          [id],
        ),
      ).toBe("42501");

      const cancelled = await insertWindow(place);
      expect(
        await moveTo(
          place,
          cancelled,
          "status = 'cancelled', cancelled_at = now(), cancelled_by = activated_by, business_date_to = '2026-11-26'",
        ),
      ).toBeNull();
      expect(
        await moveTo(
          place,
          cancelled,
          "status = 'returning', cancelled_at = NULL, return_started_at = now()",
        ),
      ).toBe("42501");
    });
  });

  it("row checks tie the timestamps to the status", async () => {
    await inRollback(async (place) => {
      const id = await insertWindow(place);
      // returning without a return time, closed without a close time.
      expect(
        await moveTo(
          place,
          id,
          "status = 'returning', return_started_by = activated_by, business_date_to = '2026-11-26'",
        ),
      ).toBe("23514");
      // A window that left active names its last business date.
      expect(
        await moveTo(
          place,
          id,
          "status = 'returning', return_started_at = now(), return_started_by = activated_by",
        ),
      ).toBe("23514");
      expect(await moveTo(place, id, "business_date_to = '2026-11-25'")).toBe(
        "23514",
      );
    });
  });

  it("review P2: an edge copy applies although its managers are not in the edge people snapshot", async () => {
    await inRollback(async (place) => {
      // Ids of managers the edge has never seen (no row in "user").
      for (const status of ["closed", "cancelled", "returning"])
        await insertWindow(place, {
          status,
          actor: `absent-${hex()}`,
        }).then(
          (id) => expect(id).toBeTypeOf("string"),
          (error: { code?: string }) => expect(error.code ?? null).toBeNull(),
        );
    });
  });

  it("who started the return and who cancelled are tied to the status", async () => {
    await inRollback(async (place) => {
      const id = await insertWindow(place);
      expect(
        await moveTo(
          place,
          id,
          "status = 'returning', return_started_at = now(), business_date_to = '2026-11-26'",
        ),
      ).toBe("23514");
      expect(await moveTo(place, id, "cancelled_by = activated_by")).toBe(
        "23514",
      );
      expect(await moveTo(place, id, "return_started_by = activated_by")).toBe(
        "23514",
      );
      expect(
        await moveTo(
          place,
          id,
          "status = 'cancelled', cancelled_at = now(), business_date_to = '2026-11-26'",
        ),
      ).toBe("23514");
    });
  });

  it("TEN-02/TEN-03: only the own tenant and outlet scope sees a window", async () => {
    await inRollback(async (place) => {
      await insertWindow(place);
      const count = async (tenantId: string, outletIds: string) => {
        await place.client.query("SAVEPOINT iso");
        await place.client.query("SET LOCAL ROLE legend_app");
        await place.client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
          [tenantId, outletIds],
        );
        const seen = await place.client.query(
          "SELECT 1 FROM outlet_failover_windows WHERE outlet_id = $1",
          [place.outletId],
        );
        await place.client.query("ROLLBACK TO SAVEPOINT iso");
        return seen.rowCount;
      };
      expect(await count(tenantAId, JSON.stringify([place.outletId]))).toBe(1);
      expect(await count(tenantAId, JSON.stringify([outletBaseId]))).toBe(0);
      expect(await count(randomUUID(), "*")).toBe(0);
    });
  });
});

describe("1271 F1 failover_window_id on pos_orders and pos_shifts", () => {
  it("the key names a window of the same outlet and never changes", async () => {
    await inRollback(async (place) => {
      const windowId = await insertWindow(place);
      const shiftId = randomUUID();
      // Another outlet's window is refused by the composite key.
      expect(
        await sqlState(
          place.client,
          `INSERT INTO pos_shifts
             (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
              opened_at, opening_float_idr, open_key, open_fingerprint, failover_window_id)
           VALUES ($1, $2, $3, $4, $5, '2026-11-26', 'open', now(), 990000, $6, $7, $8)`,
          [
            randomUUID(),
            tenantAId,
            outletBaseId,
            randomUUID(),
            place.userId,
            `open-${hex()}`,
            "0".repeat(64),
            windowId,
          ],
        ),
      ).toBe("23503");
      expect(
        await sqlState(
          place.client,
          `INSERT INTO pos_shifts
             (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
              opened_at, opening_float_idr, open_key, open_fingerprint, failover_window_id)
           VALUES ($1, $2, $3, $4, $5, '2026-11-26', 'open', now(), 990000, $6, $7, $8)`,
          [
            shiftId,
            tenantAId,
            place.outletId,
            randomUUID(),
            place.userId,
            `open-${hex()}`,
            "0".repeat(64),
            windowId,
          ],
        ),
      ).toBeNull();
      expect(
        await sqlState(
          place.client,
          "UPDATE pos_shifts SET failover_window_id = NULL WHERE id = $1",
          [shiftId],
        ),
      ).toBe("42501");
    });
  });
});

describe("1271 F1 receipt_sequences.series", () => {
  it("N2: an F<1-4 digits> prefix is the failover series and only it", async () => {
    await inRollback(async (place) => {
      expect(await insertSequence(place, { prefix: "F1" })).toBe("23514");
      expect(
        await insertSequence(place, { series: "cloud", prefix: "F2" }),
      ).toBe("23514");
      expect(
        await insertSequence(place, { series: "failover", prefix: "P9" }),
      ).toBe("23514");
      expect(
        await insertSequence(place, { series: "failover", prefix: "F12345" }),
      ).toBe("23514");
      expect(
        await insertSequence(place, { series: "other", prefix: "Q1" }),
      ).toBe("23514");
      expect(
        await insertSequence(place, { series: "failover", prefix: "F1" }),
      ).toBeNull();
    });
  });

  it("N1: a failover run is never edge-bound; a device keeps its P-run beside its F-run", async () => {
    await inRollback(async (place) => {
      const deviceId = randomUUID();
      expect(
        await insertSequence(place, {
          series: "failover",
          prefix: "F3",
          deviceId,
          edgeNodeId: place.nodeId,
        }),
      ).toBe("23514");
      expect(
        await insertSequence(place, { prefix: "P3", deviceId }),
      ).toBeNull();
      expect(
        await insertSequence(place, {
          series: "failover",
          prefix: "F3",
          deviceId,
        }),
      ).toBeNull();
      // Still one current run per device and series.
      expect(
        await insertSequence(place, {
          series: "failover",
          prefix: "F4",
          deviceId,
        }),
      ).toBe("23505");
      // Binding the F-run later is refused, and its series never changes.
      expect(
        await sqlState(
          place.client,
          `UPDATE receipt_sequences SET edge_node_id = $1, edge_instance_id = gen_random_uuid()
            WHERE device_id = $2 AND series = 'failover'`,
          [place.nodeId, deviceId],
        ),
      ).toBe("23514");
      expect(
        await sqlState(
          place.client,
          "UPDATE receipt_sequences SET series = 'cloud' WHERE device_id = $1 AND series = 'device'",
          [deviceId],
        ),
      ).toBe("23514");
    });
  });

  it("the migration preflight aborts when a run already uses an F<number> prefix", async () => {
    const migration = readFileSync(
      new URL("../../drizzle/0529_edge_failover.sql", import.meta.url),
      "utf8",
    );
    const preflight = migration
      .split("--> statement-breakpoint")
      .find((statement) => statement.includes("1271 F1 preflight"));
    expect(preflight).toBeDefined();
    await inRollback(async (place) => {
      // Passes on today's data.
      expect(await sqlState(place.client, preflight!)).toBeNull();
      // A legacy device run named F7 (possible before 0529) stops it.
      await place.client.query(
        "ALTER TABLE receipt_sequences DROP CONSTRAINT receipt_sequences_failover_prefix_check",
      );
      expect(await insertSequence(place, { prefix: "F7" })).toBeNull();
      expect(await sqlState(place.client, preflight!)).toBe("23514");
    });
  });
});

describe("1271 F1 migration 0529 backfills", () => {
  const statements = readFileSync(
    new URL("../../drizzle/0529_edge_failover.sql", import.meta.url),
    "utf8",
  ).split("--> statement-breakpoint");
  const statement = (marker: string) => {
    const found = statements.filter((text) => text.includes(marker));
    expect(found).toHaveLength(1);
    return found[0]!;
  };

  it("marks the outlet-keyed C run as the cloud series and leaves device runs alone", async () => {
    const backfill = statement("SET series = 'cloud'");
    await inRollback(async (place) => {
      await place.client.query(
        "ALTER TABLE receipt_sequences DISABLE TRIGGER receipt_sequences_series_fixed_trg",
      );
      expect(
        await insertSequence(place, {
          prefix: "C",
          deviceId: place.outletId,
        }),
      ).toBeNull();
      const deviceId = randomUUID();
      expect(
        await insertSequence(place, { prefix: "P1", deviceId }),
      ).toBeNull();
      await place.client.query(backfill);
      await place.client.query(backfill);
      const { rows } = await place.client.query<{
        prefix: string;
        series: string;
      }>(
        "SELECT prefix, series FROM receipt_sequences WHERE outlet_id = $1 ORDER BY prefix",
        [place.outletId],
      );
      expect(rows).toEqual([
        { prefix: "C", series: "cloud" },
        { prefix: "P1", series: "device" },
      ]);
    });
  });

  it("grants pos.failover.manage to the stored owner, outlet_manager and supervisor templates only, once", async () => {
    const grant = statement("('supervisor', 'pos.failover.manage')");
    const code = "pos.failover.manage";
    await inRollback(async (place) => {
      await place.client.query(
        "UPDATE roles SET permissions = permissions - $2 WHERE tenant_id = $1",
        [tenantAId, code],
      );
      const { rows: custom } = await place.client.query<{ id: string }>(
        `INSERT INTO roles (tenant_id, name, is_template, permissions, allowed_scope_types)
         VALUES ($1, $2, false, '["pos.day.close"]'::jsonb, '["tenant"]'::jsonb) RETURNING id`,
        [tenantAId, `EFS ${hex()}`],
      );
      await place.client.query(grant);
      await place.client.query(grant);
      await place.client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantAId,
      ]);
      const { rows } = await place.client.query<{ key: string; n: number }>(
        `SELECT template_key AS key,
                (SELECT count(*)::int FROM jsonb_array_elements_text(permissions) c WHERE c = $2) AS n
           FROM roles WHERE tenant_id = $1 AND permissions ? $2 ORDER BY template_key`,
        [tenantAId, code],
      );
      expect(rows).toEqual([
        { key: "outlet_manager", n: 1 },
        { key: "owner", n: 1 },
        { key: "supervisor", n: 1 },
      ]);
      const { rows: kept } = await place.client.query<{
        permissions: string[];
      }>("SELECT permissions FROM roles WHERE id = $1", [custom[0]!.id]);
      expect(kept[0]!.permissions).toEqual(["pos.day.close"]);
    });
  });
});
