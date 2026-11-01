import { createHash } from "node:crypto";
import { z, tenantIdSchema, ulidSchema } from "@starter/shared/core";
import { PgBoss } from "pg-boss";

export const OUTBOX_QUEUE = "domain-event-outbox";
export const OUTBOX_DEAD_LETTER_QUEUE = "domain-event-outbox-dead";
const jobSchema = z
  .object({
    tenantId: tenantIdSchema,
    outboxId: ulidSchema,
    generation: z.number().int().nonnegative().safe(),
  })
  .strict();
export type OutboxJob = z.infer<typeof jobSchema>;

type Boss = {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  createQueue(
    name: string,
    options?: {
      deadLetter?: string;
      retryLimit?: number;
      retryDelay?: number;
      retryBackoff?: boolean;
      retryDelayMax?: number;
    },
  ): Promise<void>;
  work(
    name: string,
    handler: (jobs: { data: unknown }[]) => Promise<void>,
  ): Promise<unknown>;
  send(
    name: string,
    data: OutboxJob,
    options: {
      id: string;
      retryLimit: number;
      retryDelay: number;
      retryBackoff: boolean;
      retryDelayMax: number;
      expireInSeconds: number;
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
  markDead: (context: Context, job: OutboxJob) => Promise<void>;
}) {
  const { boss, resolveContext, authorize, deliver, markDead } = options;
  async function enqueue(input: unknown) {
    const job = jobSchema.parse(input);
    const hex = createHash("sha256")
      .update(`${job.tenantId}:${job.outboxId}:${job.generation}`)
      .digest("hex");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    await boss.send(OUTBOX_QUEUE, job, {
      id,
      retryLimit: 5,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: 300,
      // A vanished worker must not own the job for pg-boss's 900s default;
      // delivery is one transaction (with its provider call) and consumers
      // dedupe by event id, so 120s is safe and keeps the outbox queued lease
      // (20 min) above pg-boss's whole retry window.
      expireInSeconds: 120,
      deadLetter: OUTBOX_DEAD_LETTER_QUEUE,
    });
    return id;
  }
  return {
    async start() {
      try {
        await boss.start();
        await boss.createQueue(OUTBOX_DEAD_LETTER_QUEUE, {
          retryLimit: 1000,
          retryDelay: 5,
          retryBackoff: true,
          retryDelayMax: 300,
        });
        await boss.createQueue(OUTBOX_QUEUE, {
          deadLetter: OUTBOX_DEAD_LETTER_QUEUE,
        });
        await boss.work(OUTBOX_DEAD_LETTER_QUEUE, async (jobs) => {
          for (const { data } of jobs) {
            const job = jobSchema.parse(data);
            await markDead(await resolveContext(job.tenantId), job);
          }
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
    stop: () => boss.stop(),
  };
}

/** Adapt the actual pg-boss instance without exposing its queue API to consumers. */
export function createPgBoss(connectionString: string): Boss {
  const boss = new PgBoss({ connectionString, createSchema: false });
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
