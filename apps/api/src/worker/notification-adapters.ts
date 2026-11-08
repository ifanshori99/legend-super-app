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
  idr,
  toIsoDateTime,
  z,
  type TenantId,
} from "@starter/shared/core";
import {
  emailRequestSchema,
  operationResultSchema,
  type EmailProvider,
  type PushProvider,
} from "@starter/shared/adapters";
import type { EventEnvelope } from "@starter/shared/events";
import {
  approvalRequestedEvent,
  approvalResolvedEvent,
} from "@starter/shared/identity";
import {
  notificationPolicySchema,
  notificationPreferenceSchema,
  type NotificationCategory,
  type NotificationPolicy,
  type NotificationPreference,
  type Reachability,
} from "@starter/shared/notification";
import { operationsEventPayloadSchemas } from "@starter/shared/operations";
import type * as schema from "../db/schema/index.ts";
import {
  notificationPolicies,
  notificationPreferences,
  pushSubscriptions,
  whatsappReservations,
} from "../db/schema/notification.ts";
import { roleAssignments, roles } from "../db/schema/platform-access.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { user } from "../db/schema/user.ts";
import { withTenant } from "../db/tenant.ts";
import type { NotificationRecipientResolver } from "../services/notification-consumer.ts";
import type { NotificationRecipient } from "../services/notification-core.ts";
import type { deliverNotificationAttempt } from "../services/notification-delivery.ts";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<NotificationRecipientResolver>[2];
type DeliveryDependencies = Parameters<typeof deliverNotificationAttempt>[3];
type FetchLike = typeof globalThis.fetch;

const DEFAULT_TIME_ZONE = "Asia/Jakarta";
const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const BREVO_TIMEOUT_MS = 10_000;
const SETTINGS_MANAGE_PERMISSION = "org.settings.manage";
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
  return notificationPolicySchema.parse(
    row
      ? {
          tenantId,
          webPushEnabled: row.webPushEnabled,
          emailEnabled: row.emailEnabled,
          whatsapp: row.whatsapp,
          maxAttempts: row.maxAttempts,
          retryBackoffSeconds: row.retryBackoffSeconds,
          updatedAt: toIsoDateTime(row.updatedAt),
        }
      : {
          tenantId,
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
      active: account !== undefined && account.banned !== true,
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

/** Distinct users with an active assignment of a matching role whose scope
 * covers the audience. A tenant-wide event reaches tenant-scope holders only. */
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
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        roleCondition,
        scope,
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
  return {
    userIds: [row.requestedBy],
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

async function ruleFor(input: RuleInput): Promise<Rule> {
  switch (input.event.name) {
    case "approval.requested":
      return approvalRequestedRule(input);
    case "approval.resolved":
      return approvalResolvedRule(input);
    case "support_access.granted":
      return supportAccessRule(input, false);
    case "support_access.ended":
      return supportAccessRule(input, true);
    case "checklist.missed":
    case "checklist.failed":
      return checklistRule(input, input.event.name);
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
        email: reachability.hasVerifiedEmail ? userState.email : null,
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
};

/** 2xx accepted; 4xx (not 429) declined for good; 429, 5xx and network errors
 * throw because the message may or may not have been sent (retried). */
export function createBrevoEmailProvider(
  config: BrevoEmailConfig,
): EmailProvider {
  const {
    apiKey,
    from,
    fromName,
    fetch: fetchImpl = globalThis.fetch,
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
          headers: { "X-Legend-Reference": request.reference },
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
      // 401/403 (bad or revoked key, unverified sender) and 408 are
      // operator or transient problems, not a bad message: throw so the
      // attempt is retried and the failure is visible instead of a silent drop.
      if (
        response.status >= 400 &&
        response.status < 500 &&
        ![401, 403, 408, 429].includes(response.status)
      )
        return operationResultSchema.parse({
          reference: request.reference,
          accepted: false,
        });
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
    if (from === undefined)
      problems.push(
        "NOTIFICATION_EMAIL_FROM is required when the email provider is brevo",
      );
    else if (!z.email().safeParse(from).success)
      problems.push("NOTIFICATION_EMAIL_FROM must be an email address");
    if (apiKey !== undefined && from !== undefined)
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
        })
      : (disabledProvider("email") satisfies EmailProvider);
  return {
    resolveNotificationRecipients:
      createNotificationRecipientResolver(channels),
    notificationDelivery: {
      resolve: createDeliveryRecipientLookup(database, channels),
      email,
      push: disabledProvider("push") satisfies PushProvider,
      // Left undefined while WhatsApp is disabled: worker-main only polls
      // WhatsApp attempts when this provider is present.
    },
  };
}
