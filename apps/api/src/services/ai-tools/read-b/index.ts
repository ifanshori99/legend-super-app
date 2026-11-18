// TL-07..TL-12, TL-20, TL-21 handlers (bead legend-ktqc). Owned by part R-B.
//
// TL-09 (get_my_payslip, bead legend-39d.2) opens only after the employee
// unlocked that payslip with the PIN on the screen (see tl-09-my-payslip.ts).
import type { AiToolHandlerMap } from "../types.ts";
import { getCustomerSegments } from "./tl-07-customer-segments.ts";
import { getShiftSchedule } from "./tl-08-shift-schedule.ts";
import { getMyPayslip } from "./tl-09-my-payslip.ts";
import { searchSop } from "./tl-10-search-sop.ts";
import { getAnomalies } from "./tl-11-anomalies.ts";
import { getMyProfitShare } from "./tl-12-my-profit-share.ts";
import { getFacilityUtilization } from "./tl-20-facility-utilization.ts";
import { getReviewSummary } from "./tl-21-review-summary.ts";

export const readToolsB: AiToolHandlerMap = {
  "TL-07": getCustomerSegments,
  "TL-08": getShiftSchedule,
  "TL-09": getMyPayslip,
  "TL-10": searchSop,
  "TL-11": getAnomalies,
  "TL-12": getMyProfitShare,
  "TL-20": getFacilityUtilization,
  "TL-21": getReviewSummary,
};
