// Action requests for AI/MCP write tools (PRD v1.7 §3 Fitur 38/39/40, AIG-03,
// MCP-04; bead legend-zw9r, part W). A write tool NEVER mutates its target
// module: it opens one approval request (action `ai_action` / `mcp_action`)
// and stores one `action_requests` row. When the approval chain ends, the
// worker calls `handleAiActionApprovalResolved`, which settles the row from
// the chain outcome re-read under the row lock (the event is a trigger, never
// the authority), then executes the approved action as the REQUESTER with the
// requester's access re-read at execution time.
//
// - Status follows ACTION_REQUEST_TRANSITIONS: pending -> approved|rejected|
//   expired, approved -> executed|failed. A replayed or forged event is a
//   no-op: only `pending` and `approved` rows move.
// - Execution runs inside a savepoint of the settle transaction, so a failed
//   executor rolls back its own writes and the row ends `failed` with a safe
//   reason (never the payload). Executors that call module services on their
//   own connection are idempotent by key or by value; see ai-action-executors.
// - Events carry ids and outcomes only, never the write payload.
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  AiError,
  actionRequestReviewSchema,
  actionRequestSchema,
  aiEvents,
  canTransitionActionRequest,
  getAiTool,
  getActionRequestStatusOutputSchema,
  actionRequestReceiptSchema,
  toActionRequestDraft,
  type ActionRequestReceipt,
  type ActionRequestApprovalActionType,
  type ActionRequestStatus,
  type ActionRequestToolCode,
  type AiEventName,
  type GetActionRequestStatusOutput,
} from "@starter/shared/ai";
import {
  AccessError,
  approvalRequirementFor,
  type ApprovalActionType,
} from "@starter/shared/access";
import {
  CoreError,
  createUlid,
  decodeCursor,
  encodeCursor,
  parseDecimal4,
  ulidSchema,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { approvalResolvedEvent } from "@starter/shared/identity";
import type { ApprovalRequestId } from "@starter/shared/identity";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import {
  actionRequests,
  aiSettings,
  mcpClients,
  mcpTokens,
} from "../db/schema/ai.ts";
import { stockBalances, stockLocations } from "../db/schema/inventory.ts";
import { approvalPolicies } from "../db/schema/platform-access.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { user } from "../db/schema/user.ts";
import { redactPii } from "../lib/ai/pii.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import {
  actionExecutors,
  ActionExecutionError,
  type ActionRequestRow,
} from "./ai-action-executors/index.ts";
import {
  holdsToolAccess,
  isBanActive,
  outletIdsOf,
} from "./ai-action-executors/access.ts";
import { toolMatches } from "./ai-metrics/scope.ts";
import { assertAiPlatformUnlockedShared } from "./ai-platform-lock.ts";
import type { AiToolContext } from "./ai-tools/types.ts";
import { appendOutbox } from "./core-outbox.ts";
import {
  accessSnapshotInTransaction,
  type AccessSnapshot,
  type Tx,
} from "./permission-resolver.ts";
import {
  getApprovalChainOutcome,
  openApprovalRequest,
} from "./platform-approval.service.ts";

const EVENT_DESTINATION = "cloud-sync";
const OBJECT_TYPE = "action_request";
/** Approval window for an AI proposal: 24 hours. */
const DEADLINE_MINUTES = 24 * 60;
const FAILURE_REASON_MAX = 500;
const GENERIC_FAILURE = "Aksi gagal dijalankan. Hubungi admin.";

export const AI_ACTION_SOURCE_MODULES = ["ai", "mcp"] as const;

const lower = (value: string) => value.toLowerCase();

// ------------------------------------------------------------------ helpers

function forbidden(): AiError {
  return new AiError("AI_TOOL_FORBIDDEN");
}

function notFound(): AiError {
  return new AiError("ACTION_REQUEST_NOT_FOUND");
}

function summaryOf(
  toolCode: ActionRequestToolCode,
  payload: Record<string, unknown>,
): string {
  const count = (key: string) =>
    Array.isArray(payload[key]) ? (payload[key] as unknown[]).length : 0;
  switch (toolCode) {
    case "TL-14":
      return `Penyesuaian stok untuk ${count("lines")} item.`;
    case "TL-15":
      return `Promo "${String(payload.name ?? "").slice(0, 120)}" untuk ${count("outletIds")} outlet.`;
    case "TL-17":
      return `Perubahan harga untuk ${count("changes")} item menu.`;
    case "TL-18":
      return `Ubah ketersediaan ${count("items")} item menu.`;
    default:
      return "Pengajuan aksi dari AI.";
  }
}

function toView(row: ActionRequestRow) {
  return actionRequestSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    toolCode: row.toolCode,
    requestedByUserId: row.requestedByUserId,
    source: row.source,
    mcpClientId: row.mcpClientId,
    payload: row.payload,
    approvalRequestId: row.approvalRequestId,
    approvalActionType: row.approvalActionType,
    status: row.status,
    resultRef: row.resultRef,
    failureReason: row.failureReason,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    executedAt: row.executedAt?.toISOString() ?? null,
  });
}

/** Tenant-wide read context for discovery; visibility is decided by `canSee`. */
function discoveryContext(access: AccessSnapshot): ScopedTenantContext {
  return establishScopedTenantContext(access.tenant, { kind: "tenant" });
}

/** The requester, or an approval-inbox viewer whose reach covers the request. */
function canSee(access: AccessSnapshot, row: ActionRequestRow): boolean {
  if (lower(row.requestedByUserId) === lower(access.userId)) return true;
  return access.allows(
    "approval.inbox.view",
    row.outletId === null
      ? { type: "tenant" }
      : { type: "outlet", id: row.outletId },
  );
}

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateId: string,
): Promise<number> {
  const [last] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, "action_request"),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(last?.last ?? 0) + 1;
}

async function emit(
  tx: Tx,
  context: ScopedTenantContext,
  name: Extract<AiEventName, `action_request.${string}`>,
  row: ActionRequestRow,
  extra: Record<string, unknown>,
  actor: { type: "user"; id: string } | { type: "system" },
  now: Date,
): Promise<void> {
  const definition = aiEvents[name];
  const sequence = await nextSequence(tx, row.tenantId, row.id);
  const event = definition.envelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId: row.tenantId,
    outletId: row.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: row.id,
    sequence,
    occurredAt: now.toISOString(),
    actor,
    deviceId: null,
    idempotencyKey: `${definition.name}:${row.id}:${sequence}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: {
      actionRequestId: row.id,
      approvalRequestId: row.approvalRequestId,
      toolCode: row.toolCode,
      source: row.source,
      outletId: row.outletId,
      ...extra,
    },
  });
  await appendOutbox(tx, context, {
    id: createUlid(now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

// ------------------------------------------------------------ approval plan

/** Rupiah value of a stock adjustment: sum of |qty| x average cost, rounded up. */
export function adjustmentValueIdr(
  lines: readonly { inventoryItemId: string; qtyDelta: string }[],
  avgCostByItem: ReadonlyMap<string, string>,
): number | null {
  let scaled = 0n;
  for (const line of lines) {
    const cost = avgCostByItem.get(line.inventoryItemId);
    if (cost === undefined) return null; // unknown cost: fail closed
    const qty = parseDecimal4(line.qtyDelta);
    scaled += (qty < 0n ? -qty : qty) * parseDecimal4(cost);
  }
  const idr = (scaled + 99_999_999n) / 100_000_000n; // Decimal4 x Decimal4
  return idr <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(idr) : null;
}

/**
 * The module rule the same change would face by hand (§3.7), and its amount:
 * stock adjustment by value, promotion as a discount (nominal amount; a
 * percentage has no known amount), price change (no amount: every tier).
 * `null` amount means unknown, so every tier applies (fail closed).
 */
async function approvalPlanFor(
  tx: Tx,
  toolCode: ActionRequestToolCode,
  payload: Record<string, unknown>,
  outletId: string | null,
): Promise<{
  moduleAction: ApprovalActionType | null;
  amountIdr: number | null;
}> {
  switch (toolCode) {
    case "TL-14": {
      const lines =
        (payload.lines as { inventoryItemId: string; qtyDelta: string }[]) ??
        [];
      const rows =
        outletId === null || lines.length === 0
          ? []
          : await tx
              .select({
                item: stockBalances.inventoryItemId,
                cost: stockBalances.avgCostIdr,
                quantity: stockBalances.quantity,
              })
              .from(stockBalances)
              .innerJoin(
                stockLocations,
                and(
                  eq(stockLocations.tenantId, stockBalances.tenantId),
                  eq(stockLocations.id, stockBalances.locationId),
                ),
              )
              .where(
                and(
                  eq(stockBalances.outletId, outletId),
                  // Active locations only, as the executor's pickLocation.
                  eq(stockLocations.isActive, true),
                  inArray(
                    stockBalances.inventoryItemId,
                    lines.map((line) => line.inventoryItemId),
                  ),
                ),
              );
      // Same location the executor posts to: the largest balance of the item.
      const best = new Map<string, { cost: string; quantity: bigint }>();
      for (const row of rows) {
        const quantity = parseDecimal4(row.quantity);
        const known = best.get(row.item);
        if (!known || quantity > known.quantity)
          best.set(row.item, { cost: row.cost, quantity });
      }
      return {
        moduleAction: "stock_adjustment",
        amountIdr: adjustmentValueIdr(
          lines,
          new Map([...best].map(([item, value]) => [item, value.cost])),
        ),
      };
    }
    case "TL-15": {
      const discount = payload.discount as {
        kind?: string;
        amountIdr?: number;
      };
      return {
        moduleAction: "discount",
        amountIdr:
          discount?.kind === "amount" ? (discount.amountIdr ?? null) : null,
      };
    }
    case "TL-17":
      return { moduleAction: "price_change", amountIdr: null };
    default:
      return { moduleAction: null, amountIdr: null };
  }
}

/**
 * An AI request is never weaker than the same change made by hand: when the
 * tenant has a policy for the module's own action (price_change -> general
 * manager, stock_adjustment and discount by amount) that applies at this
 * amount, the request opens that rule. Otherwise it opens `ai_action` /
 * `mcp_action`. A missing policy counts as no requirement.
 */
export async function pickApprovalAction(
  tx: Tx,
  tenantId: string,
  input: {
    source: "ai" | "mcp";
    moduleAction: ApprovalActionType | null;
    amountIdr: number | null;
  },
): Promise<ApprovalActionType> {
  const aiAction: ApprovalActionType =
    input.source === "ai" ? "ai_action" : "mcp_action";
  if (input.moduleAction === null) return aiAction;
  const rows = await tx
    .select()
    .from(approvalPolicies)
    .where(
      and(
        eq(approvalPolicies.tenantId, tenantId),
        eq(approvalPolicies.actionType, input.moduleAction),
      ),
    );
  if (rows.length === 0) return aiAction;
  const requirement = approvalRequirementFor(
    rows as never,
    input.moduleAction,
    input.amountIdr,
  );
  return requirement.required && requirement.steps.length > 0
    ? input.moduleAction
    : aiAction;
}

// ----------------------------------------------------------------- propose

/**
 * Write-tool entry (TL-13..TL-18): permission at every outlet in the payload,
 * one approval request, one action request, `action_request.created`. Nothing
 * else changes. Returns the receipt the tool hands back to the model.
 */
export async function proposeActionRequest(
  ctx: AiToolContext,
  toolCode: ActionRequestToolCode,
  rawInput: unknown,
): Promise<ActionRequestReceipt> {
  const tool = getAiTool(toolCode);
  if (!tool || tool.kind !== "write") throw new RangeError("Not a write tool");
  const { access, now } = ctx;
  const payload = tool.input.parse(rawInput) as Record<string, unknown>;
  const source = ctx.channel === "mcp" ? "mcp" : "ai";
  if (source === "mcp" && ctx.mcpClientId === null) throw forbidden();

  // The caller must hold one minRoles role with all its tool permissions,
  // `ai.action.propose` and the domain write permission at EVERY outlet of the
  // payload (tenant target when it names none), all through that same role
  // (`allowsVia`).
  toolMatches(ctx, toolCode);
  const outletIds = outletIdsOf(payload);
  if (!holdsToolAccess(access, toolCode, payload)) throw forbidden();

  // Row outlet: the single outlet, else tenant-level (needs tenant reach).
  const rowOutletId = outletIds.length === 1 ? outletIds[0]! : null;
  const context = access.contextFor(
    "ai.action.propose",
    rowOutletId === null
      ? { type: "tenant" }
      : { type: "outlet", id: rowOutletId },
  );
  if (!context) throw forbidden();

  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + DEADLINE_MINUTES * 60_000);
  const summary = summaryOf(toolCode, payload);
  let chainId = "";
  try {
    await withTenant(db, context, async (tx) => {
      const plan = await approvalPlanFor(tx, toolCode, payload, rowOutletId);
      const actionType = await pickApprovalAction(tx, access.tenant.tenantId, {
        source,
        moduleAction: plan.moduleAction,
        amountIdr: plan.amountIdr,
      });
      const opened = await openApprovalRequest(tx, context, {
        sourceModule: source,
        actionType,
        objectType: OBJECT_TYPE,
        objectId: id,
        amountIdr: plan.amountIdr,
        outletId: rowOutletId,
        requestedBy: access.userId,
        source,
        requestReason: summary,
        payload: { toolCode, actionRequestId: id },
        deadlineMinutes: DEADLINE_MINUTES,
        now,
      });
      if (!opened.required)
        throw new AiError(
          "AI_WRITE_REQUIRES_APPROVAL",
          "Kebijakan approval untuk aksi AI belum diatur.",
        );
      chainId = opened.chainId;
      const draft = toActionRequestDraft({
        toolCode,
        input: payload,
        tenantId: access.tenant.tenantId as TenantId,
        outletId: rowOutletId as OutletId | null,
        requestedByUserId: access.userId as UserId,
        source,
        mcpClientId: (ctx.mcpClientId ?? null) as never,
        approvalRequestId: opened.chainId as ApprovalRequestId,
        approvalActionType: actionType as ActionRequestApprovalActionType,
        now: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      const [row] = await tx
        .insert(actionRequests)
        .values({
          id,
          tenantId: draft.tenantId,
          outletId: draft.outletId,
          toolCode: draft.toolCode,
          requestedByUserId: draft.requestedByUserId,
          source: draft.source,
          mcpClientId: draft.mcpClientId,
          payload: draft.payload,
          approvalRequestId: draft.approvalRequestId,
          approvalActionType: draft.approvalActionType,
          status: "pending",
          expiresAt,
          createdAt: now,
        })
        .returning();
      if (!row) throw new Error("Action request insert returned no row");
      await emit(
        tx,
        context,
        "action_request.created",
        row,
        {
          requestedByUserId: row.requestedByUserId,
          expiresAt: expiresAt.toISOString(),
          createdAt: now.toISOString(),
        },
        { type: "user", id: access.userId },
        now,
      );
    });
  } catch (error) {
    // No approval policy for the action: nobody may approve (fail closed).
    if (
      error instanceof AccessError &&
      error.code === "APPROVAL_POLICY_MISSING"
    )
      throw new AiError(
        "AI_TOOL_DISABLED",
        "Kebijakan approval untuk aksi AI belum diatur oleh admin.",
      );
    throw error;
  }
  return actionRequestReceiptSchema.parse({
    actionRequestId: id,
    approvalRequestId: chainId,
    toolCode,
    status: "pending",
    summary,
  });
}

// -------------------------------------------------------------------- reads

async function findRow(
  access: AccessSnapshot,
  actionRequestId: string,
): Promise<ActionRequestRow> {
  if (!/^[0-9a-f-]{36}$/i.test(actionRequestId)) throw notFound();
  const row = await withTenant(db, discoveryContext(access), async (tx) => {
    const [found] = await tx
      .select()
      .from(actionRequests)
      .where(
        and(
          eq(actionRequests.tenantId, access.tenant.tenantId),
          eq(actionRequests.id, actionRequestId),
        ),
      );
    return found;
  });
  // Another user's request is indistinguishable from a missing one.
  if (!row || !canSee(access, row)) throw notFound();
  if (row.status !== "pending" && row.status !== "approved") return row;
  // Read-through settle: the worker hook normally does this, but a decided
  // chain must not look pending just because the worker is behind or absent.
  // settleActionRequest is idempotent and a no-op while the chain is open.
  try {
    await settleActionRequest(discoveryContext(access), row.id);
  } catch (error) {
    // A platform lock must reach the caller as 403, not look like a pending read.
    if (isPlatformLockError(error)) throw error;
    return row;
  }
  const [fresh] = await withTenant(db, discoveryContext(access), (tx) =>
    tx
      .select()
      .from(actionRequests)
      .where(
        and(
          eq(actionRequests.tenantId, access.tenant.tenantId),
          eq(actionRequests.id, row.id),
        ),
      ),
  );
  return fresh ?? row;
}

/** GET /api/ai/action-requests/:id: the requester, or an approver in reach. */
export async function getActionRequestView(
  access: AccessSnapshot,
  actionRequestId: string,
) {
  return toView(await findRow(access, actionRequestId));
}

const LABELS: Record<string, string> = {
  outletId: "Outlet",
  outletIds: "Outlet",
  name: "Nama",
  reason: "Alasan",
  note: "Catatan",
  description: "Deskripsi",
  until: "Sampai",
  startsAt: "Mulai",
  endsAt: "Selesai",
  effectiveAt: "Berlaku",
  discount: "Diskon",
  lines: "Baris",
  items: "Item",
  changes: "Perubahan",
};

/** Redacted, bounded label/value lines of a payload for the approval inbox. */
function summaryLines(payload: Record<string, unknown>) {
  return Object.entries(payload)
    .slice(0, 30)
    .map(([key, value]) => ({
      label: (LABELS[key] ?? key).slice(0, 80),
      value: redactPii(
        Array.isArray(value)
          ? `${value.length} entri`
          : typeof value === "object" && value !== null
            ? JSON.stringify(value)
            : String(value),
      ).slice(0, 300),
    }));
}

/**
 * GET /api/ai/action-requests/by-approval/:approvalRequestId: the request
 * behind one approval inbox item (any level row of the chain), for the
 * requester or an inbox viewer in reach. Not found otherwise.
 */
export async function getActionRequestReview(
  access: AccessSnapshot,
  approvalRequestId: string,
) {
  if (!/^[0-9a-f-]{36}$/i.test(approvalRequestId)) throw notFound();
  const found = await withTenant(db, discoveryContext(access), async (tx) => {
    const [approval] = await tx
      .select({ chainId: approvalRequests.chainId })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, access.tenant.tenantId),
          eq(approvalRequests.id, approvalRequestId),
        ),
      );
    if (!approval) return null;
    const [row] = await tx
      .select()
      .from(actionRequests)
      .where(
        and(
          eq(actionRequests.tenantId, access.tenant.tenantId),
          eq(actionRequests.approvalRequestId, approval.chainId),
        ),
      );
    if (!row || !canSee(access, row)) return null;
    const [requester] = await tx
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, row.requestedByUserId));
    const outlet =
      row.outletId === null
        ? null
        : ((
            await tx
              .select({ name: outlets.name })
              .from(outlets)
              .where(
                and(
                  eq(outlets.tenantId, row.tenantId),
                  eq(outlets.id, row.outletId),
                ),
              )
          )[0] ?? null);
    return { row, requesterName: requester?.name ?? "Pengguna", outlet };
  });
  if (!found) throw notFound();
  return actionRequestReviewSchema.parse({
    actionRequest: toView(found.row),
    toolTitleId:
      getAiTool(found.row.toolCode as ActionRequestToolCode)?.titleId ??
      found.row.toolCode,
    requestedByName: found.requesterName.slice(0, 120) || "Pengguna",
    outletName: found.outlet?.name.slice(0, 120) ?? null,
    summary: summaryLines(found.row.payload),
  });
}

/** GET /api/ai/action-requests: the caller's own requests, newest first. */
export async function listMyActionRequests(
  access: AccessSnapshot,
  query: {
    limit: number;
    cursor?: string | undefined;
    status?: ActionRequestStatus | undefined;
    toolCode?: string | undefined;
    approvalRequestId?: string | undefined;
  },
) {
  return withTenant(db, discoveryContext(access), async (tx) => {
    const filters = [
      eq(actionRequests.tenantId, access.tenant.tenantId),
      eq(actionRequests.requestedByUserId, access.userId as UserId),
    ];
    if (query.status) filters.push(eq(actionRequests.status, query.status));
    if (query.toolCode)
      filters.push(eq(actionRequests.toolCode, query.toolCode));
    if (query.approvalRequestId)
      filters.push(
        eq(actionRequests.approvalRequestId, query.approvalRequestId),
      );
    if (query.cursor) {
      const [createdAt, id] = decodeCursor(query.cursor);
      const at = new Date(String(createdAt));
      if (typeof id !== "string" || Number.isNaN(at.getTime()))
        throw new CoreError("VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        sql`(${actionRequests.createdAt}, ${actionRequests.id}) < (${at}, ${id}::uuid)`,
      );
    }
    const rows = await tx
      .select()
      .from(actionRequests)
      .where(and(...filters))
      .orderBy(desc(actionRequests.createdAt), desc(actionRequests.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toView),
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

/** TL-19 get_action_request_status. */
export async function getActionRequestStatus(
  ctx: AiToolContext,
  actionRequestId: string,
): Promise<GetActionRequestStatusOutput> {
  const row = await findRow(ctx.access, actionRequestId);
  const approval = await withTenant(
    db,
    discoveryContext(ctx.access),
    async (tx) => {
      const [latest] = await tx
        .select({
          status: approvalRequests.status,
          decidedAt: approvalRequests.decidedAt,
        })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.tenantId, row.tenantId),
            eq(approvalRequests.chainId, row.approvalRequestId),
          ),
        )
        .orderBy(desc(approvalRequests.level))
        .limit(1);
      return latest;
    },
  );
  return getActionRequestStatusOutputSchema.parse({
    actionRequestId: row.id,
    toolCode: row.toolCode,
    status: row.status,
    approvalStatus: approval?.status ?? "pending",
    decidedAt: approval?.decidedAt?.toISOString() ?? null,
    resultRef: row.resultRef,
    failureReason: row.failureReason,
  });
}

// ------------------------------------------------------------------- settle

function isPlatformLockError(error: unknown): error is AiError {
  return error instanceof AiError && error.code === "AI_PLATFORM_DISABLED";
}

function safeFailureReason(error: unknown): string {
  if (error instanceof ActionExecutionError)
    return error.message.slice(0, FAILURE_REASON_MAX);
  if (
    error instanceof AiError ||
    error instanceof CoreError ||
    error instanceof HttpError ||
    error instanceof AccessError
  )
    return (error.message || GENERIC_FAILURE).slice(0, FAILURE_REASON_MAX);
  return GENERIC_FAILURE;
}

async function transition(
  tx: Tx,
  row: ActionRequestRow,
  to: ActionRequestStatus,
  set: Partial<typeof actionRequests.$inferInsert>,
): Promise<ActionRequestRow> {
  if (!canTransitionActionRequest(row.status as ActionRequestStatus, to))
    throw new AiError("ACTION_REQUEST_INVALID_TRANSITION");
  const [updated] = await tx
    .update(actionRequests)
    .set({ status: to, ...set })
    .where(
      and(
        eq(actionRequests.tenantId, row.tenantId),
        eq(actionRequests.id, row.id),
        // Compare-and-set on the status read under the row lock: a second
        // writer can never move the row again (no double execution).
        eq(actionRequests.status, row.status),
      ),
    )
    .returning();
  if (!updated) throw new AiError("ACTION_REQUEST_INVALID_TRANSITION");
  return updated;
}

/**
 * Who is acting must still be allowed at execution time: not banned, and for
 * MCP the client still approved (not revoked). Role and outlet rights are
 * checked by `holdsToolAccess` on the requester's re-read snapshot
 * (`allowsVia`, role by role).
 */
async function assertActorStillValid(
  tx: Tx,
  row: ActionRequestRow,
  now: Date,
): Promise<void> {
  const [account] = await tx
    .select({ banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, row.requestedByUserId));
  if (!account || isBanActive(account.banned, account.banExpires, now))
    throw new ActionExecutionError("Akun pengaju tidak aktif.");
  // Tenant switches: AI master switch, and the MCP switch for MCP requests
  // (no settings row: AI on, MCP off, as `loadMcpSettings`).
  const [settings] = await tx
    .select({
      aiEnabled: aiSettings.aiEnabled,
      mcpEnabled: aiSettings.mcpEnabled,
    })
    .from(aiSettings)
    .where(eq(aiSettings.tenantId, row.tenantId))
    .limit(1);
  if (!(settings?.aiEnabled ?? true))
    throw new ActionExecutionError("Fitur AI dimatikan oleh admin.");
  if (row.source === "mcp" && !(settings?.mcpEnabled ?? false))
    throw new ActionExecutionError("MCP dimatikan oleh admin.");
  // Platform lock: shared row lock on the tenant, held until this tx ends, so
  // a lock change waits for this execution and a later one sees "locked".
  // Throws AiError AI_PLATFORM_DISABLED; `execute` and `findRow` let it pass
  // (not a `failed` action: the request is retried once the platform unlocks).
  await assertAiPlatformUnlockedShared(tx, row.tenantId);
  if (row.source === "mcp") {
    const [client] = await tx
      .select({ status: mcpClients.status })
      .from(mcpClients)
      .where(
        and(
          eq(mcpClients.tenantId, row.tenantId),
          eq(mcpClients.id, row.mcpClientId ?? ""),
        ),
      );
    if (client?.status !== "approved")
      throw new ActionExecutionError("Aplikasi MCP pengaju sudah dicabut.");
    // The requester must still hold an unrevoked token of that client.
    const [token] = await tx
      .select({ id: mcpTokens.id })
      .from(mcpTokens)
      .where(
        and(
          eq(mcpTokens.tenantId, row.tenantId),
          eq(mcpTokens.mcpClientId, row.mcpClientId ?? ""),
          eq(mcpTokens.userId, row.requestedByUserId),
          isNull(mcpTokens.revokedAt),
        ),
      )
      .limit(1);
    if (!token)
      throw new ActionExecutionError("Token MCP pengaju sudah dicabut.");
  }
}

/**
 * Settles one action request from its approval chain and, when approved,
 * executes it. Idempotent: rows that are not `pending`/`approved` and chains
 * that are still open do nothing. Runs under the worker's tenant context.
 */
export async function settleActionRequest(
  context: ScopedTenantContext,
  actionRequestId: string,
  now = new Date(),
): Promise<ActionRequestStatus> {
  return withTenant(db, context, async (tx) => {
    const [locked] = await tx
      .select()
      .from(actionRequests)
      .where(
        and(
          eq(actionRequests.tenantId, context.tenant.tenantId),
          eq(actionRequests.id, actionRequestId),
        ),
      )
      .for("update");
    if (!locked) throw notFound();
    let row = locked;
    if (row.status === "pending") {
      const outcome = await getApprovalChainOutcome(tx, {
        chainId: row.approvalRequestId,
        sourceModule: row.source,
      });
      if (outcome === "pending") return "pending";
      const [last] = await tx
        .select({
          decidedBy: approvalRequests.decidedBy,
          decidedAt: approvalRequests.decidedAt,
        })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.tenantId, row.tenantId),
            eq(approvalRequests.chainId, row.approvalRequestId),
          ),
        )
        .orderBy(desc(approvalRequests.level))
        .limit(1);
      const decider = last?.decidedBy ?? row.requestedByUserId;
      const decidedAt = last?.decidedAt ?? now;
      if (outcome === "approved") {
        row = await transition(tx, row, "approved", {});
        await emit(
          tx,
          context,
          "action_request.approved",
          row,
          {
            approvedByUserId: decider,
            approvedAt: decidedAt.toISOString(),
          },
          { type: "user", id: decider },
          now,
        );
      } else if (outcome === "expired") {
        row = await transition(tx, row, "expired", {});
        await emit(
          tx,
          context,
          "action_request.expired",
          row,
          { expiredAt: now.toISOString() },
          { type: "system" },
          now,
        );
      } else {
        // rejected, or cancelled by the source (we never cancel): not executed.
        row = await transition(tx, row, "rejected", {});
        await emit(
          tx,
          context,
          "action_request.rejected",
          row,
          {
            rejectedByUserId: decider,
            rejectedAt: decidedAt.toISOString(),
          },
          { type: "user", id: decider },
          now,
        );
      }
    }
    if (row.status !== "approved") return row.status as ActionRequestStatus;
    return execute(tx, context, row, now);
  });
}

async function execute(
  tx: Tx,
  context: ScopedTenantContext,
  row: ActionRequestRow,
  now: Date,
): Promise<ActionRequestStatus> {
  const executor = actionExecutors[row.toolCode as ActionRequestToolCode];
  try {
    // Re-check the REQUESTER at execution time: roles and outlet reach may
    // have changed since the proposal (MCP-04, AIG-03).
    const access = await accessSnapshotInTransaction(
      tx,
      context,
      row.requestedByUserId,
      now,
    );
    if (!executor)
      throw new ActionExecutionError(
        "Aksi ini belum bisa dijalankan otomatis.",
      );
    await assertActorStillValid(tx, row, now);
    if (
      !holdsToolAccess(
        access,
        row.toolCode as ActionRequestToolCode,
        row.payload,
      )
    )
      throw new ActionExecutionError(
        "Pengaju tidak lagi punya izin untuk aksi ini.",
      );
    const result = await tx.transaction((savepoint) =>
      executor({ tx: savepoint, context, access, row, now }),
    );
    const done = await transition(tx, row, "executed", {
      resultRef: result.resultRef.slice(0, 200),
      executedAt: now,
    });
    await emit(
      tx,
      context,
      "action_request.executed",
      done,
      { resultRef: result.resultRef, executedAt: now.toISOString() },
      { type: "system" },
      now,
    );
    return "executed";
  } catch (error) {
    // Locked platform: abort the settle transaction (the row keeps its prior
    // status, nothing executes) and answer AI_PLATFORM_DISABLED upstream.
    if (isPlatformLockError(error)) throw error;
    if (!(error instanceof ActionExecutionError))
      logger.warn(
        { actionRequestId: row.id, toolCode: row.toolCode },
        "AI action execution failed",
      );
    const reason = safeFailureReason(error);
    const failed = await transition(tx, row, "failed", {
      failureReason: reason,
    });
    await emit(
      tx,
      context,
      "action_request.failed",
      failed,
      { failureReason: reason, failedAt: now.toISOString() },
      { type: "system" },
      now,
    );
    return "failed";
  }
}

// ------------------------------------------------------------ worker hook

function refuse(message: string): never {
  throw new CoreError("VALIDATION_ERROR", message);
}

/** ULID or UUID spelling of one id, compared in its stored (uuid) form. */
function storedId(id: string): string {
  return ulidSchema.safeParse(id).success
    ? ulidToUuid(id).toLowerCase()
    : id.toLowerCase();
}

/**
 * `approval.resolved` consumer for AI/MCP action requests (wired in
 * worker-main.ts). Ignores other events and source modules; refuses a
 * malformed or cross-tenant event; settles from the database, never from the
 * event payload. A chain that is not ours (no row) is ignored.
 */
export async function handleAiActionApprovalResolved(
  context: ScopedTenantContext,
  event: EventEnvelope,
): Promise<void> {
  if (event.name !== approvalResolvedEvent.name) return;
  const sourceModule = (event.payload as Record<string, unknown>)?.sourceModule;
  if (sourceModule !== "ai" && sourceModule !== "mcp") return;
  const parsed = approvalResolvedEvent.envelopeSchema.safeParse(event);
  if (!parsed.success)
    refuse(`approval.resolved for ${sourceModule} has an unknown shape`);
  const resolved = parsed.data;
  if (lower(resolved.tenantId) !== lower(context.tenant.tenantId))
    refuse("approval.resolved tenant does not match the worker context");
  if (resolved.payload.objectType !== OBJECT_TYPE) return;
  const owner = await withTenant(db, context, async (tx) => {
    const [found] = await tx
      .select({
        id: actionRequests.id,
        approvalRequestId: actionRequests.approvalRequestId,
      })
      .from(actionRequests)
      .where(
        and(
          eq(actionRequests.tenantId, context.tenant.tenantId),
          eq(actionRequests.id, storedId(resolved.payload.objectId)),
        ),
      );
    return found ?? null;
  });
  if (owner === null) return;
  if (storedId(owner.approvalRequestId) !== storedId(resolved.payload.chainId))
    refuse("approval.resolved chain belongs to another action request");
  try {
    await settleActionRequest(context, owner.id);
  } catch (error) {
    // The platform AI lock is a deliberate pause, not a delivery failure. This
    // handler shares the `approval.resolved` delivery with other handlers, so a
    // throw would retry 5x, dead-letter the event, and skip later handlers.
    // The action stays pending/approved; reads and `settleActionRequest` still
    // reject with AI_PLATFORM_DISABLED until the tenant is unlocked.
    if (!isPlatformLockError(error)) throw error;
    logger.info(
      { tenantId: context.tenant.tenantId, actionRequestId: owner.id },
      "ai action approval settle skipped: platform AI is locked",
    );
  }
}
