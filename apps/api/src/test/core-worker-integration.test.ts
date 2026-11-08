import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { Client } from "pg";
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
  const setup = new Client({ connectionString: url });
  await setup.connect();
  // The queue verify refuses the owner login, so the worker uses a restricted
  // login that owns only the pgboss schema.
  const queueRole = `legend_queue_it_${randomBytes(6).toString("hex")}`;
  const queuePassword = randomBytes(16).toString("hex");
  await setup.query(
    `CREATE ROLE ${queueRole} LOGIN PASSWORD '${queuePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
  );
  await setup.query(
    `CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION ${queueRole}`,
  );
  await setup.end();
  const queueUrl = new URL(url);
  queueUrl.username = queueRole;
  queueUrl.password = queuePassword;
  const inspector = new PgBoss(url);
  inspector.on("error", () => {});
  let permitted = false;
  let deliveries = 0;
  let dead = 0;
  const runtime = createWorkerRuntime({
    boss: createPgBoss(queueUrl.toString()),
    resolveContext: async (tenantId) => ({ tenantId }),
    authorize: async () => permitted,
    deliver: async () => {
      deliveries++;
    },
    markDead: async () => {
      dead++;
    },
  });
  const job = {
    tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    outboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    generation: 0,
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
    await waitFor(async () => dead === 1);
    expect(deliveries).toBe(0);
    permitted = true;
    const replay = { ...job, generation: 1 };
    const firstId = await runtime.enqueue(replay);
    expect(await runtime.enqueue(replay)).toBe(firstId);
    await waitFor(async () =>
      (await inspector.findJobs(OUTBOX_QUEUE, { id: firstId })).some(
        (row) => row.state === "completed",
      ),
    );
    expect(await runtime.enqueue(replay)).toBe(firstId);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(deliveries).toBe(1);
    expect(
      (await inspector.findJobs(OUTBOX_DEAD_LETTER_QUEUE, { data: job }))
        .length,
    ).toBeGreaterThan(0);
  } finally {
    await runtime.stop();
    await inspector.stop();
    const cleanup = new Client({ connectionString: url });
    await cleanup.connect();
    await cleanup.query(`DROP OWNED BY ${queueRole}`);
    await cleanup.query(`DROP ROLE ${queueRole}`);
    await cleanup.end();
  }
}, 40000);
