// Review round 2, card G1 (legend-bod, docs/briefs/bod-emergency-impl.md): a
// cloud resolve (OM/GM) closes the alert on the edge. `resolveEmergencyAlert`
// queues one `panic_alert.resolved` event cloud -> edge on the same
// transaction, only when the resolve really changed the alert (a re-resolve is
// 409 and queues nothing) and only when the outlet has an active edge node.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { resolveEmergencyAlert } from "../services/panic-alert-cloud.service.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const tenantContext = establishTenantContext({
  tenantId: tenant.id,
  brandId: null,
  source: "session",
});
const outletScope = (id: string) =>
  establishScopedTenantContext(tenantContext, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(id)],
  });

const deviceIds: string[] = [];
const resolver = randomUUID();

async function asTenantOwner<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
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

async function seedOutlet(label: string, withEdgeNode: boolean) {
  const id = randomUUID();
  const nodeId = randomUUID();
  await asTenantOwner(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `FD-${id.slice(0, 8)}`.toUpperCase(),
        label,
      ],
    );
    if (withEdgeNode)
      await client.query(
        `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash)
         VALUES ($1, $2, $3, 'primary', 'active', $4, $5)`,
        [nodeId, tenant.id, id, label, "a".repeat(64)],
      );
  });
  return { outlet: id, nodeId };
}

async function insertAlert(outlet: string) {
  const deviceId = randomUUID();
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'panic_button', 'Perangkat FD', now())`,
      [deviceId, tenant.id, outlet],
    ),
  );
  deviceIds.push(deviceId);
  const id = randomUUID();
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO panic_alerts (id, tenant_id, outlet_id, device_id, first_device_event_id,
                                 unit_code_snapshot, facility_name_snapshot, device_label_snapshot, received_at)
       VALUES ($1, $2, $3, $4, $5, 'P1', 'Fasilitas FD', 'Tombol FD', now())`,
      [id, tenant.id, outlet, deviceId, `evt-${id}`],
    ),
  );
  return id;
}

async function queuedFor(alertId: string) {
  return (
    await asTenantOwner((client) =>
      client.query<{
        direction: string;
        edge_node_id: string;
        aggregate_type: string;
        aggregate_sequence: string;
        event: {
          name: string;
          aggregateId: string;
          payload: Record<string, unknown>;
        };
      }>(
        "SELECT direction, edge_node_id, aggregate_type, aggregate_sequence, event FROM edge_outbound_queue WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY link_seq",
        [tenant.id, alertId],
      ),
    )
  ).rows;
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  try {
    await owner.query(
      "DELETE FROM devices WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, deviceIds],
    );
  } catch {
    // Best effort: every row uses random ids that no other file touches.
  }
  await owner.end();
});

describe("G1 cloud resolve queues panic_alert.resolved cloud -> edge", () => {
  it("queues exactly one resolved event for the edge node of the outlet", async () => {
    const { outlet, nodeId } = await seedOutlet("FD resolve", true);
    const alertId = await insertAlert(outlet);
    const dto = await resolveEmergencyAlert(
      outletScope(outlet),
      outlet,
      alertId,
      resolver,
      "Aman, tamu sudah dibantu",
    );
    const rows = await queuedFor(alertId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.direction).toBe("cloud_to_edge");
    expect(row.edge_node_id).toBe(nodeId);
    expect(row.aggregate_type).toBe("panic_alert");
    expect(Number(row.aggregate_sequence)).toBe(1);
    expect(row.event.name).toBe("panic_alert.resolved");
    expect(row.event.aggregateId).toBe(alertId);
    expect(row.event.payload).toEqual({
      alertId,
      resolvedBy: resolver,
      resolvedAt: dto.resolvedAt,
      resolutionNote: "Aman, tamu sudah dibantu",
    });
  });

  it("a re-resolve is 409 and queues nothing more", async () => {
    const { outlet } = await seedOutlet("FD re-resolve", true);
    const alertId = await insertAlert(outlet);
    await resolveEmergencyAlert(
      outletScope(outlet),
      outlet,
      alertId,
      resolver,
      "Selesai",
    );
    await expect(
      resolveEmergencyAlert(
        outletScope(outlet),
        outlet,
        alertId,
        resolver,
        "Lagi",
      ),
    ).rejects.toMatchObject({ status: 409, code: "ALREADY_RESOLVED" });
    expect(await queuedFor(alertId)).toHaveLength(1);
  });

  it("an outlet without an edge node queues nothing", async () => {
    const { outlet } = await seedOutlet("FD cloud only", false);
    const alertId = await insertAlert(outlet);
    const dto = await resolveEmergencyAlert(
      outletScope(outlet),
      outlet,
      alertId,
      resolver,
      "Selesai",
    );
    expect(dto.resolvedAt).not.toBeNull();
    expect(await queuedFor(alertId)).toHaveLength(0);
  });
});
