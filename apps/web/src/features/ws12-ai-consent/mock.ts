// Mock handlers for the MCP consent screen (VITE_API_MOCK=true). Every answer
// is validated with the contract schema. Scenarios by URL (mock mode):
//   /mcp/consent?client_id=asisten-pembelian&redirect_uri=https://client.example/cb&state=abc   normal
//   ...&client_id=tidak-dikenal    preview error (client not approved)
//   ...&client_id=butuh-mfa        approve answers redirectTo with error=access_denied
//   ...&client_id=gagal-setuju     approve fails (retry shown)
//   /mcp/consent                   missing params
//   add ?mock=slow for loading, ?mock=error for a failing preview
import {
  MCP_SCOPE_LABELS_ID,
  isMcpScope,
  mcpAuthorizePreviewSchema,
  previewMcpAuthorize,
  type McpScope,
} from "@starter/shared/ai";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { authorizeMcp } from "./endpoints.ts";

const DEFAULT_SCOPES: McpScope[] = [
  "mcp:inventory:read",
  "mcp:purchasing:draft",
];

registerMock(previewMcpAuthorize, ({ query }) => {
  if (query.client_id === "tidak-dikenal")
    throw new ApiError(
      403,
      "MCP_CLIENT_NOT_APPROVED",
      "Klien ini belum disetujui admin tenant. Minta admin menyetujuinya di Pengaturan MCP & AI.",
    );
  const requested = (query.scope ?? "")
    .split(/\s+/)
    .filter((scope): scope is McpScope => isMcpScope(scope));
  const scopes = requested.length > 0 ? requested : DEFAULT_SCOPES;
  return {
    data: mcpAuthorizePreviewSchema.parse({
      clientName: "Asisten Pembelian",
      redirectUri: query.redirect_uri,
      scopes: scopes.map((scope) => ({
        scope,
        label: MCP_SCOPE_LABELS_ID[scope],
      })),
    }),
  };
});

registerMock(authorizeMcp, ({ body }) => {
  if (body.client_id === "gagal-setuju")
    throw new ApiError(500, "INTERNAL_ERROR", "Terjadi kesalahan.");
  const url = new URL(body.redirect_uri);
  if (body.client_id === "butuh-mfa") {
    url.searchParams.set("error", "access_denied");
  } else {
    url.searchParams.set("code", "mock-authorization-code");
  }
  if (body.state) url.searchParams.set("state", body.state);
  return { redirectTo: url.href };
});
