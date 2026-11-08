import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type * as schema from "../db/schema/index.ts";
import type { consumeOutbox, GapRequest } from "../services/core-outbox.ts";
import type { NotificationRecipientResolver } from "../services/notification-consumer.ts";
import type { deliverNotificationAttempt } from "../services/notification-delivery.ts";
import { createWorkerNotificationHandlers } from "./notification-adapters.ts";
import type { OutboxJob } from "./runtime.ts";
import { createBuiltinWorkerTransport, type OutboxRoute } from "./transport.ts";

type Delivery = Parameters<Parameters<typeof consumeOutbox>[2]["deliver"]>;
type Event = Parameters<Parameters<typeof consumeOutbox>[2]["authorize"]>[0];
type Database = NodePgDatabase<typeof schema>;

/** The outbox row's routing columns, read by the worker in the consumption
 * transaction (legend-18qw). The transport routes on them, never on the event. */
export type { OutboxRoute };

/** Deployment transport must durably deliver events and request gaps. It must
 * honor the supplied event id as an idempotency key. A missing adapter is a
 * startup error: pretending delivery succeeded would lose the sync stream. */
export type WorkerTransport = {
  deliverEvent(
    context: ScopedTenantContext,
    ...args: [...Delivery, route: OutboxRoute]
  ): Promise<void>;
  requestMissing(context: ScopedTenantContext, gap: GapRequest): Promise<void>;
};

/** Recipient lookup and channel providers, required in production so a
 * notification event is never dead-lettered for lack of a resolver and a due
 * delivery attempt is never left queued forever (legend-18qw). */
export type WorkerNotificationHandlers = {
  resolveNotificationRecipients: NotificationRecipientResolver;
  notificationDelivery: Parameters<typeof deliverNotificationAttempt>[3];
};

export type WorkerHandlers = WorkerNotificationHandlers & {
  resolveContext: (
    tenantId: OutboxJob["tenantId"],
  ) => Promise<ScopedTenantContext>;
  authorize: (context: ScopedTenantContext, job: OutboxJob) => Promise<boolean>;
  authorizeEvent: (
    context: ScopedTenantContext,
    event: Event,
  ) => Promise<boolean>;
  requestMissing: (
    context: ScopedTenantContext,
    gap: GapRequest,
  ) => Promise<void>;
  deliverEvent: (
    context: ScopedTenantContext,
    ...args: [...Delivery, route: OutboxRoute]
  ) => Promise<void>;
};

function assertNotificationHandlers(
  value: unknown,
): asserts value is WorkerNotificationHandlers {
  const handlers = value as Partial<WorkerNotificationHandlers> | null;
  const delivery = handlers?.notificationDelivery;
  if (
    typeof handlers?.resolveNotificationRecipients !== "function" ||
    typeof delivery !== "object" ||
    delivery === null ||
    typeof delivery.resolve !== "function" ||
    typeof delivery.email?.send !== "function" ||
    typeof delivery.push?.send !== "function"
  )
    throw new Error(
      "Worker notification handlers require resolveNotificationRecipients and notificationDelivery (resolve, email, push)",
    );
}

export function createProductionWorkerConfig(
  transport: WorkerTransport,
  notifications: WorkerNotificationHandlers,
): WorkerHandlers {
  if (
    !transport ||
    typeof transport.deliverEvent !== "function" ||
    typeof transport.requestMissing !== "function"
  )
    throw new Error(
      "Worker transport requires deliverEvent and requestMissing",
    );
  assertNotificationHandlers(notifications);
  return {
    resolveNotificationRecipients: notifications.resolveNotificationRecipients,
    notificationDelivery: notifications.notificationDelivery,
    // The caller verifies the active registry before invoking this resolver.
    async resolveContext(tenantId: OutboxJob["tenantId"]) {
      const tenant = establishTenantContext({
        tenantId,
        brandId: null,
        source: "job",
      });
      return establishScopedTenantContext(tenant, { kind: "tenant" });
    },
    async authorize(context: ScopedTenantContext, job: OutboxJob) {
      assertTrustedScopedContext(context);
      return (
        context.tenant.source === "job" &&
        context.outletScope.kind === "tenant" &&
        context.tenant.tenantId === job.tenantId
      );
    },
    async authorizeEvent(context: ScopedTenantContext, event: Event) {
      assertTrustedScopedContext(context);
      return (
        context.tenant.source === "job" &&
        context.outletScope.kind === "tenant" &&
        context.tenant.tenantId === event.tenantId
      );
    },
    async deliverEvent(context, ...args) {
      assertTrustedScopedContext(context);
      if (context.tenant.tenantId !== args[0].tenantId)
        throw new Error("Event tenant mismatch");
      await transport.deliverEvent(context, ...args);
    },
    async requestMissing(context: ScopedTenantContext, gap: GapRequest) {
      assertTrustedScopedContext(context);
      await transport.requestMissing(context, gap);
    },
  };
}

const importModule = async (path: string): Promise<unknown> =>
  import(pathToFileURL(resolve(path)).href);

/**
 * Chooses the worker configuration from the deployment environment, never
 * from a request (legend-18qw). Precedence:
 *   1. WORKER_CONFIG_MODULE: a trusted module exporting the whole config;
 *   2. WORKER_TRANSPORT_MODULE: a trusted transport module (deliverEvent,
 *      requestMissing) plus the built-in notification adapters;
 *   3. WORKER_TRANSPORT=builtin: the built-in transport (transport.ts).
 * Nothing configured, or an incomplete config, is a startup error.
 */
export async function loadWorkerConfig(options: {
  env: Record<string, string | undefined>;
  database: Database;
  load?: (path: string) => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
}): Promise<WorkerHandlers> {
  const { env, database } = options;
  const load = options.load ?? importModule;
  let config: unknown;
  if (env.WORKER_CONFIG_MODULE) {
    config = await load(env.WORKER_CONFIG_MODULE);
  } else {
    let transport: unknown;
    if (env.WORKER_TRANSPORT_MODULE)
      transport = await load(env.WORKER_TRANSPORT_MODULE);
    else if (env.WORKER_TRANSPORT === "builtin")
      transport = createBuiltinWorkerTransport({ database, env });
    else
      throw new Error(
        env.WORKER_TRANSPORT
          ? "WORKER_TRANSPORT must be builtin"
          : "WORKER_TRANSPORT=builtin (or WORKER_TRANSPORT_MODULE) is required; no durable sync transport is configured",
      );
    config = createProductionWorkerConfig(
      transport as WorkerTransport,
      createWorkerNotificationHandlers(database, env, {
        fetch: options.fetch,
      }),
    );
  }
  const handlers = config as Partial<WorkerHandlers> | null;
  if (
    typeof handlers !== "object" ||
    handlers === null ||
    typeof handlers.resolveContext !== "function" ||
    typeof handlers.authorize !== "function" ||
    typeof handlers.authorizeEvent !== "function" ||
    typeof handlers.deliverEvent !== "function" ||
    typeof handlers.requestMissing !== "function"
  )
    throw new Error(
      "Worker configuration requires resolveContext, authorize, authorizeEvent, deliverEvent, and requestMissing functions",
    );
  assertNotificationHandlers(handlers);
  return handlers as WorkerHandlers;
}
