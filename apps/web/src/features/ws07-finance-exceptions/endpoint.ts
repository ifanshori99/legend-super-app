// Contract of GET /api/accounting/finance-exceptions for the typed client and
// mock mode (docs/frontend.md "Typed endpoints and mock mode"). The request
// schema and kinds are the API's own (`validators/finance-exceptions`); the
// response schema mirrors `FinanceExceptionsDto` in `types/api.ts`. The API
// route is a plain Express handler, so this definition lives with the screen.
// Relative `.ts` imports only: the mock loads it in Node tests.
import { defineEndpoint } from "@starter/shared/api";
import { z } from "@starter/shared/core";
import {
  FINANCE_EXCEPTION_KINDS,
  financeExceptionsQuerySchema,
} from "@starter/shared/validators/finance-exceptions";

const kindSchema = z.enum(FINANCE_EXCEPTION_KINDS);

export const financeExceptionsResponseSchema = z.strictObject({
  summary: z.array(
    z.strictObject({
      kind: kindSchema,
      count: z.number().int().nonnegative(),
      knownAmountCount: z.number().int().nonnegative(),
      amountIdr: z.number().int().nonnegative(),
    }),
  ),
  items: z.array(
    z.strictObject({
      kind: kindSchema,
      outletId: z.string().nullable(),
      occurredAt: z.string(),
      refType: z.string(),
      refId: z.string(),
      amountIdr: z.number().int().nullable(),
      detail: z.string().nullable(),
      receiptPending: z
        .strictObject({
          orderId: z.string().nullable(),
          intentId: z.string().nullable(),
          outboxState: z.enum([
            "pending",
            "dead_lettered",
            "delivered",
            "missing",
          ]),
        })
        .optional(),
    }),
  ),
  truncated: z.boolean(),
});

export const listFinanceExceptions = defineEndpoint({
  method: "GET",
  path: "/api/accounting/finance-exceptions",
  query: financeExceptionsQuerySchema,
  response: financeExceptionsResponseSchema,
});
