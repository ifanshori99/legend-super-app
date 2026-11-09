// Alert for a NEW sync conflict (bead legend-wqc6). Kept apart from
// edge-sync-conflict.service.ts because the link store (db-link-store.ts)
// calls it and must not pull in the shared database singleton.
//
// The link records a conflict in the same transaction that receives the
// batch; the outlet's supervisors get an in-app notification there too (the
// service-request pattern: notification consumer + pg_notify at commit). No
// domain-outbox event is appended because the shared event catalog has no
// entry for it.
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { RoleTemplateKey } from "@starter/shared/access";
import {
  idr,
  toIsoDateTime,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { notificationPolicySchema } from "@starter/shared/notification";
import {
  notificationPolicies,
  pushSubscriptions,
} from "../db/schema/notification.ts";
import { roleAssignments, roles } from "../db/schema/platform-access.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { user } from "../db/schema/user.ts";
import type { EdgeTx } from "./edge-queue.service.ts";
import { createNotificationConsumer } from "./notification-consumer.ts";
import type { NotificationRecipient } from "./notification-core.ts";

const EVENT_NAME = "edge_sync_conflict.recorded";
const SUPERVISOR_TEMPLATE_KEYS: RoleTemplateKey[] = [
  "supervisor",
  "outlet_manager",
];

export type NewEdgeSyncConflict = {
  /** ULID of the conflict row just inserted. */
  id: string;
  tenantId: TenantId;
  outletId: OutletId;
  edgeNodeId: string;
  aggregateType: string;
  reason: string;
};

/** Active (not banned) supervisors of the outlet; owners when there is none. */
async function supervisorIds(
  tx: EdgeTx,
  tenantId: TenantId,
  outletId: OutletId,
): Promise<string[]> {
  const [outlet] = await tx
    .select({ brandId: outlets.brandId })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) return [];
  const holders = async (roleCondition: SQL, reach: "outlet" | "tenant") => {
    const scope =
      reach === "tenant"
        ? eq(roleAssignments.scopeType, "tenant")
        : or(
            eq(roleAssignments.scopeType, "tenant"),
            and(
              eq(roleAssignments.scopeType, "brand"),
              eq(roleAssignments.scopeId, outlet.brandId),
            ),
            and(
              eq(roleAssignments.scopeType, "outlet"),
              eq(roleAssignments.scopeId, outletId),
            ),
          );
    const rows = await tx
      .selectDistinct({ userId: roleAssignments.userId })
      .from(roleAssignments)
      .innerJoin(
        roles,
        and(
          eq(roles.tenantId, roleAssignments.tenantId),
          eq(roles.id, roleAssignments.roleId),
        ),
      )
      .innerJoin(user, eq(user.id, roleAssignments.userId))
      .where(
        and(
          eq(roleAssignments.tenantId, tenantId),
          roleCondition,
          scope,
          or(
            isNull(user.banned),
            eq(user.banned, false),
            lte(user.banExpires, sql`now()`),
          ),
          lte(roleAssignments.validFrom, sql`now()`),
          or(
            isNull(roleAssignments.validUntil),
            gt(roleAssignments.validUntil, sql`now()`),
          ),
        ),
      );
    return rows.map((row) => row.userId);
  };
  const supervisors = await holders(
    inArray(roles.templateKey, SUPERVISOR_TEMPLATE_KEYS),
    "outlet",
  );
  return supervisors.length > 0
    ? supervisors
    : holders(eq(roles.templateKey, "owner"), "tenant");
}

/**
 * Notify the outlet's supervisors that the link recorded a NEW sync conflict.
 * Call it in the transaction that inserted the conflict row (db-link-store);
 * the in-app rows and the realtime `pg_notify` commit together with it. The
 * event id is the conflict's ULID, so a retry never notifies twice.
 *
 * Category `edge_sync_conflict` (shared catalog: staff audience, realtime).
 */
export async function notifyEdgeSyncConflictRecorded(
  tx: EdgeTx,
  context: ScopedTenantContext,
  conflict: NewEdgeSyncConflict,
  now: Date = new Date(),
): Promise<void> {
  const userIds = await supervisorIds(tx, conflict.tenantId, conflict.outletId);
  if (userIds.length === 0) return;
  const [policyRow] = await tx
    .select()
    .from(notificationPolicies)
    .where(eq(notificationPolicies.tenantId, conflict.tenantId));
  const policy = notificationPolicySchema.parse(
    policyRow
      ? {
          tenantId: conflict.tenantId,
          webPushEnabled: policyRow.webPushEnabled,
          emailEnabled: policyRow.emailEnabled,
          whatsapp: policyRow.whatsapp,
          maxAttempts: policyRow.maxAttempts,
          retryBackoffSeconds: policyRow.retryBackoffSeconds,
          updatedAt: toIsoDateTime(policyRow.updatedAt),
        }
      : {
          tenantId: conflict.tenantId,
          webPushEnabled: true,
          emailEnabled: false,
          whatsapp: {
            enabled: false,
            allowedCategories: [],
            monthlyCap: 0,
            costPerMessageIdr: idr(0),
          },
          maxAttempts: 3,
          retryBackoffSeconds: [30, 120],
          updatedAt: toIsoDateTime(now),
        },
  );
  const subscribed = new Set(
    (
      await tx
        .select({ userId: pushSubscriptions.userId })
        .from(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.tenantId, conflict.tenantId),
            inArray(pushSubscriptions.userId, userIds),
          ),
        )
    ).map((row) => row.userId),
  );
  const recipients: NotificationRecipient[] = userIds.map((userId) => ({
    userId,
    category: "edge_sync_conflict",
    title: "Konflik sinkronisasi edge",
    body: "Ada data dari server lokal yang ditolak cloud. Tinjau dan ulangi atau abaikan di pengaturan perangkat.",
    link: null,
    policy,
    preference: null,
    reachability: {
      hasPushSubscription: subscribed.has(userId),
      hasVerifiedEmail: false,
      whatsappOptIn: false,
    },
    whatsappSentThisMonth: 0,
    defaultTimeZone: "Asia/Jakarta",
  }));
  const event = eventEnvelopeSchema.parse({
    id: conflict.id,
    tenantId: conflict.tenantId,
    outletId: conflict.outletId,
    name: EVENT_NAME,
    version: 1,
    aggregateType: "edge_sync_conflict",
    aggregateId: conflict.id,
    sequence: 1,
    occurredAt: toIsoDateTime(now),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${EVENT_NAME}:${ulidToUuid(conflict.id)}`,
    payloadSchemaRef: `${EVENT_NAME}.v1`,
    payload: {
      conflictId: conflict.id,
      edgeNodeId: conflict.edgeNodeId,
      aggregateType: conflict.aggregateType,
      reason: conflict.reason,
    },
  });
  await createNotificationConsumer(context, async () => recipients)(
    event,
    event.idempotencyKey,
    tx,
  );
}
