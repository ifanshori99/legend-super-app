-- legend-94q2l: refund from a failed-item approval (ORD-09). payment_refunds gets a
-- nullable order_issue_id (composite FK to order_issues) and a partial unique index so
-- one issue opens at most one live refund; a failed refund frees the issue for a retry.
-- Lift FORCE RLS on the child and the parent so a non-superuser migrator can validate the
-- FK (docs/plan/contracts.md pattern 2); restored after the FK.
ALTER TABLE "payment_refunds" ADD COLUMN "order_issue_id" uuid;--> statement-breakpoint
ALTER TABLE public.order_issues NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.payment_refunds NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_order_issue_fk" FOREIGN KEY ("tenant_id","order_issue_id") REFERENCES "public"."order_issues"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE public.payment_refunds FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.order_issues FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "payment_refunds_order_issue_idx" ON "payment_refunds" USING btree ("tenant_id","order_issue_id") WHERE "payment_refunds"."order_issue_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_order_issue_unique" ON "payment_refunds" USING btree ("tenant_id","order_issue_id") WHERE "payment_refunds"."order_issue_id" IS NOT NULL AND "payment_refunds"."status" <> 'failed';
