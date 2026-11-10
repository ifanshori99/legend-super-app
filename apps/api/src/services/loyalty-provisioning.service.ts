// Loyalty provisioning (legend-111j, docs/design/ws08-member-loyalty.md §M7):
// the published consent policy versions every tenant needs before a member
// can grant consent. Runs inside the caller's tenant transaction (tenant
// creation) or its own (backfill). Idempotent, insert-only: an existing
// version is never changed. No program row is created: the program stays
// absent (inactive) until the owner saves it (PUT /api/loyalty/program).

import { createHash } from "node:crypto";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { consentPolicyVersions } from "../db/schema/crm-member.ts";
import { withTenant } from "../db/tenant.ts";
import type { TenantTransaction } from "./accounting-shared.ts";

export const DEFAULT_CONSENT_POLICY_VERSION = "2026-01";
export const DEFAULT_CONSENT_POLICY_PURPOSES = [
  "loyalty",
  "marketing",
  "ai",
] as const;
const DEFAULT_CONSENT_PUBLISHED_AT = new Date("2026-01-01T00:00:00+07:00");

/** Adds the default `2026-01` policy version per purpose that the tenant lacks. */
export async function provisionLoyaltyDefaults(
  tx: TenantTransaction,
  context: ScopedTenantContext,
): Promise<{ policiesInserted: number }> {
  const inserted = await tx
    .insert(consentPolicyVersions)
    .values(
      DEFAULT_CONSENT_POLICY_PURPOSES.map((purpose) => ({
        tenantId: context.tenant.tenantId,
        purpose,
        version: DEFAULT_CONSENT_POLICY_VERSION,
        textHash: createHash("sha256")
          .update(`${purpose}:${DEFAULT_CONSENT_POLICY_VERSION}`)
          .digest("hex"),
        publishedAt: DEFAULT_CONSENT_PUBLISHED_AT,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: consentPolicyVersions.id });
  return { policiesInserted: inserted.length };
}

/** Backfill for one existing tenant (`db/backfill-tenant-defaults.ts`). */
export async function backfillTenantLoyaltyDefaults(
  tenantId: string,
): Promise<{ policiesInserted: number }> {
  const context = establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
  return withTenant(db, context, (tx) => provisionLoyaltyDefaults(tx, context));
}
