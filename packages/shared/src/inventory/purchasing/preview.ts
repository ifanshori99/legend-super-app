// Purchasing UI reads the existing AI-08 endpoint, rather than maintaining a
// second suggestion shape. It is currently par-based and never creates a PO.
import {
  listAiPurchaseSuggestions,
  purchaseSuggestionSchema,
} from "../../ai/insights.ts";
import { defineEndpoint } from "../../api/index.ts";
import { z } from "../../core/index.ts";
import { purchaseOrderIdSchema } from "./schemas.ts";

export const listPurchasingAiSuggestions = listAiPurchaseSuggestions;
export const purchasingAiSuggestionSchema = purchaseSuggestionSchema;
export type PurchasingAiSuggestion = z.infer<
  typeof purchasingAiSuggestionSchema
>;

/**
 * Authenticated, read-only preview: `application/pdf` bytes, not a JSON
 * envelope. Uses the same outlet read permission as the PO detail. This does
 * not send the PO, change its status, or issue a public share link. Share
 * delivery remains `sendPurchaseOrder` with channel `share_link` or `email`.
 */
export const getPurchaseOrderPdfPreview = defineEndpoint({
  method: "GET",
  path: "/api/inventory/purchase-orders/:purchaseOrderId/preview.pdf",
  params: z.strictObject({ purchaseOrderId: purchaseOrderIdSchema }),
});

/** UI/mock metadata for the binary preview; the URL requires a session. */
export const purchaseOrderPdfPreviewSchema = z.strictObject({
  purchaseOrderId: purchaseOrderIdSchema,
  url: z
    .string()
    .regex(/^\/api\/inventory\/purchase-orders\/[0-9a-f-]+\/preview\.pdf$/i),
  filename: z.string().min(1).max(150).endsWith(".pdf"),
  contentType: z.literal("application/pdf"),
});
export type PurchaseOrderPdfPreview = z.infer<
  typeof purchaseOrderPdfPreviewSchema
>;
