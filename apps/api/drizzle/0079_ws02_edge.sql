CREATE TABLE "edge_sync_conflict_resolutions" (
	"id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"conflict_id" uuid NOT NULL,
	"action" varchar(20) NOT NULL,
	"outcome" varchar(20) NOT NULL,
	"error" text,
	"note" varchar(500) NOT NULL,
	"resolved_by" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_sync_conflict_resolutions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "edge_sync_conflict_resolutions_action_check" CHECK ("edge_sync_conflict_resolutions"."action" IN ('replayed', 'dismissed')),
	CONSTRAINT "edge_sync_conflict_resolutions_outcome_check" CHECK (("edge_sync_conflict_resolutions"."action" = 'replayed' AND "edge_sync_conflict_resolutions"."outcome" IN ('applied', 'failed')) OR ("edge_sync_conflict_resolutions"."action" = 'dismissed' AND "edge_sync_conflict_resolutions"."outcome" = 'dismissed')),
	CONSTRAINT "edge_sync_conflict_resolutions_error_check" CHECK (("edge_sync_conflict_resolutions"."outcome" = 'failed') = ("edge_sync_conflict_resolutions"."error" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "edge_nodes" ADD COLUMN "previous_credential_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "edge_nodes" ADD COLUMN "previous_credential_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pos_orders" ADD COLUMN "is_training" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "edge_sync_conflict_resolutions" ADD CONSTRAINT "edge_sync_conflict_resolutions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_sync_conflict_resolutions" ADD CONSTRAINT "edge_sync_conflict_resolutions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_sync_conflict_resolutions" ADD CONSTRAINT "edge_sync_conflict_resolutions_conflict_fk" FOREIGN KEY ("tenant_id","conflict_id") REFERENCES "public"."edge_sync_conflicts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edge_sync_conflict_resolutions_conflict_idx" ON "edge_sync_conflict_resolutions" USING btree ("tenant_id","conflict_id","resolved_at");--> statement-breakpoint
ALTER TABLE "edge_nodes" ADD CONSTRAINT "edge_nodes_previous_credential_check" CHECK (("edge_nodes"."previous_credential_hash" IS NULL AND "edge_nodes"."previous_credential_expires_at" IS NULL) OR ("edge_nodes"."previous_credential_hash" ~ '^[0-9a-f]{64}$' AND "edge_nodes"."previous_credential_expires_at" IS NOT NULL));