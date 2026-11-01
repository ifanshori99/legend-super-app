import { expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import {
  createPgBoss,
  createWorkerRuntime,
  OUTBOX_QUEUE,
  OUTBOX_DEAD_LETTER_QUEUE,
} from "../worker/runtime";

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for pg-boss");
}

it("runs real jobs, dead-letters exhausted delivery, and replays through authorization", async () => {
  if (
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-") ||
    !process.env.STARTER_TEST_DATABASE_URL
  )
    throw new Error("Requires the disposable test database");
  const url = process.env.STARTER_TEST_DATABASE_URL;
  const inspector = new PgBoss(url);
  inspector.on("error", () => {});
  let permitted = false;
  let deliveries = 0;
  const runtime = createWorkerRuntime({
    boss: createPgBoss(url),
    resolveContext: async (tenantId) => ({ tenantId }),
    authorize: async () => permitted,
    deliver: async () => {
      deliveries++;
    },
  });
  const job = {
    tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    outboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  };
  try {
    await runtime.start();
    await inspector.start();
    await inspector.send(OUTBOX_QUEUE, job, {
      retryLimit: 0,
      deadLetter: OUTBOX_DEAD_LETTER_QUEUE,
    });
    await waitFor(
      async () =>
        (await inspector.findJobs(OUTBOX_DEAD_LETTER_QUEUE, { data: job }))
          .length > 0,
    );
    expect(deliveries).toBe(0);
    permitted = true;
    await runtime.replay(job);
    await waitFor(async () => deliveries === 1);
    expect(
      (await inspector.findJobs(OUTBOX_DEAD_LETTER_QUEUE, { data: job }))
        .length,
    ).toBeGreaterThan(0);
  } finally {
    await runtime.stop();
    await inspector.stop();
  }
}, 40000);
