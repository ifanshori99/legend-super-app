import "./load-env";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { databaseUrl } from "./db/connection";
import { withTenant } from "./db/tenant.ts";
import { db, pool } from "./db";
import {
  consumeOutbox,
  markOutboxDead,
  relayOutbox,
  type GapRequest,
} from "./services/core-outbox";
import {
  createNotificationConsumer,
  type NotificationRecipientResolver,
} from "./services/notification-consumer.ts";
import { deliverNotificationAttempt } from "./services/notification-delivery.ts";
import { expireDueApprovalRequests } from "./services/platform-approval.service.ts";
import { expireDueSupportAccessGrants } from "./services/platform-support.service.ts";
import {
  createPgBoss,
  createWorkerRuntime,
  type OutboxJob,
} from "./worker/runtime";
import {
  createRelayRuntime,
  createRelayScheduler,
  createWakeListener,
} from "./worker/relay";

// This module belongs to the deployment, never to the incoming request.
const modulePath = process.env.WORKER_CONFIG_MODULE;
if (!modulePath)
  throw new Error(
    "WORKER_CONFIG_MODULE is required; no tenant resolver or consumer is configured",
  );
const config: unknown = await import(pathToFileURL(resolve(modulePath)).href);
if (
  typeof config !== "object" ||
  config === null ||
  !("resolveContext" in config) ||
  typeof config.resolveContext !== "function" ||
  !("authorize" in config) ||
  typeof config.authorize !== "function" ||
  !("deliverEvent" in config) ||
  typeof config.deliverEvent !== "function" ||
  !("authorizeEvent" in config) ||
  typeof config.authorizeEvent !== "function" ||
  !("requestMissing" in config) ||
  typeof config.requestMissing !== "function"
)
  throw new Error(
    "Worker configuration requires resolveContext, authorize, authorizeEvent, deliverEvent, and requestMissing functions",
  );
const handlers = config as {
  resolveNotificationRecipients?: NotificationRecipientResolver;
  notificationDelivery?: Parameters<typeof deliverNotificationAttempt>[3];
  resolveContext: (
    tenantId: OutboxJob["tenantId"],
  ) => Promise<ScopedTenantContext>;
  authorize: (context: ScopedTenantContext, job: OutboxJob) => Promise<boolean>;
  authorizeEvent: (
    context: ScopedTenantContext,
    event: Parameters<Parameters<typeof consumeOutbox>[2]["authorize"]>[0],
  ) => Promise<boolean>;
  requestMissing: (
    context: ScopedTenantContext,
    gap: GapRequest,
  ) => Promise<void>;
  deliverEvent: (
    context: ScopedTenantContext,
    ...args: Parameters<Parameters<typeof consumeOutbox>[2]["deliver"]>
  ) => Promise<void>;
};
if (!process.env.WORKER_DATABASE_URL)
  throw new Error(
    "WORKER_DATABASE_URL is required for the isolated queue role",
  );
const workerUrl = databaseUrl(process.env.WORKER_DATABASE_URL);
const registry = new Pool({ connectionString: workerUrl, max: 1 });
registry.on("error", () => console.error("Worker registry connection error"));
async function resolveContext(tenantId: string) {
  const parsed = tenantIdSchema.parse(tenantId);
  const result = await registry.query(
    "SELECT id FROM app.active_tenant_registry WHERE id = $1",
    [parsed],
  );
  if (result.rowCount !== 1) throw new Error("Worker tenant is not active");
  const context = await handlers.resolveContext(parsed);
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new Error("Worker requires tenant-wide scope");
  if (context.tenant.tenantId !== parsed)
    throw new Error("Worker tenant context mismatch");
  return context;
}
const runtime = createWorkerRuntime({
  boss: createPgBoss(workerUrl),
  resolveContext,
  authorize: handlers.authorize,
  deliver: async (context, job) => {
    await consumeOutbox(db, context, {
      outboxId: job.outboxId,
      generation: job.generation,
      authorize: (event) => handlers.authorizeEvent(context, event),
      deliver: async (event, key, tx) => {
        const result = await tx.execute(
          sql`SELECT destination FROM domain_event_outbox WHERE id = ${ulidToUuid(job.outboxId)}::uuid`,
        );
        if (result.rows[0]?.destination === "notification") {
          if (!handlers.resolveNotificationRecipients)
            throw new Error(
              "Notification recipient resolver is not configured",
            );
          await createNotificationConsumer(
            context,
            handlers.resolveNotificationRecipients,
          )(event, key, tx);
        } else {
          await handlers.deliverEvent(context, event, key, tx);
        }
      },
    });
  },
  markDead: async (context, job) => {
    await markOutboxDead(db, context, job);
  },
});
const relay = createRelayRuntime({
  scheduler: createRelayScheduler(workerUrl),
  listener: createWakeListener(workerUrl),
  listActiveTenantIds: async () =>
    (
      await registry.query<{ id: string }>(
        "SELECT id FROM app.active_tenant_registry",
      )
    ).rows.map((row) => row.id),
  resolveContext,
  relay: async (context) => {
    await relayOutbox(db, context, runtime.enqueue, (gap) =>
      handlers.requestMissing(context, gap),
    );
    // §3 F7 approval deadlines (legend-y5q): expire overdue levels and append
    // approval.resolved for the source module + notifications. Fail closed: a
    // sweep error never blocks the relay, the next tick retries.
    try {
      await expireDueApprovalRequests(context);
    } catch {
      console.error("Approval deadline sweep failed");
    }
    // TEN-04: record lapsed support-access sessions exactly once.
    try {
      await expireDueSupportAccessGrants(context);
    } catch {
      console.error("Support access expiry sweep failed");
    }
    // The relay's periodic sweep also recovers due notification attempts.
    // Providers and recipient lookup are deployment-owned and absent by default.
    if (!handlers.notificationDelivery) return;
    const due = await withTenant(db, context, async (tx) =>
      tx.execute(
        sql`SELECT a.id FROM delivery_attempts a WHERE ((a.status IN ('queued','failed','sending') AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= now())) OR (a.channel = 'whatsapp' AND a.status = 'skipped' AND a.skip_reason = 'free_channel_available')) AND (a.channel <> 'whatsapp' OR ${Boolean(handlers.notificationDelivery?.whatsapp)}::boolean) AND (a.channel <> 'whatsapp' OR NOT EXISTS (SELECT 1 FROM delivery_attempts f WHERE f.tenant_id = a.tenant_id AND f.notification_id = a.notification_id AND f.channel IN ('email','web_push') AND f.status IN ('queued','failed','sending','sent','delivered'))) ORDER BY a.created_at, a.id LIMIT 100`,
      ),
    );
    for (const row of due.rows) {
      try {
        await deliverNotificationAttempt(
          db,
          context,
          uuidToUlid(String(row.id)),
          handlers.notificationDelivery,
        );
      } catch {
        console.error("Notification delivery attempt failed");
      }
    }
  },
});
try {
  await runtime.start();
  await relay.start();
} catch (error) {
  await runtime.stop().catch(() => {});
  await registry.end();
  throw error;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await relay.stop();
  await runtime.stop();
  await registry.end();
  await pool.end();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
