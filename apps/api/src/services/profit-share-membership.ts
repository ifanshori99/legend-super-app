// Real `ShareholderMembership` for shareholder documents (SH-01; bead
// legend-2ljb): the profit entities in whose APPROVED share version the
// caller's shareholder row appears. A pending, rejected or draft version gives
// no access, and neither does an inactive shareholder.

import { and, eq } from "drizzle-orm";
import {
  shareAllocations,
  shareAllocationVersions,
  shareholders,
} from "../db/schema";
import type { ShareholderMembership } from "./shareholder-documents.service";

export const dbShareholderMembership: ShareholderMembership = {
  async profitEntityIdsForUser(tx, context, userId) {
    const tenantId = context.tenant.tenantId;
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
        ),
      );
    return rows.map((row) => row.profitEntityId);
  },
};
