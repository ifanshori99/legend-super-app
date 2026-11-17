// TL-13..TL-18 write tools + TL-19 status (bead legend-zw9r, legend-ktqc TL-19).
// A write handler only proposes: it opens an approval request and stores an
// action request (ai-action-request.service.ts). It never mutates the target
// module (AIG-03). TL-13 (purchase order draft) and TL-16 (shift schedule
// draft) propose like the others; their executors only create drafts.
import {
  getActionRequestStatusInputSchema,
  type ActionRequestToolCode,
} from "@starter/shared/ai";
import {
  getActionRequestStatus,
  proposeActionRequest,
} from "../../ai-action-request.service.ts";
import { toolMatches } from "../../ai-metrics/scope.ts";
import type { AiToolHandler, AiToolHandlerMap } from "../types.ts";

function proposer(code: ActionRequestToolCode): AiToolHandler {
  return (ctx, input) => proposeActionRequest(ctx, code, input);
}

export const writeTools: AiToolHandlerMap = {
  "TL-13": proposer("TL-13"),
  "TL-14": proposer("TL-14"),
  "TL-15": proposer("TL-15"),
  "TL-16": proposer("TL-16"),
  "TL-17": proposer("TL-17"),
  "TL-18": proposer("TL-18"),
  "TL-19": async (ctx, input) => {
    const parsed = getActionRequestStatusInputSchema.parse(input);
    toolMatches(ctx, "TL-19");
    return getActionRequestStatus(ctx, parsed.actionRequestId);
  },
};
