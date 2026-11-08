CREATE TABLE "domain_event_gap_requests" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid,
	"destination" varchar(255) NOT NULL,
	"aggregate_type" varchar(255) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"missing_sequence" bigint NOT NULL,
	"first_requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "domain_event_gap_requests_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "domain_event_gap_requests_gap_key" UNIQUE("tenant_id","destination","aggregate_type","aggregate_id","missing_sequence"),
	CONSTRAINT "domain_event_gap_requests_sequence_check" CHECK ("domain_event_gap_requests"."missing_sequence" >= 1),
	CONSTRAINT "domain_event_gap_requests_count_check" CHECK ("domain_event_gap_requests"."request_count" >= 1)
);
--> statement-breakpoint
CREATE INDEX "domain_event_gap_requests_open_idx" ON "domain_event_gap_requests" USING btree ("tenant_id","resolved_at");