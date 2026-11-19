// Platform-only reads of the tenant chosen by the path, never host/session
// tenant data. Active registry grants are rechecked here as defense in depth.
import {
  and,
  asc,
  eq,
  gt,
  ilike,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { maskEmail } from "@starter/shared/identity";
import {
  platformTenantDetailSchema,
  searchTenantAccountsQuerySchema,
  tenantAccountSummarySchema,
  tenantOwnerSummarySchema,
  type PlatformTenantDetail,
  type SearchTenantAccountsQuery,
  type TenantAccountSummary,
  type TenantOwnerSummary,
} from "@starter/shared/platform";
import { db } from "../db/index.ts";
import {
  platformAdmins,
  roleAssignments,
  roles,
  user,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createFixedWindowCounter } from "../lib/fixed-window-counter.ts";
import { HttpError } from "../lib/http-error.ts";
import { SYSTEM_ACCOUNT_ID } from "../lib/system-account.ts";
import { recordAudit } from "./audit-writer.ts";
import type { Tx } from "./permission-resolver.ts";
import { getTenantOrThrow } from "./platform-org.service.ts";
import {
  assertTenantExists,
  isPlatformAdmin,
  platformTenantContext,
} from "./platform-support.service.ts";

type DirectoryRequest = {
  tenantId: string;
  actorUserId: string;
  impersonatedBy: string | null;
};

// Per actor across sessions and target tenants: changing either cannot bypass
// the cap. The shared counter sweeps expired keys and bounds total entries.
const accountSearchLimit = createFixedWindowCounter({
  limit: 30,
  windowMs: 60_000,
  capacity: 10_000,
});

export class TenantAccountSearchRateLimitError extends HttpError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      429,
      "RATE_LIMITED",
      "Terlalu banyak pencarian akun. Coba lagi sebentar.",
    );
  }
}

async function authorizeAny(request: DirectoryRequest) {
  if (
    request.impersonatedBy !== null ||
    !(await isPlatformAdmin(request.actorUserId))
  )
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Your account cannot perform this action.",
    );
  await assertTenantExists(request.tenantId);
  return platformTenantContext(request.tenantId);
}

async function auditRead(
  tx: Tx,
  context: ScopedTenantContext,
  request: DirectoryRequest,
  action: string,
  after: Record<string, unknown>,
) {
  await recordAudit(
    {
      tenantId: request.tenantId,
      outletId: null,
      actorType: "user",
      actorId: request.actorUserId,
      deviceId: null,
      action,
      objectType: "tenant",
      objectId: request.tenantId,
      reason: "Pembacaan direktori tenant melalui Panel Platform.",
      before: null,
      after,
      sensitiveAccess: true,
    },
    { tx, context },
  );
}

async function ownerSummaries(
  tx: Tx,
  tenantId: string,
): Promise<TenantOwnerSummary[]> {
  const rows = await tx
    .select({
      assignmentId: roleAssignments.id,
      userId: user.id,
      name: user.name,
      email: user.email,
      assignedAt: roleAssignments.assignedAt,
    })
    .from(roleAssignments)
    .innerJoin(
      roles,
      and(eq(roles.id, roleAssignments.roleId), eq(roles.tenantId, tenantId)),
    )
    .innerJoin(user, eq(user.id, roleAssignments.userId))
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        eq(roles.templateKey, "owner"),
        eq(roleAssignments.scopeType, "tenant"),
        // DB clock, the one that stamps valid_from/valid_until (bead 1201).
        lte(roleAssignments.validFrom, sql`statement_timestamp()`),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, sql`statement_timestamp()`),
        ),
      ),
    )
    .orderBy(asc(roleAssignments.assignedAt), asc(roleAssignments.id));
  return rows.map((row) =>
    tenantOwnerSummarySchema.parse({
      ...row,
      email: maskEmail(row.email),
      assignedAt: row.assignedAt.toISOString(),
    }),
  );
}

export async function listTenantOwnersAny(
  request: DirectoryRequest,
): Promise<{ data: TenantOwnerSummary[] }> {
  const context = await authorizeAny(request);
  return withTenant(db, context, async (tx) => {
    const data = await ownerSummaries(tx, request.tenantId);
    await auditRead(tx, context, request, "platform.tenant_owners.read", {
      resultCount: data.length,
    });
    return { data };
  });
}

export async function getPlatformTenantDetailAny(
  request: DirectoryRequest,
): Promise<PlatformTenantDetail> {
  const context = await authorizeAny(request);
  const tenant = await getTenantOrThrow(request.tenantId);
  return withTenant(db, context, async (tx) => {
    const owners = await ownerSummaries(tx, request.tenantId);
    await auditRead(tx, context, request, "platform.tenant_detail.read", {
      ownerCount: owners.length,
    });
    return platformTenantDetailSchema.parse({ ...tenant, owners });
  });
}

export async function searchTenantAccountsAny(
  request: DirectoryRequest & { query: SearchTenantAccountsQuery },
): Promise<{ data: TenantAccountSummary[] }> {
  const context = await authorizeAny(request);
  const query = searchTenantAccountsQuerySchema.parse(request.query);
  const now = new Date();
  const retryAfter = accountSearchLimit.take(
    request.actorUserId,
    now.getTime(),
  );
  // Audit even a throttled search, and commit that row before sending 429.
  if (retryAfter !== null) {
    await withTenant(db, context, (tx) =>
      auditRead(tx, context, request, "platform.tenant_accounts.search", {
        queryLength: query.q.length,
        limit: query.limit,
        resultCount: 0,
        outcome: "rate_limited",
      }),
    );
    throw new TenantAccountSearchRateLimitError(retryAfter);
  }
  const pattern = `%${query.q.replaceAll(/[%_\\]/g, "\\$&")}%`;
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .selectDistinct({ userId: user.id, name: user.name, email: user.email })
      .from(roleAssignments)
      .innerJoin(user, eq(user.id, roleAssignments.userId))
      .where(
        and(
          eq(roleAssignments.tenantId, request.tenantId),
          lte(roleAssignments.validFrom, sql`statement_timestamp()`),
          or(
            isNull(roleAssignments.validUntil),
            gt(roleAssignments.validUntil, sql`statement_timestamp()`),
          ),
          ne(user.id, SYSTEM_ACCOUNT_ID),
          ne(user.id, request.actorUserId),
          or(
            isNull(user.banned),
            eq(user.banned, false),
            lte(user.banExpires, now),
          ),
          notExists(
            tx
              .select({ id: platformAdmins.id })
              .from(platformAdmins)
              .where(
                and(
                  eq(platformAdmins.userId, user.id),
                  isNull(platformAdmins.revokedAt),
                ),
              ),
          ),
          or(ilike(user.name, pattern), ilike(user.email, pattern)),
        ),
      )
      .orderBy(asc(user.name), asc(user.id), asc(user.email))
      .limit(query.limit);
    const data = rows.map((row) =>
      tenantAccountSummarySchema.parse({ ...row, email: maskEmail(row.email) }),
    );
    // Search text can itself contain PII. Persist only bounded metadata.
    await auditRead(tx, context, request, "platform.tenant_accounts.search", {
      queryLength: query.q.length,
      limit: query.limit,
      resultCount: data.length,
      outcome: "allowed",
    });
    return { data };
  });
}
