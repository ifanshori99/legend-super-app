-- legend-ba8p: promo customer references cannot escape their tenant, and a
-- facility reward can only grant a product of its issuing outlet. Existing
-- vouchers_profile_fk was installed by 0207 and is not added a second time.
--
-- Validate every existing row. Dangling monetary/reward history aborts this
-- migration instead of deleting usage, moving rewards or inventing a parent.
-- FORCE is lifted on both sides only within the migration transaction
-- (docs/plan/contracts.md pattern 2), then restored before this file ends.
ALTER TABLE public.customer_profiles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.facility_products NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.promotion_customer_usage NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.facility_rewards NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.promotion_customer_usage
  ADD CONSTRAINT promotion_customer_usage_profile_fk
  FOREIGN KEY (tenant_id, customer_profile_id)
  REFERENCES public.customer_profiles (tenant_id, id);
--> statement-breakpoint
ALTER TABLE public.facility_rewards
  ADD CONSTRAINT facility_rewards_profile_fk
  FOREIGN KEY (tenant_id, customer_profile_id)
  REFERENCES public.customer_profiles (tenant_id, id);
--> statement-breakpoint
ALTER TABLE public.facility_rewards
  ADD CONSTRAINT facility_rewards_product_fk
  FOREIGN KEY (tenant_id, outlet_id, facility_product_id)
  REFERENCES public.facility_products (tenant_id, outlet_id, id);
--> statement-breakpoint
ALTER TABLE public.facility_rewards FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.promotion_customer_usage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.facility_products FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.customer_profiles FORCE ROW LEVEL SECURITY;
