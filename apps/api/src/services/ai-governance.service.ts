// AI governance settings and usage summary (WS-12 part G, bead legend-zfi4;
// PRD §3 Fitur 40, AIG-01..04). One settings row per tenant. A PATCH locks the
// row, validates the MERGED result (warn < stop even when only one of them is
// in the payload), then writes the audit row and the `ai_settings.updated`
// event in the same transaction.
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  AI_FEATURE_CODES,
  AI_TOOL_CATALOG,
  budgetState,
  aiToolCallListQuerySchema,
  aiTenantUsageQuerySchema,
  type AiBlockedReason,
  type AiGovernanceSettings,
  type AiGovernanceTool,
  type AiTenantUsage,
  type AiToolCallOutcome,
  type AiToolCallRecord,
  type AiUsageSummary,
  type UpdateAiGovernanceSettings,
} from "@starter/shared/ai";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  ulidToUuid,
  type CursorPage,
  type UserId,
  type z,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { isAiPlatformLocked } from "./ai-platform-lock.ts";
import { aiSettings, aiToolCalls, aiUsageEvents } from "../db/schema/ai.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { resolveTenantAiProvider } from "./ai-provider-config.service.ts";
import {
  dailyLimitFor,
  defaultAiSettings,
  emitAiEvent,
  gatewayContext,
  getAiSettings,
  getAiSettingsRow,
  isFeatureEnabled,
  readDailyCount,
  readMonthlyUsedIdr,
  settingsRowToView,
  usageDateOf,
  usageMonthOf,
  type AiSettingsView,
} from "./ai-gateway.service.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";

const AUDIT_SAFE_FIELDS = [
  "changedFields",
  "aiEnabled",
  "mcpEnabled",
  "dynamicClientRegistrationEnabled",
  "monthlyBudgetIdr",
  "budgetWarnPct",
  "budgetStopPct",
  "disabledToolCodes",
  "mcpRateLimitPerMinute",
  "maxRowsPerResponse",
  "featuresCount",
] as const;

type EditableKey = keyof UpdateAiGovernanceSettings;
const EDITABLE_KEYS: readonly EditableKey[] = [
  "aiEnabled",
  "mcpEnabled",
  "dynamicClientRegistrationEnabled",
  "monthlyBudgetIdr",
  "budgetWarnPct",
  "budgetStopPct",
  "features",
  "disabledToolCodes",
  "mcpRateLimitPerMinute",
  "maxRowsPerResponse",
];

function toGovernance(
  view: AiSettingsView,
  updatedAt: Date,
  updatedBy: string,
  platformLocked: boolean,
): AiGovernanceSettings {
  return {
    ...view,
    platformLocked,
    updatedAt: updatedAt.toISOString(),
    updatedBy: updatedBy as UserId,
  } as AiGovernanceSettings;
}

/** Settings of the tenant, or the fail-closed defaults when none are saved. */
export async function getGovernanceSettings(
  access: AccessSnapshot,
): Promise<AiGovernanceSettings> {
  return withTenant(db, gatewayContext(access), async (tx) => {
    const row = await getAiSettingsRow(tx, access);
    const locked = await isAiPlatformLocked(tx, access.tenant.tenantId);
    return row
      ? toGovernance(
          settingsRowToView(row),
          row.updatedAt,
          row.updatedBy,
          locked,
        )
      : toGovernance(
          defaultAiSettings(access),
          new Date(0),
          access.userId,
          locked,
        );
  });
}

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export async function updateGovernanceSettings(
  access: AccessSnapshot,
  patch: UpdateAiGovernanceSettings,
): Promise<AiGovernanceSettings> {
  const context = gatewayContext(access);
  const now = new Date();
  return withTenant(db, context, async (tx) => {
    const defaults = defaultAiSettings(access);
    await tx
      .insert(aiSettings)
      .values({
        tenantId: access.tenant.tenantId,
        updatedBy: access.userId as UserId,
      })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(aiSettings)
      .where(eq(aiSettings.tenantId, access.tenant.tenantId))
      .for("update");
    if (!row) throw new Error("ai_settings row missing after insert");
    const before = settingsRowToView(row);
    const merged: AiSettingsView = { ...defaults, ...before, ...patch };
    if (merged.budgetWarnPct >= merged.budgetStopPct)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "budgetWarnPct must be lower than budgetStopPct.",
      );
    const changed = EDITABLE_KEYS.filter(
      (key) => key in patch && !sameJson(before[key], merged[key]),
    );
    if (changed.length === 0)
      return toGovernance(
        before,
        row.updatedAt,
        row.updatedBy,
        await isAiPlatformLocked(tx, access.tenant.tenantId),
      );
    const [saved] = await tx
      .update(aiSettings)
      .set({
        aiEnabled: merged.aiEnabled,
        mcpEnabled: merged.mcpEnabled,
        dynamicClientRegistrationEnabled:
          merged.dynamicClientRegistrationEnabled,
        monthlyBudgetIdr: merged.monthlyBudgetIdr,
        budgetWarnPct: merged.budgetWarnPct,
        budgetStopPct: merged.budgetStopPct,
        features: merged.features,
        disabledToolCodes: merged.disabledToolCodes,
        mcpRateLimitPerMinute: merged.mcpRateLimitPerMinute,
        maxRowsPerResponse: merged.maxRowsPerResponse,
        updatedBy: access.userId as UserId,
        updatedAt: now,
      })
      .where(eq(aiSettings.id, row.id))
      .returning();
    if (!saved) throw new Error("ai_settings update returned no row");
    const snapshot = (view: AiSettingsView) => ({
      changedFields: changed,
      ...Object.fromEntries(
        changed
          .filter((key) => key !== "features")
          .map((key) => [key, view[key]]),
      ),
      ...(changed.includes("features")
        ? { featuresCount: view.features.length }
        : {}),
    });
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: access.tenant.tenantId,
        outletId: null,
        actorType: "user",
        actorId: access.userId,
        deviceId: null,
        action: "ai_settings.updated",
        objectType: "ai_settings",
        objectId: row.id,
        reason: null,
        maskedChanges: { before: snapshot(before), after: snapshot(merged) },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      AUDIT_SAFE_FIELDS,
    );
    await emitAiEvent(tx, context, {
      name: "ai_settings.updated",
      aggregateId: row.id,
      idempotencyKey: `ai_settings.updated:${row.id}:${now.getTime()}`,
      actor: { type: "user", id: access.userId },
      payload: {
        changedFields: changed,
        updatedBy: access.userId,
        updatedAt: now.toISOString(),
      },
      now,
    });
    return toGovernance(
      settingsRowToView(saved),
      saved.updatedAt,
      saved.updatedBy,
      await isAiPlatformLocked(tx, access.tenant.tenantId),
    );
  });
}

/**
 * Caller's quota per feature today; tenant budget only with
 * `ai.governance.manage` (tenant-wide spend is not for every user). The quota
 * counter is per user per day across features, so `usedToday` is that total.
 */
export async function getUsageSummary(
  access: AccessSnapshot,
): Promise<AiUsageSummary> {
  const now = new Date();
  const month = usageMonthOf(now);
  // Tenant-wide spend needs the permission at the tenant target, like the
  // /governance routes (requireTenantPermission); `permissions` is the flat
  // union over every scope, so an outlet or station grant would pass it
  // (legend-cot3).
  const canSeeBudget = access.allows("ai.governance.manage", {
    type: "tenant",
  });
  const providerAvailable =
    (await resolveTenantAiProvider(gatewayContext(access)).catch(
      () => null,
    )) !== null;
  return withTenant(db, gatewayContext(access), async (tx) => {
    const row = await getAiSettingsRow(tx, access);
    const settings = row ? settingsRowToView(row) : defaultAiSettings(access);
    const usedToday = await readDailyCount(tx, access, usageDateOf(now));
    const usedIdr = canSeeBudget
      ? await readMonthlyUsedIdr(tx, access, month)
      : 0;
    return {
      aiEnabled: settings.aiEnabled,
      platformLocked: await isAiPlatformLocked(tx, access.tenant.tenantId),
      providerAvailable,
      month,
      features: AI_FEATURE_CODES.map((feature) => ({
        feature,
        isEnabled: settings.aiEnabled && isFeatureEnabled(settings, feature),
        dailyLimit: dailyLimitFor(settings, access, feature),
        usedToday,
      })),
      budget: canSeeBudget
        ? {
            monthlyBudgetIdr: settings.monthlyBudgetIdr,
            usedIdr: usedIdr as AiSettingsView["monthlyBudgetIdr"],
            warnPct: settings.budgetWarnPct,
            stopPct: settings.budgetStopPct,
            state: budgetState(
              usedIdr,
              settings.monthlyBudgetIdr,
              settings.budgetWarnPct,
              settings.budgetStopPct,
            ),
          }
        : null,
    };
  });
}

// ------------------------------------------------- tools, tenant usage, audit

/** Every catalog tool with its kill-switch state (ai.governance.manage). */
export async function listGovernanceTools(
  access: AccessSnapshot,
): Promise<AiGovernanceTool[]> {
  const settings = await getAiSettings(access);
  const disabled = new Set<string>(settings.disabledToolCodes);
  return AI_TOOL_CATALOG.map((tool) => ({
    code: tool.code,
    name: tool.name,
    kind: tool.kind,
    titleId: tool.titleId,
    description: tool.description,
    scope: tool.scope,
    mcpAnnotations: tool.mcpAnnotations,
    isEnabled: !disabled.has(tool.code),
  }));
}

const BLOCK_REASON_BY_CODE: Record<string, AiBlockedReason> = {
  AI_QUOTA_EXCEEDED: "quota_exceeded",
  AI_BUDGET_EXCEEDED: "budget_exceeded",
  AI_FEATURE_DISABLED: "feature_disabled",
  AI_PLATFORM_DISABLED: "feature_disabled",
  AI_PII_BLOCKED: "pii_blocked",
  AI_TOOL_DISABLED: "tool_disabled",
  AI_TOOL_FORBIDDEN: "permission_denied",
};

/** Month window in the business time zone (Asia/Jakarta, D-CORE-6). */
function monthWindow(month: string): { start: SQL; end: SQL } {
  const first = sql`(${month} || '-01')::date`;
  return {
    start: sql`(${first})::timestamp AT TIME ZONE 'Asia/Jakarta'`,
    end: sql`((${first}) + interval '1 month')::timestamp AT TIME ZONE 'Asia/Jakarta'`,
  };
}

/** Tenant-wide usage and spend of a month (AIG-02), no prompt or answer content. */
export async function getTenantUsage(
  access: AccessSnapshot,
  query: z.infer<typeof aiTenantUsageQuerySchema>,
): Promise<AiTenantUsage> {
  const month = query.month ?? usageMonthOf(new Date());
  const window = monthWindow(month);
  const tenantId = access.tenant.tenantId;
  return withTenant(db, gatewayContext(access), async (tx) => {
    const row = await getAiSettingsRow(tx, access);
    const settings = row ? settingsRowToView(row) : defaultAiSettings(access);
    const usedIdr = await readMonthlyUsedIdr(tx, access, month);
    const inMonth = and(
      eq(aiUsageEvents.tenantId, tenantId),
      sql`${aiUsageEvents.createdAt} >= ${window.start}`,
      sql`${aiUsageEvents.createdAt} < ${window.end}`,
    );
    const features = await tx
      .select({
        feature: aiUsageEvents.feature,
        jobs: sql<number>`count(*) FILTER (WHERE ${aiUsageEvents.status} = 'ok')::int`,
        blockedJobs: sql<number>`count(*) FILTER (WHERE ${aiUsageEvents.status} = 'blocked')::int`,
        tokensIn: sql<number>`coalesce(sum(${aiUsageEvents.inputTokens}), 0)::bigint`,
        tokensOut: sql<number>`coalesce(sum(${aiUsageEvents.outputTokens}), 0)::bigint`,
        costIdr: sql<number>`coalesce(sum(${aiUsageEvents.costIdr}), 0)::bigint`,
      })
      .from(aiUsageEvents)
      .where(and(inMonth, sql`${aiUsageEvents.feature} IS NOT NULL`))
      .groupBy(aiUsageEvents.feature)
      .orderBy(aiUsageEvents.feature);
    const blocked = await tx
      .select({
        code: aiUsageEvents.errorCode,
        count: sql<number>`count(*)::int`,
      })
      .from(aiUsageEvents)
      .where(and(inMonth, eq(aiUsageEvents.status, "blocked")))
      .groupBy(aiUsageEvents.errorCode);
    const inMonthCalls = and(
      eq(aiToolCalls.tenantId, tenantId),
      sql`${aiToolCalls.createdAt} >= ${window.start}`,
      sql`${aiToolCalls.createdAt} < ${window.end}`,
    );
    const toolBlocked = await tx
      .select({
        code: aiToolCalls.errorCode,
        count: sql<number>`count(*)::int`,
      })
      .from(aiToolCalls)
      .where(
        and(
          inMonthCalls,
          sql`${aiToolCalls.errorCode} IN ('AI_TOOL_DISABLED', 'AI_TOOL_FORBIDDEN')`,
        ),
      )
      .groupBy(aiToolCalls.errorCode);
    const [mcp] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(aiToolCalls)
      .where(and(inMonthCalls, eq(aiToolCalls.channel, "mcp")));
    const byReason = new Map<AiBlockedReason, number>();
    for (const { code, count } of [...blocked, ...toolBlocked]) {
      const reason = code ? BLOCK_REASON_BY_CODE[code] : undefined;
      if (reason) byReason.set(reason, (byReason.get(reason) ?? 0) + count);
    }
    return {
      month,
      budget: {
        monthlyBudgetIdr: settings.monthlyBudgetIdr,
        usedIdr: usedIdr as AiSettingsView["monthlyBudgetIdr"],
        warnPct: settings.budgetWarnPct,
        stopPct: settings.budgetStopPct,
        state: budgetState(
          usedIdr,
          settings.monthlyBudgetIdr,
          settings.budgetWarnPct,
          settings.budgetStopPct,
        ),
      },
      byFeature: features.flatMap((f) =>
        (AI_FEATURE_CODES as readonly string[]).includes(f.feature ?? "")
          ? [
              {
                feature: f.feature as (typeof AI_FEATURE_CODES)[number],
                jobs: f.jobs,
                blockedJobs: f.blockedJobs,
                tokensIn: Number(f.tokensIn),
                tokensOut: Number(f.tokensOut),
                costIdr: Number(
                  f.costIdr,
                ) as AiSettingsView["monthlyBudgetIdr"],
              },
            ]
          : [],
      ),
      blockedByReason: [...byReason].map(([reason, count]) => ({
        reason,
        count,
      })),
      mcpToolCalls: mcp?.n ?? 0,
    };
  });
}

const OUTCOME_CODES = {
  disabled: "AI_TOOL_DISABLED",
  rate_limited: "MCP_RATE_LIMITED",
};

/** `ai_tool_calls` stores ok/denied/error; the two extra outcomes ride on the error code. */
function outcomeOf(
  status: string,
  errorCode: string | null,
): AiToolCallOutcome {
  if (errorCode === OUTCOME_CODES.disabled) return "disabled";
  if (errorCode === OUTCOME_CODES.rate_limited) return "rate_limited";
  return status as AiToolCallOutcome;
}

function outcomeFilter(outcome: AiToolCallOutcome): SQL {
  const special = sql`${aiToolCalls.errorCode} IN ('AI_TOOL_DISABLED', 'MCP_RATE_LIMITED')`;
  if (outcome === "disabled")
    return sql`${aiToolCalls.errorCode} = ${OUTCOME_CODES.disabled}`;
  if (outcome === "rate_limited")
    return sql`${aiToolCalls.errorCode} = ${OUTCOME_CODES.rate_limited}`;
  return sql`${aiToolCalls.status} = ${outcome} AND NOT coalesce(${special}, false)`;
}

/** Params as scalars only (the wire contract); nested values are stringified. */
function flattenParams(
  params: Record<string, unknown>,
): AiToolCallRecord["redactedParams"] {
  const out: AiToolCallRecord["redactedParams"] = {};
  for (const [key, value] of Object.entries(params)) {
    if (key.length < 1 || key.length > 60) continue;
    out[key] =
      value === null || typeof value === "number" || typeof value === "boolean"
        ? (value as number | boolean | null)
        : typeof value === "string"
          ? value.slice(0, 200)
          : JSON.stringify(value).slice(0, 200);
  }
  return out;
}

/** Audit list of tool calls, newest first, no content (MCP-03, AIG-02). */
export async function listToolCalls(
  access: AccessSnapshot,
  query: z.infer<typeof aiToolCallListQuerySchema>,
): Promise<CursorPage<AiToolCallRecord>> {
  const tenantId = access.tenant.tenantId;
  const conditions: (SQL | undefined)[] = [eq(aiToolCalls.tenantId, tenantId)];
  if (query.channel) conditions.push(eq(aiToolCalls.channel, query.channel));
  if (query.toolCode) conditions.push(eq(aiToolCalls.toolCode, query.toolCode));
  if (query.mcpClientId)
    conditions.push(eq(aiToolCalls.mcpClientId, query.mcpClientId));
  if (query.userId)
    conditions.push(eq(aiToolCalls.userId, query.userId as UserId));
  if (query.outcome) conditions.push(outcomeFilter(query.outcome));
  if (query.cursor) {
    let keys: ReturnType<typeof decodeCursor>;
    try {
      keys = decodeCursor(query.cursor);
      if (
        keys.length !== 2 ||
        typeof keys[0] !== "string" ||
        typeof keys[1] !== "string"
      )
        throw new RangeError("Invalid cursor");
      conditions.push(
        sql`(${aiToolCalls.createdAt}, ${aiToolCalls.id}) < (${keys[0]}::timestamptz, ${ulidToUuid(keys[1])}::uuid)`,
      );
    } catch {
      throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
    }
  }
  const rows = await withTenant(db, gatewayContext(access), (tx) =>
    tx
      .select({
        row: aiToolCalls,
        createdAtText: sql<string>`${aiToolCalls.createdAt}::text`,
      })
      .from(aiToolCalls)
      .where(and(...conditions))
      .orderBy(desc(aiToolCalls.createdAt), desc(aiToolCalls.id))
      .limit(query.limit + 1),
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map(({ row }) => ({
      id: row.id as AiToolCallRecord["id"],
      tenantId: row.tenantId,
      outletId: row.outletId,
      userId: row.userId,
      channel: row.channel as AiToolCallRecord["channel"],
      mcpClientId: row.mcpClientId as AiToolCallRecord["mcpClientId"],
      mcpTokenId: row.mcpTokenId as AiToolCallRecord["mcpTokenId"],
      toolCode: row.toolCode as AiToolCallRecord["toolCode"],
      redactedParams: flattenParams(row.params),
      outcome: outcomeOf(row.status, row.errorCode),
      rowCount: row.rowCount ?? 0,
      actionRequestId: null,
      durationMs: row.durationMs ?? 0,
      occurredAt: row.createdAt.toISOString(),
    })),
    meta: {
      limit: query.limit,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor([last.createdAtText, last.row.id])
          : null,
    },
  };
}
