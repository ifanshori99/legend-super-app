// Member scope (legend-111j, docs/design/ws08-member-loyalty.md §M4): runs a
// member's request in a tenant-wide transaction whose GUC
// `app.customer_profile_id` narrows member-visible tables (customer_profiles,
// point_ledger, customer_visits, consents) to the member's own profile.

import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { HttpError } from "../lib/http-error";
import type * as schema from "./schema";
import { customerProfiles } from "./schema/crm-member";
import { withTenant } from "./tenant";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type CustomerProfileRow = typeof customerProfiles.$inferSelect;

export type MembershipStatus =
  "pending_verification" | "active" | "suspended" | "closed";

export type MemberScope = {
  /** Tenant-wide outlet scope from `memberTenantContext`. */
  context: ScopedTenantContext;
  tenantId: string;
  /** Better Auth user id (session). */
  userId: string;
  /** Null only for `allow: "signup"` without a profile. */
  customerProfileId: string | null;
  status: MembershipStatus | null;
};

/** Tenant-wide, trusted context for a member request (pattern of
 * `tenantWideContext` in payment-webhook.service.ts). */
export function memberTenantContext(tenantId: string): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId,
    brandId: null,
    source: "webhook",
  });
  return establishScopedTenantContext(tenant, { kind: "tenant" });
}

/** Transaction-local GUC; empty string means no member narrowing. */
export async function setMemberProfileGuc(
  tx: Tx,
  profileId: string | null,
): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('app.customer_profile_id', ${profileId ?? ""}, true)`,
  );
}

export async function withMemberScope<T>(
  database: Database,
  scope: MemberScope,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTenant(database, scope.context, async (tx) => {
    await setMemberProfileGuc(tx, scope.customerProfileId);
    return run(tx);
  });
}

/** Serializes ledger writes and counter updates of one profile. */
export async function withProfileLock(
  tx: Tx,
  tenantId: string,
  profileId: string,
): Promise<CustomerProfileRow> {
  const [row] = await tx
    .select()
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.tenantId, tenantIdSchema.parse(tenantId)),
        eq(customerProfiles.id, profileId),
      ),
    )
    // NO KEY UPDATE: the FK key-share locks of visit and attach inserts do not
    // wait on it, while two balance writers still serialise.
    .for("no key update");
  if (!row)
    throw new HttpError(
      404,
      "CUSTOMER_NOT_FOUND",
      "Pelanggan tidak ditemukan.",
    );
  return row;
}
