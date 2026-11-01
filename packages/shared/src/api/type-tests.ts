// Compile-time tests for endpoint typing, checked by `pnpm typecheck` (never
// imported at runtime). Each @ts-expect-error line must fail to compile.

import type { EndpointInput, EndpointOutput } from "./endpoint.ts";
import {
  addExampleOrderLine,
  getExampleOutlet,
  listExampleOutlets,
  removeExampleOrderLine,
} from "./example.ts";

export function typeTests(): void {
  // Only declared parts are accepted, with their schema's input type.
  const list: EndpointInput<typeof listExampleOutlets> = {
    query: { limit: 10 },
  };
  const listNoInput: EndpointInput<typeof listExampleOutlets> = {
    query: { cursor: undefined },
  };
  // @ts-expect-error GET list declares no body
  const listWithBody: EndpointInput<typeof listExampleOutlets> = { body: {} };
  // @ts-expect-error path params are required for a detail endpoint
  const noParams: EndpointInput<typeof getExampleOutlet> = {};
  const lineInput: EndpointInput<typeof addExampleOrderLine> = {
    params: { orderId: "01JBQ7Z8K0A1B2C3D4E5F6G7H8" },
    body: {
      name: "Es Teh",
      quantity: 1,
      unitPriceIdr: 12_000,
      idempotencyKey: "key-12345678",
    },
  };
  const badBody: EndpointInput<typeof addExampleOrderLine> = {
    params: { orderId: "01JBQ7Z8K0A1B2C3D4E5F6G7H8" },
    body: {
      name: "Es Teh",
      quantity: 1,
      unitPriceIdr: 12_000,
      idempotencyKey: "key-12345678",
      // @ts-expect-error the client never sends tenantId (TEN-02)
      tenantId: "x",
    },
  };

  // Output: parsed response type, or void for 204.
  const page: EndpointOutput<typeof listExampleOutlets> = {
    data: [],
    meta: { limit: 25, nextCursor: null },
  };
  const removed: EndpointOutput<typeof removeExampleOrderLine> = undefined;
  // @ts-expect-error a 204 endpoint has no payload
  const payload: EndpointOutput<typeof removeExampleOrderLine> = { data: 1 };

  void [
    list,
    listNoInput,
    listWithBody,
    noParams,
    lineInput,
    badBody,
    page,
    removed,
    payload,
  ];
}
