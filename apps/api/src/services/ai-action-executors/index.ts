// Executor registry for approved action requests (WS-12 part W).
// TL-13 and TL-16 only create drafts (a purchase order draft, shift assignment
// drafts); a person still submits the order and publishes the roster.
import type { ActionRequestToolCode } from "@starter/shared/ai";
import { executeMenuAvailability } from "./menu-availability.ts";
import { executePriceChange } from "./price-change.ts";
import { executePromotion } from "./promotion.ts";
import { executePurchaseOrder } from "./purchase-order.ts";
import { executeShiftSchedule } from "./shift-schedule.ts";
import { executeStockAdjustment } from "./stock-adjustment.ts";
import type { ActionExecutor } from "./types.ts";

export const actionExecutors: Partial<
  Record<ActionRequestToolCode, ActionExecutor>
> = {
  "TL-13": executePurchaseOrder,
  "TL-14": executeStockAdjustment,
  "TL-15": executePromotion,
  "TL-16": executeShiftSchedule,
  "TL-17": executePriceChange,
  "TL-18": executeMenuAvailability,
};

/** Tools that can create a request (an executor exists). */
export const EXECUTABLE_ACTION_TOOLS: readonly ActionRequestToolCode[] = [
  "TL-13",
  "TL-14",
  "TL-15",
  "TL-16",
  "TL-17",
  "TL-18",
];

export * from "./types.ts";
