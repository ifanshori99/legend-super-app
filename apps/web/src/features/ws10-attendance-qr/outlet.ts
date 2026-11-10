// Attendance constants. The outlet itself comes from the shell's outlet context
// (`useTenantContext().outlet`); screens pass its id down to the hooks.
import { DEFAULT_TIME_ZONE } from "@starter/shared/core";

/** Outlet time zone for business dates and the QR timestamps (D-CORE-6). */
export const ATTENDANCE_TIME_ZONE = DEFAULT_TIME_ZONE;
