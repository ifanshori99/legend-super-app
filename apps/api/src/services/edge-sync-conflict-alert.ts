// Alert for a NEW sync conflict (bead legend-wqc6). Kept apart from
// edge-sync-conflict.service.ts because the link store (db-link-store.ts)
// calls it and must not pull in the shared database singleton.
//
// The link records a conflict in the same transaction that receives the
// batch; the outlet's supervisors get an in-app notification there too (the
// service-request pattern: notification consumer + pg_notify at commit). No
// domain-outbox event is appended because the shared event catalog has no
// entry for it.
import { createHash } from "node:crypto";
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
  createUlid,
  toIsoDateTime,
  ulidToUuid,
  uuidToUlid,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  defaultNotificationPolicy,
  notificationPolicySchema,
  type NotificationCategory,
} from "@starter/shared/notification";
import {
  notificationOutbox,
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
const PARKED_UNCLASSIFIED_EVENT = "edge_event.parked_unclassified";
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

/**
 * Active (not banned) supervisors of the outlet; owners when there is none,
 * or always with `alsoOwners`.
 */
async function supervisorIds(
  tx: EdgeTx,
  tenantId: TenantId,
  outletId: OutletId | null,
  alsoOwners = false,
): Promise<string[]> {
  // No outlet (a tenant-wide alert): only the owners are reachable.
  const [outlet] =
    outletId === null
      ? [undefined]
      : await tx
          .select({ brandId: outlets.brandId })
          .from(outlets)
          .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (outletId !== null && !outlet) return [];
  const holders = async (roleCondition: SQL, reach: "outlet" | "tenant") => {
    const scope =
      reach === "tenant" || outletId === null || !outlet
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
  const supervisors =
    outletId === null
      ? []
      : await holders(
          inArray(roles.templateKey, SUPERVISOR_TEMPLATE_KEYS),
          "outlet",
        );
  if (supervisors.length > 0 && !alsoOwners) return supervisors;
  const owners = await holders(eq(roles.templateKey, "owner"), "tenant");
  return [...new Set([...supervisors, ...owners])];
}

export type SupervisorAlert = {
  tenantId: TenantId;
  /** Notification category; defaults to `edge_sync_conflict`. */
  category?: NotificationCategory;
  /** Owners get it even when the outlet has supervisors. */
  alsoOwners?: boolean;
  /** `null` for a tenant-wide alert: only the owners are notified. */
  outletId: OutletId | null;
  /** ULID; the notification consumer dedupes on it. */
  id: string;
  eventName: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, string>;
  title: string;
  body: string;
  /** Persist a dedupe marker even if nobody can receive this alert. */
  recordEmpty?: boolean;
};

/**
 * Sends one in-app alert to the outlet's supervisors (category
 * `edge_sync_conflict`: shared catalog, staff audience, realtime). The rows
 * and the realtime `pg_notify` commit with the caller's transaction.
 */
export async function notifyOutletSupervisors(
  tx: EdgeTx,
  context: ScopedTenantContext,
  alert: SupervisorAlert,
  now: Date,
): Promise<boolean> {
  const userIds = await supervisorIds(
    tx,
    alert.tenantId,
    alert.outletId,
    alert.alsoOwners === true,
  );
  if (userIds.length === 0) {
    if (alert.recordEmpty) {
      const event = eventEnvelopeSchema.parse({
        id: alert.id,
        tenantId: alert.tenantId,
        outletId: alert.outletId,
        name: alert.eventName,
        version: 1,
        aggregateType: alert.aggregateType,
        aggregateId: alert.aggregateId,
        sequence: 1,
        occurredAt: toIsoDateTime(now),
        actor: { type: "system" },
        deviceId: null,
        idempotencyKey: `${alert.eventName}:${ulidToUuid(alert.id)}`,
        payloadSchemaRef: `${alert.eventName}.v1`,
        payload: alert.payload,
      });
      await createNotificationConsumer(context, async () => [])(
        event,
        event.idempotencyKey,
        tx,
      );
    }
    return false;
  }
  const [policyRow] = await tx
    .select()
    .from(notificationPolicies)
    .where(eq(notificationPolicies.tenantId, alert.tenantId));
  const policy = policyRow
    ? notificationPolicySchema.parse({
        tenantId: alert.tenantId,
        webPushEnabled: policyRow.webPushEnabled,
        emailEnabled: policyRow.emailEnabled,
        whatsapp: policyRow.whatsapp,
        maxAttempts: policyRow.maxAttempts,
        retryBackoffSeconds: policyRow.retryBackoffSeconds,
        updatedAt: toIsoDateTime(policyRow.updatedAt),
      })
    : defaultNotificationPolicy(alert.tenantId, now);
  const subscribed = new Set(
    (
      await tx
        .select({ userId: pushSubscriptions.userId })
        .from(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.tenantId, alert.tenantId),
            inArray(pushSubscriptions.userId, userIds),
          ),
        )
    ).map((row) => row.userId),
  );
  const recipients: NotificationRecipient[] = userIds.map((userId) => ({
    userId,
    category: alert.category ?? "edge_sync_conflict",
    title: alert.title,
    body: alert.body,
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
    id: alert.id,
    tenantId: alert.tenantId,
    outletId: alert.outletId,
    name: alert.eventName,
    version: 1,
    aggregateType: alert.aggregateType,
    aggregateId: alert.aggregateId,
    sequence: 1,
    occurredAt: toIsoDateTime(now),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${alert.eventName}:${ulidToUuid(alert.id)}`,
    payloadSchemaRef: `${alert.eventName}.v1`,
    payload: alert.payload,
  });
  await createNotificationConsumer(context, async () => recipients)(
    event,
    event.idempotencyKey,
    tx,
  );
  return true;
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
  await notifyOutletSupervisors(
    tx,
    context,
    {
      tenantId: conflict.tenantId,
      outletId: conflict.outletId,
      id: conflict.id,
      eventName: EVENT_NAME,
      aggregateType: "edge_sync_conflict",
      aggregateId: conflict.id,
      payload: {
        conflictId: conflict.id,
        edgeNodeId: conflict.edgeNodeId,
        aggregateType: conflict.aggregateType,
        reason: conflict.reason,
      },
      title: "Konflik sinkronisasi edge",
      body: "Ada data dari server lokal yang ditolak cloud. Tinjau dan ulangi atau abaikan di pengaturan perangkat.",
    },
    now,
  );
}

export type EdgeCatalogStale = {
  tenantId: TenantId;
  outletId: OutletId;
  edgeNodeId: string;
  stream: string;
  /** Start of the stale episode as the edge reported it (ISO). */
  staleSince: string;
  reason: string;
};

/**
 * Stable alert id for one edge, stream and stale episode: the same heartbeat
 * repeated every few seconds maps to the same ULID, and the notification
 * consumer ignores an event id it has seen. A new episode (a later success
 * moves `staleSince`) notifies again.
 */
export function edgeCatalogStaleAlertId(stale: EdgeCatalogStale): string {
  const hex = createHash("sha256")
    .update(
      `edge_catalog.stale\0${stale.edgeNodeId}\0${stale.stream}\0${stale.staleSince}`,
    )
    .digest("hex")
    .slice(0, 32);
  return uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/**
 * Notify the outlet's supervisors AND owners that an edge's critical catalog
 * stream (prices, product status) has failed to sync for a few minutes while
 * the edge reaches the cloud, with no extra age condition (legend-10nex).
 * Called from the cloud when a heartbeat carries `catalogStale`; idempotent per edge, stream and episode
 * (see `edgeCatalogStaleAlertId`). Carries stream and reason code only.
 */
export async function notifyEdgeCatalogStale(
  tx: EdgeTx,
  context: ScopedTenantContext,
  stale: EdgeCatalogStale,
  now: Date = new Date(),
): Promise<void> {
  const id = edgeCatalogStaleAlertId(stale);
  const elapsedTimeUnproven = stale.reason === "CLOCK_ELAPSED_UNPROVEN";
  await notifyOutletSupervisors(
    tx,
    context,
    {
      tenantId: stale.tenantId,
      outletId: stale.outletId,
      alsoOwners: true,
      id,
      eventName: "edge_catalog.stale",
      aggregateType: "edge_catalog",
      aggregateId: id,
      payload: {
        edgeNodeId: stale.edgeNodeId,
        stream: stale.stream,
        staleSince: stale.staleSince,
        reason: stale.reason,
      },
      title: elapsedTimeUnproven
        ? "Usia katalog edge sempat belum dapat dibuktikan"
        : "Katalog edge belum diperbarui",
      body: elapsedTimeUnproven
        ? `Alarm ini tercatat pada ${stale.staleSince}: usia katalog server lokal belum dapat dibuktikan setelah perangkat menyala kembali. Jika tidak ada alasan lain yang menahan penjualan, penjualan boleh berjalan dengan harga normal; promo dan voucher dimatikan selama usia data belum dapat dibuktikan. Alarm dapat tertunda saat offline; periksa status terbaru karena jam mundur atau katalog yang terbukti basi tetap dapat menahan penjualan.`
        : "Harga atau status produk di server lokal gagal diperbarui padahal internet tersambung. Jika belum tersinkron lebih dari 24 jam, penjualan ditahan sampai owner mengizinkan; periksa sinkronisasi.",
    },
    now,
  );
}

export type EdgeEventParkedUnclassified = {
  tenantId: TenantId;
  outletId: OutletId;
  edgeNodeId: string;
  eventName: string;
  aggregateType: string;
};

/**
 * Notify the outlet's supervisors that the cloud parked a NEW edge event as
 * `unclassified` (no domain registered it; bead legend-eadm / legend-niq9).
 * Call it only when the parked row was just inserted, in a savepoint (see
 * deferred-event-applier.ts). It carries the event name, aggregate type and
 * edge node only, never the payload. At most one alarm per (outlet,
 * aggregate type, event name) per 24 hours, counted from the alarms actually
 * sent (`notification_outbox`): an edge on a newer build can emit an unknown
 * name on every sale. An alarm that was not sent (no supervisor, or a failed
 * savepoint) does not silence the next event. The alert has its own ULID: the edge
 * event's id stays free in the notification tables (unique per source event)
 * for a later cloud applier that replays the parked event.
 */
export async function notifyEdgeEventParkedUnclassified(
  tx: EdgeTx,
  context: ScopedTenantContext,
  parked: EdgeEventParkedUnclassified,
  now: Date = new Date(),
): Promise<void> {
  const [recent] = await tx
    .select({ one: sql<number>`1` })
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.tenantId, parked.tenantId),
        eq(notificationOutbox.outletId, parked.outletId),
        eq(notificationOutbox.eventType, PARKED_UNCLASSIFIED_EVENT),
        sql`${notificationOutbox.payload}->>'eventName' = ${parked.eventName}`,
        sql`${notificationOutbox.payload}->>'aggregateType' = ${parked.aggregateType}`,
        gt(notificationOutbox.createdAt, sql`now() - interval '24 hours'`),
      ),
    )
    .limit(1);
  if (recent) return;
  const alertId = createUlid(now.getTime());
  await notifyOutletSupervisors(
    tx,
    context,
    {
      tenantId: parked.tenantId,
      outletId: parked.outletId,
      id: alertId,
      eventName: PARKED_UNCLASSIFIED_EVENT,
      aggregateType: "edge_event",
      aggregateId: alertId,
      payload: {
        edgeNodeId: parked.edgeNodeId,
        eventName: parked.eventName,
        aggregateType: parked.aggregateType,
      },
      title: "Event edge belum dikenali cloud",
      body: "Server lokal mengirim event yang belum diproses cloud. Event disimpan dan tidak menghentikan sinkronisasi; hubungi tim teknis.",
    },
    now,
  );
}

export type BrevoAuthFailed = {
  tenantId: TenantId;
  /** `null` for a tenant-wide email (owners only). */
  outletId: OutletId | null;
  /** The 401 or 403 Brevo answered with. */
  status: number;
};

const BREVO_AUTH_FAILED_EVENT = "notification_provider.email_auth_failed";
const BREVO_AUTH_FAILED_WINDOW = "15 minutes";

/**
 * Notify the tenant's owners (and the outlet's supervisors) that Brevo
 * refused the API key or sender (401/403, bead legend-j75w). Every delivery
 * retry fails the same way, so at most one alert per tenant per 15 minutes,
 * counted from the alerts actually sent (`notification_outbox`; no new
 * table). The advisory lock serializes concurrent failures of one tenant so
 * two of them cannot both see an empty window. Carries the status only.
 */
export async function notifyBrevoAuthFailed(
  tx: EdgeTx,
  context: ScopedTenantContext,
  failed: BrevoAuthFailed,
  now: Date = new Date(),
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${BREVO_AUTH_FAILED_EVENT}:${failed.tenantId}`}, 0))`,
  );
  const [recent] = await tx
    .select({ one: sql<number>`1` })
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.tenantId, failed.tenantId),
        eq(notificationOutbox.eventType, BREVO_AUTH_FAILED_EVENT),
        gt(
          notificationOutbox.createdAt,
          sql`now() - interval '${sql.raw(BREVO_AUTH_FAILED_WINDOW)}'`,
        ),
      ),
    )
    .limit(1);
  if (recent) return;
  const alertId = createUlid(now.getTime());
  await notifyOutletSupervisors(
    tx,
    context,
    {
      tenantId: failed.tenantId,
      outletId: failed.outletId,
      alsoOwners: true,
      id: alertId,
      eventName: BREVO_AUTH_FAILED_EVENT,
      aggregateType: "notification_provider",
      aggregateId: alertId,
      payload: { status: String(failed.status) },
      title: "Pengiriman email gagal: kunci atau pengirim ditolak",
      body: "Penyedia email menolak kunci API atau alamat pengirim, sehingga email tidak terkirim. Hubungi tim teknis untuk memeriksa pengaturan email.",
    },
    now,
  );
}
