// Purchasing screen examples for AI-08 and authenticated PDF preview. The AI
// sample models a low-stock scenario using real inventory fixture references.
import { z } from "../../core/index.ts";
import { cafeLegendInventoryFixtures } from "../fixtures.ts";
import { cafeLegendPurchasingFixtures } from "./fixtures.ts";
import { purchaseOrderSendResultSchema } from "./schemas.ts";
import {
  purchasingAiSuggestionSchema,
  purchaseOrderPdfPreviewSchema,
} from "./preview.ts";

const inventory = cafeLegendInventoryFixtures;
const par = inventory.parLevels[0]!;
const item = inventory.items.find((row) => row.id === par.inventoryItemId)!;
const location = inventory.locations.find((row) => row.id === par.locationId)!;
const unit = inventory.uoms.find((row) => row.id === item.baseUomId)!;
const onHand = Math.max(0, Number(par.parMin) - 1);
const sentOrder = cafeLegendPurchasingFixtures.purchaseOrders.find(
  (order) => order.sentAt !== null && order.sentTo !== null,
)!;

export const purchasingPreviewFixtureSchema = z.strictObject({
  aiSuggestions: z.array(purchasingAiSuggestionSchema),
  pdfPreviews: z.array(purchaseOrderPdfPreviewSchema),
  sendResults: z.array(purchaseOrderSendResultSchema),
});

export const cafeLegendPurchasingPreviewFixtures =
  purchasingPreviewFixtureSchema.parse({
    aiSuggestions: [
      {
        inventoryItemId: item.id,
        itemName: item.name,
        locationId: location.id,
        locationName: location.name,
        unit: unit.code,
        onHand,
        parMin: Number(par.parMin),
        parMax: Number(par.parMax),
        suggestedQty: Number(par.parMax) - onHand,
        reason: "below_min",
      },
    ],
    pdfPreviews: cafeLegendPurchasingFixtures.purchaseOrders.map((order) => ({
      purchaseOrderId: order.id,
      url: `/api/inventory/purchase-orders/${order.id}/preview.pdf`,
      filename: `${order.number.replace(/[^A-Za-z0-9_-]+/g, "-")}.pdf`,
      contentType: "application/pdf",
    })),
    sendResults: [
      {
        purchaseOrder: sentOrder,
        channel: "email",
        sentTo: sentOrder.sentTo,
        shareUrl: null,
        expiresAt: null,
      },
      {
        purchaseOrder: sentOrder,
        channel: "share_link",
        sentTo: null,
        // An illustrative URL on the reserved .example domain, not a live token.
        shareUrl:
          "https://cafe-legend.example/api/public/purchase-orders/fixture-preview-token",
        expiresAt: "2026-11-06T05:30:00.000Z",
      },
    ],
  });
