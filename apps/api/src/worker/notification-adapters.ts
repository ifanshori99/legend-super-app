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
import { createHash } from "node:crypto";
import {
  and,
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
import { facilityIncidentRaisedEvent } from "@starter/shared/facility";
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
} from "@starter/shared/notification";
import { shiftCancelled, shiftPublished } from "@starter/shared/hris";
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
  notificationPreferences,
  pushSubscriptions,
  whatsappReservations,
} from "../db/schema/notification.ts";
import { customerProfiles } from "../db/schema/crm-member.ts";
import { facilityIncidents } from "../db/schema/facility.ts";
import { employees } from "../db/schema/hris.ts";
import { roleAssignments, roles } from "../db/schema/platform-access.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
import { user } from "../db/schema/user.ts";
import { withTenant } from "../db/tenant.ts";
import { isReservedAddress } from "../services/identity-email-login.service.ts";
import { notifyBrevoAuthFailed } from "../services/edge-sync-conflict-alert.ts";
import { issueInvitationLink } from "../services/identity-invitation.service.ts";
import type { NotificationRecipientResolver } from "../services/notification-consumer.ts";
import type { NotificationRecipient } from "../services/notification-core.ts";
import { prepareReservationEmail } from "../services/reservation-guest-notify.ts";
import type { deliverNotificationAttempt } from "../services/notification-delivery.ts";

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

async function audienceOf(tx: Tx, event: EventEnvelope): Promise<Audience> {
  if (!event.outletId) return { kind: "tenant" };
  const [outlet] = await tx
    .select({ brandId: outlets.brandId })
    .from(outlets)
    .where(
      and(eq(outlets.tenantId, event.tenantId), eq(outlets.id, event.outletId)),
    );
  if (!outlet) throw new Error("Notification outlet not found");
  return { kind: "outlet", outletId: event.outletId, brandId: outlet.brandId };
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
      category: "schedule_update",
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
      title: "Refund menunggu terlalu lama",
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
    case "facility_incident.raised":
      return facilityIncidentRaisedRule(input);
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

/** Re-reads policy, preference and reachability right before a send, so a
 * change since the plan was made is honoured. Push decryption belongs to bead
 * legend-hyq: the endpoint stays null and push reachability false until then. */
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
      const reachability = {
        ...reachabilityOf(userState, channels),
        hasPushSubscription: false,
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
        pushEndpoint: null,
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
  push: { provider: "disabled" };
  whatsapp: { provider: "disabled" };
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
  choice("NOTIFICATION_PUSH_PROVIDER", ["disabled"]);
  choice("NOTIFICATION_WHATSAPP_PROVIDER", ["disabled"]);
  let email: NotificationProviderConfig["email"] = { provider: "disabled" };
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
    push: { provider: "disabled" },
    whatsapp: { provider: "disabled" },
  };
}

/** The two hooks worker-main reads, built from the deployment environment. */
export function createWorkerNotificationHandlers(
  database: Database,
  env: Env,
  options: { fetch?: FetchLike } = {},
): {
  resolveNotificationRecipients: NotificationRecipientResolver;
  notificationDelivery: DeliveryDependencies;
} {
  const config = parseNotificationProviderEnv(env);
  const channels: NotificationChannels = {
    email: config.email.provider !== "disabled",
    push: false,
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
  return {
    resolveNotificationRecipients:
      createNotificationRecipientResolver(channels),
    notificationDelivery: {
      resolve: createDeliveryRecipientLookup(database, channels),
      email,
      push: disabledProvider("push") satisfies PushProvider,
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
      // WhatsApp attempts when this provider is present.
    },
  };
}
