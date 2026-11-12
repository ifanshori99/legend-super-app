CREATE TABLE "pos_deposit_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"pos_refund_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"amount_idr" bigint NOT NULL,
	"released_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pos_deposit_refunds_refund_intent_key" UNIQUE("tenant_id","pos_refund_id","payment_intent_id"),
	CONSTRAINT "pos_deposit_refunds_amount_check" CHECK ("pos_deposit_refunds"."amount_idr" > 0),
	CONSTRAINT "pos_deposit_refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_deposit_refunds_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_deposit_refunds_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_deposit_refunds_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_deposit_refunds_pos_refund_fk" FOREIGN KEY ("tenant_id","pos_refund_id") REFERENCES "public"."pos_order_refunds"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "pos_deposit_refunds_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "reservation_deposit_remainders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"customer_profile_id" uuid,
	"amount_idr" bigint NOT NULL,
	"remaining_idr" bigint NOT NULL,
	"kind" varchar(24) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_dp_remainder_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reservation_dp_remainder_source_key" UNIQUE("tenant_id","reservation_id","table_session_id"),
	CONSTRAINT "reservation_dp_remainder_amount_check" CHECK ("reservation_deposit_remainders"."amount_idr" > 0 AND "reservation_deposit_remainders"."remaining_idr" >= 0 AND "reservation_deposit_remainders"."remaining_idr" <= "reservation_deposit_remainders"."amount_idr"),
	CONSTRAINT "reservation_dp_remainder_kind_check" CHECK ("reservation_deposit_remainders"."kind" IN ('customer_credit','manual_refund') AND ("reservation_deposit_remainders"."kind" <> 'customer_credit' OR "reservation_deposit_remainders"."customer_profile_id" IS NOT NULL)),
	CONSTRAINT "reservation_deposit_remainders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reservation_deposit_remainders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reservation_dp_remainder_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reservation_dp_remainder_reservation_fk" FOREIGN KEY ("tenant_id","reservation_id") REFERENCES "public"."reservations"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reservation_dp_remainder_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reservation_dp_remainder_intent_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reservation_dp_remainder_profile_fk" FOREIGN KEY ("tenant_id","customer_profile_id") REFERENCES "public"."customer_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "reservation_customer_credit_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"remainder_id" uuid NOT NULL,
	"table_session_id" uuid NOT NULL,
	"amount_idr" bigint NOT NULL,
	"returned_idr" bigint DEFAULT 0 NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_credit_use_key" UNIQUE("tenant_id","idempotency_key","remainder_id"),
	CONSTRAINT "reservation_credit_use_amount_check" CHECK ("reservation_customer_credit_uses"."amount_idr" > 0 AND "reservation_customer_credit_uses"."returned_idr" >= 0 AND "reservation_customer_credit_uses"."returned_idr" <= "reservation_customer_credit_uses"."amount_idr"),
	CONSTRAINT "reservation_customer_credit_uses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reservation_customer_credit_uses_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reservation_credit_use_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reservation_credit_use_remainder_fk" FOREIGN KEY ("tenant_id","remainder_id") REFERENCES "public"."reservation_deposit_remainders"("tenant_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "reservation_credit_use_session_fk" FOREIGN KEY ("tenant_id","table_session_id") REFERENCES "public"."table_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "pos_deposit_refunds_order_idx" ON "pos_deposit_refunds" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "reservation_credit_use_session_idx" ON "reservation_customer_credit_uses" USING btree ("tenant_id","table_session_id");--> statement-breakpoint
CREATE INDEX "reservation_dp_remainder_profile_idx" ON "reservation_deposit_remainders" USING btree ("tenant_id","customer_profile_id");
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.pos_deposit_refunds'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.pos_deposit_refunds'::regclass);

--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reservation_deposit_remainders'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.reservation_deposit_remainders'::regclass);

--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.reservation_customer_credit_uses'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.reservation_customer_credit_uses'::regclass);

--> statement-breakpoint
CREATE TRIGGER pos_deposit_refunds_append_only_trg BEFORE UPDATE OR DELETE ON public.pos_deposit_refunds FOR EACH ROW EXECUTE FUNCTION app.pos_append_only();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.pos_deposit_refunds FROM legend_app;
