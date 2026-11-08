import { z } from "zod";

// Where the shift screens send the cashier back to after a shift is opened:
// only a bill under /pos/bayar/, never an outside or arbitrary path.
const RETURN_TO_PATTERN = /^\/pos\/bayar\/[A-Za-z0-9_-]+$/;

export const shiftSearchSchema = z.object({
  returnTo: z.string().regex(RETURN_TO_PATTERN).optional().catch(undefined),
});

export function paymentReturnTo(orderId: string): string {
  return `/pos/bayar/${orderId}`;
}
