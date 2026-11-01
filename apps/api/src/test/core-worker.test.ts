import { describe, expect, it, vi } from "vitest";
import { createWorkerRuntime } from "../worker/runtime";

describe("outbox worker", () => {
  it("rechecks authorization before delivering a tenant job", async () => {
    let handler: ((jobs: { data: unknown }[]) => Promise<void>) | undefined;
    const boss = {
      start: vi.fn(async () => {}),
      createQueue: vi.fn(async () => {}),
      work: vi.fn(async (_name: string, callback: typeof handler) => {
        handler = callback;
      }),
      send: vi.fn(async () => "job-id"),
      stop: vi.fn(async () => {}),
    };
    const context = { tenant: "tenant" };
    const authorize = vi.fn(async () => false);
    const deliver = vi.fn(async () => {});
    const runtime = createWorkerRuntime({
      boss,
      resolveContext: async () => context,
      authorize,
      deliver,
    });
    await runtime.start();
    const job = {
      tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      outboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    await expect(handler!([{ data: job }])).rejects.toThrow("permission");
    expect(deliver).not.toHaveBeenCalled();
    authorize.mockResolvedValue("allowed" as unknown as boolean);
    await expect(handler!([{ data: job }])).rejects.toThrow("permission");
    authorize.mockResolvedValue(true);
    await handler!([{ data: job }]);
    expect(deliver).toHaveBeenCalledWith(context, job);
  });
});

describe("worker startup and retry", () => {
  it("stops pg-boss when queue registration fails", async () => {
    const boss = {
      start: vi.fn(async () => {}),
      createQueue: vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
      work: vi.fn(async () => {}),
      send: vi.fn(async () => "job-id"),
      stop: vi.fn(async () => {}),
    };
    const runtime = createWorkerRuntime({
      boss,
      resolveContext: async () => null,
      authorize: async () => false,
      deliver: async () => {},
    });
    await expect(runtime.start()).rejects.toThrow("queue unavailable");
    expect(boss.stop).toHaveBeenCalledOnce();
  });

  it("uses bounded exponential retries and retains a dead-letter queue for replay", async () => {
    const boss = {
      start: vi.fn(async () => {}),
      createQueue: vi.fn(async () => {}),
      work: vi.fn(async () => {}),
      send: vi.fn(async () => "job-id"),
      stop: vi.fn(async () => {}),
    };
    const runtime = createWorkerRuntime({
      boss,
      resolveContext: async () => null,
      authorize: async () => false,
      deliver: async () => {},
    });
    const job = {
      tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      outboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    await runtime.replay(job);
    expect(boss.send).toHaveBeenCalledWith(
      "domain-event-outbox",
      job,
      expect.objectContaining({
        retryLimit: 5,
        retryBackoff: true,
        retryDelayMax: 300,
        deadLetter: "domain-event-outbox-dead",
      }),
    );
    await expect(
      runtime.enqueue({ ...job, tenantId: "invalid" }),
    ).rejects.toThrow();
  });
});
