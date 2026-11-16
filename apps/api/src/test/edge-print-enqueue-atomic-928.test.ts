// legend-2lp.2 / legend-2lp.4: enqueue from a caller transaction must not
// dispatch before commit or leave a printable job behind after rollback.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createPrintAgent } from "../edge/print/agent.ts";
import { createDbPrintStore } from "../edge/print/store.ts";
import { FakePrinterTransport } from "../edge/print/transport.ts";
import type { NewPrintJob } from "../edge/print/types.ts";

const tenantId = cafeLegendFixtures.tenant.id;
const outletId = cafeLegendFixtures.outlets[0].id;
const context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "outlets", outletIds: [outletId] },
);
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const printerId = randomUUID();

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
      `INSERT INTO edge_printers
         (id, tenant_id, outlet_id, label, role, transport, host, port, paper_width)
       VALUES ($1, $2, $3, 'Atomic receipt 928', 'receipt', 'network', '192.168.1.50', 9100, 48)`,
      [printerId, tenantId, outletId],
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

function fixture() {
  const transport = new FakePrinterTransport();
  const store = createDbPrintStore({ db, context });
  const agent = createPrintAgent({ store, transportFor: () => transport });
  const key = `atomic-928-${randomUUID()}`;
  const job: NewPrintJob = {
    printerId,
    kind: "receipt",
    content: Buffer.from("\x1b\x40Receipt atomic 928\n"),
    idempotencyKey: key,
  };
  return { transport, store, agent, key, job };
}

describe("Print Agent caller transaction atomicity (928)", () => {
  it("does not print or retain a receipt job when its caller rolls back", async () => {
    const { transport, store, agent, key, job } = fixture();
    try {
      await expect(
        withTenant(db, context, async (tx) => {
          // Reflect.apply lets this regression run on the old one-argument
          // method, exposing the behavior instead of a TypeScript arity error.
          await Reflect.apply(agent.enqueue, agent, [job, tx]);
          throw new Error("Receipt transaction rolled back");
        }),
      ).rejects.toThrow("Receipt transaction rolled back");
      await agent.stop();
      const jobs = await store.listJobs({ limit: 100 });
      expect(jobs.items.filter((row) => row.idempotencyKey === key)).toEqual(
        [],
      );
      expect(transport.printed).toHaveLength(0);
    } finally {
      await agent.stop();
    }
  });

  it("defers transport until commit, then a normal drain prints exactly once", async () => {
    const { transport, store, agent, key, job } = fixture();
    try {
      await withTenant(db, context, async (tx) => {
        await Reflect.apply(agent.enqueue, agent, [job, tx]);
        await agent.drain(printerId);
        expect(transport.printed).toHaveLength(0);
      });
      await agent.drain(printerId);
      await agent.stop();
      expect(transport.printed).toHaveLength(1);
      const jobs = await store.listJobs({ limit: 100 });
      expect(
        jobs.items.filter((row) => row.idempotencyKey === key),
      ).toMatchObject([{ status: "printed", attempts: 1 }]);
    } finally {
      await agent.stop();
    }
  });
});
