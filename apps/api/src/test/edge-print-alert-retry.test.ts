import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  cafeLegendFixtures,
  tenantIdSchema,
  uuidToUlid,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { createPrintAgent } from "../edge/print/agent.ts";
import { createPrintAlertNotifier } from "../edge/print/runtime.ts";
import { createDbPrintStore } from "../edge/print/store.ts";
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
const context = edgeNodeContext({ tenantId, outletId });
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
});

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
       VALUES ($1, $2, $3, 'standby', 'active', $4, $5)`,
      [nodeId, tenantId, outletId, `retry-${nodeId}`, "a".repeat(64)],
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
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      "UPDATE edge_nodes SET status = 'revoked', revoked_at = now() WHERE id = $1",
      [nodeId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

async function readDelivery(printerId: string) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const alerts = await client.query<{
      id: string;
      notification_enqueued_at: Date | null;
    }>(
      "SELECT id, notification_enqueued_at FROM edge_print_alerts WHERE subject_id = $1",
      [printerId],
    );
    const events = await client.query<{
      event: { id: string; aggregateId: string; name: string };
    }>(
      "SELECT event FROM edge_outbound_queue WHERE edge_node_id = $1 AND event->>'name' = 'print_alert.raised' AND event->'payload'->>'subjectId' = $2",
      [nodeId, printerId],
    );
    await client.query("ROLLBACK");
    return { alerts: alerts.rows, events: events.rows };
  } finally {
    client.release();
  }
}

async function pruneDeliveredEvent(printerId: string) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      "UPDATE edge_outbound_queue SET status = 'acked', acked_at = now() WHERE edge_node_id = $1 AND event->>'name' = 'print_alert.raised' AND event->'payload'->>'subjectId' = $2",
      [nodeId, printerId],
    );
    await client.query(
      "DELETE FROM edge_outbound_queue WHERE edge_node_id = $1 AND event->>'name' = 'print_alert.raised' AND event->'payload'->>'subjectId' = $2",
      [nodeId, printerId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

it.each(["queue unavailable", "transaction rollback"] as const)(
  "retries an undelivered alert after agent restart with one stable queued event (%s)",
  async (failure) => {
    const printerId = randomUUID();
    const clock = createFakeClock();
    const fake = createFakeStore(clock, [makePrinter(printerId)]);
    const transport = new FakePrinterTransport();
    const initialNotifier = createPrintAlertNotifier(context, outletId, nodeId);
    let failedAttempts = 0;
    const firstAgent = createPrintAgent({
      store: {
        ...createDbPrintStore({ db, context }),
        listPrinters: fake.listPrinters,
        getPrinter: fake.getPrinter,
        setPrinterStatus: fake.setPrinterStatus,
      },
      clock,
      transportFor: () => transport,
      notify: async (alert, tx) => {
        failedAttempts += 1;
        if (failure === "transaction rollback" && tx)
          await initialNotifier(alert, tx);
        throw new Error("outbound queue unavailable");
      },
    });
    try {
      await firstAgent.tick();
      transport.online = false;
      for (let i = 0; i < 6; i += 1) {
        clock.advance(5000);
        await firstAgent.tick();
      }
    } finally {
      await firstAgent.stop();
    }
    expect(failedAttempts).toBeGreaterThanOrEqual(2);
    const beforeRestart = await readDelivery(printerId);
    expect(beforeRestart.alerts).toHaveLength(1);
    expect(beforeRestart.alerts[0]!.notification_enqueued_at).toBeNull();
    expect(beforeRestart.events).toHaveLength(0);

    // Reconstruct both the store and notifier: no process-local retry state survives.
    const restart = () =>
      createPrintAgent({
        store: {
          ...createDbPrintStore({ db, context }),
          listPrinters: async () => [],
        },
        transportFor: () => transport,
        notify: createPrintAlertNotifier(context, outletId, nodeId),
        tickMs: 5,
      });
    const restartedAgent = restart();
    const competingAgent = restart();
    restartedAgent.start();
    competingAgent.start();
    try {
      await expect
        .poll(async () => (await readDelivery(printerId)).events.length, {
          timeout: 2000,
          interval: 20,
        })
        .toBe(1);
      // Several further health sweeps must leave exactly one outbound event.
      for (let i = 0; i < 3; i += 1)
        await Promise.all([restartedAgent.tick(), competingAgent.tick()]);
      const delivered = await readDelivery(printerId);
      expect(delivered.alerts).toHaveLength(1);
      expect(delivered.alerts[0]!.notification_enqueued_at).toBeInstanceOf(
        Date,
      );
      expect(delivered.events).toEqual([
        {
          event: expect.objectContaining({
            id: uuidToUlid(beforeRestart.alerts[0]!.id),
            aggregateId: uuidToUlid(beforeRestart.alerts[0]!.id),
            name: "print_alert.raised",
          }),
        },
      ]);
      // Successful delivery stays recorded even after the outbound queue is pruned.
      await pruneDeliveredEvent(printerId);
      await Promise.all([restartedAgent.tick(), competingAgent.tick()]);
      expect((await readDelivery(printerId)).events).toHaveLength(0);
    } finally {
      await restartedAgent.stop();
      await competingAgent.stop();
    }
  },
);

it.each(["printer_offline", "kds_down"] as const)(
  "sweeps only pending %s alerts in the agent tenant and outlet",
  async (kind) => {
    const localSubject = randomUUID();
    const otherSubject = randomUUID();
    const otherOutletContext = edgeNodeContext({
      tenantId,
      outletId: cafeLegendFixtures.outlets[1].id,
    });
    const unavailable = async () => {
      throw new Error("outbound queue unavailable");
    };
    for (const [scope, subjectId] of [
      [context, localSubject],
      [otherOutletContext, otherSubject],
    ] as const) {
      await createDbPrintStore({ db, context: scope }).recordAlert(
        {
          kind,
          subjectId,
          stationId: null,
          detail: {},
          occurredAt: new Date(),
        },
        unavailable,
      );
    }

    const transport = new FakePrinterTransport();
    const sweep = async (scope: typeof context) => {
      const agent = createPrintAgent({
        store: {
          ...createDbPrintStore({ db, context: scope }),
          listPrinters: async () => [],
        },
        transportFor: () => transport,
        notify: createPrintAlertNotifier(scope, outletId, nodeId),
      });
      try {
        await agent.tick();
      } finally {
        await agent.stop();
      }
    };

    await sweep(
      edgeNodeContext({
        tenantId: tenantIdSchema.parse(randomUUID()),
        outletId,
      }),
    );
    expect((await readDelivery(localSubject)).events).toHaveLength(0);
    expect((await readDelivery(otherSubject)).events).toHaveLength(0);

    await sweep(context);
    const delivered = await readDelivery(localSubject);
    expect(delivered.events).toHaveLength(1);
    expect(delivered.alerts[0]!.notification_enqueued_at).toBeInstanceOf(Date);
    expect(delivered.events[0]!.event).toMatchObject({
      id: uuidToUlid(delivered.alerts[0]!.id),
      aggregateId: uuidToUlid(delivered.alerts[0]!.id),
      payload: { kind, subjectId: localSubject },
    });
    // A second agent instance reads the delivery marker from persistent state.
    await sweep(context);
    expect((await readDelivery(localSubject)).events).toHaveLength(1);
    const hidden = await readDelivery(otherSubject);
    expect(hidden.alerts).toHaveLength(1);
    expect(hidden.alerts[0]!.notification_enqueued_at).toBeNull();
    expect(hidden.events).toHaveLength(0);
  },
);
