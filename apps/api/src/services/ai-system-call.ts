// Model call for worker jobs (WS-12 wave 3, part A; AI-10 daily summary).
//
// The gateway's `aiPreflight` is built for a user request: it also spends the
// caller's daily quota. A scheduled job has no caller, so this applies the
// same tenant kill switch, feature switch, PII scan and monthly budget stop,
// skips the per-user quota, then calls `aiComplete` for the provider call and
// the usage, cost and budget-event bookkeeping. `ai_usage_events.user_id` is
// NOT NULL, so the job passes the snapshot of a real user who receives the
// result (the "billing" user); their quota is never touched.
//
// Never throws for an AI reason: `ok: false` means "use the deterministic
// fallback". A blocked call writes the same `blocked` ledger row as the
// gateway. Nothing here logs prompt or answer content.
import { AiError, budgetState } from "@starter/shared/ai";
import type { OutletId, UserId } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { aiUsageEvents } from "../db/schema/ai.ts";
import { withTenant } from "../db/tenant.ts";
import { scanPii } from "../lib/ai/pii.ts";
import type {
  AiCompletionRequest,
  AiCompletionResult,
} from "../lib/ai/types.ts";
import { logger } from "../lib/logger.ts";
import {
  aiComplete,
  gatewayContext,
  getAiSettings,
  isFeatureEnabled,
  readMonthlyUsedIdr,
  usageMonthOf,
} from "./ai-gateway.service.ts";
import { isAiPlatformLocked } from "./ai-platform-lock.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";

export type SystemAiSkipReason =
  | "feature_disabled"
  | "platform_locked"
  | "pii_blocked"
  | "budget_exceeded"
  | "provider_unavailable";

export type SystemAiOutcome =
  | { ok: true; result: AiCompletionResult }
  | { ok: false; reason: SystemAiSkipReason };

const BLOCK_CODES = {
  feature_disabled: "AI_FEATURE_DISABLED",
  platform_locked: "AI_PLATFORM_DISABLED",
  pii_blocked: "AI_PII_BLOCKED",
  budget_exceeded: "AI_BUDGET_EXCEEDED",
} as const;

/** Same ledger row as the gateway's `recordBlocked` (status `blocked`). */
async function recordBlocked(
  billing: AccessSnapshot,
  meta: { feature: string; outletId: string | null },
  reason: keyof typeof BLOCK_CODES,
): Promise<SystemAiOutcome> {
  await withTenant(db, gatewayContext(billing), (tx) =>
    tx.insert(aiUsageEvents).values({
      tenantId: billing.tenant.tenantId,
      userId: billing.userId as UserId,
      outletId: meta.outletId as OutletId | null,
      feature: /^AI-\d{2}$/.test(meta.feature) ? meta.feature : null,
      channel: "tanya_ai",
      provider: "none",
      model: "none",
      status: "blocked",
      errorCode: BLOCK_CODES[reason],
    }),
  ).catch((error: unknown) =>
    logger.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "ai usage bookkeeping failed",
    ),
  );
  return { ok: false, reason };
}

function requestText(req: AiCompletionRequest): string {
  const parts = [req.system];
  for (const message of req.messages)
    for (const block of message.content)
      if (block.type === "text") parts.push(block.text);
      else if (block.type === "tool_result") parts.push(block.content);
  return parts.join("\n");
}

export async function systemAiComplete(
  billing: AccessSnapshot,
  req: AiCompletionRequest,
  meta: { feature: string; outletId: string | null },
  now: Date = new Date(),
): Promise<SystemAiOutcome> {
  const platformLocked = await withTenant(db, gatewayContext(billing), (tx) =>
    isAiPlatformLocked(tx, billing.tenant.tenantId),
  );
  if (platformLocked) return recordBlocked(billing, meta, "platform_locked");
  const settings = await getAiSettings(billing);
  if (!settings.aiEnabled || !isFeatureEnabled(settings, meta.feature))
    return recordBlocked(billing, meta, "feature_disabled");
  if (scanPii(requestText(req)).found.length > 0)
    return recordBlocked(billing, meta, "pii_blocked");
  const used = await withTenant(db, gatewayContext(billing), (tx) =>
    readMonthlyUsedIdr(tx, billing, usageMonthOf(now)),
  );
  if (
    budgetState(
      used,
      settings.monthlyBudgetIdr,
      settings.budgetWarnPct,
      settings.budgetStopPct,
    ) === "stopped"
  )
    return recordBlocked(billing, meta, "budget_exceeded");
  try {
    const result = await aiComplete(billing, req, {
      feature: meta.feature,
      channel: "tanya_ai",
      outletId: meta.outletId,
    });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof AiError) {
      // The lock can commit between the plain check above and the
      // reservation's FOR SHARE check inside `aiComplete`.
      if (error.code === "AI_PLATFORM_DISABLED")
        return recordBlocked(billing, meta, "platform_locked");
      return { ok: false, reason: "provider_unavailable" };
    }
    logger.warn(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "system ai call failed",
    );
    return { ok: false, reason: "provider_unavailable" };
  }
}
