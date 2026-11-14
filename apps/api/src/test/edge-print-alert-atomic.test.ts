import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { createDbPrintStore } from "../edge/print/store.ts";
import { createPrintAlertNotifier } from "../edge/print/runtime.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";

const tenantId = cafeLegendFixtures.tenant.id;
const outletId = cafeLegendFixtures.outlets[0].id;
const nodeId = randomUUID();
const subjectId = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
});
const context = edgeNodeContext({ tenantId, outletId });

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash)
       VALUES ($1, $2, $3, 'primary', 'active', $4, $5)`,
      [nodeId, tenantId, outletId, `atomic-${nodeId}`, "a".repeat(64)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await owner.end();
});

it("preserves the local alert without a queued event when notification fails", async () => {
  const store = createDbPrintStore({ db, context });
  const notifier = createPrintAlertNotifier(context, outletId, nodeId);
  await expect(
    store.recordAlert(
      {
        kind: "printer_offline",
        subjectId,
        stationId: null,
        detail: {},
        occurredAt: new Date(),
      },
      async (alert, tx) => {
        await notifier(alert, tx);
        throw new Error("notification failed after enqueue");
      },
    ),
  ).resolves.toBe(true);

  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const alerts = await client.query(
      "SELECT id FROM edge_print_alerts WHERE subject_id = $1",
      [subjectId],
    );
    const events = await client.query(
      "SELECT event_id FROM edge_outbound_queue WHERE edge_node_id = $1",
      [nodeId],
    );
    expect(alerts.rowCount).toBe(1);
    expect(events.rowCount).toBe(0);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});
