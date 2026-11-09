// Executor registry for approved action requests (WS-12 part W).
// TL-13 (purchase order) and TL-16 (shift schedule) have no executor: this
// base has no purchase-order service and no shift-schedule write. Their tool
// handlers refuse (AI_TOOL_DISABLED) so no request is ever created for them.
import type { ActionRequestToolCode } from "@starter/shared/ai";
import { executeMenuAvailability } from "./menu-availability.ts";
import { executePriceChange } from "./price-change.ts";
import { executePromotion } from "./promotion.ts";
import { executeStockAdjustment } from "./stock-adjustment.ts";
import type { ActionExecutor } from "./types.ts";

export const actionExecutors: Partial<
  Record<ActionRequestToolCode, ActionExecutor>
> = {
  "TL-14": executeStockAdjustment,
  "TL-15": executePromotion,
  "TL-17": executePriceChange,
  "TL-18": executeMenuAvailability,
};

/** Tools that can create a request (an executor exists). */
export const EXECUTABLE_ACTION_TOOLS: readonly ActionRequestToolCode[] = [
  "TL-14",
  "TL-15",
  "TL-17",
  "TL-18",
];

export * from "./types.ts";
