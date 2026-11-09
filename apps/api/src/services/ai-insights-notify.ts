// Notifications for AI insights (WS-12 wave 3, part A; AI-09 anomaly alerts,
// AI-10 daily summary).
//
// - A new insight row appends one `ai_insight.*` event to the transactional
//   outbox with destination `notification`, in the same transaction as the
//   row. The worker's notification consumer resolves recipients and content
//   (worker/notification-adapters.ts rules) from trusted database state.
// - Each insight row is its own aggregate. It emits sequence 1 on insert and,
//   for an anomaly, sequence 2 on its single warn -> high rise; the
//   idempotency key carries row id + sequence, and the (tenant, destination,
//   aggregate, sequence) unique key rejects a duplicate.
// - `outletPermissionHolders` picks the daily-summary billing user (the
//   recipient whose snapshot allows the permission at the outlet).
import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import { aiEvents } from "@starter/shared/ai";
import { createUlid, type ScopedTenantContext } from "@starter/shared/core";
import type { db } from "../db/index.ts";
import { roleAssignments } from "../db/schema/platform-access.ts";
import { user } from "../db/schema/user.ts";
import { appendOutbox } from "./core-outbox.ts";
import {
  accessSnapshotInTransaction,
  type AccessSnapshot,
} from "./permission-resolver.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Upper bound of candidate users checked per notification. */
const MAX_CANDIDATES = 500;

export type OutletHolder = { userId: string; access: AccessSnapshot };

/**
 * Active (not banned) users whose snapshot allows `permission` at `outletId`,
 * sorted by user id. Runs on the caller's tenant transaction.
 */
export async function outletPermissionHolders(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  permission: PermissionCode,
  now: Date,
): Promise<OutletHolder[]> {
  const rows = await tx
    .selectDistinct({ userId: roleAssignments.userId })
    .from(roleAssignments)
    .innerJoin(user, eq(user.id, roleAssignments.userId))
    .where(
      and(
        eq(roleAssignments.tenantId, context.tenant.tenantId),
        lte(roleAssignments.validFrom, now),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, now),
        ),
        or(
          isNull(user.banned),
          eq(user.banned, false),
          lte(user.banExpires, now),
        ),
      ),
    )
    .orderBy(roleAssignments.userId)
    .limit(MAX_CANDIDATES);
  const holders: OutletHolder[] = [];
  for (const { userId } of rows) {
    const access = await accessSnapshotInTransaction(tx, context, userId, now);
    if (access.allows(permission, { type: "outlet", id: outletId }))
      holders.push({ userId, access });
  }
  return holders;
}

export const AI_INSIGHT_NOTIFICATION_DESTINATION = "notification";

export type InsightEvent =
  | {
      name: "ai_insight.anomaly_detected";
      aggregateId: string;
      outletId: string;
      /** 1 = new alert, 2 = its one warn -> high rise. */
      sequence?: 1 | 2;
      payload: {
        alertId: string;
        outletId: string;
        businessDate: string;
        kind: string;
        severity: string;
        observedIdr: number;
        baselineIdr: number;
      };
    }
  | {
      name: "ai_insight.daily_summary_ready";
      aggregateId: string;
      outletId: string;
      sequence?: 1;
      payload: {
        summaryId: string;
        outletId: string;
        businessDate: string;
        aiAssisted: boolean;
      };
    };

/** Appends the insight event to the outbox in the caller's transaction. */
export async function emitInsightNotification(
  tx: Tx,
  context: ScopedTenantContext,
  input: InsightEvent,
  now: Date,
): Promise<void> {
  const definition = aiEvents[input.name];
  const sequence = input.sequence ?? 1;
  const event = definition.envelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: now.toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${definition.name}:${input.aggregateId}:${sequence}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(now.getTime()),
    event,
    destination: AI_INSIGHT_NOTIFICATION_DESTINATION,
    direction: null,
    peerId: null,
  });
}
