// Local endpoint for the one call the shared contract has no constant for.
// Kept free of app aliases so the mock can import it directly.
import { defineEndpoint } from "@starter/shared/api";
import { z } from "@starter/shared/core";
import { mcpAuthorizePreviewQuerySchema } from "@starter/shared/ai";

/**
 * POST /api/ai/mcp/authorize (docs/contracts/ws12-ai-fe.md, "MCP consent
 * screen"): the OAuth query as JSON (same snake_case names) plus
 * `approve: true`; the answer is `{ redirectTo }` and may carry `error=`.
 */
export const authorizeMcp = defineEndpoint({
  method: "POST",
  path: "/api/ai/mcp/authorize",
  body: mcpAuthorizePreviewQuerySchema.extend({ approve: z.literal(true) }),
  response: z.strictObject({ redirectTo: z.string().min(1) }),
});
