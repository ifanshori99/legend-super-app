-- legend-zmc2: inclusive-price (harga nett) orders. subtotal_idr holds the gross
-- line sum; service_charge_idr and tax_idr are backed out of it, so the total
-- does not add them again, and they must fit inside subtotal minus discount.
-- No foreign key is added, so no FORCE RLS lift.
ALTER TABLE "orders" DROP CONSTRAINT "orders_total_check";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "prices_include_tax" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_check" CHECK (("orders"."prices_include_tax" = false AND "orders"."total_idr" = "orders"."subtotal_idr" - "orders"."discount_idr" + "orders"."service_charge_idr" + "orders"."tax_idr" + "orders"."rounding_idr") OR ("orders"."prices_include_tax" = true AND "orders"."total_idr" = "orders"."subtotal_idr" - "orders"."discount_idr" + "orders"."rounding_idr" AND "orders"."service_charge_idr" + "orders"."tax_idr" <= "orders"."subtotal_idr" - "orders"."discount_idr"));