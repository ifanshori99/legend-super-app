-- legend-5b7uf: a return of goods already invoiced at a price other than the
-- order price must clear the payable at the BILLED value, and reverse the price
-- variance the invoice booked to 5105. `value_idr` stays the stock value (order
-- price, = uninvoiced + invoiced); `price_variance_idr` is signed, billed value
-- minus order-price value of the invoiced part. The debit note is invoiced +
-- price variance + PPN. Old rows get 0 (their debit note was invoiced + PPN).
-- Idempotent: a re-run changes nothing. RLS is unchanged (same table, policies
-- cover all columns).
ALTER TABLE "purchase_returns" ADD COLUMN IF NOT EXISTS "price_variance_idr" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "purchase_returns" DROP CONSTRAINT IF EXISTS "purchase_returns_price_variance_check";
--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_price_variance_check" CHECK ("purchase_returns"."invoiced_value_idr" + "purchase_returns"."price_variance_idr" >= 0
        AND ("purchase_returns"."price_variance_idr" = 0 OR "purchase_returns"."invoiced_value_idr" > 0));
