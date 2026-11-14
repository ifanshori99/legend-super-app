// Recipient picker for scheduled report emails (WS-11, bead legend-rmvu;
// contract `listReportScheduleRecipientsEndpoint` in
// `@starter/shared/dashboard`). Lists only users who hold an active role
// assignment in the caller's tenant (tenant filtered in SQL, plus RLS through
// `withTenant`). Only user id, name and one role name leave the server: the
// email stays here and is resolved from the user id when a schedule is sent
// (DASH-04).

import {
  decodeCursor,
  encodeCursor,
  type CursorPageQuery,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  reportAcceptsAggregateView,
  reportCatalog,
  reportScheduleRecipientPageSchema,
  type ReportScheduleRecipientPage,
} from "@starter/shared/dashboard";
import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { roleAssignments, roles, user } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";

/**
 * Every permission that opens a report on its own: all of one report's
 * requirements, or the aggregate view for a report that accepts it. A role
 * holding none of these cannot open any report, so its users are no
 * recipients. Coarser than per-report checks on purpose: the server rechecks
 * what a recipient may read when it builds the email.
 */
const recipientPermissionCodes: readonly string[] = [
  ...new Set(
    reportCatalog.flatMap((report) => [
      ...report.requiredPermissions,
      ...(reportAcceptsAggregateView(report) ? ["report.aggregate.view"] : []),
    ]),
  ),
];

export async function listReportScheduleRecipients(
  context: ScopedTenantContext,
  query: CursorPageQuery,
  now = new Date(),
): Promise<ReportScheduleRecipientPage> {
  let after: { name: string; id: string } | undefined;
  if (query.cursor !== undefined) {
    let keys: ReturnType<typeof decodeCursor>;
    try {
      keys = decodeCursor(query.cursor);
    } catch {
      throw new HttpError(422, "VALIDATION_ERROR", "Cursor tidak valid.");
    }
    const [name, id] = keys;
    if (typeof name !== "string" || typeof id !== "string")
      throw new HttpError(422, "VALIDATION_ERROR", "Cursor tidak valid.");
    after = { name, id };
  }
  const tenantId = context.tenant.tenantId;
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({
        userId: user.id,
        name: user.name,
        roleName: sql<string>`min(${roles.name})`,
      })
      .from(roleAssignments)
      .innerJoin(user, eq(user.id, roleAssignments.userId))
      .innerJoin(
        roles,
        and(
          eq(roles.tenantId, roleAssignments.tenantId),
          eq(roles.id, roleAssignments.roleId),
        ),
      )
      .where(
        and(
          eq(roleAssignments.tenantId, tenantId),
          eq(roles.tenantId, tenantId),
          sql`jsonb_exists_any(${roles.permissions}, ${sql.raw("ARRAY[")}${sql.join(
            recipientPermissionCodes.map((code) => sql`${code}`),
            sql`, `,
          )}${sql.raw("]::text[]")})`,
          sql`${roleAssignments.validFrom} <= ${now.toISOString()}::timestamptz`,
          or(
            isNull(roleAssignments.validUntil),
            gt(
              roleAssignments.validUntil,
              sql`${now.toISOString()}::timestamptz`,
            ),
          ),
          // Never offer a suspended account as a recipient.
          or(isNull(user.banned), ne(user.banned, true)),
          after === undefined
            ? sql`TRUE`
            : sql`(${user.name}, ${user.id}) > (${after.name}, ${after.id})`,
        ),
      )
      .groupBy(user.id, user.name)
      .orderBy(asc(user.name), asc(user.id))
      .limit(query.limit + 1),
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return reportScheduleRecipientPageSchema.parse({
    data: page,
    meta: {
      limit: query.limit,
      nextCursor:
        rows.length > page.length && last !== undefined
          ? encodeCursor([last.name, last.userId])
          : null,
    },
  });
}
