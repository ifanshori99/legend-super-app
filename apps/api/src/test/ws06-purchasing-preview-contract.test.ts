import { describe, expect, it } from "vitest";
import * as purchasing from "@starter/shared/inventory";

describe("legend-ca3c purchasing preview contracts", () => {
  it("exports an authenticated PDF preview contract without creating a share link", () => {
    expect(Reflect.get(purchasing, "getPurchaseOrderPdfPreview")).toMatchObject(
      {
        method: "GET",
        path: "/api/inventory/purchase-orders/:purchaseOrderId/preview.pdf",
      },
    );
  });
  it("exposes the existing AI-08 read contract in the purchasing namespace", () => {
    expect(
      Reflect.get(purchasing, "listPurchasingAiSuggestions"),
    ).toMatchObject({ method: "GET", path: "/api/ai/purchase-suggestions" });
    expect(
      Reflect.get(purchasing, "purchasingAiSuggestionSchema"),
    ).toBeDefined();
  });
  it("provides AI suggestions and typed PDF preview fixtures for purchasing screens", () => {
    const fixtures = Reflect.get(
      purchasing,
      "cafeLegendPurchasingPreviewFixtures",
    );
    expect(fixtures).toBeDefined();
    expect(fixtures.aiSuggestions.length).toBeGreaterThan(0);
    expect(fixtures.pdfPreviews.length).toBeGreaterThan(0);
    for (const pdf of fixtures.pdfPreviews)
      expect(pdf).toMatchObject({
        contentType: "application/pdf",
        url: `/api/inventory/purchase-orders/${pdf.purchaseOrderId}/preview.pdf`,
      });
    for (const suggestion of fixtures.aiSuggestions)
      expect(
        Reflect.get(purchasing, "purchasingAiSuggestionSchema").safeParse(
          suggestion,
        ).success,
      ).toBe(true);
  });
  it("provides email and expiring share delivery fixtures validated by the public contract", () => {
    const fixtures = Reflect.get(
      purchasing,
      "cafeLegendPurchasingPreviewFixtures",
    );
    expect(
      fixtures.sendResults
        .map((result: { channel: string }) => result.channel)
        .sort(),
    ).toEqual(["email", "share_link"]);
    for (const result of fixtures.sendResults)
      expect(
        purchasing.purchaseOrderSendResultSchema.safeParse(result).success,
      ).toBe(true);
  });
});
