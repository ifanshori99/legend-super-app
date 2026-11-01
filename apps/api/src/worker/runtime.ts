import { z, tenantIdSchema, ulidSchema } from "@starter/shared/core";
import { PgBoss } from "pg-boss";

export const OUTBOX_QUEUE = "domain-event-outbox";
export const OUTBOX_DEAD_LETTER_QUEUE = "domain-event-outbox-dead";
const jobSchema = z
  .object({ tenantId: tenantIdSchema, outboxId: ulidSchema })
  .strict();
export type OutboxJob = z.infer<typeof jobSchema>;

type Boss = {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  createQueue(name: string, options?: { deadLetter?: string }): Promise<void>;
  work(
    name: string,
    handler: (jobs: { data: unknown }[]) => Promise<void>,
  ): Promise<unknown>;
  send(
    name: string,
    data: OutboxJob,
    options: {
      retryLimit: number;
      retryDelay: number;
      retryBackoff: boolean;
      retryDelayMax: number;
      deadLetter: string;
    },
  ): Promise<string | null>;
};

/** The caller must resolve tenant context from a trusted tenant registry, not the job alone.
 * Delivery must load the event from the outbox, enforce aggregate sequence and dedupe,
 * and use the persisted event ID as the provider idempotency key. */
export function createWorkerRuntime<Context>(options: {
  boss: Boss;
  resolveContext: (tenantId: OutboxJob["tenantId"]) => Promise<Context>;
  authorize: (context: Context, job: OutboxJob) => Promise<boolean>;
  deliver: (context: Context, job: OutboxJob) => Promise<void>;
}) {
  const { boss, resolveContext, authorize, deliver } = options;
  async function enqueue(input: unknown) {
    const job = jobSchema.parse(input);
    const id = await boss.send(OUTBOX_QUEUE, job, {
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: 300,
      deadLetter: OUTBOX_DEAD_LETTER_QUEUE,
    });
    if (!id) throw new Error("Failed to enqueue outbox job");
    return id;
  }
  return {
    async start() {
      try {
        await boss.start();
        await boss.createQueue(OUTBOX_DEAD_LETTER_QUEUE);
        await boss.createQueue(OUTBOX_QUEUE, {
          deadLetter: OUTBOX_DEAD_LETTER_QUEUE,
        });
        await boss.work(OUTBOX_QUEUE, async (jobs) => {
          for (const { data } of jobs) {
            const job = jobSchema.parse(data);
            const context = await resolveContext(job.tenantId);
            if ((await authorize(context, job)) !== true)
              throw new Error("Worker permission denied");
            await deliver(context, job);
          }
        });
      } catch (error) {
        await boss.stop().catch(() => {});
        throw error;
      }
    },
    enqueue,
    // Replay deliberately creates a fresh job. The original dead-letter record remains
    // available for inspection and the consumer's durable dedupe remains authoritative.
    replay: enqueue,
    stop: () => boss.stop(),
  };
}

/** Adapt the actual pg-boss instance without exposing its queue API to consumers. */
export function createPgBoss(connectionString: string): Boss {
  const boss = new PgBoss(connectionString);
  // pg-boss emits background errors; an explicit listener avoids EventEmitter's
  // unhandled-error crash while keeping credentials out of logs.
  boss.on("error", () => console.error("pg-boss encountered a database error"));
  return {
    start: () => boss.start(),
    stop: () => boss.stop(),
    createQueue: (name, options) => boss.createQueue(name, options),
    work: (name, handler) => boss.work(name, handler),
    send: (name, data, options) => boss.send(name, data, options),
  };
}
