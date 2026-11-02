// One mock for GET /api/facility/subscription-plans, called both by the
// facility screens and by the Wi-Fi portal (same contract, same fixtures).
// Both features import this module; registering it in either feature made the
// later glob entry win silently (bead legend-jzud).
import {
  cafeLegendSubscriptionPlans,
  listSubscriptionPlans,
} from "@starter/shared/facility";
import { registerMock } from "../registry.ts";

registerMock(listSubscriptionPlans, ({ query, scenario }) => {
  if (scenario === "empty") return { data: { plans: [] } };
  const plans = cafeLegendSubscriptionPlans.filter(
    (plan) => plan.facilityId === query.facilityId && plan.isActive,
  );
  return { data: { plans } };
});
