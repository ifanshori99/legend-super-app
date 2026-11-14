// AI gateway (WS-12 part G, bead legend-zfi4; PRD §40 AIG-01..05, AI-12).
// Every Tanya AI / MCP model call passes `aiPreflight` (switches, PII, budget,
// daily quota) before it and `aiComplete` (provider, usage, cost, budget
// events) around it. Fixed cross-part API: docs/briefs/sub-ws12-ai.md §G.
//
// - Bookkeeping tables (settings, usage, cache) are tenant-wide with tenant RLS
//   only, so the gateway runs them in a server-minted tenant-scope context;
//   what data the LLM may read is decided by the tool handlers, not here.
// - Preflight order: tenant switch -> feature switch -> PII -> budget -> quota.
//   The quota counter moves last, so a blocked request never uses quota.
// - A provider failure never leaks details and never throws anything but
//   `AiError("AI_PROVIDER_UNAVAILABLE")`. Nothing here logs prompt content.
import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import {
  AiError,
  aiEvents,
  budgetState,
  defaultDailyLimitForRole,
  type AiBlockedReason,
  type AiChannel,
  type AiGovernanceSettings,
  type AiToolCode,
} from "@starter/shared/ai";
import {
  businessDateOf,
  createUlid,
  DEFAULT_BUSINESS_DAY_CLOCK,
  idr,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import {
  aiResponseCache,
  aiSettings,
  aiUsageDaily,
  aiUsageEvents,
  aiUsageMonthly,
} from "../db/schema/ai.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { scanPii, type PiiKind } from "../lib/ai/pii.ts";
import { ChatgptCodexError } from "../lib/ai/chatgpt-codex.ts";
import {
  estimateRequestInputTokens,
  prepareAiRequest,
} from "../lib/ai/request-policy.ts";
import type {
  AiCompletionRequest,
  AiCompletionResult,
} from "../lib/ai/types.ts";
import { logger } from "../lib/logger.ts";
import {
  aiProviderVersionOf,
  resolveTenantAiProvider,
  resolveTenantCustomAiProvider,
  type ResolvedAiProvider,
} from "./ai-provider-config.service.ts";
import { appendOutbox } from "./core-outbox.ts";
import { costMicroUsd, microUsdToIdr, USD_IDR_RATE } from "./ai-pricing.ts";
import {
  isAiPlatformLocked,
  isAiPlatformLockedShared,
} from "./ai-platform-lock.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** `tanya_ai` is the tool-layer spelling of the contract channel `app`. */
export type AiGatewayChannel = AiChannel | "tanya_ai";
type AiBillingMode = "api_metered" | "chatgpt_plan";

// Stored settings only. `platformLocked` is derived from the tenant's feature
// flags at read time (ai-platform-lock.ts), never stored with the settings.
export type AiSettingsView = Omit<
  AiGovernanceSettings,
  "updatedAt" | "updatedBy" | "platformLocked"
>;

export type AiCacheKeyInput = {
  /** Scope string of the question (e.g. the period or feature code). */
  scope: string;
  question: string;
  /** Outlet reach of the caller; omit or null for tenant-wide. */
  outletIds?: readonly string[] | null;
};

export const AI_OUTBOX_DESTINATION = "cloud-sync";
export const AI_CACHE_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

/** PII kinds a user may type when asking about their own payslip (allowOwnData). */
const OWN_DATA_PII: ReadonlySet<PiiKind> = new Set([
  "salary",
  "bank_account",
  "nik",
  "npwp",
]);

/**
 * Server-minted tenant-scope context for the gateway's own bookkeeping
 * (usage, budget, audit) AND for server-side candidate reads such as menu
 * items in draftPromoCopy and business accounts. RLS alone does not narrow
 * those reads: every caller must filter the loaded rows by the caller's
 * scoped reach before they reach the model or the response (legend-cy2e,
 * Codex review 152).
 */
export function gatewayContext(access: AccessSnapshot): ScopedTenantContext {
  return establishScopedTenantContext(access.tenant, { kind: "tenant" });
}

export function usageDateOf(now: Date): string {
  return businessDateOf(now, DEFAULT_BUSINESS_DAY_CLOCK);
}

/** "YYYY-MM" of the business calendar. */
export function usageMonthOf(now: Date): string {
  return usageDateOf(now).slice(0, 7);
}

const dbChannel = (channel: AiGatewayChannel) =>
  channel === "mcp" ? "mcp" : "tanya_ai";

const featureColumn = (feature: string | null | undefined) =>
  feature !== null && feature !== undefined && /^AI-\d{2}$/.test(feature)
    ? feature
    : null;

// ---------------------------------------------------------------- settings

export function defaultAiSettings(access: AccessSnapshot): AiSettingsView {
  return {
    tenantId: access.tenant.tenantId,
    aiEnabled: true,
    mcpEnabled: false,
    dynamicClientRegistrationEnabled: false,
    // Fail closed: no budget set means the gateway is stopped until the owner sets one.
    monthlyBudgetIdr: idr(0),
    budgetWarnPct: 80,
    budgetStopPct: 100,
    features: [],
    disabledToolCodes: [],
    mcpRateLimitPerMinute: 60,
    maxRowsPerResponse: 200,
  };
}

export type AiSettingsRow = typeof aiSettings.$inferSelect;

export function settingsRowToView(row: AiSettingsRow): AiSettingsView {
  return {
    tenantId: row.tenantId,
    aiEnabled: row.aiEnabled,
    mcpEnabled: row.mcpEnabled,
    dynamicClientRegistrationEnabled: row.dynamicClientRegistrationEnabled,
    monthlyBudgetIdr: row.monthlyBudgetIdr,
    budgetWarnPct: row.budgetWarnPct,
    budgetStopPct: row.budgetStopPct,
    features: row.features as AiSettingsView["features"],
    disabledToolCodes: row.disabledToolCodes as AiToolCode[],
    mcpRateLimitPerMinute: row.mcpRateLimitPerMinute,
    maxRowsPerResponse: row.maxRowsPerResponse,
  };
}

async function readSettingsRow(
  tx: Tx,
  access: AccessSnapshot,
): Promise<AiSettingsRow | null> {
  const [row] = await tx
    .select()
    .from(aiSettings)
    .where(eq(aiSettings.tenantId, access.tenant.tenantId))
    .limit(1);
  return row ?? null;
}

async function readSettings(
  tx: Tx,
  access: AccessSnapshot,
): Promise<AiSettingsView> {
  const row = await readSettingsRow(tx, access);
  return row ? settingsRowToView(row) : defaultAiSettings(access);
}

/** Tenant AI settings; defaults when the tenant has no row yet. */
export async function getAiSettings(
  access: AccessSnapshot,
): Promise<AiSettingsView> {
  return withTenant(db, gatewayContext(access), (tx) =>
    readSettings(tx, access),
  );
}

/** Row of the tenant, for the governance service (needs id and audit fields). */
export async function getAiSettingsRow(
  tx: Tx,
  access: AccessSnapshot,
): Promise<AiSettingsRow | null> {
  return readSettingsRow(tx, access);
}

// ------------------------------------------------------------------ quota

/**
 * Daily limit of the caller for one feature: the highest limit among the
 * roles the caller holds (feature override by role key, else the role
 * default). A caller with no template role gets the employee default.
 */
export function dailyLimitFor(
  settings: AiSettingsView,
  access: AccessSnapshot,
  feature: string,
): number {
  const override =
    settings.features.find((f) => f.feature === feature)?.dailyLimitByRole ??
    {};
  const keys = access.templateKeys;
  if (keys.length === 0) return defaultDailyLimitForRole("employee");
  return Math.max(
    ...keys.map((key) => {
      const set = (override as Record<string, number | undefined>)[key];
      return (
        set ??
        defaultDailyLimitForRole(
          key as Parameters<typeof defaultDailyLimitForRole>[0],
        )
      );
    }),
  );
}

export function isFeatureEnabled(
  settings: AiSettingsView,
  feature: string,
): boolean {
  return (
    settings.features.find((f) => f.feature === feature)?.isEnabled ?? true
  );
}

async function monthlyUsedIdr(
  tx: Tx,
  access: AccessSnapshot,
  month: string,
): Promise<number> {
  const [row] = await tx
    .select({ costIdr: aiUsageMonthly.costIdr })
    .from(aiUsageMonthly)
    .where(
      and(
        eq(aiUsageMonthly.tenantId, access.tenant.tenantId),
        eq(aiUsageMonthly.usageMonth, month),
      ),
    )
    .limit(1);
  return row?.costIdr ?? 0;
}

export async function readDailyCount(
  tx: Tx,
  access: AccessSnapshot,
  date: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: aiUsageDaily.requestCount })
    .from(aiUsageDaily)
    .where(
      and(
        eq(aiUsageDaily.tenantId, access.tenant.tenantId),
        eq(aiUsageDaily.userId, access.userId as UserId),
        eq(aiUsageDaily.usageDate, date),
      ),
    )
    .limit(1);
  return row?.count ?? 0;
}

export async function readMonthlyUsedIdr(
  tx: Tx,
  access: AccessSnapshot,
  month: string,
): Promise<number> {
  return monthlyUsedIdr(tx, access, month);
}

// -------------------------------------------------------------- preflight

type Block = {
  code:
    | "AI_FEATURE_DISABLED"
    | "AI_PLATFORM_DISABLED"
    | "AI_PII_BLOCKED"
    | "AI_QUOTA_EXCEEDED"
    | "AI_BUDGET_EXCEEDED";
  reason: AiBlockedReason;
};

const BLOCKS = {
  feature: { code: "AI_FEATURE_DISABLED", reason: "feature_disabled" },
  platform: { code: "AI_PLATFORM_DISABLED", reason: "feature_disabled" },
  pii: { code: "AI_PII_BLOCKED", reason: "pii_blocked" },
  budget: { code: "AI_BUDGET_EXCEEDED", reason: "budget_exceeded" },
  quota: { code: "AI_QUOTA_EXCEEDED", reason: "quota_exceeded" },
} as const satisfies Record<string, Block>;

async function recordBlocked(
  tx: Tx,
  access: AccessSnapshot,
  p: {
    feature: string;
    channel: AiGatewayChannel;
    billingMode?: AiBillingMode;
  },
  block: Block,
) {
  await tx.insert(aiUsageEvents).values({
    tenantId: access.tenant.tenantId,
    userId: access.userId as UserId,
    outletId: null,
    feature: featureColumn(p.feature),
    channel: dbChannel(p.channel),
    provider: "none",
    model: "none",
    billingMode: p.billingMode ?? "api_metered",
    status: "blocked",
    errorCode: block.code,
  });
}

/**
 * Gate before any model call. Throws `AiError` (AI_FEATURE_DISABLED,
 * AI_PII_BLOCKED, AI_BUDGET_EXCEEDED, AI_QUOTA_EXCEEDED). On success the
 * caller's daily quota has been used by one (atomic, concurrency-safe).
 * `allowOwnData`: the caller asserts the text is about the user's own data, so
 * salary, bank account, NIK and NPWP are not blocked (login codes, phone
 * numbers and e-mail addresses still are).
 */
export async function aiPreflight(
  access: AccessSnapshot,
  p: {
    feature: string;
    channel: AiGatewayChannel;
    text: string;
    allowOwnData?: boolean;
  },
): Promise<{ settings: AiSettingsView }> {
  const now = new Date();
  const outcome = await withTenant(
    db,
    gatewayContext(access),
    async (tx): Promise<{ settings: AiSettingsView } | { block: Block }> => {
      const settings = await readSettings(tx, access);
      const blocked = async (block: Block) => {
        await recordBlocked(tx, access, p, block);
        return { block };
      };
      // Platform lock first: before the tenant switch, PII and any quota use.
      if (await isAiPlatformLocked(tx, access.tenant.tenantId))
        return blocked(BLOCKS.platform);
      if (!settings.aiEnabled || !isFeatureEnabled(settings, p.feature))
        return blocked(BLOCKS.feature);
      const found = scanPii(p.text).found;
      if (found.some((kind) => !(p.allowOwnData && OWN_DATA_PII.has(kind))))
        return blocked(BLOCKS.pii);
      const month = usageMonthOf(now);
      const [held] = await tx
        .select({ reserved: aiUsageMonthly.reservedCostIdr })
        .from(aiUsageMonthly)
        .where(
          and(
            eq(aiUsageMonthly.tenantId, access.tenant.tenantId),
            eq(aiUsageMonthly.usageMonth, month),
          ),
        )
        .limit(1);
      const used =
        (await monthlyUsedIdr(tx, access, month)) + (held?.reserved ?? 0);
      if (
        budgetState(
          used,
          settings.monthlyBudgetIdr,
          settings.budgetWarnPct,
          settings.budgetStopPct,
        ) === "stopped"
      )
        return blocked(BLOCKS.budget);
      const limit = dailyLimitFor(settings, access, p.feature);
      if (limit <= 0) return blocked(BLOCKS.quota);
      // One atomic statement: the conflict update only runs below the limit, and
      // a parallel caller waits on the row lock, then re-checks the limit.
      const [counted] = await tx
        .insert(aiUsageDaily)
        .values({
          tenantId: access.tenant.tenantId,
          userId: access.userId as UserId,
          usageDate: usageDateOf(now),
          requestCount: 1,
        })
        .onConflictDoUpdate({
          target: [
            aiUsageDaily.tenantId,
            aiUsageDaily.userId,
            aiUsageDaily.usageDate,
          ],
          set: {
            requestCount: sql`${aiUsageDaily.requestCount} + 1`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`${aiUsageDaily.requestCount} < ${limit}`,
        })
        .returning({ count: aiUsageDaily.requestCount });
      if (!counted) return blocked(BLOCKS.quota);
      return { settings };
    },
  );
  if ("block" in outcome) throw new AiError(outcome.block.code);
  return outcome;
}

// -------------------------------------------------------------- complete

/** Authorization is pinned to this month even if the provider crosses midnight. */
type AiBudgetReservation = { month: string; amountIdr: number; at: Date };

/**
 * Commit the worst-case cost before any paid I/O. The settings lock serializes
 * authorizations with governance edits; the conditional monthly upsert also
 * arbitrates calls from other API processes. A later budget decrease stops new
 * calls but cannot undo an already authorized or incurred provider charge.
 */
async function reserveAiBudget(
  access: AccessSnapshot,
  request: AiCompletionRequest,
  model: string,
  meta: { feature: string; channel: AiGatewayChannel },
  billingMode: AiBillingMode,
): Promise<AiBudgetReservation> {
  const at = new Date();
  const month = usageMonthOf(at);
  const amountIdr =
    billingMode === "chatgpt_plan"
      ? 0
      : microUsdToIdr(
          costMicroUsd(model, {
            inputTokens: estimateRequestInputTokens(request),
            outputTokens: request.maxTokens,
          }),
        );
  const outcome = await withTenant(
    db,
    gatewayContext(access),
    async (
      tx,
    ): Promise<{ block: Block } | { reservation: AiBudgetReservation }> => {
      const [row] = await tx
        .select()
        .from(aiSettings)
        .where(eq(aiSettings.tenantId, access.tenant.tenantId))
        .for("update");
      const settings = row ? settingsRowToView(row) : defaultAiSettings(access);
      const block = async (reason: Block) => {
        await recordBlocked(tx, access, { ...meta, billingMode }, reason);
        return { block: reason };
      };
      // Operation start is this reservation commit (the provider call follows
      // it), so check under a shared tenant row lock: a lock write waits for
      // this commit, and a check after the lock write sees "locked". Lock
      // order is ai_settings (update) then tenants (share); the lock writers
      // only take the tenants row, so no cycle.
      if (await isAiPlatformLockedShared(tx, access.tenant.tenantId))
        return block(BLOCKS.platform);
      if (!settings.aiEnabled || !isFeatureEnabled(settings, meta.feature))
        return block(BLOCKS.feature);
      const cap = Math.min(
        settings.monthlyBudgetIdr,
        Number(
          (BigInt(settings.monthlyBudgetIdr) * BigInt(settings.budgetStopPct)) /
            100n,
        ),
      );
      if (
        !Number.isSafeInteger(amountIdr) ||
        amountIdr < 0 ||
        (amountIdr === 0 && billingMode !== "chatgpt_plan") ||
        cap <= 0 ||
        amountIdr > cap
      )
        return block(BLOCKS.budget);
      const [reserved] = await tx
        .insert(aiUsageMonthly)
        .values({
          tenantId: access.tenant.tenantId,
          usageMonth: month,
          reservedCostIdr: idr(amountIdr),
        })
        .onConflictDoUpdate({
          target: [aiUsageMonthly.tenantId, aiUsageMonthly.usageMonth],
          set: {
            reservedCostIdr: sql`${aiUsageMonthly.reservedCostIdr} + ${amountIdr}`,
            updatedAt: sql`now()`,
          },
          setWhere:
            billingMode === "chatgpt_plan"
              ? sql`${aiUsageMonthly.costIdr} + ${aiUsageMonthly.reservedCostIdr} < ${cap}`
              : sql`${aiUsageMonthly.costIdr} + ${aiUsageMonthly.reservedCostIdr} + ${amountIdr} <= ${cap}`,
        })
        .returning({ id: aiUsageMonthly.id });
      if (!reserved) {
        const [monthly] = await tx
          .select({
            id: aiUsageMonthly.id,
            costIdr: aiUsageMonthly.costIdr,
            warnedAt: aiUsageMonthly.warnedAt,
          })
          .from(aiUsageMonthly)
          .where(
            and(
              eq(aiUsageMonthly.tenantId, access.tenant.tenantId),
              eq(aiUsageMonthly.usageMonth, month),
            ),
          )
          .limit(1);
        if (monthly)
          await emitBudgetThresholds(
            tx,
            access,
            gatewayContext(access),
            settings,
            monthly,
            month,
            at,
          );
        return block(BLOCKS.budget);
      }
      return { reservation: { month, amountIdr, at } };
    },
  );
  if ("block" in outcome) throw new AiError(outcome.block.code);
  return outcome.reservation;
}

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, AI_OUTBOX_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** Appends one WS-12 event to the outbox in the caller's transaction. */
export async function emitAiEvent(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    name: "ai_budget.threshold_reached" | "ai_settings.updated";
    aggregateId: string;
    idempotencyKey: string;
    actor: { type: "user"; id: string } | { type: "system" };
    payload: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  const definition = aiEvents[input.name];
  const tenantId = context.tenant.tenantId;
  const sequence = await nextSequence(
    tx,
    tenantId,
    definition.entry.aggregateType,
    input.aggregateId,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId,
    outletId: null,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor: input.actor,
    deviceId: null,
    idempotencyKey: input.idempotencyKey,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: AI_OUTBOX_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/** Warn (once: `warned_at`) and stop (once: outbox lookup) events of the month. */
async function emitBudgetThresholds(
  tx: Tx,
  access: AccessSnapshot,
  context: ScopedTenantContext,
  settings: AiSettingsView,
  monthly: { id: string; costIdr: number; warnedAt: Date | null },
  month: string,
  now: Date,
): Promise<void> {
  // A zero budget is permanently "stopped": nothing was crossed, no events.
  if (settings.monthlyBudgetIdr <= 0) return;
  const state = budgetState(
    monthly.costIdr,
    settings.monthlyBudgetIdr,
    settings.budgetWarnPct,
    settings.budgetStopPct,
  );
  if (state === "ok") return;
  const payload = (threshold: "warn" | "stop") => ({
    threshold,
    month,
    usedIdr: monthly.costIdr,
    budgetIdr: settings.monthlyBudgetIdr,
    reachedAt: now.toISOString(),
  });
  if (monthly.warnedAt === null) {
    // The monthly row is locked by this transaction's upsert, so only one
    // caller wins this update.
    const claimed = await tx
      .update(aiUsageMonthly)
      .set({ warnedAt: now })
      .where(
        and(
          eq(aiUsageMonthly.id, monthly.id),
          sql`${aiUsageMonthly.warnedAt} IS NULL`,
        ),
      )
      .returning({ id: aiUsageMonthly.id });
    if (claimed.length > 0)
      await emitAiEvent(tx, context, {
        name: "ai_budget.threshold_reached",
        aggregateId: monthly.id,
        idempotencyKey: `ai_budget.threshold_reached:${monthly.id}:warn`,
        actor: { type: "system" },
        payload: payload("warn"),
        now,
      });
  }
  if (state === "stopped") {
    const [already] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(domainEventOutbox)
      .where(
        and(
          eq(domainEventOutbox.tenantId, access.tenant.tenantId),
          eq(domainEventOutbox.aggregateType, "ai_budget"),
          eq(domainEventOutbox.aggregateId, monthly.id),
          sql`${domainEventOutbox.event} -> 'payload' ->> 'threshold' = 'stop'`,
        ),
      );
    if (Number(already?.n ?? 0) === 0)
      await emitAiEvent(tx, context, {
        name: "ai_budget.threshold_reached",
        aggregateId: monthly.id,
        idempotencyKey: `ai_budget.threshold_reached:${monthly.id}:stop`,
        actor: { type: "system" },
        payload: payload("stop"),
        now,
      });
  }
}

async function recordUsage(
  access: AccessSnapshot,
  meta: {
    feature: string;
    channel: AiGatewayChannel;
    outletId?: string | null;
  },
  outcome:
    | { status: "ok"; result: AiCompletionResult }
    | { status: "error"; errorCode: string },
  // Provider and model that served (or failed) this call, from the tenant's
  // resolution; `null` when no provider was available.
  used: {
    provider: string;
    model: string;
    source: "tenant" | "platform";
    billingMode: AiBillingMode;
  } | null,
  reservation?: AiBudgetReservation,
): Promise<void> {
  const now = reservation?.at ?? new Date();
  const context = gatewayContext(access);
  const ok = outcome.status === "ok";
  const usage = ok ? outcome.result.usage : { inputTokens: 0, outputTokens: 0 };
  const model = ok ? outcome.result.model : (used?.model ?? env.AI_MODEL);
  // A tenant's server names its own model in the answer: price the model the
  // tenant configured, never the name the remote reports.
  const priced = used?.source === "tenant" ? used.model : model;
  // A plan subscription is not an incremental metered API invoice. Actual
  // successful token usage stays in the ledger with its server-owned mode.
  // For failed plan attempts, zero token fields mean unknown, not free usage.
  const micro =
    ok && used?.billingMode !== "chatgpt_plan"
      ? costMicroUsd(priced, usage)
      : 0;
  const month = reservation?.month ?? usageMonthOf(now);
  await withTenant(db, context, async (tx) => {
    await tx.insert(aiUsageEvents).values({
      tenantId: access.tenant.tenantId,
      userId: access.userId as UserId,
      outletId: (meta.outletId ?? null) as OutletId | null,
      feature: featureColumn(meta.feature),
      channel: dbChannel(meta.channel),
      provider: (used?.provider ?? "none").slice(0, 30),
      model: model.slice(0, 100),
      billingMode: used?.billingMode ?? "api_metered",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMicroUsd: micro,
      costIdr: idr(microUsdToIdr(micro)),
      status: outcome.status,
      errorCode: ok ? null : outcome.errorCode,
      createdAt: now,
    });
    if (!ok) return;
    // Cost IDR of the month is recomputed from the micro-USD total (ceil), so
    // per-call rounding never accumulates.
    const [monthly] = await tx
      .insert(aiUsageMonthly)
      .values({
        tenantId: access.tenant.tenantId,
        usageMonth: month,
        costIdr: idr(microUsdToIdr(micro)),
        costMicroUsd: micro,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        requestCount: 1,
      })
      .onConflictDoUpdate({
        target: [aiUsageMonthly.tenantId, aiUsageMonthly.usageMonth],
        set: {
          costMicroUsd: sql`${aiUsageMonthly.costMicroUsd} + ${micro}`,
          costIdr: sql`ceil((${aiUsageMonthly.costMicroUsd} + ${micro})::numeric * ${USD_IDR_RATE} / 1000000)::bigint`,
          reservedCostIdr: sql`${aiUsageMonthly.reservedCostIdr} - ${reservation?.amountIdr ?? 0}`,
          inputTokens: sql`${aiUsageMonthly.inputTokens} + ${usage.inputTokens}`,
          outputTokens: sql`${aiUsageMonthly.outputTokens} + ${usage.outputTokens}`,
          requestCount: sql`${aiUsageMonthly.requestCount} + 1`,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: aiUsageMonthly.id,
        costIdr: aiUsageMonthly.costIdr,
        warnedAt: aiUsageMonthly.warnedAt,
      });
    if (!monthly) return;
    const settings = await readSettings(tx, access);
    await emitBudgetThresholds(
      tx,
      access,
      context,
      settings,
      monthly,
      month,
      now,
    );
  });
}

/**
 * One model call through the configured provider. No provider, a failure or a
 * timeout all become `AiError("AI_PROVIDER_UNAVAILABLE")`; details are logged
 * by error name only (never prompt, answer or tool content). Records usage,
 * cost and the budget threshold events.
 */
export async function aiComplete(
  access: AccessSnapshot,
  req: AiCompletionRequest,
  meta: {
    feature: string;
    channel: AiGatewayChannel;
    outletId?: string | null;
  },
): Promise<AiCompletionResult> {
  // Platform lock first: no provider lookup, no reservation, no paid call.
  const platformLocked = await withTenant(
    db,
    gatewayContext(access),
    async (tx) => {
      if (!(await isAiPlatformLocked(tx, access.tenant.tenantId))) return false;
      await recordBlocked(tx, access, meta, BLOCKS.platform);
      return true;
    },
  );
  if (platformLocked) throw new AiError("AI_PLATFORM_DISABLED");
  // Tenant's own provider first, platform env provider as the fallback. A
  // lookup failure counts as "no provider": never a silent switch to the
  // platform key.
  const resolved = await resolveTenantAiProvider(gatewayContext(access)).catch(
    (error: unknown) => {
      logger.error(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "ai provider resolution failed",
      );
      return null;
    },
  );
  if (!resolved) {
    await recordUsage(
      access,
      meta,
      { status: "error", errorCode: "AI_PROVIDER_UNAVAILABLE" },
      null,
    ).catch(logBookkeepingFailure);
    throw new AiError("AI_PROVIDER_UNAVAILABLE");
  }
  return completeAiAttempt(access, req, meta, resolved);
}

/** Every fallback is a new attempt with its own capabilities and reservation. */
async function completeAiAttempt(
  access: AccessSnapshot,
  req: AiCompletionRequest,
  meta: {
    feature: string;
    channel: AiGatewayChannel;
    outletId?: string | null;
  },
  resolved: ResolvedAiProvider,
): Promise<AiCompletionResult> {
  const { provider } = resolved;
  const used = {
    provider: provider.name,
    model: resolved.model,
    source: resolved.source,
    billingMode: resolved.billingMode,
  };
  const prepared = prepareAiRequest(req, resolved.capabilities);
  // Platform adapters can perform a server-side model fallback. Reserve at
  // the conservative unknown-model rate; tenant models use their configured rate.
  const reservation = await reserveAiBudget(
    access,
    prepared,
    resolved.source === "tenant" ? resolved.model : "unknown",
    meta,
    resolved.billingMode,
  );
  let result: AiCompletionResult;
  try {
    result = await provider.complete(prepared, {
      signal: AbortSignal.timeout(env.AI_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn(
      {
        provider: provider.name,
        errorName: error instanceof Error ? error.name : "unknown",
      },
      "ai provider call failed",
    );
    await recordUsage(
      access,
      meta,
      { status: "error", errorCode: "AI_PROVIDER_UNAVAILABLE" },
      used,
      reservation,
    ).catch(logBookkeepingFailure);
    // Only explicit authentication loss or a local kill/revoke may switch to
    // the tenant's own API key. Ambiguous errors never trigger another call.
    if (
      resolved.billingMode === "chatgpt_plan" &&
      error instanceof ChatgptCodexError &&
      (error.kind === "auth" || error.kind === "disabled")
    ) {
      const fallback = await resolveTenantCustomAiProvider(
        gatewayContext(access),
      ).catch(() => null);
      if (fallback) return completeAiAttempt(access, req, meta, fallback);
    }
    // A timeout, malformed response or transport failure may already be billed.
    // Keep a metered hold; plan quota consumption is unknown on this error.
    throw new AiError("AI_PROVIDER_UNAVAILABLE");
  }
  // The answer is already paid for: a bookkeeping failure is logged, not thrown.
  await recordUsage(
    access,
    meta,
    { status: "ok", result },
    used,
    reservation,
  ).catch(logBookkeepingFailure);
  return result;
}

function logBookkeepingFailure(error: unknown) {
  logger.error(
    { errorName: error instanceof Error ? error.name : "unknown" },
    "ai usage bookkeeping failed",
  );
}

// ------------------------------------------------------------------ cache

/**
 * Cache key: tenant + brand + USER + actual reach (per-outlet permission
 * fingerprint) + sorted permission set + outlet scope + scope string +
 * normalized question + settings version, hashed. The user id is in
 * the key because the permission codes alone do not say WHICH outlets a role
 * reaches: two outlet managers hold the same codes at different outlets, and a
 * caller-passed `outletIds` is client input, never proof of reach. The
 * settings `updatedAt` makes a kill-switch or budget change drop every older
 * answer. Callers must NOT cache answers that used a self-only tool (payslip,
 * profit share, own schedule).
 */
export function aiCacheKey(
  access: AccessSnapshot,
  key: AiCacheKeyInput,
  settingsVersion: string,
  reach: string,
): string {
  const parts = [
    access.tenant.tenantId,
    access.tenant.brandId,
    access.userId,
    access.mfaRequired,
    access.mfaVerified,
    reach,
    [...access.permissions].sort().join(","),
    key.outletIds ? [...key.outletIds].sort().join(",") : "*",
    key.scope,
    key.question.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(),
    settingsVersion,
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * What the caller can reach RIGHT NOW: for the tenant and for each outlet of
 * the tenant, the sorted permission codes the resolver allows there. A user
 * removed from an outlet, or moved to another, gets a different fingerprint, so
 * old answers stop matching. Computed from the snapshot (never from the
 * caller-passed `outletIds`).
 */
async function reachFingerprint(
  tx: Tx,
  access: AccessSnapshot,
): Promise<string> {
  const outletRows = await tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(eq(outlets.tenantId, access.tenant.tenantId))
    .orderBy(outlets.id);
  // Per template role: swapping one role for another at an outlet changes the
  // fingerprint even when the union of permission codes stays the same.
  const roles = [...access.templateKeys].sort().map((templateKey) => {
    const codes = [...access.permissionsVia(templateKey)].sort();
    const at = (target: Parameters<AccessSnapshot["allows"]>[1]) =>
      codes
        .filter((code) => access.allowsVia(templateKey, code, target))
        .join(",");
    return [
      templateKey,
      at({ type: "tenant" }),
      ...outletRows.map((row) => [row.id, at({ type: "outlet", id: row.id })]),
    ];
  });
  // Roles without a template key only show up in the union view.
  const codes = [...access.permissions].sort();
  const union = [
    ["tenant", ...codes.filter((c) => access.allows(c, { type: "tenant" }))],
    ...outletRows.map((row) => [
      row.id,
      ...codes.filter((c) => access.allows(c, { type: "outlet", id: row.id })),
    ]),
  ];
  const reach = { roles, union };
  return createHash("sha256").update(JSON.stringify(reach)).digest("hex");
}

/** `updated_at` of the tenant settings row (microsecond text), or "none". */
async function settingsVersionOf(
  tx: Tx,
  access: AccessSnapshot,
): Promise<string> {
  const [row] = await tx
    .select({ version: sql<string>`${aiSettings.updatedAt}::text` })
    .from(aiSettings)
    .where(eq(aiSettings.tenantId, access.tenant.tenantId))
    .limit(1);
  // A provider change must also drop older cached answers.
  return `${row?.version ?? "none"}|${await aiProviderVersionOf(tx, access.tenant.tenantId)}`;
}

export async function aiCacheGet(
  access: AccessSnapshot,
  key: AiCacheKeyInput,
): Promise<Record<string, unknown> | null> {
  return withTenant(db, gatewayContext(access), async (tx) => {
    const cacheKey = aiCacheKey(
      access,
      key,
      await settingsVersionOf(tx, access),
      await reachFingerprint(tx, access),
    );
    const [row] = await tx
      .select({ response: aiResponseCache.response })
      .from(aiResponseCache)
      .where(
        and(
          eq(aiResponseCache.tenantId, access.tenant.tenantId),
          eq(aiResponseCache.cacheKey, cacheKey),
          gt(aiResponseCache.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    return row?.response ?? null;
  });
}

/** Stores an answer; TTL is clamped to 1..7 days (table check). */
export async function aiCachePut(
  access: AccessSnapshot,
  key: AiCacheKeyInput,
  value: Record<string, unknown>,
  ttlSeconds: number,
): Promise<void> {
  const ttl = Math.min(
    AI_CACHE_MAX_TTL_SECONDS,
    Math.max(1, Math.trunc(ttlSeconds)),
  );
  await withTenant(db, gatewayContext(access), async (tx) => {
    const cacheKey = aiCacheKey(
      access,
      key,
      await settingsVersionOf(tx, access),
      await reachFingerprint(tx, access),
    );
    await tx
      .insert(aiResponseCache)
      .values({
        tenantId: access.tenant.tenantId,
        cacheKey,
        response: value,
        expiresAt:
          sql`now() + make_interval(secs => ${ttl})` as unknown as Date,
      })
      .onConflictDoUpdate({
        target: [aiResponseCache.tenantId, aiResponseCache.cacheKey],
        set: {
          response: value,
          createdAt: sql`now()`,
          expiresAt: sql`now() + make_interval(secs => ${ttl})`,
        },
      });
  });
}
