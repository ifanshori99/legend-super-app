CREATE TABLE "pos_shift_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"counts" jsonb NOT NULL,
	"counts_fingerprint" varchar(64) NOT NULL,
	"counted_idr" bigint NOT NULL,
	"expected_idr" bigint NOT NULL,
	"variance_idr" bigint NOT NULL,
	"submitted_by" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_shift_counts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_shift_counts_sequence_key" UNIQUE("tenant_id","shift_id","sequence"),
	CONSTRAINT "pos_shift_counts_idempotency_key" UNIQUE("tenant_id","shift_id","idempotency_key"),
	CONSTRAINT "pos_shift_counts_sequence_check" CHECK ("pos_shift_counts"."sequence" >= 1),
	CONSTRAINT "pos_shift_counts_counted_check" CHECK ("pos_shift_counts"."counted_idr" >= 0),
	CONSTRAINT "pos_shift_counts_variance_check" CHECK ("pos_shift_counts"."variance_idr" = "pos_shift_counts"."counted_idr" - "pos_shift_counts"."expected_idr"),
	CONSTRAINT "pos_shift_counts_counts_check" CHECK (jsonb_typeof("pos_shift_counts"."counts") = 'array')
);
--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD COLUMN "count_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_shift_counts" ADD CONSTRAINT "pos_shift_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shift_counts" ADD CONSTRAINT "pos_shift_counts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shift_counts" ADD CONSTRAINT "pos_shift_counts_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shift_counts" ADD CONSTRAINT "pos_shift_counts_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."pos_shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shift_counts" ADD CONSTRAINT "pos_shift_counts_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pos_shift_counts_shift_idx" ON "pos_shift_counts" USING btree ("tenant_id","shift_id","sequence");--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_closed_count_check" CHECK ("pos_shifts"."status" <> 'closed' OR "pos_shifts"."count_id" IS NOT NULL);