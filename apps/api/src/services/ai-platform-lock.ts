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

export async function assertAiPlatformUnlocked(
  executor: LockExecutor,
  tenantId: string,
): Promise<void> {
  if (await isAiPlatformLocked(executor, tenantId))
    throw new AiError("AI_PLATFORM_DISABLED");
}
