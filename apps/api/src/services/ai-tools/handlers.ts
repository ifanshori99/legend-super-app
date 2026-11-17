// Merged TL-01..TL-21 handler registry (part I, AIG-01). The invoke layer is
// the only caller: every tool call from Tanya AI and MCP goes through
// `invokeAiTool`, which looks the handler up here.
import type { AiToolCode } from "@starter/shared/ai";
import { readToolsA } from "./read-a/index.ts";
import { readToolsB } from "./read-b/index.ts";
import type { AiToolHandler, AiToolHandlerMap } from "./types.ts";
import { writeTools } from "./write/index.ts";

export const aiToolHandlers: AiToolHandlerMap = Object.freeze({
  ...readToolsA,
  ...readToolsB,
  ...writeTools,
});

/** Read at call time so a part that fills its map later is picked up. */
export function getAiToolHandler(code: AiToolCode): AiToolHandler | undefined {
  return aiToolHandlers[code];
}
