import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createUlid, outletIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { createPrintAgent } from "../edge/print/agent.ts";
import {
  getEdgePrintAgent,
  startEdgePrintAgent,
} from "../edge/print/runtime.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { FakePrinterTransport } from "../edge/print/transport.ts";
import {
  createFakeClock,
  createFakeStore,
  makePrinter,
} from "./edge-print-fakes.ts";
import { agent as httpAgent, originHeader } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  staffOfIsolatedTenant,
} from "./floor-test-helpers.ts";
import { asCashierTenant } from "./pos-cashier-test-helpers.ts";

afterAll(async () => {
  await owner.end();
});

describe("legend-2lp.3 KDS fallback integration", () => {
  it("routes persistent backlog on each tick, waits 15 seconds, and queues one marked station ticket", async () => {
    const clock = createFakeClock();
    const store = createFakeStore(clock, [
      makePrinter("bar-printer", { role: "station", stationId: "bar" }),
    ]);
    const transport = new FakePrinterTransport();
    let pending = true;
    const agent = createPrintAgent({
      store,
      clock,
      transportFor: () => transport,
      sweepStationTickets: async (route) => {
        if (!pending) return;
        const result = await route({
          stationId: "bar",
          sourceRef: "ticket-1",
          idempotencyKey: "kds-fallback:ticket-1",
          ticket: {
            stationName: "Bar",
            ticketNumber: "K-001",
            orderLabel: "Meja 4",
            createdAt: clock.now(),
            items: [{ name: "Kopi", qty: 2 }],
          },
        });
        if (result.printed) pending = false;
      },
    });
    agent.recordKdsHeartbeat("bar");
    await agent.tick();
    clock.advance(14_999);
    await agent.tick();
    expect(store.jobs).toHaveLength(0);
    clock.advance(2);
    await agent.tick();
    await agent.tick();
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]).toMatchObject({
      sourceRef: "ticket-1",
      printedFallback: true,
      fallbackReason: "kds_down",
    });
    expect(new TextDecoder().decode(store.jobs[0]!.content)).toContain(
      "KDS MATI",
    );
    expect(transport.printed).toHaveLength(1);
  });

  it("accepts only an authenticated, authorized station heartbeat at its outlet", async () => {
    const app = createApp();
    const tenant = await createIsolatedTenant(
      `kds-hb-${randomUUID().slice(0, 6)}`,
    );
    await owner.query("UPDATE roles SET permissions = $2 WHERE id = $1", [
      tenant.roleId,
      JSON.stringify(["kds.ticket.process"]),
    ]);
    const staff = await staffOfIsolatedTenant(app, tenant);
    const stationId = randomUUID();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.tenantId],
      );
      await client.query(
        "INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Bar heartbeat', 'coffee_bar')",
        [stationId, tenant.tenantId, tenant.outletId],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const path = `/api/outlets/${tenant.outletId}/kitchen/stations/${stationId}/heartbeat`;
    const headers = { Host: tenant.hostname };
    const anonymous = await httpAgent(app)
      .post(path)
      .set(headers)
      .set(originHeader)
      .send({});
    expect(anonymous.status).toBe(401);
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenant.tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
    );
    const previousRuntime = getEdgeRuntimeState();
    setEdgeRuntimeStateForTests({
      ...previousRuntime,
      edgeMode: true,
      identity: {
        context,
        scope: {
          tenantId: tenant.tenantId,
          outletId: tenant.outletId,
          edgeNodeId: randomUUID(),
        },
      },
    });
    const handle = startEdgePrintAgent();
    const printAgent = getEdgePrintAgent()!;
    printAgent.monitor.recordKdsHeartbeat(
      stationId,
      new Date(Date.now() - 20_000),
    );
    expect(printAgent.monitor.isKdsUp(stationId)).toBe(false);
    try {
      const allowed = await staff.client
        .post(path)
        .set(headers)
        .set(originHeader)
        .send({});
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      expect(allowed.body.data.recorded).toBe(true);
      expect(printAgent.monitor.isKdsUp(stationId)).toBe(true);
      const edgeRuntime = getEdgeRuntimeState();
      printAgent.monitor.recordKdsHeartbeat(
        stationId,
        new Date(Date.now() - 20_000),
      );
      setEdgeRuntimeStateForTests({
        ...edgeRuntime,
        identity: {
          context,
          scope: {
            tenantId: tenant.tenantId,
            outletId: randomUUID(),
            edgeNodeId: randomUUID(),
          },
        },
      });
      const wrongEdge = await staff.client
        .post(path)
        .set(headers)
        .set(originHeader)
        .send({});
      expect(wrongEdge.status).toBe(200);
      expect(wrongEdge.body.data.recorded).toBe(false);
      expect(printAgent.monitor.isKdsUp(stationId)).toBe(false);
      setEdgeRuntimeStateForTests(edgeRuntime);
      const untrusted = await staff.client
        .post(path)
        .set(headers)
        .set("Origin", "https://untrusted.example")
        .send({});
      expect(untrusted.status).toBe(403);
      const invalid = await staff.client
        .post(path)
        .set(headers)
        .set(originHeader)
        .send({ stationId: randomUUID() });
      expect(invalid.status).toBe(422);
      const denied = await staff.client
        .post(
          `/api/outlets/${tenant.outletId}/kitchen/stations/${randomUUID()}/heartbeat`,
        )
        .set(headers)
        .set(originHeader)
        .send({});
      expect([403, 404]).toContain(denied.status);
      const other = await createIsolatedTenant(
        `kds-hb-other-${randomUUID().slice(0, 6)}`,
      );
      const otherStaff = await staffOfIsolatedTenant(app, other);
      const noPermission = await otherStaff.client
        .post(
          `/api/outlets/${other.outletId}/kitchen/stations/${stationId}/heartbeat`,
        )
        .set({ Host: other.hostname })
        .set(originHeader)
        .send({});
      expect([403, 404]).toContain(noPermission.status);
      const wrongOutlet = await staff.client
        .post(
          `/api/outlets/${other.outletId}/kitchen/stations/${stationId}/heartbeat`,
        )
        .set(headers)
        .set(originHeader)
        .send({});
      expect([403, 404]).toContain(wrongOutlet.status);
      await owner.query("UPDATE roles SET permissions = '[]' WHERE id = $1", [
        tenant.roleId,
      ]);
      const missingPermission = await staff.client
        .post(path)
        .set(headers)
        .set(originHeader)
        .send({});
      expect(missingPermission.status).toBe(403);
    } finally {
      await handle.stop();
      setEdgeRuntimeStateForTests(previousRuntime);
    }
  });

  it("prints only eligible unbumped backlog and reuses the job when its marker is retried", async () => {
    const { createKdsPrintFallback } =
      await import("../edge/print/kds-fallback.ts");
    const tenant = await createIsolatedTenant(
      `kds-print-${randomUUID().slice(0, 6)}`,
    );
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenant.tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
    );
    const bar = randomUUID();
    const disabled = randomUUID();
    const category = randomUUID();
    const menuItem = randomUUID();
    const orderId = createUlid();
    const fixtureNowMs = Date.now();
    const heartbeatAt = new Date(fixtureNowMs - 8 * 60 * 60 * 1000);
    const clock = createFakeClock(heartbeatAt.getTime());
    // Open, in-progress, done, disabled, already printed, expired, already
    // seen at the last heartbeat, all voided, and all served respectively.
    const ticketIds = Array.from({ length: 9 }, () => createUlid());
    await asCashierTenant(tenant.tenantId, async (client) => {
      for (const [stationId, enabled] of [
        [bar, true],
        [disabled, false],
      ] as const)
        await client.query(
          "INSERT INTO stations (id, tenant_id, outlet_id, name, type, auto_print_fallback) VALUES ($1,$2,$3,$5,'coffee_bar',$4)",
          [stationId, tenant.tenantId, tenant.outletId, enabled, stationId],
        );
      await client.query(
        "INSERT INTO menu_categories (id,tenant_id,brand_id,name,sort_order) VALUES ($1,$2,$3,'Fallback',0)",
        [category, tenant.tenantId, tenant.brandId],
      );
      await client.query(
        "INSERT INTO menu_items (id,tenant_id,brand_id,category_id,name,course,media_id) VALUES ($1,$2,$3,$4,'Kopi backlog','drink',$5)",
        [menuItem, tenant.tenantId, tenant.brandId, category, randomUUID()],
      );
      await client.query(
        "INSERT INTO orders (id,tenant_id,outlet_id,number,channel,service_type,payment_mode,subtotal_idr,discount_idr,service_charge_idr,tax_idr,rounding_idr,total_idr,status,business_date,placed_at) VALUES ($1,$2,$3,'POS-KDS-BACKLOG','pos','takeaway','open_bill',0,0,0,0,0,0,'sent','2026-11-14',now())",
        [ulidToUuid(orderId), tenant.tenantId, tenant.outletId],
      );
      for (const [index, id] of ticketIds.entries()) {
        const itemId = createUlid();
        await client.query(
          "INSERT INTO order_items (id,tenant_id,outlet_id,order_id,menu_item_id,name,quantity,unit_price_idr,modifiers_total_idr,line_total_idr,fire_status,status,reserved_business_date) VALUES ($1,$2,$3,$4,$5,'Kopi backlog',1,0,0,0,'fired','queued','2026-11-14')",
          [
            ulidToUuid(itemId),
            tenant.tenantId,
            tenant.outletId,
            ulidToUuid(orderId),
            menuItem,
          ],
        );
        await client.query(
          "INSERT INTO kitchen_tickets (id,tenant_id,outlet_id,order_id,station_id,fire_batch_id,business_date,ticket_no,status,fired_at,printed_fallback) VALUES ($1,$2,$3,$4,$5,$6,'2026-11-14',$7,$8,$10,$9)",
          [
            ulidToUuid(id),
            tenant.tenantId,
            tenant.outletId,
            ulidToUuid(orderId),
            index === 3 ? disabled : bar,
            ulidToUuid(createUlid()),
            index + 1,
            index === 2 ? "done" : index === 1 ? "in_progress" : "new",
            index === 4,
            new Date(
              fixtureNowMs +
                (index === 5
                  ? -7 * 60 * 60 * 1000
                  : index === 6
                    ? -8 * 60 * 60 * 1000 - 1
                    : index + 1),
            ),
          ],
        );
        if (index === 1 || index === 2)
          await client.query(
            "UPDATE kitchen_tickets SET started_at=now(), done_at=CASE WHEN status='done' THEN now() ELSE NULL END WHERE id=$1",
            [ulidToUuid(id)],
          );
        await client.query(
          "INSERT INTO kitchen_ticket_items (id,tenant_id,outlet_id,ticket_id,order_id,order_item_id,menu_item_id,name,quantity,status,fired_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'Kopi backlog',1,'queued',now())",
          [
            ulidToUuid(createUlid()),
            tenant.tenantId,
            tenant.outletId,
            ulidToUuid(id),
            ulidToUuid(orderId),
            ulidToUuid(itemId),
            menuItem,
          ],
        );
        if (index === 7 || index === 8)
          await client.query(
            "UPDATE kitchen_ticket_items SET status=$2::varchar, started_at=CASE WHEN $2::varchar='served' THEN now() END, ready_at=CASE WHEN $2::varchar='served' THEN now() END, served_at=CASE WHEN $2::varchar='served' THEN now() END WHERE ticket_id=$1",
            [ulidToUuid(id), index === 7 ? "voided" : "served"],
          );
      }
    });
    const store = createFakeStore(clock, [
      makePrinter("bar-printer", {
        role: "station",
        stationId: bar,
        tenantId: tenant.tenantId,
        outletId: tenant.outletId,
      }),
    ]);
    const transport = new FakePrinterTransport();
    const sweep = createKdsPrintFallback({
      db,
      context,
      outletId: outletIdSchema.parse(tenant.outletId),
    });
    const routedRefs: (string | undefined)[] = [];
    const agent = createPrintAgent({
      store,
      clock,
      transportFor: () => transport,
      sweepStationTickets: async (route, ...rest) =>
        sweep(
          async (input) => {
            routedRefs.push(input.sourceRef);
            return route(input);
          },
          ...rest,
        ),
    });
    const tupleLocks = () =>
      asCashierTenant(tenant.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string; lockTx: string }>(
          'SELECT id, xmax::text AS "lockTx" FROM kitchen_tickets WHERE tenant_id=$1 ORDER BY id',
          [tenant.tenantId],
        );
        return rows;
      });
    const beforeHealthySweep = await tupleLocks();
    await agent.tick();
    expect.soft(await tupleLocks()).toEqual(beforeHealthySweep);
    expect.soft(routedRefs).toHaveLength(0);
    agent.recordKdsHeartbeat(bar);
    await agent.tick();
    // FOR UPDATE leaves its locking transaction in xmax, even when it
    // commits without UPDATE. Healthy screens must never acquire that lock.
    expect.soft(await tupleLocks()).toEqual(beforeHealthySweep);
    expect.soft(routedRefs).toHaveLength(0);
    clock.advance(14_999);
    await agent.tick();
    expect.soft(store.jobs).toHaveLength(0);
    clock.advance(8 * 60 * 60 * 1000 - 14_999 + 20_000);
    await agent.tick();
    await agent.tick();
    expect
      .soft(store.jobs.map((job) => job.sourceRef).sort())
      .toEqual(ticketIds.slice(0, 2).sort());
    expect.soft(transport.printed).toHaveLength(2);
    expect.soft(routedRefs).not.toContain(ticketIds[5]);
    expect.soft(routedRefs).not.toContain(ticketIds[6]);
    expect.soft(routedRefs).not.toContain(ticketIds[7]);
    expect.soft(routedRefs).not.toContain(ticketIds[8]);
    await asCashierTenant(tenant.tenantId, async (client) => {
      const result = await client.query(
        "SELECT id,printed_fallback FROM kitchen_tickets WHERE tenant_id=$1 ORDER BY ticket_no",
        [tenant.tenantId],
      );
      expect
        .soft(result.rows.map((row) => row.printed_fallback))
        .toEqual([true, true, false, false, true, false, false, false, false]);
      await client.query(
        "UPDATE kitchen_tickets SET printed_fallback=false WHERE id=$1",
        [ulidToUuid(ticketIds[0]!)],
      );
    });
    await agent.tick();
    expect.soft(store.jobs).toHaveLength(2);
    expect.soft(transport.printed).toHaveLength(2);
  });
});
