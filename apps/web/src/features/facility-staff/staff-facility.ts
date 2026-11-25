// Which facility the staff screens work on. Pure, so it is tested without React.
import { isFacilityTypeReleased } from "@starter/shared/facility";

type FacilityRef = { readonly id: string; readonly type: string };

/**
 * The contract has no "current facility" read; the caller may name one with
 * `?facilityId=`, else the shower facility (the Legend booth board, PRD §3 F22)
 * and then the first configured facility.
 *
 * `releasedOnly` (1269 F0: board, cleaning, incidents) leaves deferred shower
 * facilities out. A named one answers null, so staff never work on another
 * facility than the one they asked for. The emergency screen and the panic
 * layer do not pass it: a panic signal is never hidden.
 */
export function pickStaffFacility<T extends FacilityRef>(
  list: readonly T[],
  requestedFacilityId?: string,
  { releasedOnly = false }: { releasedOnly?: boolean } = {},
): T | null {
  const open = releasedOnly
    ? list.filter((item) => isFacilityTypeReleased(item.type))
    : list;
  const requested = requestedFacilityId
    ? list.find((item) => item.id === requestedFacilityId)
    : undefined;
  if (requested) return open.includes(requested) ? requested : null;
  return open.find((item) => item.type === "shower") ?? open[0] ?? null;
}

/**
 * The facility the emergency screen's board and incident links open: its own
 * one, else the first released one; null when the outlet has none (the links
 * are hidden then).
 */
export function boardFacility<T extends FacilityRef>(
  list: readonly T[],
  current: T | null,
): T | null {
  if (current && isFacilityTypeReleased(current.type)) return current;
  return pickStaffFacility(list, undefined, { releasedOnly: true });
}
