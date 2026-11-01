import { expect, it, vi } from "vitest";
import {
  createWorkerRuntime,
  OUTBOX_QUEUE,
  OUTBOX_DEAD_LETTER_QUEUE,
} from "../worker/runtime";

it("rechecks permissions and records exhausted jobs with their generation", async () => {
  const handlers = new Map<
    string,
    (jobs: { data: unknown }[]) => Promise<void>
  >();
  const boss = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    createQueue: vi.fn(async () => {}),
    work: vi.fn(
      async (
        name: string,
        callback: (jobs: { data: unknown }[]) => Promise<void>,
      ) => {
        handlers.set(name, callback);
      },
    ),
    send: vi.fn(async () => "job-id"),
  };
  const context = { tenant: "tenant" };
  const authorize = vi.fn(async () => false);
  const deliver = vi.fn(async () => {});
  const markDead = vi.fn(async () => {});
  const runtime = createWorkerRuntime({
    boss,
    resolveContext: async () => context,
    authorize,
    deliver,
    markDead,
  });
  const job = {
    tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    outboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    generation: 1,
  };
  await runtime.start();
  expect(boss.createQueue).toHaveBeenCalledWith(
    OUTBOX_DEAD_LETTER_QUEUE,
    expect.objectContaining({ retryLimit: 1000, retryBackoff: true }),
  );
  await expect(handlers.get(OUTBOX_QUEUE)!([{ data: job }])).rejects.toThrow(
    "permission",
  );
  expect(deliver).not.toHaveBeenCalled();
  authorize.mockResolvedValue("allowed" as unknown as boolean);
  await expect(handlers.get(OUTBOX_QUEUE)!([{ data: job }])).rejects.toThrow(
    "permission",
  );
  authorize.mockResolvedValue(true);
  await handlers.get(OUTBOX_QUEUE)!([{ data: job }]);
  expect(deliver).toHaveBeenCalledWith(context, job);
  await handlers.get(OUTBOX_DEAD_LETTER_QUEUE)!([{ data: job }]);
  expect(markDead).toHaveBeenCalledWith(context, job);
});

it("gives a generation a deterministic id and retries startup failures safely", async () => {
  const boss = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    createQueue: vi.fn(async () => {}),
    work: vi.fn(async () => {}),
    send: vi.fn(async () => null),
  };
  const runtime = createWorkerRuntime({
    boss,
    resolveContext: async () => null,
    authorize: async () => false,
    deliver: async () => {},
    markDead: async () => {},
  });
  const job = {
    tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    outboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    generation: 1,
  };
  const a = await runtime.enqueue(job);
  const b = await runtime.enqueue(job);
  const c = await runtime.enqueue({ ...job, generation: 2 });
  expect(a).toBe(b);
  expect(c).not.toBe(a);
  expect(boss.send).toHaveBeenCalledWith(
    OUTBOX_QUEUE,
    job,
    expect.objectContaining({
      id: a,
      retryLimit: 5,
      retryBackoff: true,
      // A vanished worker must not own the job for pg-boss's 900s default.
      expireInSeconds: 120,
      deadLetter: OUTBOX_DEAD_LETTER_QUEUE,
    }),
  );
  await expect(runtime.enqueue({ ...job, generation: -1 })).rejects.toThrow();
  boss.createQueue.mockRejectedValueOnce(new Error("queue unavailable"));
  await expect(runtime.start()).rejects.toThrow("queue unavailable");
  expect(boss.stop).toHaveBeenCalledOnce();
});
