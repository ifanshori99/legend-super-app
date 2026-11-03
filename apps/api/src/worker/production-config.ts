import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { consumeOutbox, GapRequest } from "../services/core-outbox.ts";
import type { OutboxJob } from "./runtime.ts";

type Delivery = Parameters<Parameters<typeof consumeOutbox>[2]["deliver"]>;
type Event = Parameters<Parameters<typeof consumeOutbox>[2]["authorize"]>[0];

/** Deployment transport must durably deliver events and request gaps. It must
 * honor the supplied event id as an idempotency key. A missing adapter is a
 * startup error: pretending delivery succeeded would lose the sync stream. */
export type WorkerTransport = {
  deliverEvent(context: ScopedTenantContext, ...args: Delivery): Promise<void>;
  requestMissing(context: ScopedTenantContext, gap: GapRequest): Promise<void>;
};

export function createProductionWorkerConfig(transport: WorkerTransport) {
  if (
    !transport ||
    typeof transport.deliverEvent !== "function" ||
    typeof transport.requestMissing !== "function"
  )
    throw new Error(
      "Worker transport requires deliverEvent and requestMissing",
    );
  return {
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
    async deliverEvent(context: ScopedTenantContext, ...args: Delivery) {
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
