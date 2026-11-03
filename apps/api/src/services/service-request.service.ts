import { maskAuditChanges } from "@starter/shared/audit";
// Waiter call / bill request / complaint (PRD v1.7 §3 F10 "Panggil Waiter &
// Minta Tagihan", §6 C service_requests; ORD-07: the call shows on the phone of
// the zone's waiter within 3 seconds).
//
// Realtime path (ORD-07): the request row, its `service_request.created`
// outbox event and the in-app notification rows for the zone's waiters are
// written in ONE tenant transaction, and the notification consumer issues
// `pg_notify` inside it. PostgreSQL delivers the NOTIFY at commit, the
// realtime WebSocket (notification-realtime.ts) fans it out to each
// recipient's own connection only. No worker, relay or polling sits between
// the guest's tap and the waiter's socket.
//
// Recipients are exactly the users in `zone_waiter_assignments` for the
// table's zone (never other zones, never other tenants). A zone with no
// assigned waiter creates the request without a push; the inbox still lists it
// and the overdue sweep escalates it (decision: the PRD is silent).

import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  decodeCursor,
  encodeCursor,
  idr,
  idempotencyKeySchema,
  toIsoDateTime,
  z,
  type ScopedTenantContext,
  type TenantId,
  type OutletId,
} from "@starter/shared/core";
import {
  eventEnvelopeSchema,
  payloadSchemaRefOf,
  type EventEnvelope,
} from "@starter/shared/events";
import { notificationPolicySchema } from "@starter/shared/notification";
import {
  createServiceRequestInputSchema,
  resolveServiceRequestInputSchema,
  serviceRequestListQuerySchema,
  qrOrderEvents,
  serviceRequestSchema,
  transitionServiceRequest,
  type ServiceRequest,
  type ServiceRequestAction,
} from "@starter/shared/qr-order";
import { db } from "../db";
import { tableSessions } from "../db/schema/floor";
import {
  notificationPolicies,
  pushSubscriptions,
} from "../db/schema/notification";
import {
  serviceRequests,
  zoneWaiterAssignments,
} from "../db/schema/service-request";
import { withTenant } from "../db/tenant";
import { recordAudit } from "./core-audit";
import { appendOutbox } from "./core-outbox";
import { createNotificationConsumer } from "./notification-consumer";
import type { NotificationRecipient } from "./notification-core";
import { serviceRequestLimiter } from "./service-request-limiter";
import { authenticateGuestSession } from "./table-session.service";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Row = typeof serviceRequests.$inferSelect;
type CreateInput = z.infer<typeof createServiceRequestInputSchema>;
type ResolveInput = z.infer<typeof resolveServiceRequestInputSchema>;
type ListQuery = z.infer<typeof serviceRequestListQuerySchema>;

/**
 * Open (pending or acknowledged) requests older than this raise one overdue
 * escalation. PRD §3 F10 / ORD-07 only fix the 3 s delivery target; the
 * escalation age is a documented default (decision, PRD silent): 3 minutes.
 */
export const SERVICE_REQUEST_OVERDUE_SECONDS = 180;

const EVENT_DESTINATION = "cloud-sync";
const OVERDUE_EVENT = "service_request.overdue";
/** Rows an overdue sweep processes per tenant per run. */
const SWEEP_BATCH = 200;
const AUDIT_SAFE_FIELDS = [
  "id",
  "status",
  "type",
  "tableId",
  "zoneId",
  "assignedTo",
] as const;

const iso = (value: Date | null): string | null =>
  value ? toIsoDateTime(value) : null;

function toRequest(row: Row): ServiceRequest {
  return serviceRequestSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    tableSessionId: row.tableSessionId,
    tableId: row.tableId,
    zoneId: row.zoneId,
    type: row.type,
    reason: row.reason,
    message: row.message,
    status: row.status,
    assignedTo: row.assignedTo,
    createdAt: toIsoDateTime(row.createdAt),
    acknowledgedAt: iso(row.acknowledgedAt),
    resolvedAt: iso(row.resolvedAt),
  });
}

function fingerprintOf(sessionId: string, input: CreateInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: "service_request.create",
        sessionId,
        type: input.type,
        reason: input.reason ?? null,
        message: input.message?.trim() ?? null,
      }),
    )
    .digest("hex");
}

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateId: string,
): Promise<number> {
  const result = await tx.execute(
    sql`SELECT coalesce(max(sequence), 0) AS last FROM domain_event_outbox
        WHERE tenant_id = ${tenantId}::uuid AND destination = ${EVENT_DESTINATION}
          AND aggregate_type = 'service_request' AND aggregate_id = ${aggregateId}::uuid`,
  );
  return Number(result.rows[0]?.last ?? 0) + 1;
}

/** Zone waiters (user ids) of one zone; the only push audience. */
async function zoneWaiterIds(
  tx: Tx,
  tenantId: TenantId,
  zoneId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ userId: zoneWaiterAssignments.userId })
    .from(zoneWaiterAssignments)
    .where(
      and(
        eq(zoneWaiterAssignments.tenantId, tenantId),
        eq(zoneWaiterAssignments.zoneId, zoneId),
      ),
    );
  return [...new Set(rows.map((row) => row.userId))];
}

async function buildRecipients(
  tx: Tx,
  tenantId: string,
  userIds: string[],
  content: { title: string; body: string },
  now: Date,
): Promise<NotificationRecipient[]> {
  if (userIds.length === 0) return [];
  const [policyRow] = await tx
    .select()
    .from(notificationPolicies)
    .where(eq(notificationPolicies.tenantId, tenantId));
  const policy = notificationPolicySchema.parse(
    policyRow
      ? {
          tenantId,
          webPushEnabled: policyRow.webPushEnabled,
          emailEnabled: policyRow.emailEnabled,
          whatsapp: policyRow.whatsapp,
          maxAttempts: policyRow.maxAttempts,
          retryBackoffSeconds: policyRow.retryBackoffSeconds,
          updatedAt: toIsoDateTime(policyRow.updatedAt),
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
  const subscribed = new Set(
    (
      await tx
        .select({ userId: pushSubscriptions.userId })
        .from(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.tenantId, tenantId),
            inArray(pushSubscriptions.userId, userIds),
          ),
        )
    ).map((row) => row.userId),
  );
  return userIds.map((userId) => ({
    userId,
    category: "waiter_call" as const,
    title: content.title,
    body: content.body,
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
}

/** Append the envelope to the outbox and fan it out to `userIds`, same tx. */
async function emitAndNotify(
  tx: Tx,
  context: ScopedTenantContext,
  event: EventEnvelope,
  userIds: string[],
  content: { title: string; body: string },
  now: Date,
): Promise<void> {
  await appendOutbox(tx, context, {
    id: createUlid(now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
  const recipients = await buildRecipients(
    tx,
    context.tenant.tenantId,
    userIds,
    content,
    now,
  );
  if (recipients.length === 0) return;
  // Inserts notifications and runs pg_notify inside this transaction; the
  // NOTIFY is delivered to the realtime listener at commit (ORD-07).
  await createNotificationConsumer(context, async () => recipients)(
    event,
    event.idempotencyKey,
    tx,
  );
}

const TYPE_LABEL = {
  call_waiter: "Panggilan waiter",
  request_bill: "Permintaan tagihan",
  complaint: "Keluhan",
} as const;

/** Guest: call the waiter, request the bill or file a complaint (ORD-07). */
export async function createServiceRequest(
  context: ScopedTenantContext,
  sessionId: string,
  rawToken: string,
  input: CreateInput,
  now = new Date(),
  limiter: Pick<typeof serviceRequestLimiter, "check"> = serviceRequestLimiter,
): Promise<{ request: ServiceRequest; created: boolean }> {
  const { session, table } = await authenticateGuestSession(
    context,
    rawToken,
    now,
  );
  // The credential must belong to the session in the path (no oracle).
  if (session.id !== sessionId)
    throw new CoreError(
      "UNAUTHORIZED",
      "Sesi meja tidak dikenali; pindai QR meja lagi.",
    );
  limiter.check(session.id, now.getTime());
  const key = idempotencyKeySchema.parse(input.idempotencyKey);
  const fingerprint = fingerprintOf(session.id, input);

  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    // Serialise concurrent calls for the same table and kind (dedupe race).
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`service-request:${tenantId}:${table.id}:${input.type}`}, 0))`,
    );
    const [live] = await tx
      .select({ status: tableSessions.status })
      .from(tableSessions)
      .where(
        and(
          eq(tableSessions.tenantId, tenantId),
          eq(tableSessions.id, session.id),
        ),
      );
    if (!live || live.status === "closed" || live.status === "voided")
      throw new CoreError(
        "UNAUTHORIZED",
        "ORD-04: sesi meja sudah ditutup; pindai QR meja lagi.",
      );

    const [replay] = await tx
      .select()
      .from(serviceRequests)
      .where(
        and(
          eq(serviceRequests.tenantId, tenantId),
          eq(serviceRequests.tableSessionId, session.id),
          eq(serviceRequests.idempotencyKey, key),
        ),
      );
    if (replay) {
      if (replay.requestFingerprint !== fingerprint)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key already used for a different request.",
        );
      return { request: toRequest(replay), created: false };
    }

    // Dedupe: one open request per table and kind; return it instead.
    const [open] = await tx
      .select()
      .from(serviceRequests)
      .where(
        and(
          eq(serviceRequests.tenantId, tenantId),
          eq(serviceRequests.tableId, table.id),
          eq(serviceRequests.type, input.type),
          inArray(serviceRequests.status, ["pending", "acknowledged"]),
        ),
      );
    if (open) return { request: toRequest(open), created: false };

    const id = randomUUID();
    const [row] = await tx
      .insert(serviceRequests)
      .values({
        id,
        tenantId,
        outletId: session.outletId,
        tableSessionId: session.id,
        tableId: table.id,
        zoneId: table.zoneId,
        type: input.type,
        reason: input.reason ?? null,
        message: input.message?.trim() || null,
        status: "pending",
        idempotencyKey: key,
        requestFingerprint: fingerprint,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new CoreError("CONFLICT", "Permintaan gagal disimpan.");

    const definition = qrOrderEvents["service_request.created"];
    const sequence = await nextSequence(tx, tenantId, id);
    const event = definition.envelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId,
      outletId: session.outletId,
      name: "service_request.created",
      version: definition.version,
      aggregateType: definition.entry.aggregateType,
      aggregateId: id,
      sequence,
      occurredAt: toIsoDateTime(now),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `service_request.created:${id}:${sequence}`,
      payloadSchemaRef: definition.payloadSchemaRef,
      payload: {
        serviceRequestId: id,
        sessionId: session.id,
        tableId: table.id,
        zoneId: table.zoneId,
        type: input.type,
        reason: input.reason ?? null,
      },
    });
    await emitAndNotify(
      tx,
      context,
      event as EventEnvelope,
      await zoneWaiterIds(tx, tenantId, table.zoneId),
      {
        title: `${TYPE_LABEL[input.type]} - Meja ${table.code}`,
        body:
          input.message?.trim() ||
          `${TYPE_LABEL[input.type]} dari meja ${table.code}.`,
      },
      now,
    );
    return { request: toRequest(row), created: true };
  });
}

/** Staff inbox for one outlet, newest first (cursor on createdAt, id). */
export async function listServiceRequests(
  context: ScopedTenantContext,
  outletId: OutletId,
  query: ListQuery,
) {
  assertOutletInScope(context.outletScope, outletId);
  return withTenant(db, context, async (tx) => {
    const conditions = [
      eq(serviceRequests.tenantId, context.tenant.tenantId),
      eq(serviceRequests.outletId, outletId),
    ];
    if (query.status) conditions.push(eq(serviceRequests.status, query.status));
    if (query.zoneId) conditions.push(eq(serviceRequests.zoneId, query.zoneId));
    if (query.cursor) {
      let keys;
      try {
        keys = decodeCursor(query.cursor);
      } catch {
        throw new CoreError("VALIDATION_ERROR", "Kursor tidak valid.");
      }
      if (
        keys.length !== 2 ||
        typeof keys[0] !== "string" ||
        typeof keys[1] !== "string" ||
        Number.isNaN(Date.parse(keys[0])) ||
        !z.uuid().safeParse(keys[1]).success
      )
        throw new CoreError("VALIDATION_ERROR", "Kursor tidak valid.");
      conditions.push(
        sql`(${serviceRequests.createdAt}, ${serviceRequests.id}) < (${keys[0]}::timestamptz, ${keys[1]}::uuid)`,
      );
    }
    const rows = await tx
      .select()
      .from(serviceRequests)
      .where(and(...conditions))
      .orderBy(desc(serviceRequests.createdAt), desc(serviceRequests.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toRequest),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/**
 * Resolves the outlet that owns a request, from a tenant-wide context, so the
 * route can then demand the permission for exactly that outlet.
 */
export async function findServiceRequestOutlet(
  context: ScopedTenantContext,
  serviceRequestId: string,
): Promise<string> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ outletId: serviceRequests.outletId })
      .from(serviceRequests)
      .where(
        and(
          eq(serviceRequests.tenantId, context.tenant.tenantId),
          eq(serviceRequests.id, serviceRequestId),
        ),
      );
    if (!row)
      throw new CoreError("NOT_FOUND", "Permintaan layanan tidak ditemukan.");
    return row.outletId;
  });
}

async function transition(
  context: ScopedTenantContext,
  serviceRequestId: string,
  actorUserId: string,
  action: Extract<ServiceRequestAction, "acknowledge" | "resolve">,
  now: Date,
  note: string | null,
): Promise<ServiceRequest> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(serviceRequests)
      .where(
        and(
          eq(serviceRequests.tenantId, context.tenant.tenantId),
          eq(serviceRequests.id, serviceRequestId),
        ),
      )
      .for("update");
    if (!row)
      throw new CoreError("NOT_FOUND", "Permintaan layanan tidak ditemukan.");
    assertOutletInScope(context.outletScope, row.outletId);

    const target = action === "acknowledge" ? "acknowledged" : "resolved";
    // A retry by the same staff member after success is a no-op, not an error.
    if (row.status === target && row.assignedTo === actorUserId)
      return toRequest(row);
    let next;
    try {
      next = transitionServiceRequest(row.status, action);
    } catch {
      throw new CoreError(
        "CONFLICT",
        `Permintaan berstatus ${row.status}; tidak bisa ${action}.`,
      );
    }
    if (action === "acknowledge" && row.assignedTo !== null)
      throw new CoreError("CONFLICT", "Permintaan sudah diambil waiter lain.");

    const [updated] = await tx
      .update(serviceRequests)
      .set({
        status: next,
        assignedTo: row.assignedTo ?? actorUserId,
        acknowledgedAt: row.acknowledgedAt ?? now,
        resolvedAt: action === "resolve" ? now : null,
        resolutionNote: action === "resolve" ? note : row.resolutionNote,
        updatedAt: now,
      })
      .where(
        and(
          eq(serviceRequests.tenantId, context.tenant.tenantId),
          eq(serviceRequests.id, serviceRequestId),
        ),
      )
      .returning();
    if (!updated) throw new CoreError("CONFLICT", "Permintaan gagal diubah.");

    if (action === "resolve")
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
          tenantId: context.tenant.tenantId,
          outletId: row.outletId,
          actorType: "user",
          actorId: actorUserId,
          deviceId: null,
          action: "service_request.resolve",
          objectType: "service_request",
          objectId: row.id,
          reason: note,
          maskedChanges: {
            before: maskAuditChanges(
              { id: row.id, status: row.status },
              AUDIT_SAFE_FIELDS,
            ),
            after: maskAuditChanges(
              { id: row.id, status: next, assignedTo: updated.assignedTo },
              AUDIT_SAFE_FIELDS,
            ),
          } as never,
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: toIsoDateTime(now),
        },
        AUDIT_SAFE_FIELDS,
      );
    return toRequest(updated);
  });
}

/** Staff: take the request (pending -> acknowledged). */
export function acknowledgeServiceRequest(
  context: ScopedTenantContext,
  serviceRequestId: string,
  actorUserId: string,
  now = new Date(),
): Promise<ServiceRequest> {
  return transition(
    context,
    serviceRequestId,
    actorUserId,
    "acknowledge",
    now,
    null,
  );
}

/** Staff: done (acknowledged, or still pending, -> resolved). */
export function resolveServiceRequest(
  context: ScopedTenantContext,
  serviceRequestId: string,
  actorUserId: string,
  input: ResolveInput,
  now = new Date(),
): Promise<ServiceRequest> {
  return transition(
    context,
    serviceRequestId,
    actorUserId,
    "resolve",
    now,
    input.note?.trim() || null,
  );
}

/**
 * Escalates every open request older than the threshold, once each: an
 * `service_request.overdue` outbox event plus a notification to the zone's
 * waiters and the assignee. Run per tenant by the scheduler (a job context
 * with tenant scope); returns the escalated request ids.
 */
export async function sweepOverdueServiceRequests(
  now: Date,
  context: ScopedTenantContext,
  thresholdSeconds = SERVICE_REQUEST_OVERDUE_SECONDS,
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - thresholdSeconds * 1000);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const due = await tx
      .select()
      .from(serviceRequests)
      .where(
        and(
          eq(serviceRequests.tenantId, tenantId),
          inArray(serviceRequests.status, ["pending", "acknowledged"]),
          sql`${serviceRequests.overdueNotifiedAt} IS NULL`,
          lte(serviceRequests.createdAt, cutoff),
        ),
      )
      .orderBy(serviceRequests.createdAt)
      .limit(SWEEP_BATCH)
      .for("update", { skipLocked: true });
    const escalated: string[] = [];
    for (const row of due) {
      await tx
        .update(serviceRequests)
        .set({ overdueNotifiedAt: now, updatedAt: now })
        .where(
          and(
            eq(serviceRequests.tenantId, tenantId),
            eq(serviceRequests.id, row.id),
          ),
        );
      const sequence = await nextSequence(tx, tenantId, row.id);
      const event = eventEnvelopeSchema.parse({
        id: createUlid(now.getTime()),
        tenantId,
        outletId: row.outletId,
        name: OVERDUE_EVENT,
        version: 1,
        aggregateType: "service_request",
        aggregateId: row.id,
        sequence,
        occurredAt: toIsoDateTime(now),
        actor: { type: "system" },
        deviceId: null,
        idempotencyKey: `${OVERDUE_EVENT}:${row.id}:${sequence}`,
        payloadSchemaRef: payloadSchemaRefOf(OVERDUE_EVENT, 1),
        payload: {
          serviceRequestId: row.id,
          sessionId: row.tableSessionId,
          tableId: row.tableId,
          zoneId: row.zoneId,
          type: row.type,
          status: row.status,
          assignedTo: row.assignedTo,
          ageSeconds: Math.floor(
            (now.getTime() - row.createdAt.getTime()) / 1000,
          ),
          thresholdSeconds,
        },
      });
      const audience = new Set(await zoneWaiterIds(tx, tenantId, row.zoneId));
      if (row.assignedTo) audience.add(row.assignedTo);
      await emitAndNotify(
        tx,
        context,
        event,
        [...audience],
        {
          title: `${TYPE_LABEL[row.type]} belum ditangani`,
          body: `${TYPE_LABEL[row.type]} sudah menunggu lebih dari ${Math.round(thresholdSeconds / 60)} menit.`,
        },
        now,
      );
      escalated.push(row.id);
    }
    return escalated;
  });
}
