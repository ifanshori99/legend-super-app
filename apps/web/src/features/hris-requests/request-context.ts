import type { ShiftSwapRequest } from "@starter/shared/hris";

/** The request endpoints return only the shift details needed for this decision. */
export type RequestShift = {
  id: string;
  businessDate: string;
  segments: readonly { startsAt: string; endsAt: string }[];
};

export function hasShiftContext<T extends RequestShift>(
  shift: T | null | undefined,
): shift is T {
  return Boolean(
    shift &&
    /^\d{4}-\d{2}-\d{2}$/.test(shift.businessDate) &&
    shift.segments.length > 0 &&
    shift.segments.every(
      (segment) =>
        Number.isFinite(Date.parse(segment.startsAt)) &&
        Number.isFinite(Date.parse(segment.endsAt)) &&
        Date.parse(segment.startsAt) < Date.parse(segment.endsAt),
    ),
  );
}

export function hasSwapContext(swap: ShiftSwapRequest): boolean {
  return Boolean(
    swap.requestedByName?.trim() &&
    swap.toEmployeeName?.trim() &&
    hasShiftContext(swap.fromAssignment) &&
    swap.fromAssignment.id === swap.fromAssignmentId &&
    (swap.toAssignmentId === null ||
      (hasShiftContext(swap.toAssignment) &&
        swap.toAssignment.id === swap.toAssignmentId)),
  );
}

export function requestShiftLabel(
  shift: RequestShift,
  timeZone = "Asia/Jakarta",
): string {
  const date = new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${shift.businessDate}T12:00:00Z`));
  const clock = new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
  return `${date} · ${shift.segments.map((segment) => `${clock.format(new Date(segment.startsAt))}–${clock.format(new Date(segment.endsAt))}`).join(" / ")}`;
}
