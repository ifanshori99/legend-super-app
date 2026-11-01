// Example endpoints for the typed client and FE mock mode (bead legend-zj2).
// They exercise every shape a real contract needs: cursor list, id lookup with
// path params, a write guarded by an idempotency key, and a 204 delete. The
// paths live under /api/example so they can never collide with a domain
// route; the API does not implement them. Domain contracts copy the pattern
// (see docs/frontend.md, "Typed endpoints and mock mode").

import {
  clientInputSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  idrSchema,
  moneyLineFixtureSchema,
  outletIdSchema,
  outletRefSchema,
  ulidIdSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "./endpoint.ts";

export const exampleOrderIdSchema = ulidIdSchema<"OrderId">();

export const listExampleOutlets = defineEndpoint({
  method: "GET",
  path: "/api/example/outlets",
  query: cursorPageQuerySchema,
  response: cursorPageSchema(outletRefSchema),
});

export const getExampleOutlet = defineEndpoint({
  method: "GET",
  path: "/api/example/outlets/:outletId",
  params: z.strictObject({ outletId: outletIdSchema }),
  response: dataResponseSchema(outletRefSchema),
});

export const addExampleOrderLineInputSchema = clientInputSchema({
  name: z.string().min(1).max(150),
  quantity: z.number().int().positive().max(999),
  unitPriceIdr: idrSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const addExampleOrderLine = defineEndpoint({
  method: "POST",
  path: "/api/example/orders/:orderId/lines",
  params: z.strictObject({ orderId: exampleOrderIdSchema }),
  body: addExampleOrderLineInputSchema,
  response: dataResponseSchema(moneyLineFixtureSchema),
});

export const removeExampleOrderLine = defineEndpoint({
  method: "DELETE",
  path: "/api/example/orders/:orderId/lines/:lineId",
  params: z.strictObject({
    orderId: exampleOrderIdSchema,
    lineId: ulidIdSchema<"OrderItemId">(),
  }),
});
