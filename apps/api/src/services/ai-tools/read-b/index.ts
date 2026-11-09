// TL-07..TL-12, TL-20 handlers (bead legend-ktqc). Owned by part R-B.
//
// TL-09 (get_my_payslip) is NOT registered: no payslip is stored anywhere yet
// (payroll run persistence does not exist), and its output schema has no empty
// shape. The engineer decides what the invoke layer answers for it.
import type { AiToolHandlerMap } from "../types.ts";
import { getCustomerSegments } from "./tl-07-customer-segments.ts";
import { getShiftSchedule } from "./tl-08-shift-schedule.ts";
import { searchSop } from "./tl-10-search-sop.ts";
import { getAnomalies } from "./tl-11-anomalies.ts";
import { getMyProfitShare } from "./tl-12-my-profit-share.ts";
import { getFacilityUtilization } from "./tl-20-facility-utilization.ts";

export const readToolsB: AiToolHandlerMap = {
  "TL-07": getCustomerSegments,
  "TL-08": getShiftSchedule,
  "TL-10": searchSop,
  "TL-11": getAnomalies,
  "TL-12": getMyProfitShare,
  "TL-20": getFacilityUtilization,
};
