// Profit-share recipient reconciliation (bead legend-9t04v, Codex finding 405).
// Migration 0239 cannot know who received a pre-snapshot distribution line, so
// it flags the lines whose shareholder has a login today as
// `recipient_unverified` (recipient_user_id stays NULL). No shareholder login
// reads such a line. Only a tenant Owner lists them here and assigns the
// recipient (a login, or null for "no login"), once; the audit row records it.
import {
  distributionLineIdSchema,
  unverifiedRecipientLineSchema,
  type ResolveUnverifiedRecipientInput,
  type ResolveUnverifiedRecipientResult,
  type UnverifiedRecipientLine,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { db } from "../db";
import {
  distributionLines,
  distributionRuns,
  roleAssignments,
  roles,
  shareholders,
} from "../db/schema";
import { user } from "../db/schema/user";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import type { TenantTransaction } from "./accounting-shared";
import { recordAudit } from "./audit-writer";

/** Owner = an 'owner' role assignment at tenant scope that is valid now. */
export async function assertTenantOwner(
  tx: TenantTransaction,
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  const now = new Date();
  const rows = await tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
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
        eq(roleAssignments.userId, actorUserId),
        eq(roles.templateKey, "owner"),
        eq(roleAssignments.scopeType, "tenant"),
        lte(roleAssignments.validFrom, now),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, now),
        ),
      ),
    )
    .limit(1);
  if (rows.length === 0)
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Hanya Owner yang dapat merekonsiliasi penerima bagi hasil.",
    );
}

const lineNotFound = () =>
  new HttpError(
    404,
    "NOT_FOUND",
    "Baris distribusi tidak ditemukan atau sudah direkonsiliasi.",
  );

/** Owner only: lines still waiting for a recipient decision. */
export async function listUnverifiedRecipientLinesService(
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<UnverifiedRecipientLine[]> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await assertTenantOwner(tx, tenantId, actorUserId);
    const rows = await tx
      .select({
        lineId: distributionLines.id,
        runId: distributionLines.distributionRunId,
        profitEntityId: distributionRuns.profitEntityId,
        shareholderId: distributionLines.shareholderId,
        shareholderName: shareholders.name,
        netIdr: distributionLines.netIdr,
        paymentStatus: distributionLines.paymentStatus,
        paidAt: distributionLines.paidAt,
      })
      .from(distributionLines)
      .innerJoin(
        distributionRuns,
        and(
          eq(distributionRuns.tenantId, distributionLines.tenantId),
          eq(distributionRuns.id, distributionLines.distributionRunId),
        ),
      )
      .innerJoin(
        shareholders,
        and(
          eq(shareholders.tenantId, distributionLines.tenantId),
          eq(shareholders.id, distributionLines.shareholderId),
        ),
      )
      .where(
        and(
          eq(distributionLines.tenantId, tenantId),
          eq(distributionLines.recipientUnverified, true),
        ),
      )
      .orderBy(
        asc(distributionLines.distributionRunId),
        asc(distributionLines.id),
      );
    return rows.map((row) =>
      unverifiedRecipientLineSchema.parse({
        ...row,
        paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      }),
    );
  });
}

/**
 * Owner only: sets the recipient of one flagged line and clears the flag in a
 * single UPDATE (the guard trigger allows exactly this change). A line that is
 * not flagged (or does not exist) is 404, so a second call cannot overwrite.
 */
export async function resolveUnverifiedRecipientService(
  context: ScopedTenantContext,
  actorUserId: string,
  lineId: string,
  input: ResolveUnverifiedRecipientInput,
): Promise<ResolveUnverifiedRecipientResult> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await assertTenantOwner(tx, tenantId, actorUserId);
    if (input.recipientUserId !== null) {
      const [login] = await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, input.recipientUserId))
        .limit(1);
      if (!login)
        throw new HttpError(
          422,
          "RECIPIENT_NOT_FOUND",
          "Akun penerima tidak ditemukan.",
        );
    }
    const [row] = await tx
      .update(distributionLines)
      .set({
        recipientUserId: input.recipientUserId,
        recipientUnverified: false,
      })
      .where(
        and(
          eq(distributionLines.tenantId, tenantId),
          eq(distributionLines.id, lineId),
          eq(distributionLines.recipientUnverified, true),
        ),
      )
      .returning({
        id: distributionLines.id,
        runId: distributionLines.distributionRunId,
        shareholderId: distributionLines.shareholderId,
        paymentStatus: distributionLines.paymentStatus,
      });
    if (!row) throw lineNotFound();
    await recordAudit(
      {
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "profit_share.recipient_reconciled",
        objectType: "distribution_line",
        objectId: row.id,
        // The Owner's note is free text: it goes in `reason`, never in a snapshot.
        reason: input.note,
        before: { recipientUnverified: true },
        after: {
          recipientUnverified: false,
          recipientUserId: input.recipientUserId,
          distributionRunId: row.runId,
          shareholderId: row.shareholderId,
          paymentStatus: row.paymentStatus,
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return {
      lineId: distributionLineIdSchema.parse(row.id),
      recipientUserId: input.recipientUserId,
    };
  });
}
