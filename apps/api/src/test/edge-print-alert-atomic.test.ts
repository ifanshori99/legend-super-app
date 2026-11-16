import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { createDbPrintStore } from "../edge/print/store.ts";
import { createPrintAlertNotifier } from "../edge/print/runtime.ts";
import { createPrintAgent } from "../edge/print/agent.ts";
import { FakePrinterTransport } from "../edge/print/transport.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";
import {
  createFakeClock,
  createFakeStore,
  makePrinter,
} from "./edge-print-fakes.ts";

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
    // Only one active primary node may exist per outlet. A test file that ran
    // earlier in the same database can have left its node active (the order of
    // files is not fixed), so retire any such node before adding this one.
    await client.query(
      `UPDATE edge_nodes SET status = 'revoked', revoked_at = now()
        WHERE tenant_id = $1 AND outlet_id = $2 AND role = 'primary' AND status = 'active'`,
      [tenantId, outletId],
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
  // Do not leave an active primary node behind for the next file (see above).
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      "UPDATE edge_nodes SET status = 'revoked', revoked_at = now() WHERE id = $1 AND status = 'active'",
      [nodeId],
    );
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
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
  ).resolves.toBe(false);

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

it("retries a transient enqueue failure and queues exactly one print alert", async () => {
  const printerId = randomUUID();
  const clock = createFakeClock();
  const store = createFakeStore(clock, [makePrinter(printerId)]);
  const dbStore = createDbPrintStore({ db, context });
  store.recordAlert = dbStore.recordAlert;
  const transport = new FakePrinterTransport();
  const notifier = createPrintAlertNotifier(context, outletId, nodeId);
  let attempts = 0;
  const agent = createPrintAgent({
    store,
    clock,
    transportFor: () => transport,
    notify: async (alert, tx) => {
      attempts += 1;
      await notifier(alert, tx);
      if (attempts === 1) throw new Error("transient enqueue failure");
    },
  });
  await agent.tick();
  transport.online = false;
  for (let i = 0; i < 6; i += 1) {
    clock.advance(5000);
    await agent.tick();
  }
  await agent.stop();

  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const alerts = await client.query(
      "SELECT id FROM edge_print_alerts WHERE subject_id = $1",
      [printerId],
    );
    const events = await client.query(
      "SELECT event_id FROM edge_outbound_queue WHERE edge_node_id = $1 AND event->>'name' = 'print_alert.raised'",
      [nodeId],
    );
    expect(attempts).toBe(2);
    expect(alerts.rowCount).toBe(1);
    expect(events.rowCount).toBe(1);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});

it("deduplicates repeated notification of the same alert", async () => {
  const printerId = randomUUID();
  const notifier = createPrintAlertNotifier(context, outletId, nodeId);
  const alert = {
    kind: "printer_offline" as const,
    subjectId: printerId,
    stationId: null,
    detail: {},
    occurredAt: new Date(),
  };
  await notifier(alert);
  await notifier(alert);

  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const events = await client.query(
      "SELECT event_id FROM edge_outbound_queue WHERE edge_node_id = $1 AND event->'payload'->>'subjectId' = $2",
      [nodeId, printerId],
    );
    expect(events.rowCount).toBe(1);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});
