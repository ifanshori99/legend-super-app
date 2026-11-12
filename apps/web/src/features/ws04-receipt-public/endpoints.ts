// The public e-receipt read (GET /api/public/receipts/:token, bead legend-1uk9).
// The API route exists (apps/api/src/routes/pos-receipt.routes.ts) but
// @starter/shared/pos has no defineEndpoint for it yet, so the contract is
// declared here from the same response schema. Contract gap: lift it into
// @starter/shared/pos without a client change. The API strips the cashier
// name and payment references from this document (a bearer link is forwarded).
import { defineEndpoint } from "@starter/shared/api";
import { dataResponseSchema, z } from "@starter/shared/core";
import { receiptDocumentSchema } from "@starter/shared/pos";

export const getPublicReceipt = defineEndpoint({
  method: "GET",
  path: "/api/public/receipts/:token",
  params: z.strictObject({ token: z.string().min(1).max(200) }),
  response: dataResponseSchema(receiptDocumentSchema),
});
