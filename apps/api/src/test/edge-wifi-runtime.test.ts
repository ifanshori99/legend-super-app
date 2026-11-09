// Wi-Fi agent lock retry (bead legend-hsk, review 1 item 3). A node whose
// boot-time advisory lock was lost to an exiting process, or whose lock
// connection died later, must come back on its own: without it nothing renews
// the guests' grants and every device is cut within hours. Real PostgreSQL
// locks; the retry delay is injected so no test waits on a real backoff.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  defaultWifiLockRetryDelayMs,
  startWifiAgent,
} from "../edge/runtime.ts";
import { wifiAgent } from "../edge/wifi/port.ts";
import { pool } from "../db/index.ts";
import type { WifiAgent } from "../services/edge-wifi-agent.service.ts";
import { seededTenantId } from "./floor-test-helpers.ts";

const scopedTo = (outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: seededTenantId,
      brandId: null,
      source: "device",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

function stubAgent() {
  const stub = {
    applySession: vi.fn(),
    endSession: vi.fn(),
    listLiveGrants: vi.fn(),
    walledGarden: vi.fn(),
    reconcile: vi.fn(async () => ({
      authorized: 0,
      downgraded: 0,
      renewed: 0,
      revoked: 0,
      failed: 0,
    })),
  };
  return stub as typeof stub & WifiAgent;
}

const installed = (stub: WifiAgent) => {
  try {
    return wifiAgent() === stub;
  } catch {
    return false;
  }
};

describe("legend-hsk Wi-Fi agent lock retry", () => {
  const handles: { stop(): Promise<void> }[] = [];
  const holders: PoolClient[] = [];
  const lockSql = "SELECT pg_try_advisory_lock(hashtextextended($1, 0))";
  const unlockSql = "SELECT pg_advisory_unlock(hashtextextended($1, 0))";
  const lockNameOf = (outletId: string) =>
    `wifi-agent:${seededTenantId}:${outletId}`;

  async function start(
    outletId: string,
    agent: WifiAgent,
    extra: Partial<Parameters<typeof startWifiAgent>[0]> = {},
  ) {
    const handle = await startWifiAgent({
      context: scopedTo(outletId),
      scope: {
        tenantId: seededTenantId,
        outletId: outletIdSchema.parse(outletId),
        edgeNodeId: randomUUID(),
      },
      role: "primary",
      intervalMs: 3_600_000,
      retryDelayMs: () => 5,
      agent,
      ...extra,
    });
    if (handle) handles.push(handle);
    return handle;
  }
  /** Another process owning the outlet lock. */
  async function hold(outletId: string) {
    const client = await pool.connect();
    holders.push(client);
    const result = await client.query(`${lockSql} AS locked`, [
      lockNameOf(outletId),
    ]);
    expect(result.rows[0].locked).toBe(true);
    return client;
  }
  async function free(client: PoolClient, outletId: string) {
    await client.query(unlockSql, [lockNameOf(outletId)]);
  }
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
    for (const holder of holders.splice(0)) holder.release(true);
  });

  it("the default backoff grows and is capped", () => {
    expect(defaultWifiLockRetryDelayMs(0)).toBe(1_000);
    expect(defaultWifiLockRetryDelayMs(1)).toBe(2_000);
    expect(defaultWifiLockRetryDelayMs(20)).toBe(30_000);
  });

  it("a boot that loses the lock keeps retrying and installs the agent once the owner exits", async () => {
    const outletId = randomUUID();
    const stub = stubAgent();
    const other = await hold(outletId);
    const retryDelayMs = vi.fn(() => 5);
    const handle = await start(outletId, stub, {
      retryDelayMs,
      intervalMs: 20,
    });
    expect(handle).not.toBeNull();
    expect(installed(stub)).toBe(false);
    await vi.waitFor(() =>
      expect(retryDelayMs.mock.calls.length).toBeGreaterThan(1),
    );
    expect(installed(stub)).toBe(false);
    expect(stub.reconcile).not.toHaveBeenCalled();

    await free(other, outletId);
    await vi.waitFor(() => expect(installed(stub)).toBe(true));
    await vi.waitFor(() => expect(stub.reconcile).toHaveBeenCalled());
  });

  it("a lost database connection uninstalls the agent and it comes back on a new connection", async () => {
    const outletId = randomUUID();
    const stub = stubAgent();
    const clients: PoolClient[] = [];
    const handle = await start(outletId, stub, {
      connect: async () => {
        const client = await pool.connect();
        clients.push(client);
        return client;
      },
    });
    expect(handle).not.toBeNull();
    expect(installed(stub)).toBe(true);
    expect(clients).toHaveLength(1);

    clients[0]!.emit("error", new Error("connection terminated"));
    expect(installed(stub)).toBe(false);
    await vi.waitFor(() => expect(clients.length).toBe(2));
    await vi.waitFor(() => expect(installed(stub)).toBe(true));
  });

  it("a connect or lock failure is retried too, without throwing", async () => {
    const outletId = randomUUID();
    const stub = stubAgent();
    let calls = 0;
    const handle = await start(outletId, stub, {
      connect: async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection refused");
        return pool.connect();
      },
    });
    expect(handle).not.toBeNull();
    await vi.waitFor(() => expect(installed(stub)).toBe(true));
    expect(calls).toBe(2);
  });

  it("stop() ends the retries cleanly and a later free lock is not taken", async () => {
    const outletId = randomUUID();
    const stub = stubAgent();
    const other = await hold(outletId);
    const connect = vi.fn(() => pool.connect());
    const handle = await start(outletId, stub, { connect });
    await vi.waitFor(() =>
      expect(connect.mock.calls.length).toBeGreaterThan(1),
    );
    await handle!.stop();
    const calls = connect.mock.calls.length;

    await free(other, outletId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(connect.mock.calls.length).toBe(calls);
    expect(installed(stub)).toBe(false);
  });

  it("stop() while a retry is taking the lock gives the lock back and installs nothing", async () => {
    const outletId = randomUUID();
    const stub = stubAgent();
    const other = await hold(outletId);
    let gate!: (client: PoolClient) => void;
    const connect = vi
      .fn<() => Promise<PoolClient>>()
      .mockImplementationOnce(() => pool.connect())
      .mockImplementation(
        () =>
          new Promise<PoolClient>((resolve) => {
            gate = resolve;
          }),
      );
    const handle = await start(outletId, stub, { connect });
    await vi.waitFor(() => expect(connect.mock.calls.length).toBe(2));
    await free(other, outletId);
    const stopping = handle!.stop();
    gate(await pool.connect());
    await stopping;
    expect(installed(stub)).toBe(false);
    // The lock is free: nothing was left holding it.
    const probe = await pool.connect();
    holders.push(probe);
    const result = await probe.query(`${lockSql} AS locked`, [
      lockNameOf(outletId),
    ]);
    expect(result.rows[0].locked).toBe(true);
  });
});
