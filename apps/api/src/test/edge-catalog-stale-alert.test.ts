// legend-10nex, cloud side: a heartbeat that carries `catalogStale` notifies
// the outlet's supervisors AND owners once per edge, stream and stale episode.
// Policy (Q57): the alarm needs only a failure that lasts (5 minutes, cloud
// reachable), not a 30-minute age; the text says sales are held after 24 hours.
// The edge's own database never reaches the cloud, so the edge only reports
// the stale streams in the link heartbeat; this file covers what the cloud does
// with them (notifyEdgeCatalogStale) and the frame itself.
// Fixtures: one disposable tenant, one outlet, one supervisor and one owner;
// removed in afterAll.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  catalogStaleForHeartbeat,
  createCatalogFreshness,
} from "../edge/catalog-freshness.ts";
import { decodeFrame, encodeFrame } from "../edge/protocol.ts";
import { reportCloudDeviceRegistryHardStale } from "../edge/runtime.ts";
import {
  edgeCatalogStaleAlertId,
  notifyEdgeCatalogStale,
  type EdgeCatalogStale,
} from "../services/edge-sync-conflict-alert.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantId = randomUUID();
const outletId = randomUUID();
const edgeNodeId = randomUUID();
const supervisorUserId = randomUUID();
const ownerUserId = randomUUID();
const context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
);

const episode = (
  overrides: Partial<EdgeCatalogStale> = {},
): EdgeCatalogStale => ({
  tenantId: tenantIdSchema.parse(tenantId),
  outletId: outletIdSchema.parse(outletId),
  edgeNodeId,
  stream: "price_lists",
  staleSince: "2026-11-11T03:05:00.000Z",
  reason: "HTTP_500",
  ...overrides,
});

const send = (stale: EdgeCatalogStale) =>
  withTenant(db, context, (tx) => notifyEdgeCatalogStale(tx, context, stale));

async function notificationRows() {
  const { rows } = await owner.query<{
    user_id: string;
    title: string;
    body: string;
  }>("SELECT user_id, title, body FROM notifications WHERE tenant_id = $1", [
    tenantId,
  ]);
  return rows;
}

async function addUser(
  userId: string,
  name: string,
  templateKey: "supervisor" | "owner",
  scope: { type: "outlet" | "tenant"; id: string | null },
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
    [userId, name, `ecs-${randomBytes(4).toString("hex")}@example.test`],
  );
  const role = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = $4`,
    [roleId, tenantId, cafeLegendPlatformFixtures.tenant.id, templateKey],
  );
  if (role.rowCount !== 1) throw new Error(`No ${templateKey} role template`);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId, scope.type, scope.id],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Catalog Stale', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `catalog-stale-${randomBytes(4).toString("hex")}`,
      randomUUID(),
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `catalog-stale-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'ECS-01', 'ECS-01', 'Jl. Uji', '{}', 'active')`,
    [outletId, tenantId, brand, entity],
  );
  await addUser(supervisorUserId, "Supervisor ECS", "supervisor", {
    type: "outlet",
    id: outletId,
  });
  await addUser(ownerUserId, "Owner ECS", "owner", {
    type: "tenant",
    id: null,
  });
});

afterAll(async () => {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "delivery_attempts",
      "notifications",
      "notification_outbox",
      "domain_event_outbox",
      "audit_logs",
      "role_assignments",
      "roles",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
      [supervisorUserId, ownerUserId],
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

describe("legend-10nex heartbeat frame", () => {
  const base = {
    type: "heartbeat",
    version: "1.0.0",
    occurredAt: "2026-11-11T04:00:00.000Z",
  } as const;

  it("carries catalogStale and stays valid without it (older edge)", () => {
    const stale = [
      {
        stream: "price_lists",
        staleSince: "2026-11-11T03:05:00.000Z",
        reason: "HTTP_500",
      },
    ];
    const withStale = decodeFrame(
      encodeFrame({ ...base, catalogStale: stale }),
    );
    expect(withStale).toMatchObject({ type: "heartbeat", catalogStale: stale });
    expect(decodeFrame(encodeFrame(base))).toEqual(base);
  });

  it("refuses unknown fields inside catalogStale", () => {
    const raw = JSON.stringify({
      ...base,
      catalogStale: [
        {
          stream: "price_lists",
          staleSince: "2026-11-11T03:05:00.000Z",
          reason: "x",
          extra: 1,
        },
      ],
    });
    expect(decodeFrame(raw)).toBeNull();
  });
});

describe("legend-uvnll device registry heartbeat", () => {
  const base = {
    type: "heartbeat",
    version: "1.0.0",
    occurredAt: "2026-11-11T04:00:00.000Z",
  } as const;

  it("accepts the hard-stale flag while remaining compatible with older edges", () => {
    expect(
      decodeFrame(JSON.stringify({ ...base, deviceRegistryHardStale: true })),
    ).toMatchObject({ ...base, deviceRegistryHardStale: true });
    expect(
      decodeFrame(JSON.stringify({ ...base, deviceRegistryHardStale: false })),
    ).toMatchObject({ ...base, deviceRegistryHardStale: false });
    expect(decodeFrame(JSON.stringify(base))).toEqual(base);
  });

  it("rejects a non-boolean hard-stale flag", () => {
    expect(
      decodeFrame(JSON.stringify({ ...base, deviceRegistryHardStale: "true" })),
    ).toBeNull();
  });

});

describe("legend-10nex heartbeat is held back from an older cloud", () => {
  const MIN = 60_000;
  function staleFreshness(reason: string) {
    let clock = Date.parse("2026-11-11T03:05:00.000Z");
    const freshness = createCatalogFreshness({
      now: () => new Date(clock),
      failurePersistMs: 0,
    });
    freshness.recordSuccess("price_lists");
    freshness.recordSuccess("menu_items");
    clock += 31 * MIN;
    freshness.recordFailure("price_lists", { reason, cloudReachable: true });
    return freshness;
  }

  it("reports the alarm streams in wire form", () => {
    expect(
      catalogStaleForHeartbeat(staleFreshness("HTTP_500").snapshot()),
    ).toEqual([
      {
        stream: "price_lists",
        staleSince: "2026-11-11T03:05:00.000Z",
        reason: "HTTP_500",
      },
    ]);
  });

  it.each(["item_variants", "modifiers"])(
    "reports a stale %s stream (variant and modifier prices are money)",
    (stream) => {
      let clock = Date.parse("2026-11-11T03:05:00.000Z");
      const freshness = createCatalogFreshness({
        now: () => new Date(clock),
        failurePersistMs: 0,
      });
      freshness.recordSuccess(stream);
      clock += 31 * MIN;
      freshness.recordFailure(stream, {
        reason: "HTTP_500",
        cloudReachable: true,
      });
      expect(catalogStaleForHeartbeat(freshness.snapshot())).toEqual([
        {
          stream,
          staleSince: "2026-11-11T03:05:00.000Z",
          reason: "HTTP_500",
        },
      ]);
    },
  );

  it("a restart keeps the checkpoint's last success: the heartbeat still reports the episode", () => {
    const clock = Date.parse("2026-11-11T06:05:00.000Z");
    const freshness = createCatalogFreshness({
      now: () => new Date(clock),
      failurePersistMs: 0,
    });
    freshness.seedLastSuccess(
      "price_lists",
      new Date("2026-11-11T03:05:00.000Z"),
    );
    freshness.recordFailure("price_lists", {
      reason: "HTTP_500",
      cloudReachable: true,
    });
    expect(catalogStaleForHeartbeat(freshness.snapshot())).toEqual([
      {
        stream: "price_lists",
        staleSince: "2026-11-11T03:05:00.000Z",
        reason: "HTTP_500",
      },
    ]);
  });

  it("sends nothing while the cloud is outdated (its strict frame would drop the link)", () => {
    const snapshot = staleFreshness("CATALOG_CLOUD_OUTDATED").snapshot();
    expect(snapshot.alarmStreams).toHaveLength(1);
    expect(catalogStaleForHeartbeat(snapshot)).toEqual([]);
  });
});

describe("legend-10nex cloud notifies supervisors and owners once per episode", () => {
  it("derives one stable id per edge, stream and episode", () => {
    const id = edgeCatalogStaleAlertId(episode());
    expect(edgeCatalogStaleAlertId(episode())).toBe(id);
    expect(edgeCatalogStaleAlertId(episode({ stream: "menu_items" }))).not.toBe(
      id,
    );
    expect(
      edgeCatalogStaleAlertId(
        episode({ staleSince: "2026-11-11T05:00:00.000Z" }),
      ),
    ).not.toBe(id);
    expect(
      edgeCatalogStaleAlertId(episode({ edgeNodeId: randomUUID() })),
    ).not.toBe(id);
  });

  it("notifies the supervisor and the owner, and a repeated heartbeat adds nothing", async () => {
    await send(episode());
    const first = await notificationRows();
    expect(first.map((row) => row.user_id).sort()).toEqual(
      [supervisorUserId, ownerUserId].sort(),
    );
    expect(first[0]!.title).toBe("Katalog edge belum diperbarui");
    // Founder Q57: no longer "Penjualan tetap jalan"; after 24 hours without a
    // successful sync sales are held until the owner allows them.
    for (const row of first) {
      expect(row.body).not.toContain("Penjualan tetap jalan");
      expect(row.body).toContain("24 jam");
      expect(row.body).toContain("owner");
    }

    // The edge repeats the same episode with every heartbeat.
    await send(episode());
    await send(episode());
    expect(await notificationRows()).toHaveLength(2);
  });

  it("a different stream, or a new episode after recovery, notifies again", async () => {
    await send(episode({ stream: "menu_items" }));
    expect(await notificationRows()).toHaveLength(4);
    await send(episode({ staleSince: "2026-11-11T08:00:00.000Z" }));
    expect(await notificationRows()).toHaveLength(6);
  });

  it("Q62 reports the historical alarm without asserting that sales are currently open", async () => {
    const unproven = episode({
      reason: "CLOCK_ELAPSED_UNPROVEN",
      staleSince: "2026-11-11T09:00:00.000Z",
    });
    const before = (await notificationRows()).length;
    await send(unproven);
    await send(unproven);
    const rows = await notificationRows();
    expect(rows).toHaveLength(before + 2);
    const unprovenRows = rows.filter(
      (row) => row.title === "Usia katalog edge sempat belum dapat dibuktikan",
    );
    expect(unprovenRows.map((row) => row.user_id).sort()).toEqual(
      [supervisorUserId, ownerUserId].sort(),
    );
    for (const row of unprovenRows) {
      expect(row.body).toContain(
        "Jika tidak ada alasan lain yang menahan penjualan",
      );
      expect(row.body).toContain(
        "penjualan boleh berjalan dengan harga normal",
      );
      expect(row.body).toContain("promo dan voucher dimatikan");
      expect(row.body).toContain(
        "Alarm ini tercatat pada 2026-11-11T09:00:00.000Z",
      );
      expect(row.body).toContain("jam mundur atau katalog yang terbukti basi");
      expect(row.body).not.toContain("Penjualan tetap berjalan");
    }
  });
});

describe("legend-uvnll cloud device registry alert", () => {
  it("notifies cloud recipients once when the heartbeat is repeated", async () => {
    const identity = {
      scope: { tenantId, outletId, edgeNodeId },
      context,
      credentialHash: "test-only",
    };
    await reportCloudDeviceRegistryHardStale(identity);
    await reportCloudDeviceRegistryHardStale(identity);
    const rows = (await notificationRows()).filter(
      (row) => row.title === "Data perangkat di edge terlalu lama tidak diperbarui",
    );
    expect(rows.map((row) => row.user_id).sort()).toEqual(
      [supervisorUserId, ownerUserId].sort(),
    );
  });
});
