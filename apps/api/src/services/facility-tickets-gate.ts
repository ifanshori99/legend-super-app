// 1269 F0 (founder 25 Nov 2026): the paid shower room and every facility
// ticket right are deferred past release 1. `FACILITY_TICKETS_ENABLED` is the
// one switch (off by default) and every door that creates a ticket, a slot
// hold, a quota, a right or a claim calls this guard first, before it reads or
// writes anything, so a refusal writes no row and takes no money. The value is
// read at call time and anything but exactly `true` is off (fail closed).
// Refunds and cancellations of old transactions, and the staff emergency unit
// button, do not call it. Guest Wi-Fi and the WFC policy are not facility
// tickets and are not gated.
import { FacilityError } from "@starter/shared/facility";
import { env } from "../config/env.ts";

export function facilityTicketsEnabled(): boolean {
  return env.FACILITY_TICKETS_ENABLED === true;
}

export function assertFacilityTicketsEnabled(): void {
  if (!facilityTicketsEnabled())
    throw new FacilityError("FACILITY_TICKETS_DISABLED");
}
