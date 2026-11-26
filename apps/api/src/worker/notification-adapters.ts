// Production notification adapters for the worker (bead legend-18qw, Part N).
//
// worker-main reads two optional hooks: the recipient resolver the notification
// consumer calls inside the outbox transaction, and the delivery dependencies
// `deliverNotificationAttempt` needs. This module implements both from trusted
// database state only: recipients are never taken from event payload user ids
// unless the id is itself the subject and is re-verified in the database.
//
// Provider selection is explicit: every channel provider env var is required
// (`disabled` is a deliberate value, not a default), so a deployment can never
// silently run without a channel. Secrets are never logged or put in errors.
import { createECDH, createHash } from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  toIsoDateTime,
  ulidToUuid,
  z,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  emailRequestSchema,
  operationResultSchema,
  type EmailProvider,
  type PushProvider,
} from "@starter/shared/adapters";
import type { EventEnvelope } from "@starter/shared/events";
import { INVITATION_LINK_TTL_MINUTES } from "@starter/shared/identity";
import {
  EMERGENCY_PERMISSION_RESPOND,
  facilityIncidentRaisedEvent,
  panicAlertRaisedEvent,
} from "@starter/shared/facility";
import {
  approvalRequestedEvent,
  approvalResolvedEvent,
} from "@starter/shared/identity";
import {
  allowsUnverifiedEmail,
  defaultNotificationPolicy,
  notificationPolicySchema,
  notificationPreferenceSchema,
  type NotificationCategory,
  type NotificationPolicy,
  subscriptionInvoiceCreatedEvent,
  type NotificationPreference,
  type Reachability,
  type Notification,
} from "@starter/shared/notification";
import {
  leaveRedeductedAfterSettlement,
  shiftCancelled,
  shiftPublished,
} from "@starter/shared/hris";
import {
  payoutBatchDisputed,
  payoutBatchUnfrozen,
  payoutStepAttested,
} from "@starter/shared/hris/payroll";
import { createTranslator, messagesId } from "@starter/shared/i18n";
import { operationsEventPayloadSchemas } from "@starter/shared/operations";
import { PLATFORM_EVENT_PAYLOADS } from "@starter/shared/platform";
import { AI_EVENT_PAYLOAD_SCHEMAS } from "@starter/shared/ai";
import {
  paymentRefundEscalatedPayloadSchema,
  type RefundEscalationReason,
} from "@starter/shared/payment";
import type * as schema from "../db/schema/index.ts";
import { aiDailySummaries } from "../db/schema/ai-insights.ts";
import {
  notificationPolicies,
  notificationOutbox,
  notificationPreferences,
  pushSubscriptions,
  whatsappReservations,
} from "../db/schema/notification.ts";
import { customerProfiles } from "../db/schema/crm-member.ts";
import { facilityIncidents } from "../db/schema/facility.ts";
import { panicAlerts } from "../db/schema/panic-alert.ts";
import { employees } from "../db/schema/hris.ts";
import { payrollRuns } from "../db/schema/payroll.ts";
import {
  payrollDisbursementBatches,
  payrollPayoutApprovalLog,
  payrollPayoutBatchDisputes,
  payrollPayoutBatchUnfreezes,
} from "../db/schema/payroll-payout.ts";
import { roleAssignments, roles } from "../db/schema/platform-access.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
import { user } from "../db/schema/user.ts";
import {
  reportExports,
  reportSchedules,
  savedReports,
} from "../db/schema/report-delivery.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import { isReservedAddress } from "../services/identity-email-login.service.ts";
import { isPublicHttpsUrl } from "@starter/shared/adapters";
import {
  createKirimdevMessagingProvider,
  kirimdevSenderFromPlatformMapping,
} from "../services/messaging-kirimdev.ts";
import type { WhatsAppTemplateProvider } from "../services/notification-delivery.ts";
import { notifyBrevoAuthFailed } from "../services/edge-sync-conflict-alert.ts";
import {
  dutyWindowEnd,
  employeeOfStaff,
} from "../services/panic-receiver-duty.ts";
import { issueInvitationLink } from "../services/identity-invitation.service.ts";
import type { NotificationRecipientResolver } from "../services/notification-consumer.ts";
import type { NotificationRecipient } from "../services/notification-core.ts";
import { prepareReservationEmail } from "../services/reservation-guest-notify.ts";
import type { deliverNotificationAttempt } from "../services/notification-delivery.ts";
import { openPushSubscription } from "../lib/push-subscription.ts";
import {
  createWebPushProvider,
  deliverablePushSubscription,
  pushOutletMatches,
  type WebPushSend,
} from "./web-push-provider.ts";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<NotificationRecipientResolver>[2];
type DeliveryDependencies = Parameters<typeof deliverNotificationAttempt>[3];
type FetchLike = typeof globalThis.fetch;

const DEFAULT_TIME_ZONE = "Asia/Jakarta";
const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const BREVO_TIMEOUT_MS = 10_000;
const SETTINGS_MANAGE_PERMISSION = "org.settings.manage";
const SUPPORT_ACCESS_APPROVE_PERMISSION = "org.support_access.approve";
const FACILITY_BOOTH_OPERATE_PERMISSION = "facility.booth.operate";
const OPS_ALERT_TEMPLATE_KEYS = ["supervisor", "outlet_manager"];

/** Channels whose provider is configured; a disabled channel is never planned. */
export type NotificationChannels = { email: boolean; push: boolean };

// ---- Recipient state ---------------------------------------------------------

type UserState = {
  /** False for a banned (disabled) or missing account: never notified. */
  active: boolean;
  email: string;
  emailVerified: boolean;
  hasPushSubscription: boolean;
  preference: NotificationPreference | null;
};
type RecipientState = {
  policy: NotificationPolicy;
  whatsappSentThisMonth: number;
  users: Map<string, UserState>;
};

function utcMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Same fallback as service-request.service.ts buildRecipients: no policy row
 * means web push only, no email, no WhatsApp. */
async function loadPolicy(
  tx: Tx,
  tenantId: string,
  now: Date,
): Promise<NotificationPolicy> {
  const [row] = await tx
    .select()
    .from(notificationPolicies)
    .where(eq(notificationPolicies.tenantId, tenantId));
  return row
    ? notificationPolicySchema.parse({
        tenantId,
        webPushEnabled: row.webPushEnabled,
        emailEnabled: row.emailEnabled,
        whatsapp: row.whatsapp,
        maxAttempts: row.maxAttempts,
        retryBackoffSeconds: row.retryBackoffSeconds,
        updatedAt: toIsoDateTime(row.updatedAt),
      })
    : defaultNotificationPolicy(tenantId, now);
}

async function loadRecipientState(
  tx: Tx,
  tenantId: string,
  userIds: string[],
  channels: NotificationChannels,
  now: Date,
): Promise<RecipientState> {
  const policy = await loadPolicy(tx, tenantId, now);
  const users = new Map<string, UserState>();
  if (userIds.length === 0) return { policy, whatsappSentThisMonth: 0, users };
  const userRows = await tx
    .select({
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(user)
    .where(inArray(user.id, userIds));
  const preferenceRows = await tx
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.tenantId, tenantId),
        inArray(notificationPreferences.userId, userIds),
      ),
    );
  const subscribed = new Set<string>();
  if (channels.push) {
    const rows = await tx
      .select({ userId: pushSubscriptions.userId })
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.tenantId, tenantId),
          inArray(pushSubscriptions.userId, userIds),
          deliverablePushSubscription(now),
        ),
      );
    for (const row of rows) subscribed.add(row.userId);
  }
  // One malformed stored preference falls back to the defaults for that user
  // instead of failing the whole event for every recipient.
  const preferences = new Map<string, NotificationPreference>();
  for (const row of preferenceRows) {
    const parsed = notificationPreferenceSchema.safeParse({
      tenantId,
      userId: row.userId,
      categories: row.categories,
      quietHours: row.quietHours ?? null,
      timeZone: row.timeZone,
      updatedAt: toIsoDateTime(row.updatedAt),
    });
    if (parsed.success) preferences.set(row.userId, parsed.data);
  }
  const accounts = new Map(userRows.map((row) => [row.id, row]));
  for (const userId of userIds) {
    const account = accounts.get(userId);
    users.set(userId, {
      active:
        account !== undefined &&
        (account.banned !== true ||
          (account.banExpires !== null &&
            account.banExpires.getTime() <= now.getTime())),
      email: account?.email ?? "",
      emailVerified: account?.emailVerified === true,
      hasPushSubscription: subscribed.has(userId),
      preference: preferences.get(userId) ?? null,
    });
  }
  const [count] = await tx
    .select({ total: sql<number>`count(*)` })
    .from(whatsappReservations)
    .where(
      and(
        eq(whatsappReservations.tenantId, tenantId),
        eq(whatsappReservations.month, utcMonth(now)),
        ne(whatsappReservations.status, "released"),
      ),
    );
  return { policy, whatsappSentThisMonth: Number(count?.total ?? 0), users };
}

function reachabilityOf(
  state: UserState,
  channels: NotificationChannels,
): Reachability {
  return {
    hasPushSubscription:
      state.active && channels.push && state.hasPushSubscription,
    hasVerifiedEmail: state.active && channels.email && state.emailVerified,
    // Counts only for a category that `allowsUnverifiedEmail` (the first-admin
    // invitation); a `.invalid` placeholder is never a mailbox.
    hasUnverifiedEmail:
      state.active &&
      channels.email &&
      !state.emailVerified &&
      !isReservedAddress(state.email),
    whatsappOptIn: false,
  };
}

// ---- Audience queries --------------------------------------------------------

type Audience =
  { kind: "tenant" } | { kind: "outlet"; outletId: string; brandId: string };

function required(condition: SQL | undefined): SQL {
  if (!condition) throw new Error("Empty query condition");
  return condition;
}

/** The account may be notified: not banned, or its ban has expired. */
const accountActive = (): SQL =>
  required(
    or(
      isNull(user.banned),
      eq(user.banned, false),
      lte(user.banExpires, sql`now()`),
    ),
  );

/** Distinct active (not banned) users with an active assignment of a matching
 * role whose scope covers the audience. A tenant-wide event reaches
 * tenant-scope holders only. Filtering accounts here, before any fallback is
 * chosen, keeps a banned holder from hiding the fallback audience. */
async function activeAssignees(
  tx: Tx,
  tenantId: string,
  roleCondition: SQL,
  audience: Audience,
): Promise<string[]> {
  const scope =
    audience.kind === "tenant"
      ? eq(roleAssignments.scopeType, "tenant")
      : required(
          or(
            eq(roleAssignments.scopeType, "tenant"),
            and(
              eq(roleAssignments.scopeType, "brand"),
              eq(roleAssignments.scopeId, audience.brandId),
            ),
            and(
              eq(roleAssignments.scopeType, "outlet"),
              eq(roleAssignments.scopeId, audience.outletId),
            ),
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
        accountActive(),
        lte(roleAssignments.validFrom, sql`now()`),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, sql`now()`),
        ),
      ),
    );
  return rows.map((row) => row.userId).sort();
}

async function outletAudience(
  tx: Tx,
  tenantId: string,
  outletId: string,
): Promise<Audience> {
  const [outlet] = await tx
    .select({ brandId: outlets.brandId })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) throw new Error("Notification outlet not found");
  return { kind: "outlet", outletId, brandId: outlet.brandId };
}

async function audienceOf(
  tx: Tx,
  event: Pick<EventEnvelope, "tenantId" | "outletId">,
): Promise<Audience> {
  if (!event.outletId) return { kind: "tenant" };
  return outletAudience(tx, event.tenantId, event.outletId);
}

// ---- Event rules -------------------------------------------------------------

type Content = {
  category: NotificationCategory;
  title: string;
  body: string;
  link: string | null;
};
type Rule = {
  content: Content;
  userIds: string[];
  /** Per-recipient link that replaces `content.link` (legend-l2zru). */
  links?: ReadonlyMap<string, string>;
};
type RuleInput = {
  tx: Tx;
  event: EventEnvelope;
  tenantId: TenantId;
};

const ACTION_LABELS: Record<string, string> = {
  void: "pembatalan transaksi",
  refund: "pengembalian dana",
  payroll: "penggajian",
  expense: "pengeluaran",
  mcp_action: "aksi otomatis",
};
const actionLabel = (actionType: string) =>
  ACTION_LABELS[actionType] ?? "persetujuan";

const OUTCOME_TEXT: Record<string, { title: string; verb: string }> = {
  approved: { title: "Permintaan disetujui", verb: "disetujui" },
  rejected: { title: "Permintaan ditolak", verb: "ditolak" },
  expired: { title: "Permintaan kedaluwarsa", verb: "kedaluwarsa" },
  cancelled: { title: "Permintaan dibatalkan", verb: "dibatalkan" },
};

async function loadApprovalRequest(
  { tx, event, tenantId }: RuleInput,
  requestId: string,
) {
  const [row] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.id, requestId),
      ),
    );
  if (!row) throw new Error("Approval request not found for notification");
  if ((row.outletId ?? null) !== (event.outletId ?? null))
    throw new Error("Approval request outlet does not match the event");
  return row;
}

async function approvalRequestedRule(input: RuleInput): Promise<Rule> {
  const payload = approvalRequestedEvent.payloadSchema.parse(
    input.event.payload,
  );
  const row = await loadApprovalRequest(input, payload.requestId);
  // A delayed event for a level that was already decided (or a closed
  // request) must not page the next level's approvers or anyone at all.
  if (row.status !== "pending" || row.level !== payload.level)
    return {
      userIds: [],
      content: {
        category: "approval_request",
        title: "",
        body: "",
        link: null,
      },
    };
  const step = row.requiredSteps[payload.level - 1];
  const roleIds = step ? [...step.approverRoleIds] : [];
  const audience = await audienceOf(input.tx, input.event);
  const approvers =
    roleIds.length === 0
      ? []
      : await activeAssignees(
          input.tx,
          input.tenantId,
          inArray(roles.id, roleIds),
          audience,
        );
  return {
    userIds: approvers.filter((userId) => userId !== row.requestedBy),
    content: {
      category: "approval_request",
      title: "Permintaan persetujuan baru",
      body: `Ada permintaan ${actionLabel(row.actionType)} yang menunggu keputusan Anda.`,
      link: `/kelola/persetujuan/${row.id}`,
    },
  };
}

async function approvalResolvedRule(input: RuleInput): Promise<Rule> {
  const payload = approvalResolvedEvent.payloadSchema.parse(
    input.event.payload,
  );
  const row = await loadApprovalRequest(input, payload.requestId);
  const text = OUTCOME_TEXT[row.status] ?? {
    title: "Permintaan diproses",
    verb: "diproses",
  };
  // A requester who left the tenant (no active assignment of any scope) or
  // whose account is banned is not told about the outcome.
  const stillMember = await input.tx
    .select({ userId: roleAssignments.userId })
    .from(roleAssignments)
    .innerJoin(user, eq(user.id, roleAssignments.userId))
    .where(
      and(
        eq(roleAssignments.tenantId, input.tenantId),
        eq(roleAssignments.userId, row.requestedBy),
        accountActive(),
        lte(roleAssignments.validFrom, sql`now()`),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, sql`now()`),
        ),
      ),
    )
    .limit(1);
  return {
    userIds: stillMember.length > 0 ? [row.requestedBy] : [],
    content: {
      category: "approval_request",
      title: text.title,
      body: `Permintaan ${actionLabel(row.actionType)} Anda telah ${text.verb}.`,
      link: `/kelola/persetujuan/${row.id}`,
    },
  };
}

async function supportAccessRule(
  input: RuleInput,
  ended: boolean,
): Promise<Rule> {
  const admins = await activeAssignees(
    input.tx,
    input.tenantId,
    sql`${roles.permissions} @> ${JSON.stringify([SETTINGS_MANAGE_PERMISSION])}::jsonb`,
    { kind: "tenant" },
  );
  return {
    userIds: admins,
    content: {
      category: "security",
      title: ended ? "Akses dukungan berakhir" : "Akses dukungan diberikan",
      body: ended
        ? "Akses sementara tim dukungan ke akun Anda telah berakhir."
        : "Tim dukungan kini memiliki akses sementara ke akun Anda.",
      link: null,
    },
  };
}

/** legend-c9kbk: a read_write request pages only those who can decide it:
 * tenant-wide owner-template holders of `org.support_access.approve` (the
 * service refuses anyone else). */
async function supportAccessRequestedRule(input: RuleInput): Promise<Rule> {
  const approvers = await activeAssignees(
    input.tx,
    input.tenantId,
    sql`${roles.templateKey} = 'owner' AND ${roles.permissions} @> ${JSON.stringify([SUPPORT_ACCESS_APPROVE_PERMISSION])}::jsonb`,
    { kind: "tenant" },
  );
  return {
    userIds: approvers,
    content: {
      category: "security",
      title: "Permintaan akses dukungan",
      body: "Tim dukungan meminta akses ubah data sementara. Setujui atau tolak dalam 24 jam.",
      link: null,
    },
  };
}

async function checklistRule(
  input: RuleInput,
  name: "checklist.missed" | "checklist.failed",
): Promise<Rule> {
  const payload = operationsEventPayloadSchemas[name].parse(
    input.event.payload,
  );
  if (!input.event.outletId)
    throw new Error("Checklist notification requires an outlet");
  const audience = await audienceOf(input.tx, input.event);
  const supervisors = (
    await activeAssignees(
      input.tx,
      input.tenantId,
      inArray(roles.templateKey, OPS_ALERT_TEMPLATE_KEYS as never[]),
      audience,
    )
  ).filter((userId) => userId !== payload.assignedTo);
  // Nobody to escalate to: the owners (tenant-wide) take the alert instead.
  const userIds =
    supervisors.length > 0
      ? supervisors
      : await activeAssignees(
          input.tx,
          input.tenantId,
          eq(roles.templateKey, "owner"),
          { kind: "tenant" },
        );
  return {
    userIds,
    content: {
      category: "checklist_alert",
      title:
        name === "checklist.missed" ? "Checklist terlewat" : "Checklist gagal",
      body:
        name === "checklist.missed"
          ? "Ada checklist outlet yang melewati batas waktu dan belum selesai."
          : "Ada checklist outlet yang selesai dengan item gagal.",
      link: null,
    },
  };
}

/** OPS-04: a maintenance schedule is coming due. Same audience as the
 * checklist alerts: active supervisor and outlet-manager holders whose scope
 * covers the outlet, owners (tenant-wide) when nobody holds those roles. */
async function equipmentServiceRemindedRule(input: RuleInput): Promise<Rule> {
  operationsEventPayloadSchemas["equipment_service.reminded"].parse(
    input.event.payload,
  );
  if (!input.event.outletId)
    throw new Error("Equipment service notification requires an outlet");
  const audience = await audienceOf(input.tx, input.event);
  const supervisors = await activeAssignees(
    input.tx,
    input.tenantId,
    inArray(roles.templateKey, OPS_ALERT_TEMPLATE_KEYS as never[]),
    audience,
  );
  const userIds =
    supervisors.length > 0
      ? supervisors
      : await activeAssignees(
          input.tx,
          input.tenantId,
          eq(roles.templateKey, "owner"),
          { kind: "tenant" },
        );
  return {
    userIds,
    content: {
      category: "schedule_update",
      title: "Servis peralatan segera jatuh tempo",
      body: "Ada peralatan outlet yang jadwal servisnya jatuh tempo dalam 7 hari. Hubungi vendor servis.",
      link: null,
    },
  };
}

/** FAC-08: the staff on duty answer the emergency button. No on-duty source
 * exists yet, so the audience is active holders of `facility.booth.operate`
 * whose scope covers the incident's outlet. The `emergency` category is the
 * urgent lane: it bypasses quiet hours. Nobody holds it: owners take it. */
async function facilityIncidentRaisedRule(input: RuleInput): Promise<Rule> {
  const payload = facilityIncidentRaisedEvent.payloadSchema.parse(
    input.event.payload,
  );
  if (!input.event.outletId)
    throw new Error("Facility incident notification requires an outlet");
  const [row] = await input.tx
    .select({
      outletId: facilityIncidents.outletId,
      respondedAt: facilityIncidents.respondedAt,
    })
    .from(facilityIncidents)
    .where(
      and(
        eq(facilityIncidents.tenantId, input.tenantId),
        eq(facilityIncidents.id, payload.incidentId),
      ),
    );
  if (!row) throw new Error("Facility incident not found for notification");
  if (row.outletId !== input.event.outletId)
    throw new Error("Facility incident outlet does not match the event");
  const content: Content = {
    category: "emergency",
    title: "Tombol darurat ditekan",
    body: "Ada tombol darurat fasilitas yang ditekan di outlet Anda. Segera tanggapi.",
    link: null,
  };
  // A delayed event for an incident someone already answered pages nobody.
  if (row.respondedAt !== null) return { userIds: [], content };
  const audience = await audienceOf(input.tx, input.event);
  const operators = await activeAssignees(
    input.tx,
    input.tenantId,
    sql`${roles.permissions} @> ${JSON.stringify([FACILITY_BOOTH_OPERATE_PERMISSION])}::jsonb`,
    audience,
  );
  const userIds =
    operators.length > 0
      ? operators
      : await activeAssignees(
          input.tx,
          input.tenantId,
          eq(roles.templateKey, "owner"),
          { kind: "tenant" },
        );
  return { userIds, content };
}

/** FAC-08 (legend-kmjax): web push fallback outside the LAN. The audience is
 * the staff ON DUTY at the alert's outlet (same duty rule as the receiver
 * session, D-04) who hold `facility.emergency.respond` in a scope that covers
 * that outlet. Nobody on duty means nobody is paged: there is no owner
 * fallback. The `emergency` category bypasses quiet hours. The link carries
 * the alert reference (alertId, outletId, unitId, kind, receivedAt) so a push
 * provider can open the emergency screen on it; the visible text names only
 * the facility and unit labels. */
/** Same 24 h window as the receiver's CONNECT_LOOKBACK_MS (panic-relay.service,
 * not exported): an alert older than this is never paged. */
const PANIC_PAGE_MAX_AGE_MS = 24 * 60 * 60_000;

async function panicAlertRaisedRule(input: RuleInput): Promise<Rule> {
  const payload = panicAlertRaisedEvent.payloadSchema.parse(
    input.event.payload,
  );
  if (!input.event.outletId)
    throw new Error("Panic alert notification requires an outlet");
  if (payload.outletId !== input.event.outletId)
    throw new Error("Panic alert outlet does not match the event");
  const [row] = await input.tx
    .select({
      outletId: panicAlerts.outletId,
      acknowledgedAt: panicAlerts.acknowledgedAt,
      resolvedAt: panicAlerts.resolvedAt,
      receivedAt: panicAlerts.receivedAt,
      unitCodeSnapshot: panicAlerts.unitCodeSnapshot,
      facilityNameSnapshot: panicAlerts.facilityNameSnapshot,
    })
    .from(panicAlerts)
    .where(
      and(
        eq(panicAlerts.tenantId, input.tenantId),
        eq(panicAlerts.id, payload.alertId),
      ),
    );
  if (!row) throw new Error("Panic alert not found for notification");
  if (row.outletId !== input.event.outletId)
    throw new Error("Panic alert outlet does not match the stored alert");
  const query = new URLSearchParams({
    alertId: payload.alertId,
    outletId: payload.outletId,
    kind: payload.kind,
    receivedAt: payload.receivedAt,
  });
  if (payload.unitId) query.set("unitId", payload.unitId);
  const place = [row.facilityNameSnapshot, row.unitCodeSnapshot]
    .filter((part) => part.length > 0)
    .join(" ");
  const isTest = payload.kind === "test";
  const content: Content = {
    category: "emergency",
    title: isTest ? "UJI tombol darurat" : "Tombol darurat ditekan",
    body: `${isTest ? "UJI: " : ""}Tombol darurat ditekan${place ? ` di ${place}` : ""}. Segera tanggapi.`,
    link: `/fasilitas/darurat?${query.toString()}`,
  };
  // A delayed event for an alert someone already answered pages nobody.
  if (row.acknowledgedAt !== null || row.resolvedAt !== null)
    return { userIds: [], content };
  const now = new Date();
  // A long link outage can deliver the event hours late: never page "Segera
  // tanggapi" for a stale alert.
  if (now.getTime() - row.receivedAt.getTime() > PANIC_PAGE_MAX_AGE_MS)
    return { userIds: [], content };
  const holders = await permissionHolders(input, EMERGENCY_PERMISSION_RESPOND);
  const userIds: string[] = [];
  for (const userId of holders) {
    const employee = await employeeOfStaff(input.tx, {
      tenantId: input.tenantId,
      userId,
    });
    if (!employee?.active) continue;
    const end = await dutyWindowEnd(input.tx, {
      tenantId: input.tenantId,
      outletId: payload.outletId,
      employeeId: employee.id,
      now,
    });
    if (end !== null) userIds.push(userId);
  }
  return { userIds, content };
}

// ---- AI insights (WS-12 wave 3: AI-09 anomaly, AI-10 daily summary) --------

const ANOMALY_LABELS: Record<string, string> = {
  void: "Void",
  discount: "Diskon",
  refund: "Refund",
  waste: "Waste",
};
const rupiah = (value: number) =>
  `Rp${new Intl.NumberFormat("id-ID").format(value)}`;

/** Active holders of one permission code (through any role row) whose
 * assignment scope covers the event's outlet. */
async function permissionHolders(
  input: RuleInput,
  permission: string,
): Promise<string[]> {
  return activeAssignees(
    input.tx,
    input.tenantId,
    sql`${roles.permissions} @> ${JSON.stringify([permission])}::jsonb`,
    await audienceOf(input.tx, input.event),
  );
}

async function aiAnomalyRule(input: RuleInput): Promise<Rule> {
  const payload = AI_EVENT_PAYLOAD_SCHEMAS["ai_insight.anomaly_detected"].parse(
    input.event.payload,
  );
  if (input.event.outletId !== payload.outletId)
    throw new Error("Anomaly notification outlet mismatch");
  const label = ANOMALY_LABELS[payload.kind] ?? payload.kind;
  return {
    userIds: await permissionHolders(input, "report.operational.view"),
    content: {
      category: "operational_anomaly",
      title: `Anomali ${label.toLowerCase()} ${payload.businessDate}`,
      body:
        `${label} ${payload.businessDate}: ${rupiah(payload.observedIdr)}, ` +
        `rata-rata 28 hari ${rupiah(payload.baselineIdr)} ` +
        `(tingkat ${payload.severity === "high" ? "tinggi" : "perlu dicek"}).`,
      link: null,
    },
  };
}

async function aiDailySummaryRule(input: RuleInput): Promise<Rule> {
  const payload = AI_EVENT_PAYLOAD_SCHEMAS[
    "ai_insight.daily_summary_ready"
  ].parse(input.event.payload);
  if (input.event.outletId !== payload.outletId)
    throw new Error("Daily summary notification outlet mismatch");
  const [row] = await input.tx
    .select({ text: aiDailySummaries.text })
    .from(aiDailySummaries)
    .where(
      and(
        eq(aiDailySummaries.tenantId, input.tenantId),
        eq(aiDailySummaries.id, payload.summaryId),
      ),
    );
  if (!row) throw new Error("Daily summary not found");
  return {
    userIds: await permissionHolders(input, "report.sales.view"),
    content: {
      category: "daily_summary",
      title: `Ringkasan harian ${payload.businessDate}`,
      body: row.text.slice(0, 1000),
      link: null,
    },
  };
}

function refundEscalatedBody(reason: RefundEscalationReason): string {
  switch (reason) {
    case "pending_unapproved":
      return "Ada refund yang belum diproses dan sudah melewati batas waktu tunggu. Mohon ditinjau.";
    case "provider_pending":
      return "Ada refund yang sudah disetujui tetapi pengembalian dananya belum selesai di penyedia pembayaran. Mohon ditinjau.";
    case "payout_stalled":
      return "Ada refund yang sudah disetujui tetapi pembayarannya tertahan dan perlu ditangani manual. Mohon ditinjau.";
    case "failed_holds_order":
      return "Ada refund yang gagal dan menahan pesanan QR yang belum dibayar. Mohon ditinjau dan setujui pengajuan ulangnya.";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

/** A refund waited past its tenant threshold: outlet managers (their outlet)
 * and finance (tenant-wide) decide. Body carries no amount or customer data. */
async function refundEscalatedRule(input: RuleInput): Promise<Rule> {
  const payload = paymentRefundEscalatedPayloadSchema.parse(
    input.event.payload,
  );
  const audience = await audienceOf(input.tx, input.event);
  const managers = await activeAssignees(
    input.tx,
    input.tenantId,
    inArray(roles.templateKey, ["outlet_manager"] as never[]),
    audience,
  );
  const finance = await activeAssignees(
    input.tx,
    input.tenantId,
    inArray(roles.templateKey, ["finance"] as never[]),
    { kind: "tenant" },
  );
  const handlers = [...new Set([...managers, ...finance])].sort();
  // Nobody to escalate to: the owners (tenant-wide) take the alert instead.
  const userIds =
    handlers.length > 0
      ? handlers
      : await activeAssignees(
          input.tx,
          input.tenantId,
          eq(roles.templateKey, "owner"),
          { kind: "tenant" },
        );
  return {
    userIds,
    content: {
      category: "approval_request",
      title:
        payload.reason === "failed_holds_order"
          ? "Refund gagal menahan pesanan"
          : "Refund menunggu terlalu lama",
      body: refundEscalatedBody(payload.reason),
      link: null,
    },
  };
}

const INVOICE_AMOUNT = new Intl.NumberFormat("id-ID");

/** A recurring-billing invoice was created: the subscribing customer hears
 * about it. The recipient is re-read from the customer profile row (never the
 * payload); a missing, merged or user-less profile pages nobody. The hosted pay
 * link goes in the body because a notification link must be an in-app path. */
async function subscriptionInvoiceCreatedRule(input: RuleInput): Promise<Rule> {
  const payload = subscriptionInvoiceCreatedEvent.payloadSchema.parse(
    input.event.payload,
  );
  const [profile] = await input.tx
    .select({
      userId: customerProfiles.userId,
      mergedIntoProfileId: customerProfiles.mergedIntoProfileId,
    })
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.tenantId, input.tenantId),
        eq(customerProfiles.id, payload.customerProfileId),
      ),
    );
  const userIds =
    profile?.userId && profile.mergedIntoProfileId === null
      ? [profile.userId]
      : [];
  return {
    userIds,
    content: {
      category: "subscription_billing",
      title: "Tagihan langganan baru",
      body: `Tagihan langganan ${payload.planName} untuk periode ${payload.periodStart} sampai ${payload.periodEnd} sebesar Rp${INVOICE_AMOUNT.format(payload.amountIdr)} sudah terbit. Bayar di ${payload.hostedUrl}`,
      link: null,
    },
  };
}

const PAYOUT_RECEIPT_TIME = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  dateStyle: "long",
  timeStyle: "short",
});
const payoutReceiptText = createTranslator(messagesId);

/** legend-7gghu: the person whose login attested a payout step hears about it
 * outside that session ("Bukan Anda?"). Everything is re-read from the
 * append-only log by tenant + id; the payload carries the log id only, so a
 * forged event cannot name a recipient. The recipient is the log's actor and
 * only while still holding an open role assignment in this tenant. The text
 * has no amount, name or account number (the batch total is sealed). */
async function payoutStepAttestedRule(input: RuleInput): Promise<Rule> {
  const payload = payoutStepAttested.payloadSchema.parse(input.event.payload);
  const [log] = await input.tx
    .select({
      actor: payrollPayoutApprovalLog.actor,
      kind: payrollPayoutApprovalLog.kind,
      step: payrollPayoutApprovalLog.step,
      batchId: payrollPayoutApprovalLog.batchId,
      itemCount: payrollPayoutApprovalLog.itemCount,
      loggedAt: payrollPayoutApprovalLog.loggedAt,
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
    })
    .from(payrollPayoutApprovalLog)
    .innerJoin(
      payrollDisbursementBatches,
      and(
        eq(
          payrollDisbursementBatches.tenantId,
          payrollPayoutApprovalLog.tenantId,
        ),
        eq(payrollDisbursementBatches.id, payrollPayoutApprovalLog.batchId),
      ),
    )
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.tenantId, payrollDisbursementBatches.tenantId),
        eq(payrollRuns.id, payrollDisbursementBatches.payrollRunId),
      ),
    )
    .where(
      and(
        eq(payrollPayoutApprovalLog.tenantId, input.tenantId),
        eq(payrollPayoutApprovalLog.id, payload.logId),
      ),
    );
  if (!log) throw new Error("Payout approval log row not found for receipt");
  const [member] = await input.tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.tenantId, input.tenantId),
        eq(roleAssignments.userId, log.actor),
        lte(roleAssignments.validFrom, sql`now()`),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, sql`now()`),
        ),
      ),
    )
    .limit(1);
  const body = payoutReceiptText("payrollPayoutReceipt.body", {
    verb: payoutReceiptText(`payrollPayoutReceipt.verb.${log.step}`),
    kind: payoutReceiptText(`payrollPayoutReceipt.kind.${log.kind}`),
    period: `${log.periodStart} sampai ${log.periodEnd}`,
    count: log.itemCount,
    time: PAYOUT_RECEIPT_TIME.format(log.loggedAt),
  });
  return {
    userIds: member ? [log.actor] : [],
    content: {
      category: "payout_receipt",
      title: payoutReceiptText("payrollPayoutReceipt.title"),
      body,
      link: payoutReceiptLink(payload.logId),
    },
  };
}

/** Page of one logged payout step, with the "Bukan saya" button. */
const payoutReceiptLink = (logId: string) =>
  `/tanda-terima/payroll/${encodeURIComponent(logId)}`;

/** legend-l2zru: a payout batch was frozen by a "not me" dispute, or the freeze
 * was lifted. Owner and finance (tenant-wide) and the person behind the
 * dispute hear about it, outside any session. Everything is re-read from the
 * append-only dispute / unfreeze rows by tenant + id; the payload carries the
 * row id only, so a forged event cannot name a recipient. The disputant gets
 * it only while still holding an open role assignment in this tenant. The
 * text has no amount, name or account number. */
async function payoutBatchFreezeRule(
  input: RuleInput,
  kind: "disputed" | "unfrozen",
): Promise<Rule> {
  let batchId: string;
  let disputant: string;
  let logId: string;
  let at: Date;
  if (kind === "disputed") {
    const payload = payoutBatchDisputed.payloadSchema.parse(
      input.event.payload,
    );
    const [row] = await input.tx
      .select({
        batchId: payrollPayoutBatchDisputes.batchId,
        actor: payrollPayoutBatchDisputes.actor,
        logId: payrollPayoutBatchDisputes.logId,
        at: payrollPayoutBatchDisputes.createdAt,
      })
      .from(payrollPayoutBatchDisputes)
      .where(
        and(
          eq(payrollPayoutBatchDisputes.tenantId, input.tenantId),
          eq(payrollPayoutBatchDisputes.id, payload.disputeId),
        ),
      );
    if (!row)
      throw new Error("Payout batch dispute not found for notification");
    ({ batchId, actor: disputant, logId, at } = row);
  } else {
    const payload = payoutBatchUnfrozen.payloadSchema.parse(
      input.event.payload,
    );
    // The people to tell about an unfreeze are those of the dispute it closes.
    const [row] = await input.tx
      .select({
        batchId: payrollPayoutBatchUnfreezes.batchId,
        actor: payrollPayoutBatchDisputes.actor,
        logId: payrollPayoutBatchDisputes.logId,
        at: payrollPayoutBatchUnfreezes.createdAt,
      })
      .from(payrollPayoutBatchUnfreezes)
      .innerJoin(
        payrollPayoutBatchDisputes,
        and(
          eq(
            payrollPayoutBatchDisputes.tenantId,
            payrollPayoutBatchUnfreezes.tenantId,
          ),
          eq(
            payrollPayoutBatchDisputes.id,
            payrollPayoutBatchUnfreezes.disputeId,
          ),
        ),
      )
      .where(
        and(
          eq(payrollPayoutBatchUnfreezes.tenantId, input.tenantId),
          eq(payrollPayoutBatchUnfreezes.id, payload.unfreezeId),
        ),
      );
    if (!row)
      throw new Error("Payout batch unfreeze not found for notification");
    ({ batchId, actor: disputant, logId, at } = row);
  }
  const [batch] = await input.tx
    .select({
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
    })
    .from(payrollDisbursementBatches)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.tenantId, payrollDisbursementBatches.tenantId),
        eq(payrollRuns.id, payrollDisbursementBatches.payrollRunId),
      ),
    )
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, input.tenantId),
        eq(payrollDisbursementBatches.id, batchId),
      ),
    );
  if (!batch) throw new Error("Payout batch not found for notification");
  const handlers = await activeAssignees(
    input.tx,
    input.tenantId,
    inArray(roles.templateKey, ["owner", "finance"] as never[]),
    { kind: "tenant" },
  );
  const [member] = await input.tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.tenantId, input.tenantId),
        eq(roleAssignments.userId, disputant),
        lte(roleAssignments.validFrom, sql`now()`),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, sql`now()`),
        ),
      ),
    )
    .limit(1);
  const key =
    kind === "disputed"
      ? ("payrollPayoutReceipt.frozen" as const)
      : ("payrollPayoutReceipt.unfrozen" as const);
  // Owner and finance go to the batch; the person who said "not me" goes to
  // their own step page (unless that person is also owner or finance).
  const links =
    member && !handlers.includes(disputant)
      ? new Map([[disputant, payoutReceiptLink(logId)]])
      : undefined;
  return {
    ...(links ? { links } : {}),
    userIds: [...new Set([...handlers, ...(member ? [disputant] : [])])].sort(),
    content: {
      category: "payout_receipt",
      title: payoutReceiptText(`${key}.title`),
      body: payoutReceiptText(`${key}.body`, {
        period: `${batch.periodStart} sampai ${batch.periodEnd}`,
        time: PAYOUT_RECEIPT_TIME.format(at),
      }),
      link: `/kelola/payroll/pencairan?tab=approval&batch=${encodeURIComponent(batchId)}`,
    },
  };
}

const OWNER_CHANGE_TIME = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  dateStyle: "long",
  timeStyle: "short",
});

const OWNER_CHANGE_REASON_MAX = 300;
const NOTIFICATION_BODY_MAX = 1000;

/** Name first; the email only when it is a real one (WhatsApp invites get a
 * `@wa.invalid` placeholder). */
function accountLabel(account: { name: string; email: string }): string {
  const name = account.name.trim();
  if (account.email.endsWith("@wa.invalid")) return name || "akun baru";
  return name ? `${name} (${account.email})` : account.email;
}

/** legend-fmpgz (Q46): a platform Super Admin appointed or replaced an Owner.
 * Recipients come from database rows only: every active tenant Owner plus the
 * replaced Owner (read from the replaced assignment row; it has ended by now).
 * Owners that ended earlier are not told. */
async function tenantOwnerChangedRule(input: RuleInput): Promise<Rule> {
  const payload = PLATFORM_EVENT_PAYLOADS["tenant_owner.changed"].parse(
    input.event.payload,
  );
  const wanted: string[] = [payload.newAssignmentId];
  if (payload.replacedAssignmentId !== null)
    wanted.push(payload.replacedAssignmentId);
  const rows = await input.tx
    .select({
      id: roleAssignments.id,
      userId: roleAssignments.userId,
      name: user.name,
      email: user.email,
    })
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
        eq(roleAssignments.tenantId, input.tenantId),
        inArray(roleAssignments.id, wanted),
        eq(roles.templateKey, "owner"),
        eq(roleAssignments.scopeType, "tenant"),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const created = byId.get(payload.newAssignmentId);
  if (!created) throw new Error("Owner assignment not found for notification");
  const replaced =
    payload.replacedAssignmentId === null
      ? null
      : (byId.get(payload.replacedAssignmentId) ?? null);
  if (payload.replacedAssignmentId !== null && !replaced)
    throw new Error("Replaced Owner assignment not found for notification");
  const [actor] = await input.tx
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, payload.actorUserId));
  // Staff identity stays a name only, like the support access notices.
  const actorLabel = actor?.name.trim() ? actor.name.trim() : "tim platform";
  const when = `${OWNER_CHANGE_TIME.format(new Date(payload.changedAt))} WIB`;
  const what = replaced
    ? `mengganti Owner ${accountLabel(replaced)} dengan ${accountLabel(created)}`
    : `menunjuk ${accountLabel(created)} sebagai Owner`;
  // Owners appointed after this change (or before a replay) are not told.
  const owners = await activeAssignees(
    input.tx,
    input.tenantId,
    required(
      and(
        eq(roles.templateKey, "owner"),
        lte(roleAssignments.validFrom, new Date(payload.changedAt)),
      ),
    ),
    { kind: "tenant" },
  );
  const body = `Super Admin platform ${actorLabel} ${what} pada ${when}. Alasan: ${payload.reason.slice(0, OWNER_CHANGE_REASON_MAX)}`;
  return {
    userIds: replaced ? [...owners, replaced.userId] : owners,
    content: {
      category: "security",
      title: replaced
        ? "Owner diganti oleh platform"
        : "Owner baru ditunjuk oleh platform",
      body:
        body.length > NOTIFICATION_BODY_MAX
          ? `${body.slice(0, NOTIFICATION_BODY_MAX - 1)}…`
          : body,
      link: null,
    },
  };
}

/** F26 "Notifikasi Jadwal": the employee who owns a published (or swapped)
 * shift hears about it. Ids only in the event; the name never leaves the DB. */
async function shiftPublishedRule(input: RuleInput): Promise<Rule> {
  const payload = shiftPublished.payloadSchema.parse(input.event.payload);
  const [row] = await input.tx
    .select({ userId: employees.userId })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, input.tenantId),
        eq(employees.id, payload.employeeId),
      ),
    );
  return {
    userIds: row?.userId ? [row.userId] : [],
    content: {
      category: "schedule_update",
      title: "Jadwal shift diperbarui",
      body: `Jadwal shift kamu untuk ${payload.businessDate} sudah tersedia atau berubah. Buka Jadwal untuk melihat jamnya.`,
      link: null,
    },
  };
}

/** F26: the employee who no longer works a shift hears it too, whether the
 * manager cancelled it or an approved swap/cover moved it to someone else. */
async function shiftCancelledRule(input: RuleInput): Promise<Rule> {
  const payload = shiftCancelled.payloadSchema.parse(input.event.payload);
  const [row] = await input.tx
    .select({ userId: employees.userId })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, input.tenantId),
        eq(employees.id, payload.employeeId),
      ),
    );
  const swapped = payload.cause === "swapped_away";
  return {
    userIds: row?.userId ? [row.userId] : [],
    content: {
      category: "schedule_update",
      title: swapped ? "Shift kamu dialihkan" : "Shift dibatalkan",
      body: swapped
        ? `Shift kamu untuk ${payload.businessDate} dialihkan lewat tukar atau gantikan shift. Kamu tidak perlu masuk di shift itu.`
        : `Shift kamu untuk ${payload.businessDate} dibatalkan. Kamu tidak perlu masuk di shift itu.`,
      link: null,
    },
  };
}

/** legend-jitc3: a collective leave day was deducted again for an employee
 * whose offboarding is already settled. The snapshot is frozen, so HR (active
 * settlement-permission holders covering the employee's home outlet, re-read here) bills the
 * extra day by hand. The employee name is read from the DB, never the event. */
async function leaveRedeductedAfterSettlementRule(
  input: RuleInput,
): Promise<Rule> {
  const payload = leaveRedeductedAfterSettlement.payloadSchema.parse(
    input.event.payload,
  );
  const [employee] = await input.tx
    .select({
      fullName: employees.fullName,
      homeOutletId: employees.homeOutletId,
    })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, input.tenantId),
        eq(employees.id, payload.employeeId),
      ),
    );
  // The audience is the employee's CURRENT HOME outlet, not the outlet of the
  // attendance log that triggered the re-deduction: HR of an old attendance
  // outlet must not see settlement details. Holders are those who may read the
  // settlement (`hr.employee.manage` or `payroll.view`). Employee not found:
  // the home outlet is unknown, so nobody is notified. Falling back to the event
  // outlet would leak settlement details to HR of an outlet that may not own
  // the employee.
  const hr = employee
    ? await activeAssignees(
        input.tx,
        input.tenantId,
        sql`${roles.permissions} ?| array['hr.employee.manage', 'payroll.view']`,
        await outletAudience(input.tx, input.tenantId, employee.homeOutletId),
      )
    : [];
  const who = employee?.fullName ?? "Karyawan";
  return {
    userIds: hr,
    content: {
      category: "hr_settlement",
      title: "Potongan cuti setelah penyelesaian akhir",
      body: `${who} sudah selesai offboarding, tetapi cuti bersama ${payload.date} dipotong lagi ${Number(payload.days)} hari karena absen masuk ditolak. Penyelesaian akhir tidak diubah. Tagih selisihnya secara manual.`,
      link: null,
    },
  };
}

/** legend-fy5y: invites the first admin of a new tenant. The recipient is the
 * payload's `firstAdminUserId` ONLY when an open tenant-wide tenant_admin
 * assignment still exists for it in this tenant (re-read, never trusted).
 * The body carries no link: the one-time link is minted at send time. */
async function tenantCreatedInvitationRule(input: RuleInput): Promise<Rule> {
  const payload = PLATFORM_EVENT_PAYLOADS["tenant.created"].parse(
    input.event.payload,
  );
  const [tenant] = await input.tx
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, input.tenantId));
  const holders = await input.tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .innerJoin(
      roles,
      and(
        eq(roles.tenantId, roleAssignments.tenantId),
        eq(roles.id, roleAssignments.roleId),
      ),
    )
    .where(
      and(
        eq(roleAssignments.tenantId, input.tenantId),
        eq(roleAssignments.userId, payload.firstAdminUserId),
        eq(roles.templateKey, "tenant_admin"),
        eq(roleAssignments.scopeType, "tenant"),
        isNull(roleAssignments.validUntil),
      ),
    )
    .limit(1);
  const name = tenant?.name.trim() || payload.slug;
  return {
    userIds: holders.length > 0 ? [payload.firstAdminUserId] : [],
    content: {
      category: "tenant_invitation",
      title: `Undangan admin ${name}`,
      body: `Kamu ditunjuk sebagai admin ${name}. Buka tautan di bawah untuk memverifikasi email kamu. Tautan berlaku ${INVITATION_LINK_TTL_MINUTES} menit dan hanya bisa dipakai sekali. Jika bukan kamu yang diundang, abaikan email ini.`,
      link: null,
    },
  };
}

// ---- Scheduled reports (WS-11 F12, legend-ay6e6) ----------------------------

const REPORT_FORMAT_LABELS: Record<string, string> = {
  csv: "CSV",
  xlsx: "Excel",
  pdf: "PDF",
};

/** A scheduled export is ready: its one recipient hears of it, in-app and by
 * email. The job is re-read here; a job no longer ready notifies nobody. The
 * message names the report and period only, never a figure: the file sits
 * behind the download, which re-checks the reader's permission. */
async function reportExportDeliveredRule(input: RuleInput): Promise<Rule> {
  const payload = z
    .strictObject({ exportId: z.uuid() })
    .parse(input.event.payload);
  if (input.event.aggregateId !== payload.exportId)
    throw new Error("Report delivery aggregate mismatch");
  const [job] = await input.tx
    .select({
      requestedBy: reportExports.requestedBy,
      status: reportExports.status,
      format: reportExports.format,
      query: reportExports.query,
      scheduleId: reportExports.scheduleId,
      name: savedReports.name,
    })
    .from(reportExports)
    .innerJoin(
      savedReports,
      and(
        eq(savedReports.tenantId, reportExports.tenantId),
        eq(savedReports.id, reportExports.savedReportId),
      ),
    )
    .where(
      and(
        eq(reportExports.tenantId, input.tenantId),
        eq(reportExports.id, payload.exportId),
      ),
    );
  const period = (
    job?.query as
      { period?: { startDate?: string; endDate?: string } } | undefined
  )?.period;
  const name = job?.name ?? "Laporan";
  return {
    userIds:
      job !== undefined && job.status === "ready" && job.scheduleId !== null
        ? [job.requestedBy]
        : [],
    content: {
      category: "report_delivery",
      title: `Laporan terjadwal siap: ${name}`.slice(0, 120),
      body:
        `File ${REPORT_FORMAT_LABELS[job?.format ?? ""] ?? "laporan"} "${name}"` +
        (period?.startDate && period.endDate
          ? ` periode ${period.startDate} s.d. ${period.endDate}`
          : "") +
        " sudah siap. Buka menu Laporan > Ekspor di aplikasi untuk mengunduhnya; file tersedia 7 hari.",
      link: null,
    },
  };
}

/** A schedule was paused because its owner is blocked or lost access: the
 * tenant admins hear of it once. Names the report only, never a figure. */
async function reportSchedulePausedRule(input: RuleInput): Promise<Rule> {
  const payload = z
    .strictObject({ scheduleId: z.uuid() })
    .parse(input.event.payload);
  if (input.event.aggregateId !== payload.scheduleId)
    throw new Error("Report schedule aggregate mismatch");
  const [schedule] = await input.tx
    .select({ name: savedReports.name })
    .from(reportSchedules)
    .innerJoin(
      savedReports,
      and(
        eq(savedReports.tenantId, reportSchedules.tenantId),
        eq(savedReports.id, reportSchedules.savedReportId),
      ),
    )
    .where(
      and(
        eq(reportSchedules.tenantId, input.tenantId),
        eq(reportSchedules.id, payload.scheduleId),
      ),
    );
  const admins = await activeAssignees(
    input.tx,
    input.tenantId,
    sql`${roles.permissions} @> ${JSON.stringify([SETTINGS_MANAGE_PERMISSION])}::jsonb`,
    { kind: "tenant" },
  );
  return {
    userIds: admins,
    content: {
      category: "report_delivery",
      title: `Jadwal laporan dijeda: ${schedule?.name ?? "Laporan"}`.slice(
        0,
        120,
      ),
      body: "Pemilik jadwal diblokir atau tidak lagi punya akses di bisnis ini, jadi pengiriman laporan dihentikan. Jadwal tetap dijeda. Buat jadwal baru dengan pemilik yang masih aktif bila laporan ini masih dibutuhkan.",
      link: null,
    },
  };
}

async function ruleFor(input: RuleInput): Promise<Rule> {
  switch (input.event.name) {
    case "tenant.created":
      return tenantCreatedInvitationRule(input);
    case "approval.requested":
      return approvalRequestedRule(input);
    case "approval.resolved":
      return approvalResolvedRule(input);
    case "support_access.granted":
      return supportAccessRule(input, false);
    case "support_access.ended":
      return supportAccessRule(input, true);
    case "support_access.requested":
      return supportAccessRequestedRule(input);
    case "checklist.missed":
    case "checklist.failed":
      return checklistRule(input, input.event.name);
    case "equipment_service.reminded":
      return equipmentServiceRemindedRule(input);
    case "shift.published":
      return shiftPublishedRule(input);
    case "shift.cancelled":
      return shiftCancelledRule(input);
    case "leave.rededucted_after_settlement":
      return leaveRedeductedAfterSettlementRule(input);
    case "facility_incident.raised":
      return facilityIncidentRaisedRule(input);
    case "panic_alert.raised":
      return panicAlertRaisedRule(input);
    case "ai_insight.anomaly_detected":
      return aiAnomalyRule(input);
    case "ai_insight.daily_summary_ready":
      return aiDailySummaryRule(input);
    case "payment.refund_escalated":
      return refundEscalatedRule(input);
    case "tenant_owner.changed":
      return tenantOwnerChangedRule(input);
    case "subscription.invoice_created":
      return subscriptionInvoiceCreatedRule(input);
    case "payout.step_attested":
      return payoutStepAttestedRule(input);
    case "payout.batch_disputed":
      return payoutBatchFreezeRule(input, "disputed");
    case "payout.batch_unfrozen":
      return payoutBatchFreezeRule(input, "unfrozen");
    case "report_export.delivered":
      return reportExportDeliveredRule(input);
    case "report_schedule.paused":
      return reportSchedulePausedRule(input);
    default:
      throw new Error(`No notification recipient rule for ${input.event.name}`);
  }
}

/** Dispatches by `event.name`. An unknown name throws so the outbox retries and
 * dead-letters it instead of silently dropping the notification. */
export function createNotificationRecipientResolver(
  channels: NotificationChannels,
): NotificationRecipientResolver {
  return async (context, event, tx) => {
    assertTrustedScopedContext(context);
    const tenantId = context.tenant.tenantId;
    if (event.tenantId !== tenantId)
      throw new Error("Event tenant does not match context");
    const rule = await ruleFor({ tx, event, tenantId });
    const userIds = [...new Set(rule.userIds)];
    if (userIds.length === 0) return [];
    const state = await loadRecipientState(
      tx,
      tenantId,
      userIds,
      channels,
      new Date(),
    );
    return userIds.flatMap((userId): NotificationRecipient[] => {
      const userState = state.users.get(userId);
      if (!userState) throw new Error("Recipient state missing");
      if (!userState.active) return [];
      return [
        {
          userId,
          ...rule.content,
          ...(rule.links?.has(userId) ? { link: rule.links.get(userId) } : {}),
          policy: state.policy,
          preference: userState.preference,
          reachability: reachabilityOf(userState, channels),
          whatsappSentThisMonth: state.whatsappSentThisMonth,
          defaultTimeZone: userState.preference?.timeZone ?? DEFAULT_TIME_ZONE,
        },
      ];
    });
  };
}

// ---- Delivery-time lookup ----------------------------------------------------

/** Enqueue-time eligibility cannot authorize a delayed emergency send. */
async function panicRecipientStillEligible(
  tx: Tx,
  notification: Notification,
  now: Date,
): Promise<boolean> {
  if (notification.category !== "emergency") return true;
  if (notification.sourceEventId === null) return false;
  const [source] = await tx
    .select({
      eventType: notificationOutbox.eventType,
      payload: notificationOutbox.payload,
    })
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.tenantId, notification.tenantId),
        eq(
          notificationOutbox.sourceEventId,
          ulidToUuid(notification.sourceEventId),
        ),
      ),
    );
  if (!source) return false;
  // Other emergency events keep their own established audience rule.
  if (source.eventType !== "panic_alert.raised") return true;
  const payload = panicAlertRaisedEvent.payloadSchema.parse(source.payload);
  if (notification.outletId !== payload.outletId) return false;
  const [alert] = await tx
    .select({
      outletId: panicAlerts.outletId,
      acknowledgedAt: panicAlerts.acknowledgedAt,
      resolvedAt: panicAlerts.resolvedAt,
      receivedAt: panicAlerts.receivedAt,
    })
    .from(panicAlerts)
    .where(
      and(
        eq(panicAlerts.tenantId, notification.tenantId),
        eq(panicAlerts.id, payload.alertId),
      ),
    );
  if (
    !alert ||
    alert.outletId !== notification.outletId ||
    alert.acknowledgedAt !== null ||
    alert.resolvedAt !== null ||
    now.getTime() - alert.receivedAt.getTime() > PANIC_PAGE_MAX_AGE_MS
  )
    return false;
  const holders = await activeAssignees(
    tx,
    notification.tenantId,
    required(
      and(
        sql`${roles.permissions} @> ${JSON.stringify([EMERGENCY_PERMISSION_RESPOND])}::jsonb`,
        eq(roleAssignments.userId, notification.userId),
      ),
    ),
    await audienceOf(tx, notification),
  );
  if (!holders.includes(notification.userId)) return false;
  const employee = await employeeOfStaff(tx, {
    tenantId: notification.tenantId,
    userId: notification.userId,
  });
  return (
    employee?.active === true &&
    (await dutyWindowEnd(tx, {
      tenantId: notification.tenantId,
      outletId: alert.outletId,
      employeeId: employee.id,
      now,
    })) !== null
  );
}

/** Re-read saved subscription and account state immediately before sending. */
export function createDeliveryRecipientLookup(
  database: Database,
  channels: NotificationChannels,
): DeliveryDependencies["resolve"] {
  return async (context, notification) => {
    assertTrustedScopedContext(context);
    if (notification.tenantId !== context.tenant.tenantId)
      throw new Error("Notification tenant does not match context");
    if (notification.outletId)
      assertOutletInScope(context.outletScope, notification.outletId);
    return withTenant(database, context, async (tx) => {
      const state = await loadRecipientState(
        tx,
        notification.tenantId,
        [notification.userId],
        channels,
        new Date(),
      );
      const userState = state.users.get(notification.userId);
      if (!userState) throw new Error("Recipient state missing");
      const eligible =
        userState.active &&
        (await panicRecipientStillEligible(tx, notification, new Date()));
      let pushEndpoint: string | null = null;
      if (channels.push && eligible && userState.hasPushSubscription) {
        // An emergency alarm only reaches browsers of its own outlet; only
        // recent verified registrations of unrevoked sessions on active
        // devices count (deliverablePushSubscription); the newest first.
        const subscriptions = await tx
          .select()
          .from(pushSubscriptions)
          .where(
            and(
              eq(pushSubscriptions.tenantId, notification.tenantId),
              eq(pushSubscriptions.userId, notification.userId),
              deliverablePushSubscription(new Date()),
              pushOutletMatches(
                notification.category === "emergency"
                  ? notification.outletId
                  : null,
              ),
            ),
          )
          .orderBy(desc(pushSubscriptions.registeredAt));
        // The attempt names one endpoint (the newest readable one); the push
        // provider then sends to every deliverable browser of the recipient.
        // A subscription that cannot be opened is skipped, never fatal.
        for (const subscription of subscriptions) {
          try {
            pushEndpoint = openPushSubscription(
              subscription.subscriptionCiphertext,
              notification.tenantId,
              notification.userId,
              subscription.endpointHash,
            ).endpoint;
            break;
          } catch {
            logger.warn(
              { subscriptionId: subscription.id },
              "Push subscription could not be opened; skipped",
            );
          }
        }
      }
      const currentReachability = reachabilityOf(userState, channels);
      const reachability = {
        ...currentReachability,
        hasVerifiedEmail: eligible && currentReachability.hasVerifiedEmail,
        hasUnverifiedEmail: eligible && currentReachability.hasUnverifiedEmail,
        whatsappOptIn: eligible && currentReachability.whatsappOptIn,
        hasPushSubscription: pushEndpoint !== null,
      };
      return {
        policy: state.policy,
        preference: userState.preference,
        reachability,
        defaultTimeZone: userState.preference?.timeZone ?? DEFAULT_TIME_ZONE,
        email:
          reachability.hasVerifiedEmail ||
          (allowsUnverifiedEmail(notification.category) &&
            reachability.hasUnverifiedEmail)
            ? userState.email
            : null,
        pushEndpoint,
        whatsappNumber: null,
      };
    });
  };
}

// ---- Providers ---------------------------------------------------------------

type OperationResult = Awaited<ReturnType<EmailProvider["send"]>>;

/** A channel with no provider: reaching it is a bug (reachability is false). */
function disabledProvider(channel: string) {
  return {
    async send(): Promise<never> {
      throw new Error(`${channel} provider is disabled`);
    },
  };
}

export type BrevoEmailConfig = {
  apiKey: string;
  from: string;
  fromName?: string;
  fetch?: FetchLike;
  /** Called on a 401/403 (bad key or sender) before the throw; a failure here
   * is swallowed. The caller throttles (legend-j75w). */
  onAuthFailure?: (
    context: ScopedTenantContext,
    failure: { outletId: string | null; status: number },
  ) => Promise<void>;
};

/** Brevo deduplicates on `headers.idempotencyKey` (a UUID) for 30 minutes.
 * The key is derived from the delivery attempt's stable reference, so a retry
 * of the same attempt (lost response, crash recovery) reuses it. */
export function brevoIdempotencyKey(reference: string): string {
  const bytes = createHash("sha256")
    .update(`legend-notification:${reference}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4 layout
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Reads only Brevo's error `code`; the body is never logged or returned. */
async function brevoErrorCode(response: Response): Promise<string | null> {
  return response
    .json()
    .then((body: unknown) =>
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      typeof body.code === "string"
        ? body.code
        : null,
    )
    .catch(() => null);
}

/** 2xx accepted, as is a `duplicate_parameter` reuse of the idempotency key;
 * other 400 and 422 are declined for good; everything else (401, 403, 404,
 * 408, 429, 5xx, network) throws because the message may or may not have been
 * sent (retried). */
export function createBrevoEmailProvider(
  config: BrevoEmailConfig,
): EmailProvider {
  const {
    apiKey,
    from,
    fromName,
    fetch: fetchImpl = globalThis.fetch,
    onAuthFailure,
  } = config;
  return {
    async send(context, input): Promise<OperationResult> {
      assertTrustedScopedContext(context);
      const request = emailRequestSchema.parse(input);
      if (request.tenantId !== context.tenant.tenantId)
        throw new TypeError("Tenant mismatch");
      if (request.outletId === null) {
        if (context.outletScope.kind !== "tenant")
          throw new Error("Tenant-wide email requires tenant scope");
      } else assertOutletInScope(context.outletScope, request.outletId);
      const response = await fetchImpl(BREVO_ENDPOINT, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          sender: fromName ? { email: from, name: fromName } : { email: from },
          to: [{ email: request.to }],
          subject: request.subject,
          textContent: request.body,
          headers: {
            idempotencyKey: brevoIdempotencyKey(request.reference),
            "X-Legend-Reference": request.reference,
          },
          tags: ["legend-notification"],
        }),
        signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
      });
      if (response.status >= 200 && response.status < 300) {
        const messageId = await response
          .json()
          .then((body: unknown) =>
            typeof body === "object" &&
            body !== null &&
            "messageId" in body &&
            typeof body.messageId === "string" &&
            body.messageId.length > 0 &&
            body.messageId.length <= 255
              ? body.messageId
              : null,
          )
          .catch(() => null);
        return operationResultSchema.parse({
          reference: messageId ?? request.reference,
          accepted: true,
        });
      }
      // The same attempt was already accepted within Brevo's 30-minute
      // window (its response was lost): that is the acknowledgement. Brevo
      // does not document the status of a reused key, so any 4xx is checked.
      if (
        response.status >= 400 &&
        response.status < 500 &&
        (await brevoErrorCode(response)) === "duplicate_parameter"
      )
        return operationResultSchema.parse({
          reference: request.reference,
          accepted: true,
        });
      if (response.status === 400 || response.status === 422) {
        // Only a malformed or unprocessable message is declined for good.
        return operationResultSchema.parse({
          reference: request.reference,
          accepted: false,
        });
      }
      if (response.status === 401 || response.status === 403)
        await onAuthFailure?.(context, {
          outletId: request.outletId,
          status: response.status,
        }).catch(() => undefined);
      // Anything else (401/403 bad key or sender, 404, 408, 429, 5xx) is an
      // operator or transient problem: throw so it is retried and visible.
      throw new Error(
        `Brevo email request failed with status ${response.status}`,
      );
    },
  };
}

export type NotificationProviderConfig = {
  email:
    | { provider: "disabled" }
    | { provider: "brevo"; apiKey: string; from: string; fromName?: string };
  push:
    | { provider: "disabled" }
    | {
        provider: "web_push";
        subject: string;
        publicKey: string;
        privateKey: string;
      };
  whatsapp:
    | { provider: "disabled" }
    | { provider: "kirimdev"; apiKey: string; baseUrl?: string };
};

type Env = Record<string, string | undefined>;
const present = (env: Env, key: string) => {
  const value = env[key]?.trim();
  return value ? value : undefined;
};

/** Every provider key is required (no default). Errors name keys, never values. */
export function parseNotificationProviderEnv(
  env: Env,
): NotificationProviderConfig {
  const problems: string[] = [];
  const choice = (key: string, allowed: readonly string[]) => {
    const value = present(env, key);
    if (value === undefined) {
      problems.push(`${key} is required (${allowed.join("|")})`);
      return undefined;
    }
    if (!allowed.includes(value)) {
      problems.push(`${key} must be one of ${allowed.join("|")}`);
      return undefined;
    }
    return value;
  };
  const emailProvider = choice("NOTIFICATION_EMAIL_PROVIDER", [
    "disabled",
    "brevo",
  ]);
  const pushProvider = choice("NOTIFICATION_PUSH_PROVIDER", [
    "disabled",
    "web_push",
  ]);
  const whatsappProvider = choice("NOTIFICATION_WHATSAPP_PROVIDER", [
    "disabled",
    "kirimdev",
  ]);
  let whatsapp: NotificationProviderConfig["whatsapp"] = {
    provider: "disabled",
  };
  if (whatsappProvider === "kirimdev") {
    const apiKey = present(env, "KIRIM_API_KEY");
    const baseUrl = present(env, "KIRIM_API_BASE_URL");
    if (apiKey === undefined)
      problems.push(
        "KIRIM_API_KEY is required when the WhatsApp provider is kirimdev",
      );
    else if (!/^kdv_live_[A-Za-z0-9_-]{24}$/.test(apiKey))
      problems.push("KIRIM_API_KEY is not a valid KirimDev API key");
    else if (baseUrl !== undefined && !isPublicHttpsUrl(baseUrl))
      problems.push("KIRIM_API_BASE_URL must be a public https URL");
    else
      whatsapp = {
        provider: "kirimdev",
        apiKey,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      };
  }
  let email: NotificationProviderConfig["email"] = { provider: "disabled" };
  let push: NotificationProviderConfig["push"] = { provider: "disabled" };
  if (pushProvider === "web_push") {
    const publicKey = present(env, "VAPID_PUBLIC_KEY");
    const privateKey = present(env, "VAPID_PRIVATE_KEY");
    const subject = present(env, "VAPID_SUBJECT");
    for (const key of [
      "VAPID_PUBLIC_KEY",
      "VAPID_PRIVATE_KEY",
      "VAPID_SUBJECT",
    ])
      if (present(env, key) === undefined)
        problems.push(`${key} is required when the push provider is web_push`);
    if (
      subject !== undefined &&
      !(
        (subject.startsWith("mailto:") &&
          z.email().safeParse(subject.slice(7)).success) ||
        (z.url().safeParse(subject).success && subject.startsWith("https://"))
      )
    )
      problems.push("VAPID_SUBJECT must be a mailto address or HTTPS URL");
    if (publicKey !== undefined && privateKey !== undefined) {
      try {
        if (
          !/^[A-Za-z0-9_-]{87}$/.test(publicKey) ||
          !/^[A-Za-z0-9_-]{43}$/.test(privateKey)
        )
          throw new Error("Invalid key encoding");
        const key = createECDH("prime256v1");
        key.setPrivateKey(Buffer.from(privateKey, "base64url"));
        if (!key.getPublicKey().equals(Buffer.from(publicKey, "base64url")))
          throw new Error("Key pair mismatch");
      } catch {
        problems.push(
          "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be a matching P-256 key pair",
        );
      }
    }
    if (
      publicKey !== undefined &&
      privateKey !== undefined &&
      subject !== undefined
    )
      push = { provider: "web_push", publicKey, privateKey, subject };
  }
  if (emailProvider === "brevo") {
    const apiKey = present(env, "BREVO_API_KEY");
    const from = present(env, "NOTIFICATION_EMAIL_FROM");
    const fromName = present(env, "NOTIFICATION_EMAIL_FROM_NAME");
    if (apiKey === undefined)
      problems.push(
        "BREVO_API_KEY is required when the email provider is brevo",
      );
    else if (!/^[\x21-\x7e]+$/.test(apiKey) || /replace_me/i.test(apiKey))
      problems.push("BREVO_API_KEY is not a valid API key");
    if (from === undefined)
      problems.push(
        "NOTIFICATION_EMAIL_FROM is required when the email provider is brevo",
      );
    else if (!z.email().safeParse(from).success)
      problems.push("NOTIFICATION_EMAIL_FROM must be an email address");
    else if (/\.invalid$/i.test(from) || /replace_me/i.test(from))
      problems.push("NOTIFICATION_EMAIL_FROM must be a real sender address");
    if (problems.length === 0 && apiKey !== undefined && from !== undefined)
      email = {
        provider: "brevo",
        apiKey,
        from,
        ...(fromName === undefined ? {} : { fromName }),
      };
  }
  if (problems.length > 0)
    throw new Error(
      `Invalid notification provider configuration: ${problems.join("; ")}`,
    );
  return {
    email,
    push,
    whatsapp,
  };
}

/** The two hooks worker-main reads, built from the deployment environment. */
export function createWorkerNotificationHandlers(
  database: Database,
  env: Env,
  options: { fetch?: FetchLike; webPushSend?: WebPushSend } = {},
): {
  resolveNotificationRecipients: NotificationRecipientResolver;
  notificationDelivery: DeliveryDependencies;
} {
  const config = parseNotificationProviderEnv(env);
  const channels: NotificationChannels = {
    email: config.email.provider !== "disabled",
    push: config.push.provider !== "disabled",
  };
  const email =
    config.email.provider === "brevo"
      ? createBrevoEmailProvider({
          apiKey: config.email.apiKey,
          from: config.email.from,
          fromName: config.email.fromName,
          fetch: options.fetch,
          onAuthFailure: (context, failure) =>
            withTenant(database, context, (tx) =>
              notifyBrevoAuthFailed(tx, context, {
                tenantId: context.tenant.tenantId,
                outletId: failure.outletId as OutletId | null,
                status: failure.status,
              }),
            ),
        })
      : (disabledProvider("email") satisfies EmailProvider);
  const resolveRecipients = createNotificationRecipientResolver(channels);
  return {
    resolveNotificationRecipients: async (context, event, tx) => {
      // Without push configuration the in-app notification is still created
      // and the event completes; only the push channel is skipped. Operators
      // see this error in the log (no keys or subscription data in it).
      if (event.name === "panic_alert.raised" && !channels.push)
        logger.error(
          { event: event.name },
          "Panic web push skipped: set NOTIFICATION_PUSH_PROVIDER=web_push with VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT",
        );
      return resolveRecipients(context, event, tx);
    },
    notificationDelivery: {
      resolve: createDeliveryRecipientLookup(database, channels),
      email,
      push:
        config.push.provider === "web_push"
          ? createWebPushProvider(database, config.push, options.webPushSend)
          : (disabledProvider("push") satisfies PushProvider),
      // legend-fy5y: the link origin is always WEB_URL, never a request origin.
      // A missing WEB_URL returns null: delivery fails closed, no link is sent.
      invitationLink: async (context, notification) => {
        const webUrl = present(env, "WEB_URL");
        if (webUrl === undefined) return null;
        return issueInvitationLink(context, {
          userId: notification.userId,
          origin: new URL(webUrl).origin,
        });
      },
      // legend-lb3c: the kelola link of a reservation email is minted at send
      // time (never stored in the notification); null skips the send.
      reservationLink: (context, notification) =>
        prepareReservationEmail(context, notification),
      // Left undefined while WhatsApp is disabled: worker-main only polls
      // WhatsApp attempts when this provider is present. With kirimdev the
      // hook exists, but a send still needs a recipient with an opted-in
      // number and an approved template, plus a platform-mapped sender.
      ...(config.whatsapp.provider === "kirimdev"
        ? {
            whatsapp: (() => {
              const kirimdev = createKirimdevMessagingProvider({
                apiKey: config.whatsapp.apiKey,
                ...(config.whatsapp.baseUrl
                  ? { baseUrl: config.whatsapp.baseUrl }
                  : {}),
                fetch: options.fetch,
                resolveSender: kirimdevSenderFromPlatformMapping(database),
              });
              return {
                send: (context, request) =>
                  kirimdev.sendTemplate(context, request),
              } satisfies WhatsAppTemplateProvider;
            })(),
          }
        : {}),
    },
  };
}
