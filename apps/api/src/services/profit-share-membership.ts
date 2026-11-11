// Real `ShareholderMembership` for shareholder documents (SH-01; bead
// legend-2ljb): the profit entities in whose APPROVED share version the
// caller's shareholder row appears in the LATEST approved share version. A
// pending, rejected or draft version gives no access (and does not remove it),
// neither does an inactive shareholder, and a shareholder dropped from a newer
// approved version loses access (bead legend-lt0v4).

import { and, eq, max } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  shareAllocations,
  shareAllocationVersions,
  shareholders,
} from "../db/schema";
import type { ShareholderMembership } from "./shareholder-documents.service";

export const dbShareholderMembership: ShareholderMembership = {
  async profitEntityIdsForUser(tx, context, userId) {
    const tenantId = context.tenant.tenantId;
    const newer = alias(shareAllocationVersions, "newer_approved_versions");
    const latestApproved = tx
      .select({ version: max(newer.version) })
      .from(newer)
      .where(
        and(
          eq(newer.tenantId, shareAllocationVersions.tenantId),
          eq(newer.profitEntityId, shareAllocationVersions.profitEntityId),
          eq(newer.status, "approved"),
        ),
      );
    const rows = await tx
      .selectDistinct({ profitEntityId: shareAllocations.profitEntityId })
      .from(shareholders)
      .innerJoin(
        shareAllocations,
        and(
          eq(shareAllocations.tenantId, shareholders.tenantId),
          eq(shareAllocations.shareholderId, shareholders.id),
        ),
      )
      .innerJoin(
        shareAllocationVersions,
        and(
          eq(shareAllocationVersions.tenantId, shareAllocations.tenantId),
          eq(
            shareAllocationVersions.profitEntityId,
            shareAllocations.profitEntityId,
          ),
          eq(shareAllocationVersions.version, shareAllocations.version),
        ),
      )
      .where(
        and(
          eq(shareholders.tenantId, tenantId),
          eq(shareholders.userId, userId),
          eq(shareholders.status, "active"),
          eq(shareAllocationVersions.status, "approved"),
          eq(shareAllocationVersions.version, latestApproved),
        ),
      );
    return rows.map((row) => row.profitEntityId);
  },
};
