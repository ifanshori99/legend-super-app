// Small helpers shared by the request screens (bead legend-g12il): outlet-zone
// schedule labels and heading focus after a screen change.
import * as React from "react";
import type { Translate } from "@starter/shared/i18n";
import {
  businessDateOfInstant,
  formatClock,
  formatDayLabel,
} from "@/features/ws08-reservation-customer/lib";
import { zoneLabel } from "../../lib";

/** "Rabu, 18 November 2026" in the outlet's zone. */
export function dayLabel(instant: string, timeZone: string): string {
  return formatDayLabel(businessDateOfInstant(instant, timeZone));
}

/** "19.00 WIB" in the outlet's zone. */
export function clockLabel(instant: string, timeZone: string): string {
  return `${formatClock(instant, timeZone)} ${zoneLabel(timeZone)}`;
}

/** "Rabu, 18 November 2026 pukul 19.00 WIB". */
export function scheduleLabel(
  t: Translate,
  instant: string,
  timeZone: string,
): string {
  return t("reservationGuestRequest.schedule", {
    day: dayLabel(instant, timeZone),
    time: formatClock(instant, timeZone),
    zone: zoneLabel(timeZone),
  });
}

/**
 * Ref for a screen's h1. It does not focus: `GuestManagePage` moves focus to
 * the heading after a step change (one mechanism, so a screen reader hears the
 * heading once and the first load does not steal focus).
 */
export function useFocusHeading() {
  return React.useRef<HTMLHeadingElement>(null);
}
