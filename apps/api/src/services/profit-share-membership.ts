// Real `ShareholderMembership` for shareholder documents (SH-01; bead
// legend-2ljb): the profit entities in whose APPROVED share version IN FORCE
// TODAY the caller's shareholder row appears. The version in force is the
// approved one with the latest `effective_from` not after today (higher version
// on a tie), the same rule as `effectiveShareAllocationVersion`. A pending,
// rejected or draft version gives no access (and does not remove it), neither
// does an inactive shareholder, a shareholder dropped from the version in force
// loses access (bead legend-lt0v4), and a future-dated approved version does
// not change access until its date arrives.

import { and, eq, inArray, lte } from "drizzle-orm";
import { effectiveShareAllocationVersion } from "@starter/shared/accounting";
import { businessDateOf, type BusinessDayClock } from "@starter/shared/core";
import {
  shareAllocations,
  shareAllocationVersions,
  shareholders,
} from "../db/schema";
import type { ShareholderMembership } from "./shareholder-documents.service";

/** Same Jakarta calendar day as the distribution service (D-CORE-6). */
const MEMBERSHIP_CLOCK: BusinessDayClock = {
  timeZone: "Asia/Jakarta",
  cutoff: "00:00",
};

export const dbShareholderMembership: ShareholderMembership = {
  async profitEntityIdsForUser(tx, context, userId) {
    const tenantId = context.tenant.tenantId;
    const today = businessDateOf(new Date(), MEMBERSHIP_CLOCK);
    const held = await tx
      .select({
        profitEntityId: shareAllocations.profitEntityId,
        version: shareAllocations.version,
      })
      .from(shareholders)
      .innerJoin(
        shareAllocations,
        and(
          eq(shareAllocations.tenantId, shareholders.tenantId),
          eq(shareAllocations.shareholderId, shareholders.id),
        ),
      )
      .where(
        and(
          eq(shareholders.tenantId, tenantId),
          eq(shareholders.userId, userId),
          eq(shareholders.status, "active"),
        ),
      );
    if (held.length === 0) return [];
    const entityIds = [...new Set(held.map((row) => row.profitEntityId))];
    const approved = await tx
      .select({
        profitEntityId: shareAllocationVersions.profitEntityId,
        version: shareAllocationVersions.version,
        effectiveFrom: shareAllocationVersions.effectiveFrom,
        status: shareAllocationVersions.status,
      })
      .from(shareAllocationVersions)
      .where(
        and(
          eq(shareAllocationVersions.tenantId, tenantId),
          inArray(shareAllocationVersions.profitEntityId, entityIds),
          eq(shareAllocationVersions.status, "approved"),
          lte(shareAllocationVersions.effectiveFrom, today),
        ),
      );
    const versions = approved.map((row) => ({
      profitEntityId: row.profitEntityId as never,
      version: row.version,
      effectiveFrom: row.effectiveFrom,
      status: row.status,
    }));
    return entityIds.filter((profitEntityId) => {
      const inForce = effectiveShareAllocationVersion(
        versions,
        profitEntityId as never,
        today,
      );
      return (
        inForce !== null &&
        held.some(
          (row) =>
            row.profitEntityId === profitEntityId &&
            row.version === inForce.version,
        )
      );
    });
  },
};
