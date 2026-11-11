import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../lib/logger.ts";
import { startEdgeAuditRetention } from "./audit-retention.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PRIVATE = "private-url-password-audit-payload";
const source = {
  NODE_ENV: "test",
  MAINTENANCE_DATABASE_URL: "postgres://maint:secret@example.test/edge",
};
const DUE = "SELECT app.audit_retention_due_tenants() AS tenant_id";
const PURGE = "SELECT app.purge_audit_retention_batch($1, $2) AS deleted";

function fakePool() {
  const release = vi.fn();
  return {
    release,
    connect: vi.fn(async () => ({ release })),
    end: vi.fn(async () => undefined),
    query: vi.fn(
      async (
        text: string,
        _values?: unknown[],
      ): Promise<{ rows: Record<string, unknown>[] }> => {
        void _values;
        if (text === DUE) return { rows: [{ tenant_id: TENANT }] };
        expect(text).toBe(PURGE);
        return { rows: [{ deleted: "3" }] };
      },
    ),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("legend-0cqql edge audit retention lifecycle", () => {
  it("skips an unconfigured nonproduction edge", async () => {
    const pool = fakePool();
    expect(
      await startEdgeAuditRetention({ source: { NODE_ENV: "test" }, pool }),
    ).toBeNull();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("requires a configured maintenance connection in production", async () => {
    await expect(
      startEdgeAuditRetention({
        source: { NODE_ENV: "production" },
        pool: fakePool(),
      }),
    ).rejects.toThrow("MAINTENANCE_DATABASE_URL");
  });

  it("probes the maintenance login, purges immediately, schedules daily, and closes its pool", async () => {
    const pool = fakePool();
    const setTimer = vi.fn((_fn: () => void, _ms: number) => {
      void _fn;
      void _ms;
      return "timer";
    });
    const clearTimer = vi.fn();
    const handle = await startEdgeAuditRetention({
      source,
      pool,
      setTimer,
      clearTimer,
    });
    expect(handle).not.toBeNull();
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.release).toHaveBeenCalledTimes(1);
    const result = await handle!.runOnce();
    expect(result).toMatchObject({ tenants: 1, deleted: 3, failedTenants: 0 });
    expect(pool.query).toHaveBeenCalledWith(PURGE, [TENANT, 1000]);
    expect(setTimer).toHaveBeenCalledWith(
      expect.any(Function),
      24 * 60 * 60_000,
    );
    await handle!.stop();
    expect(clearTimer).toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledTimes(1);
    const calls = pool.query.mock.calls.length;
    expect(await handle!.runOnce()).toBeNull();
    expect(pool.query).toHaveBeenCalledTimes(calls);
  });

  it("shares an in-flight sweep and waits for it during shutdown", async () => {
    const pool = fakePool();
    let finish!: (value: { rows: Record<string, unknown>[] }) => void;
    pool.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const setTimer = vi.fn((_fn: () => void, _ms: number) => {
      void _fn;
      void _ms;
      return "timer";
    });
    const handle = await startEdgeAuditRetention({
      source,
      pool,
      setTimer,
      clearTimer: vi.fn(),
    });
    expect(handle).not.toBeNull();
    const a = handle!.runOnce();
    const b = handle!.runOnce();
    expect(pool.query).toHaveBeenCalledTimes(1);
    const stopped = handle!.stop();
    await Promise.resolve();
    expect(pool.end).not.toHaveBeenCalled();
    finish({ rows: [] });
    await Promise.all([a, b, stopped]);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("closes a failed startup probe and never exposes the connection error", async () => {
    const pool = fakePool();
    pool.connect.mockRejectedValueOnce(new Error(PRIVATE));
    const error = await startEdgeAuditRetention({ source, pool }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(PRIVATE);
    expect((error as Error).cause).toBeUndefined();
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("reports purge failure without logging tenant ids, URLs or payloads", async () => {
    const pool = fakePool();
    pool.query.mockImplementation(async (text: string) => {
      if (text === DUE) return { rows: [{ tenant_id: TENANT }] };
      throw new Error(PRIVATE);
    });
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const handle = await startEdgeAuditRetention({
      source,
      pool,
      setTimer: () => "timer",
      clearTimer: () => undefined,
    });
    expect(handle).not.toBeNull();
    const result = await handle!.runOnce();
    expect(result).toMatchObject({ failedTenants: 1, deleted: 0 });
    const logged = JSON.stringify([...error.mock.calls, ...warn.mock.calls]);
    expect(error.mock.calls.length + warn.mock.calls.length).toBeGreaterThan(0);
    expect(logged).not.toContain(TENANT);
    expect(logged).not.toContain(PRIVATE);
    expect(logged).not.toContain(source.MAINTENANCE_DATABASE_URL);
    await handle!.stop();
  });
});
