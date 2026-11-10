import { Client } from "pg";
import { PgBoss } from "pg-boss";
import { assertQueueRole, queueBossOptions } from "../db/role";

const RELAY_QUEUE = "domain-event-relay";
export const WAKE_CHANNEL = "legend_outbox_wakeup";
type Scheduler = {
  start(): Promise<unknown>;
  schedule(fn: () => Promise<void>): Promise<void>;
  stop(): Promise<void>;
};
type Listener = { start(fn: () => void): Promise<void>; stop(): Promise<void> };

export function createRelayRuntime<Context>(options: {
  scheduler: Scheduler;
  listener: Listener;
  listActiveTenantIds: () => Promise<string[]>;
  resolveContext: (tenantId: string) => Promise<Context>;
  relay: (context: Context) => Promise<unknown>;
  /** Liveness hook (legend-z649): called as the sweep makes progress. */
  onProgress?: () => void;
}) {
  let active: Promise<void> | undefined;
  let repeat = false;
  let stopping = false;
  async function sweep() {
    if (stopping) return;
    if (active) {
      repeat = true;
      return active;
    }
    active = (async () => {
      do {
        repeat = false;
        const tenantIds = await options.listActiveTenantIds();
        options.onProgress?.();
        for (const tenantId of tenantIds) {
          try {
            await options.relay(await options.resolveContext(tenantId));
          } catch {
            console.error("Tenant outbox relay failed");
          }
          options.onProgress?.();
        }
      } while (repeat && !stopping);
    })();
    try {
      await active;
    } finally {
      active = undefined;
    }
  }
  return {
    async start() {
      try {
        await options.scheduler.start();
        await options.scheduler.schedule(sweep);
        await options.listener.start(() => {
          void sweep().catch(() => console.error("Outbox relay sweep failed"));
        });
        await sweep();
      } catch (error) {
        await options.listener.stop().catch(() => {});
        await options.scheduler.stop().catch(() => {});
        throw error;
      }
    },
    async stop() {
      stopping = true;
      await options.listener.stop();
      await options.scheduler.stop();
      await active;
    },
  };
}

export function createRelayScheduler(url: string): Scheduler {
  const boss = new PgBoss(queueBossOptions(url));
  boss.on("error", () => console.error("pg-boss relay scheduler error"));
  return {
    start: () => boss.start(),
    async schedule(fn) {
      await boss.createQueue(RELAY_QUEUE);
      await boss.work(RELAY_QUEUE, async () => fn());
      await boss.schedule(RELAY_QUEUE, "* * * * *");
    },
    stop: () => boss.stop(),
  };
}

/** LISTEN notifications are hints only; scheduled sweeps recover missed hints. */
export function createWakeListener(url: string): Listener {
  let client: Client | undefined;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let notify: () => void;
  async function connect() {
    const next = new Client({ connectionString: url });
    client = next;
    next.on("notification", (message) => {
      if (message.channel === WAKE_CHANNEL) notify();
    });
    next.on("error", () => {
      void next.end().catch(() => {});
    });
    next.on("end", () => {
      if (!stopped)
        retry = setTimeout(() => {
          void connect().catch(() => {});
        }, 5000);
    });
    await next.connect();
    try {
      await assertQueueRole(next);
    } catch (error) {
      // A refused role must not be retried in the background. On a reconnect
      // the error is swallowed, so say so (fixed text, no connection details).
      console.error("Wake listener refused an unsafe queue role");
      stopped = true;
      await next.end().catch(() => {});
      throw error;
    }
    await next.query(`LISTEN ${WAKE_CHANNEL}`);
  }
  return {
    async start(fn) {
      notify = fn;
      await connect();
    },
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      await client?.end();
    },
  };
}
