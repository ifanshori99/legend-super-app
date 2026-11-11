import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertTrustedScopedContext,
  decodeCursor,
  encodeCursor,
  ulidToUuid,
  userIdSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  listNotifications,
  markNotificationRead,
  notificationSchema,
  defaultNotificationPolicy,
  notificationPolicySchema,
  notificationPreferenceSchema,
  notificationTemplateSchema,
  pushSubscriptionSchema,
  updateNotificationPreferences,
  registerPushSubscription,
  removePushSubscription,
  updateNotificationPolicy,
  listNotificationTemplates,
  notificationRead,
  notificationPreferenceUpdated,
  notificationCategorySchema,
  isEmailMandatory,
} from "@starter/shared/notification";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  appendNotificationEvent,
  appendNotificationEventsBatch,
} from "./notification-events.ts";
import type {
  NotificationOperation,
  NotificationServicePort,
} from "../routes/notification.routes.ts";

type Database = NodePgDatabase<typeof schema>;
export interface PushSubscriptionProtector {
  seal(
    input: { endpoint: string; keys: { p256dh: string; auth: string } },
    tenantId: string,
    userId: string,
  ): Promise<{ endpointHash: string; ciphertext: string; keyVersion: string }>;
}
type Authorization = (
  context: ScopedTenantContext,
  userId: string,
  operation: NotificationOperation,
) => Promise<boolean>;
const denied = () =>
  new HttpError(403, "FORBIDDEN", "Your account cannot perform this action.");
function isoTimestamp(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}
function asNotification(row: Record<string, unknown>) {
  return notificationSchema.parse({
    id: uuidToUlid(String(row.id)),
    tenantId: row.tenant_id,
    outletId: row.outlet_id,
    userId: row.user_id,
    category: row.category,
    title: row.title,
    body: row.body,
    link: row.link,
    readAt: row.read_at === null ? null : isoTimestamp(row.read_at),
    createdAt: isoTimestamp(row.created_at),
    sourceEventId:
      row.source_event_id === null
        ? null
        : uuidToUlid(String(row.source_event_id)),
    dedupeKey: row.dedupe_key,
  });
}
/** JSONB stores object keys in its own order, so compare with sorted keys. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** One `notification.read` per unread -> read transition (PRD §3.15). */
function readEventInput(
  userId: string,
  row: Record<string, unknown>,
  now: Date,
) {
  return {
    aggregateId: uuidToUlid(String(row.id)),
    outletId: row.outlet_id === null ? null : String(row.outlet_id),
    actorUserId: userId,
    payload: {
      notificationId: uuidToUlid(String(row.id)),
      userId,
      category: String(row.category),
    },
    now,
  };
}

/** All reads and writes use recipient identity and scoped RLS within one transaction. */
export function createNotificationService(
  database: Database,
  authorize: Authorization = async () => false,
  protector?: PushSubscriptionProtector,
): NotificationServicePort {
  return {
    async execute(context, rawUserId, operation, input) {
      assertTrustedScopedContext(context);
      const userId = userIdSchema.parse(rawUserId);
      if (!(await authorize(context, userId, operation))) throw denied();
      return withTenant(database, context, async (tx) => {
        const outletFilter =
          context.outletScope.kind === "tenant"
            ? sql`TRUE`
            : sql`outlet_id IN (${sql.join(
                context.outletScope.outletIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`;
        switch (operation) {
          case "unreadCount": {
            const result = await tx.execute(
              sql`SELECT count(*)::int AS unread FROM notifications WHERE user_id = ${userId}::uuid AND ${outletFilter} AND read_at IS NULL`,
            );
            return { data: { unread: Number(result.rows[0]?.unread ?? 0) } };
          }
          case "list": {
            const query = listNotifications.query.parse(input.query ?? {});
            let cursorFilter = sql`TRUE`;
            if (query.cursor) {
              const keys = decodeCursor(query.cursor);
              if (
                keys.length !== 2 ||
                typeof keys[0] !== "string" ||
                typeof keys[1] !== "string" ||
                Number.isNaN(Date.parse(keys[0]))
              )
                throw new HttpError(422, "VALIDATION_ERROR", "Invalid cursor.");
              cursorFilter = sql`(created_at, id) < (${keys[0]}::timestamptz, ${ulidToUuid(keys[1])}::uuid)`;
            }
            const unreadFilter =
              query.unreadOnly === "true" ? sql`read_at IS NULL` : sql`TRUE`;
            const categoryFilter = query.category
              ? sql`category = ${query.category}`
              : sql`TRUE`;
            const result = await tx.execute(
              sql`SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at FROM notifications WHERE user_id = ${userId}::uuid AND ${outletFilter} AND ${cursorFilter} AND ${unreadFilter} AND ${categoryFilter} ORDER BY created_at DESC, id DESC LIMIT ${query.limit + 1}`,
            );
            const rows = result.rows.slice(0, query.limit).map(asNotification);
            const last = rows.at(-1);
            const lastRaw = result.rows[rows.length - 1];
            return {
              data: rows,
              meta: {
                limit: query.limit,
                nextCursor:
                  result.rows.length > query.limit && last
                    ? encodeCursor([
                        String(lastRaw?.cursor_created_at),
                        last.id,
                      ])
                    : null,
              },
            };
          }
          case "markRead": {
            const { notificationId } = markNotificationRead.params.parse(
              input.params,
            );
            // Lock the row first: only the unread -> read transition emits an
            // event, so a repeated or concurrent markRead never doubles it.
            const current = await tx.execute(
              sql`SELECT * FROM notifications WHERE user_id = ${userId}::uuid AND ${outletFilter} AND id = ${ulidToUuid(notificationId)}::uuid FOR UPDATE`,
            );
            const existing = current.rows[0];
            if (!existing)
              throw new HttpError(404, "NOT_FOUND", "Notification not found.");
            if (existing.read_at !== null)
              return { data: asNotification(existing) };
            const result = await tx.execute(
              sql`UPDATE notifications SET read_at = now() WHERE id = ${ulidToUuid(notificationId)}::uuid AND read_at IS NULL RETURNING *`,
            );
            const row = result.rows[0] ?? existing;
            await appendNotificationEvent(
              tx,
              context,
              notificationRead,
              readEventInput(userId, row, new Date()),
            );
            return { data: asNotification(row) };
          }
          case "markAllRead": {
            const result = await tx.execute(
              sql`UPDATE notifications SET read_at = now() WHERE user_id = ${userId}::uuid AND ${outletFilter} AND read_at IS NULL RETURNING id, outlet_id, category`,
            );
            // Rows are locked by the UPDATE above, so one batched sequence
            // read is race-free (see appendNotificationEventsBatch).
            const now = new Date();
            await appendNotificationEventsBatch(
              tx,
              context,
              notificationRead,
              result.rows.map((row) => readEventInput(userId, row, now)),
            );
            return { data: { updated: result.rows.length } };
          }
          case "getPolicy": {
            const result = await tx.execute(
              sql`SELECT * FROM notification_policies LIMIT 1`,
            );
            const row = result.rows[0];
            return {
              data: row
                ? notificationPolicySchema.parse({
                    tenantId: row.tenant_id,
                    webPushEnabled: row.web_push_enabled,
                    emailEnabled: row.email_enabled,
                    whatsapp: row.whatsapp,
                    maxAttempts: row.max_attempts,
                    retryBackoffSeconds: row.retry_backoff_seconds,
                    updatedAt: isoTimestamp(row.updated_at),
                  })
                : defaultNotificationPolicy(
                    context.tenant.tenantId,
                    new Date(),
                  ),
            };
          }
          case "updatePolicy": {
            if (context.outletScope.kind !== "tenant") throw denied();
            const body = updateNotificationPolicy.body.parse(input.body);
            const result = await tx.execute(
              sql`INSERT INTO notification_policies (tenant_id,web_push_enabled,email_enabled,whatsapp,max_attempts,retry_backoff_seconds) VALUES (${context.tenant.tenantId}::uuid,${body.webPushEnabled},${body.emailEnabled},${JSON.stringify(body.whatsapp)}::jsonb,${body.maxAttempts},${JSON.stringify(body.retryBackoffSeconds)}::jsonb) ON CONFLICT (tenant_id) DO UPDATE SET web_push_enabled=EXCLUDED.web_push_enabled,email_enabled=EXCLUDED.email_enabled,whatsapp=EXCLUDED.whatsapp,max_attempts=EXCLUDED.max_attempts,retry_backoff_seconds=EXCLUDED.retry_backoff_seconds,updated_at=now() RETURNING updated_at`,
            );
            return {
              data: notificationPolicySchema.parse({
                tenantId: context.tenant.tenantId,
                ...body,
                updatedAt: isoTimestamp(result.rows[0].updated_at),
              }),
            };
          }
          case "getPreferences": {
            const result = await tx.execute(
              sql`SELECT * FROM notification_preferences WHERE user_id=${userId}::uuid`,
            );
            const row = result.rows[0];
            return {
              data: notificationPreferenceSchema.parse(
                row
                  ? {
                      tenantId: row.tenant_id,
                      userId: row.user_id,
                      categories: row.categories,
                      quietHours: row.quiet_hours,
                      timeZone: row.time_zone,
                      updatedAt: isoTimestamp(row.updated_at),
                    }
                  : {
                      tenantId: context.tenant.tenantId,
                      userId,
                      categories: {},
                      quietHours: null,
                      timeZone: "UTC",
                      updatedAt: new Date().toISOString(),
                    },
              ),
            };
          }
          case "updatePreferences": {
            const body = updateNotificationPreferences.body.parse(input.body);
            // Email for a mandatory category (security) cannot be switched
            // off by the user (legend-307w3); reject before any write.
            for (const [category, channels] of Object.entries(
              body.categories,
            )) {
              const parsed = notificationCategorySchema.safeParse(category);
              if (
                channels?.email === false &&
                parsed.success &&
                isEmailMandatory(parsed.data)
              ) {
                throw new HttpError(
                  422,
                  "VALIDATION_ERROR",
                  `Email untuk kategori ${category} wajib aktif dan tidak bisa dimatikan.`,
                );
              }
            }
            // Lock any existing row so the diff in the event matches what this
            // transaction replaces.
            const before = await tx.execute(
              sql`SELECT categories, quiet_hours FROM notification_preferences WHERE user_id=${userId}::uuid FOR UPDATE`,
            );
            const prev = before.rows[0];
            const result = await tx.execute(
              sql`INSERT INTO notification_preferences (tenant_id,user_id,categories,quiet_hours,time_zone) VALUES (${context.tenant.tenantId}::uuid,${userId}::uuid,${JSON.stringify(body.categories)}::jsonb,${body.quietHours === null ? null : JSON.stringify(body.quietHours)}::jsonb,${body.timeZone}) ON CONFLICT (tenant_id,user_id) DO UPDATE SET categories=EXCLUDED.categories,quiet_hours=EXCLUDED.quiet_hours,time_zone=EXCLUDED.time_zone,updated_at=now() RETURNING updated_at`,
            );
            const now = new Date();
            const oldCategories = (prev?.categories ?? {}) as Record<
              string,
              unknown
            >;
            const newCategories = body.categories as Record<string, unknown>;
            const changedCategories = [
              ...new Set([
                ...Object.keys(oldCategories),
                ...Object.keys(newCategories),
              ]),
            ]
              .filter(
                (key) =>
                  // A stored key that is no longer a category cannot be in
                  // the strict event payload.
                  notificationCategorySchema.safeParse(key).success &&
                  canonicalJson(oldCategories[key] ?? null) !==
                    canonicalJson(newCategories[key] ?? null),
              )
              .sort();
            // A preference is the user's own tenant-level record, not outlet
            // data: its event is tenant-wide (aggregate outlet stays null for
            // every caller), so an outlet-scoped user can still save it. Only
            // the append uses the tenant-wide context; the user's own row is
            // what was changed above.
            await appendNotificationEvent(
              tx,
              establishScopedTenantContext(context.tenant, {
                kind: "tenant",
              }),
              notificationPreferenceUpdated,
              {
                aggregateId: userId,
                outletId: null,
                actorUserId: userId,
                payload: {
                  userId,
                  changedCategories,
                  quietHoursChanged:
                    canonicalJson(prev?.quiet_hours ?? null) !==
                    canonicalJson(body.quietHours),
                },
                now,
              },
            );
            return {
              data: notificationPreferenceSchema.parse({
                tenantId: context.tenant.tenantId,
                userId,
                ...body,
                updatedAt: isoTimestamp(result.rows[0].updated_at),
              }),
            };
          }
          case "registerPush": {
            const body = registerPushSubscription.body.parse(input.body);
            if (!protector) throw denied();
            const sealed = await protector.seal(
              { endpoint: body.endpoint, keys: body.keys },
              context.tenant.tenantId,
              userId,
            );
            if (
              !sealed.endpointHash ||
              !sealed.ciphertext ||
              !sealed.keyVersion
            )
              throw denied();
            const id = randomUUID();
            const result = await tx.execute(
              sql`INSERT INTO push_subscriptions (tenant_id,id,user_id,endpoint_hash,subscription_ciphertext,key_version,device_label) VALUES (${context.tenant.tenantId}::uuid,${id}::uuid,${userId}::uuid,${sealed.endpointHash},${sealed.ciphertext},${sealed.keyVersion},${body.deviceLabel}) ON CONFLICT (tenant_id,user_id,endpoint_hash) DO UPDATE SET subscription_ciphertext=EXCLUDED.subscription_ciphertext,key_version=EXCLUDED.key_version,device_label=EXCLUDED.device_label RETURNING id,created_at,last_success_at`,
            );
            const row = result.rows[0];
            return {
              data: pushSubscriptionSchema.parse({
                id: row.id,
                tenantId: context.tenant.tenantId,
                userId,
                deviceLabel: body.deviceLabel,
                createdAt: isoTimestamp(row.created_at),
                lastSuccessAt:
                  row.last_success_at === null
                    ? null
                    : isoTimestamp(row.last_success_at),
              }),
            };
          }
          case "removePush": {
            const { subscriptionId } = removePushSubscription.params.parse(
              input.params,
            );
            const result = await tx.execute(
              sql`DELETE FROM push_subscriptions WHERE user_id=${userId}::uuid AND id=${subscriptionId}::uuid RETURNING id`,
            );
            if (!result.rows.length)
              throw new HttpError(404, "NOT_FOUND", "Subscription not found.");
            return undefined;
          }
          case "listTemplates": {
            const query = listNotificationTemplates.query.parse(
              input.query ?? {},
            );
            const keys = query.cursor ? decodeCursor(query.cursor) : null;
            if (keys && (keys.length !== 1 || typeof keys[0] !== "string"))
              throw new HttpError(422, "VALIDATION_ERROR", "Invalid cursor.");
            const cursorFilter = keys ? sql`id > ${keys[0]}::uuid` : sql`TRUE`;
            const categoryFilter = query.category
              ? sql`category=${query.category}`
              : sql`TRUE`;
            const result = await tx.execute(
              sql`SELECT * FROM notification_templates WHERE ${cursorFilter} AND ${categoryFilter} ORDER BY id LIMIT ${query.limit + 1}`,
            );
            const rows = result.rows.slice(0, query.limit).map((row) =>
              notificationTemplateSchema.parse({
                id: row.id,
                tenantId: row.tenant_id,
                category: row.category,
                channel: row.channel,
                locale: row.locale,
                title: row.title,
                body: row.body,
                link: row.link,
                whatsappTemplateName: row.whatsapp_template_name,
                variables: row.variables,
                version: row.version,
                isActive: row.is_active,
              }),
            );
            return {
              data: rows,
              meta: {
                limit: query.limit,
                nextCursor:
                  result.rows.length > query.limit && rows.length
                    ? encodeCursor([rows[rows.length - 1].id])
                    : null,
              },
            };
          }
          default:
            throw denied();
        }
      });
    },
  };
}
