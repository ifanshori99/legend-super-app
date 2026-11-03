// Owner Q39: the business-day clock of one outlet row (time zone + cutoff).
// Every service that derives a business date or a day range from an instant
// passes this to `businessDateOf` / `businessDayRange` (@starter/shared/core).
import type { BusinessDayClock } from "@starter/shared/core";

export function outletBusinessDayClock(outlet: {
  timezone: string;
  businessDayCutoff: string;
}): BusinessDayClock {
  return { timeZone: outlet.timezone, cutoff: outlet.businessDayCutoff };
}
