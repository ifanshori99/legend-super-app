import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  ulidToUuid,
  uuidToUlid,
  createUlid,
  tenantIdSchema,
  outletIdSchema,
  z,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  emailRequestSchema,
  pushRequestSchema,
  operationResultSchema,
  type EmailProvider,
  type PushProvider,
} from "@starter/shared/adapters";
import {
  nextRetryAt,
  notificationPolicySchema,
  notificationPreferenceSchema,
  notificationSchema,
  planDelivery,
  type Notification,
  type NotificationPolicy,
  type NotificationPreference,
  type Reachability,
} from "@starter/shared/notification";
import type * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";

type Database = NodePgDatabase<typeof schema>;
type Recipient = {
  policy: NotificationPolicy;
  preference: NotificationPreference | null;
  reachability: Reachability;
  defaultTimeZone: string;
  email: string | null;
  pushEndpoint: string | null;
  whatsappNumber: string | null;
  whatsappTemplate?: { name: string; variables: Record<string, string> };
};
type Dependencies = {
  resolve: (
    context: ScopedTenantContext,
    notification: Notification,
  ) => Promise<Recipient>;
  email: EmailProvider;
  push: PushProvider;
  whatsapp?: WhatsAppTemplateProvider;
  /**
   * legend-fy5y: mints the one-time first-admin invitation link at SEND time,
   * so it is never stored in `notifications.body`. Used only for the
   * `tenant_invitation` email. Missing, or null (not eligible, throttled):
   * no provider call and the attempt is recorded dead (fail closed).
   */
  invitationLink?: (
    context: ScopedTenantContext,
    notification: Notification,
  ) => Promise<string | null>;
  /**
   * legend-lb3c: send-time part of a reservation guest EMAIL (confirmation,
   * reminder): text appended to the body, holding the kelola link minted now
   * so no token is ever stored in `notifications.body`. Null: do not send (the
   * booking is no longer confirmed or was moved); the attempt is recorded
   * dead. Missing: same, fail closed.
   */
  reservationLink?: (
    context: ScopedTenantContext,
    notification: Notification,
  ) => Promise<{ readonly text: string } | null>;
};
const whatsappTemplateRequestSchema = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  reference: z.string().min(1).max(255),
  recipient: z.string().regex(/^[1-9][0-9]{7,14}$/),
  templateName: z.string().min(1).max(512),
  variables: z.record(z.string().min(1).max(64), z.string().max(1000)),
});
const CERTAIN_SEND_FAILURES = new Set(["invalid_template", "no_sender"]);
/** A provider error raised before any request was made. Matched by shape so
 * this service does not import a provider module. */
function isCertainSendFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, retryable } = error as { code?: unknown; retryable?: unknown };
  return (
    retryable === false &&
    typeof code === "string" &&
    CERTAIN_SEND_FAILURES.has(code)
  );
}

/** Provider must send an approved WhatsApp template, never arbitrary text. */
export type WhatsAppTemplateProvider = {
  send(
    context: ScopedTenantContext,
    request: z.infer<typeof whatsappTemplateRequestSchema>,
  ): Promise<unknown>;
};
function assertOutlet(context: ScopedTenantContext, outletId: string | null) {
  if (outletId) assertOutletInScope(context.outletScope, outletId);
  else if (context.outletScope.kind !== "tenant")
    throw new Error("Tenant-wide notification requires tenant scope");
}
/** Provider references are stable across crash recovery.
 * The sending claim is committed before I/O; a stale claim is recovered after a
 * lease and fenced by its attempt count. WhatsApp reserves capacity before I/O. */
export async function deliverNotificationAttempt(
  database: Database,
  context: ScopedTenantContext,
  attemptId: string,
  deps: Dependencies,
  now = new Date(),
): Promise<"sent" | "failed" | "not_due" | "skipped"> {
  assertTrustedScopedContext(context);
  const id = ulidToUuid(attemptId);
  const claim = await withTenant(database, context, async (tx) => {
    const query = await tx.execute(
      sql`SELECT a.id, a.tenant_id, a.outlet_id, a.notification_id, a.channel, a.status, a.attempts, a.next_attempt_at, a.idempotency_key, n.outlet_id AS notification_outlet_id, n.user_id, n.category, n.title, n.body, n.link, n.read_at, n.created_at, n.source_event_id, n.dedupe_key FROM delivery_attempts a JOIN notifications n ON n.tenant_id = a.tenant_id AND n.id = a.notification_id WHERE a.tenant_id = ${context.tenant.tenantId}::uuid AND a.id = ${id}::uuid FOR UPDATE OF a`,
    );
    const row = query.rows[0];
    if (!row) return null;
    const outletId = row.outlet_id === null ? null : String(row.outlet_id);
    assertOutlet(context, outletId);
    if (
      row.channel !== "email" &&
      row.channel !== "web_push" &&
      row.channel !== "whatsapp"
    )
      return null;
    const whatsappFallback =
      row.channel === "whatsapp" && row.status === "skipped";
    if (
      !["queued", "failed", "sending"].includes(String(row.status)) &&
      !whatsappFallback
    )
      return null;
    if (row.next_attempt_at && new Date(String(row.next_attempt_at)) > now)
      return null;
    const notification = notificationSchema.parse({
      id: uuidToUlid(String(row.notification_id)),
      tenantId: row.tenant_id,
      outletId,
      userId: row.user_id,
      category: row.category,
      title: row.title,
      body: row.body,
      link: row.link,
      readAt: row.read_at ? new Date(String(row.read_at)).toISOString() : null,
      createdAt: new Date(String(row.created_at)).toISOString(),
      sourceEventId: row.source_event_id
        ? uuidToUlid(String(row.source_event_id))
        : null,
      dedupeKey: row.dedupe_key,
    });
    const recipient = await deps.resolve(context, notification);
    const policy = notificationPolicySchema.parse(recipient.policy);
    const preference =
      recipient.preference &&
      notificationPreferenceSchema.parse(recipient.preference);
    if (
      policy.tenantId !== notification.tenantId ||
      (preference &&
        (preference.tenantId !== notification.tenantId ||
          preference.userId !== notification.userId))
    )
      throw new Error("Delivery recipient scope mismatch");
    let reachability = recipient.reachability;
    let reservedMonth: string | null = null;
    let existingReservation = false;
    let monthlyCount = 0;
    if (row.channel === "whatsapp") {
      if (
        !deps.whatsapp ||
        !recipient.whatsappTemplate ||
        !outletId ||
        context.outletScope.kind !== "tenant"
      )
        return null;
      const free = await tx.execute(
        sql`SELECT status FROM delivery_attempts WHERE tenant_id = ${context.tenant.tenantId}::uuid AND notification_id = ${row.notification_id}::uuid AND channel IN ('email', 'web_push')`,
      );
      if (
        free.rows.some((v) => ["sent", "delivered"].includes(String(v.status)))
      )
        return null;
      if (
        free.rows.some((v) =>
          ["queued", "sending", "failed"].includes(String(v.status)),
        )
      )
        return null;
      reachability = {
        ...recipient.reachability,
        hasPushSubscription: false,
        hasVerifiedEmail: false,
        hasUnverifiedEmail: false,
      };
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "UTC",
        year: "numeric",
        month: "2-digit",
      }).formatToParts(now);
      reservedMonth = `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}`;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${context.tenant.tenantId + ":" + reservedMonth}, 0))`,
      );
      const previous = await tx.execute(
        sql`SELECT month, status FROM whatsapp_reservations WHERE tenant_id = ${context.tenant.tenantId}::uuid AND delivery_attempt_id = ${id}::uuid`,
      );
      if (previous.rows.length) {
        if (
          previous.rows[0].month !== reservedMonth ||
          previous.rows[0].status === "released"
        )
          return null;
        existingReservation = true;
      }
      const total = await tx.execute(
        sql`SELECT count(*) AS total FROM whatsapp_reservations WHERE tenant_id = ${context.tenant.tenantId}::uuid AND month = ${reservedMonth} AND status <> 'released'`,
      );
      monthlyCount = Number(total.rows[0]?.total ?? 0);
    }
    const plan = planDelivery({
      category: notification.category,
      policy,
      preference,
      reachability,
      whatsappSentThisMonth: existingReservation
        ? Math.max(0, monthlyCount - 1)
        : monthlyCount,
      now,
      defaultTimeZone: recipient.defaultTimeZone,
    });
    const choice = plan.channels.find((v) => v.channel === row.channel);
    if (!choice || choice.decision === "skip") {
      await tx.execute(
        sql`UPDATE delivery_attempts SET status = 'skipped', skip_reason = ${choice?.decision === "skip" ? choice.reason : "policy_disabled"}, next_attempt_at = NULL, updated_at = ${now} WHERE tenant_id = ${context.tenant.tenantId}::uuid AND id = ${id}::uuid`,
      );
      return { kind: "skipped" as const };
    }
    if (choice.decision === "defer") {
      await tx.execute(
        sql`UPDATE delivery_attempts SET status = 'queued', next_attempt_at = ${new Date(choice.notBefore)}, updated_at = ${now} WHERE tenant_id = ${context.tenant.tenantId}::uuid AND id = ${id}::uuid`,
      );
      return null;
    }
    const attempts = Number(row.attempts) + 1;
    if (attempts > policy.maxAttempts) {
      await tx.execute(
        sql`UPDATE delivery_attempts SET status = 'dead', next_attempt_at = NULL, updated_at = ${now} WHERE tenant_id = ${context.tenant.tenantId}::uuid AND id = ${id}::uuid`,
      );
      return null;
    }
    if (row.channel === "whatsapp" && !existingReservation) {
      await tx.execute(
        sql`INSERT INTO whatsapp_reservations (tenant_id, id, outlet_id, delivery_attempt_id, month, status) VALUES (${context.tenant.tenantId}::uuid, ${ulidToUuid(createUlid())}::uuid, ${outletId}::uuid, ${id}::uuid, ${reservedMonth}, 'reserved')`,
      );
    }
    const lease = new Date(now.getTime() + 60_000);
    await tx.execute(
      sql`UPDATE delivery_attempts SET status = 'sending', attempts = ${attempts}, next_attempt_at = ${lease}, updated_at = ${now} WHERE tenant_id = ${context.tenant.tenantId}::uuid AND id = ${id}::uuid`,
    );
    return {
      kind: "send" as const,
      notification,
      recipient,
      policy,
      channel: row.channel,
      reference: String(row.idempotency_key),
      attempts,
    };
  });
  if (!claim) return "not_due";
  if (claim.kind === "skipped") return "skipped";
  let accepted = false;
  // True only when the provider answered and declined: the message was
  // certainly not sent. A thrown error may hide a send, so it keeps the slot.
  let rejected = false;
  let providerRef: string | null = null;
  // The invitation or reservation link could not be prepared: nothing was sent and a retry
  // cannot help, so the attempt ends dead.
  let undeliverable = false;
  try {
    const base = {
      tenantId: claim.notification.tenantId,
      outletId: claim.notification.outletId,
      reference: claim.reference,
    };
    let emailBody: string | null = claim.notification.body;
    if (
      claim.channel === "email" &&
      claim.notification.category === "tenant_invitation"
    ) {
      const link = deps.invitationLink
        ? await deps.invitationLink(context, claim.notification)
        : null;
      emailBody =
        link === null ? null : `${claim.notification.body}\n\n${link}`;
    } else if (
      claim.channel === "email" &&
      (claim.notification.category === "reservation_confirmation" ||
        claim.notification.category === "reservation_reminder")
    ) {
      const prepared = deps.reservationLink
        ? await deps.reservationLink(context, claim.notification)
        : null;
      emailBody =
        prepared === null ? null : `${claim.notification.body}${prepared.text}`;
    }
    const result =
      emailBody === null
        ? null
        : claim.channel === "whatsapp"
          ? await deps.whatsapp!.send(
              context,
              whatsappTemplateRequestSchema.parse({
                ...base,
                recipient: claim.recipient.whatsappNumber,
                templateName: claim.recipient.whatsappTemplate?.name,
                variables: claim.recipient.whatsappTemplate?.variables,
              }),
            )
          : claim.channel === "email"
            ? await deps.email.send(
                context,
                emailRequestSchema.parse({
                  ...base,
                  to: claim.recipient.email,
                  subject: claim.notification.title,
                  body: emailBody,
                }),
              )
            : await deps.push.send(
                context,
                pushRequestSchema.parse({
                  ...base,
                  endpoint: claim.recipient.pushEndpoint,
                  title: claim.notification.title,
                  body: claim.notification.body,
                }),
              );
    if (result === null) {
      rejected = true;
      undeliverable = true;
    } else {
      const parsed = operationResultSchema.parse(result);
      accepted = parsed.accepted;
      rejected = !parsed.accepted;
      providerRef = parsed.reference;
    }
  } catch (error) {
    // The provider refused before any request left (bad template name, no
    // sender mapped): certainly not sent, a retry cannot help. End dead and
    // free the quota slot (legend-wasr7.14).
    if (isCertainSendFailure(error)) {
      rejected = true;
      undeliverable = true;
    }
    /* Adapter failures are persisted as machine codes only. The log carries
     * the channel and the provider's HTTP status (or the error class), never
     * the message body, the recipient address or a key. */
    const status =
      error instanceof Error ? /status (\d{3})/.exec(error.message)?.[1] : null;
    logger.warn(
      {
        deliveryAttemptId: id,
        channel: claim.channel,
        providerStatus: status ? Number(status) : null,
        errorType: error instanceof Error ? error.name : typeof error,
      },
      "Notification provider send failed",
    );
  }
  return withTenant(database, context, async (tx) => {
    assertOutlet(context, claim.notification.outletId);
    const retryAt =
      accepted || undeliverable
        ? null
        : nextRetryAt(claim.policy, claim.attempts, now);
    const status = accepted ? "sent" : retryAt ? "failed" : "dead";
    const updated = await tx.execute(
      sql`UPDATE delivery_attempts SET status = ${status}, cost_idr = ${accepted && claim.channel === "whatsapp" ? claim.policy.whatsapp.costPerMessageIdr : 0}, provider_ref = ${providerRef}, error_code = ${accepted ? null : "DELIVERY_FAILED"}, next_attempt_at = ${retryAt}, updated_at = ${now} WHERE tenant_id = ${context.tenant.tenantId}::uuid AND id = ${id}::uuid AND status = 'sending' AND attempts = ${claim.attempts} RETURNING id`,
    );
    if (updated.rows.length && accepted && claim.channel === "whatsapp")
      await tx.execute(
        sql`UPDATE whatsapp_reservations SET status = 'sent', updated_at = ${now} WHERE tenant_id = ${context.tenant.tenantId}::uuid AND delivery_attempt_id = ${id}::uuid`,
      );
    // AUTH-03: a dead attempt the provider definitely declined frees its slot
    // in the monthly cap; ambiguous failures stay counted (fail closed on cost).
    if (
      updated.rows.length &&
      status === "dead" &&
      rejected &&
      claim.channel === "whatsapp"
    )
      await tx.execute(
        sql`UPDATE whatsapp_reservations SET status = 'released', updated_at = ${now} WHERE tenant_id = ${context.tenant.tenantId}::uuid AND delivery_attempt_id = ${id}::uuid AND status = 'reserved'`,
      );
    return updated.rows.length && accepted ? "sent" : "failed";
  });
}
