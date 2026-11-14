// Who may act on a queued correction: only the employee it was written for.
// The local queue is shared by every account used on this browser, so an
// action on a row must be refused unless the active employee owns it.

/** True only when the row belongs to the active employee (never when none). */
export function canActOnQueued(
  row: { employeeId: string },
  activeEmployeeId: string | null,
): boolean {
  return activeEmployeeId !== null && row.employeeId === activeEmployeeId;
}
