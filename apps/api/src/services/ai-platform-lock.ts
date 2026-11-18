// Platform lock for tenant AI (founder W16 Q7). The platform turns AI off for a
// tenant by removing the `ai_assistant` module from its feature flags. Fail
// closed: a missing tenant row, missing flags, or malformed JSON all mean
// locked (same rule as `isModuleEnabled`). Write and use paths call
// `assertAiPlatformUnlocked`; credential removal and reads stay open.

import { eq } from "drizzle-orm";
import { AiError } from "@starter/shared/ai";
import { isModuleEnabled } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { tenants } from "../db/schema/index.ts";

/** The pool or a transaction; only `select` is needed. */
type LockExecutor = Pick<typeof db, "select">;

export async function isAiPlatformLocked(
  executor: LockExecutor,
  tenantId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return !isModuleEnabled(row?.featureFlags ?? null, "ai_assistant");
}

/**
 * Same check, but takes a shared row lock on the tenant row (`FOR SHARE`) that
 * lasts until the caller's transaction ends. A lock write (`UPDATE tenants`)
 * needs the exclusive row lock, so it waits for every operation that checked
 * under this lock to commit, and every operation that checks after the lock
 * write committed sees "locked". Call it inside the same transaction that
 * starts the operation (reserve budget, execute an approved action).
 */
export async function isAiPlatformLockedShared(
  executor: LockExecutor,
  tenantId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .for("share");
  return !isModuleEnabled(row?.featureFlags ?? null, "ai_assistant");
}

/**
 * 981 / legend-hbuq3: the `mcp` module (tenants.feature_flags) gates every MCP
 * path (bearer endpoint, OAuth, consent, admin). Same fail-closed rule as
 * `isModuleEnabled`. Callers answer exactly as for an unknown tenant or token,
 * never naming the module or the flag. Tanya AI is not affected.
 */
export async function isMcpModuleDisabled(
  executor: LockExecutor,
  tenantId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return !isModuleEnabled(row?.featureFlags ?? null, "mcp");
}

export async function assertAiPlatformUnlockedShared(
  executor: LockExecutor,
  tenantId: string,
): Promise<void> {
  if (await isAiPlatformLockedShared(executor, tenantId))
    throw new AiError("AI_PLATFORM_DISABLED");
}

export async function assertAiPlatformUnlocked(
  executor: LockExecutor,
  tenantId: string,
): Promise<void> {
  if (await isAiPlatformLocked(executor, tenantId))
    throw new AiError("AI_PLATFORM_DISABLED");
}
