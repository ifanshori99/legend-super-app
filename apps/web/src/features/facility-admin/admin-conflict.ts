// Pure helpers behind two facility admin rules (bead legend-ws09), kept free of
// React and the API client so a root node:test can cover them.
import type { CursorPage } from "@starter/shared/core";
import type { Facility, FacilityListItem } from "@starter/shared/facility";

/**
 * A saved facility merged over its list row, so the list-only counts
 * (areaCount, unitCount, activeUnitCount, productCount) survive. Rows of other
 * facilities and an empty cache entry stay untouched.
 */
export function mergeFacilityRow(
  page: CursorPage<FacilityListItem> | undefined,
  facility: Facility,
): CursorPage<FacilityListItem> | undefined {
  return page
    ? {
        ...page,
        data: page.data.map((row) =>
          row.id === facility.id ? { ...row, ...facility } : row,
        ),
      }
    : page;
}

/**
 * Only a stale stamp (412) means another admin saved first. A 409 is a refused
 * change, so the typed values stay for a retry.
 */
export function isStaleStampStatus(status: number): boolean {
  return status === 412;
}

/**
 * After a 412 the General tab refills its form once the refetched row differs
 * from the one the form was filled from. A plain refetch (no conflict pending)
 * never refills, so unsaved edits survive it.
 */
export function shouldRefillAfterConflict(
  conflictPending: boolean,
  rowUpdatedAt: string,
  formStamp: string,
): boolean {
  return conflictPending && rowUpdatedAt !== formStamp;
}
