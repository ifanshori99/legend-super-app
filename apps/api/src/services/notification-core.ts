import {
  assertOutletInScope,
  assertTrustedScopedContext,
  createUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  notificationDedupeKey,
  notificationPolicySchema,
  notificationPreferenceSchema,
  notificationSchema,
  planDelivery,
  type NotificationCategory,
  type NotificationPolicy,
  type NotificationPreference,
  type Reachability,
} from "@starter/shared/notification";

/** Resolved server-side by a domain-specific, trusted recipient resolver. */
export type NotificationRecipient = {
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string;
  link: string | null;
  policy: NotificationPolicy;
  preference: NotificationPreference | null;
  reachability: Reachability;
  whatsappSentThisMonth: number;
  defaultTimeZone: string;
};

/** PRD §3.15: Always create an in-app record; channel choices are policy driven. */
export function buildNotificationBatch(
  context: ScopedTenantContext,
  input: unknown,
  recipients: NotificationRecipient[],
  now: Date,
) {
  assertTrustedScopedContext(context);
  const event = eventEnvelopeSchema.parse(input);
  if (event.tenantId !== context.tenant.tenantId)
    throw new Error("Event tenant does not match context");
  if (event.outletId) assertOutletInScope(context.outletScope, event.outletId);
  else if (context.outletScope.kind !== "tenant")
    throw new Error("Tenant-wide event requires tenant scope");
  const result = [];
  const keys = new Set<string>();
  for (const recipient of recipients) {
    const policy = notificationPolicySchema.parse(recipient.policy);
    const preference =
      recipient.preference === null
        ? null
        : notificationPreferenceSchema.parse(recipient.preference);
    if (
      policy.tenantId !== event.tenantId ||
      (preference &&
        (preference.tenantId !== event.tenantId ||
          preference.userId !== recipient.userId))
    )
      throw new Error("Recipient policy or preference scope mismatch");
    const dedupeKey = notificationDedupeKey(
      event.id,
      recipient.userId,
      recipient.category,
    );
    if (keys.has(dedupeKey)) continue;
    const notification = notificationSchema.parse({
      id: createUlid(now.getTime()),
      tenantId: event.tenantId,
      outletId: event.outletId,
      userId: recipient.userId,
      category: recipient.category,
      title: recipient.title,
      body: recipient.body,
      link: recipient.link,
      readAt: null,
      createdAt: now.toISOString(),
      sourceEventId: event.id,
      dedupeKey,
    });
    const plan = planDelivery({
      category: notification.category,
      policy,
      preference,
      reachability: recipient.reachability,
      whatsappSentThisMonth: recipient.whatsappSentThisMonth,
      now,
      defaultTimeZone: recipient.defaultTimeZone,
    });
    keys.add(dedupeKey);
    result.push({ notification, plan });
  }
  return result;
}
