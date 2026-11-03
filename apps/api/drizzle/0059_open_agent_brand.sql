CREATE TABLE "edge_inbound_events" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"direction" varchar(20) NOT NULL,
	"event_id" uuid NOT NULL,
	"link_seq" bigint NOT NULL,
	"aggregate_type" varchar(255) NOT NULL,
	"aggregate_id" varchar(36) NOT NULL,
	"aggregate_sequence" bigint NOT NULL,
	"kind" varchar(20) NOT NULL,
	"outcome" varchar(20) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_inbound_events_tenant_id_edge_node_id_direction_event_id_pk" PRIMARY KEY("tenant_id","edge_node_id","direction","event_id"),
	CONSTRAINT "edge_inbound_events_direction_check" CHECK ("edge_inbound_events"."direction" IN ('edge_to_cloud', 'cloud_to_edge')),
	CONSTRAINT "edge_inbound_events_kind_check" CHECK ("edge_inbound_events"."kind" IN ('master_data', 'transaction_event')),
	CONSTRAINT "edge_inbound_events_outcome_check" CHECK ("edge_inbound_events"."outcome" IN ('applied', 'superseded', 'conflict'))
);
--> statement-breakpoint
CREATE TABLE "edge_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"role" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"label" varchar(255) NOT NULL,
	"version" varchar(255) DEFAULT 'unknown' NOT NULL,
	"credential_hash" varchar(64) NOT NULL,
	"credential_issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"last_sync_cursor" varchar(1024),
	"registered_by" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_nodes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "edge_nodes_tenant_outlet_id_key" UNIQUE("tenant_id","outlet_id","id"),
	CONSTRAINT "edge_nodes_role_check" CHECK ("edge_nodes"."role" IN ('primary', 'standby')),
	CONSTRAINT "edge_nodes_status_check" CHECK (("edge_nodes"."status" = 'active' AND "edge_nodes"."revoked_at" IS NULL) OR ("edge_nodes"."status" = 'revoked' AND "edge_nodes"."revoked_at" IS NOT NULL)),
	CONSTRAINT "edge_nodes_credential_hash_check" CHECK ("edge_nodes"."credential_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "edge_outbound_queue" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"direction" varchar(20) NOT NULL,
	"link_seq" bigint NOT NULL,
	"event_id" uuid NOT NULL,
	"aggregate_type" varchar(255) NOT NULL,
	"aggregate_id" varchar(36) NOT NULL,
	"aggregate_sequence" bigint NOT NULL,
	"kind" varchar(20) NOT NULL,
	"event" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp with time zone,
	CONSTRAINT "edge_outbound_queue_tenant_id_edge_node_id_direction_link_seq_pk" PRIMARY KEY("tenant_id","edge_node_id","direction","link_seq"),
	CONSTRAINT "edge_outbound_queue_event_key" UNIQUE("tenant_id","edge_node_id","direction","event_id"),
	CONSTRAINT "edge_outbound_queue_aggregate_sequence_key" UNIQUE("tenant_id","edge_node_id","direction","aggregate_type","aggregate_id","aggregate_sequence"),
	CONSTRAINT "edge_outbound_queue_direction_check" CHECK ("edge_outbound_queue"."direction" IN ('edge_to_cloud', 'cloud_to_edge')),
	CONSTRAINT "edge_outbound_queue_kind_check" CHECK ("edge_outbound_queue"."kind" IN ('master_data', 'transaction_event')),
	CONSTRAINT "edge_outbound_queue_master_direction_check" CHECK ("edge_outbound_queue"."kind" <> 'master_data' OR "edge_outbound_queue"."direction" = 'cloud_to_edge'),
	CONSTRAINT "edge_outbound_queue_seq_check" CHECK ("edge_outbound_queue"."link_seq" >= 1 AND "edge_outbound_queue"."aggregate_sequence" >= 1),
	CONSTRAINT "edge_outbound_queue_status_check" CHECK (("edge_outbound_queue"."status" = 'pending' AND "edge_outbound_queue"."acked_at" IS NULL) OR ("edge_outbound_queue"."status" = 'acked' AND "edge_outbound_queue"."acked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "edge_sync_conflicts" (
	"id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"direction" varchar(20) NOT NULL,
	"event_id" uuid NOT NULL,
	"aggregate_type" varchar(255) NOT NULL,
	"aggregate_id" varchar(36) NOT NULL,
	"aggregate_sequence" bigint NOT NULL,
	"kind" varchar(20) NOT NULL,
	"reason" varchar(50) NOT NULL,
	"resolution" varchar(20) NOT NULL,
	"existing_sequence" bigint NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_sync_conflicts_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "edge_sync_conflicts_event_key" UNIQUE("tenant_id","edge_node_id","direction","event_id"),
	CONSTRAINT "edge_sync_conflicts_direction_check" CHECK ("edge_sync_conflicts"."direction" IN ('edge_to_cloud', 'cloud_to_edge')),
	CONSTRAINT "edge_sync_conflicts_kind_check" CHECK ("edge_sync_conflicts"."kind" IN ('master_data', 'transaction_event')),
	CONSTRAINT "edge_sync_conflicts_resolution_check" CHECK ("edge_sync_conflicts"."resolution" IN ('cloud_wins', 'append_only'))
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"direction" varchar(20) NOT NULL,
	"next_out_seq" bigint DEFAULT 0 NOT NULL,
	"acked_out_seq" bigint DEFAULT 0 NOT NULL,
	"received_in_seq" bigint DEFAULT 0 NOT NULL,
	"last_event_id" uuid,
	"last_acked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_cursors_tenant_id_edge_node_id_direction_pk" PRIMARY KEY("tenant_id","edge_node_id","direction"),
	CONSTRAINT "sync_cursors_direction_check" CHECK ("sync_cursors"."direction" IN ('edge_to_cloud', 'cloud_to_edge')),
	CONSTRAINT "sync_cursors_seq_check" CHECK ("sync_cursors"."acked_out_seq" >= 0 AND "sync_cursors"."acked_out_seq" <= "sync_cursors"."next_out_seq" AND "sync_cursors"."received_in_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" varchar(40) NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_id" text,
	"device_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_events_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_events_order_sequence_key" UNIQUE("tenant_id","order_id","sequence"),
	CONSTRAINT "order_events_sequence_check" CHECK ("order_events"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos_approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"discount_threshold_bp" smallint NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_approval_policies_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_approval_policies_threshold_check" CHECK ("pos_approval_policies"."discount_threshold_bp" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "pos_order_approval_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"override_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"purpose" varchar(30) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_order_approval_uses_override_key" UNIQUE("tenant_id","override_id"),
	CONSTRAINT "pos_order_approval_uses_purpose_check" CHECK ("pos_order_approval_uses"."purpose" IN ('order_void', 'item_void', 'discount', 'correction_void', 'refund'))
);
--> statement-breakpoint
CREATE TABLE "pos_order_discounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"source" varchar(20) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"percent_bp" smallint,
	"amount_idr" bigint NOT NULL,
	"promo_code" varchar(40),
	"reason" varchar(30) NOT NULL,
	"reason_note" varchar(500),
	"applied_by" text NOT NULL,
	"approved_by" text,
	"approval_request_id" uuid,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_order_discounts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_order_discounts_source_check" CHECK ("pos_order_discounts"."source" IN ('promo', 'voucher', 'manual')),
	CONSTRAINT "pos_order_discounts_kind_check" CHECK ("pos_order_discounts"."kind" IN ('percent', 'amount')),
	CONSTRAINT "pos_order_discounts_percent_check" CHECK (("pos_order_discounts"."kind" = 'percent') = ("pos_order_discounts"."percent_bp" IS NOT NULL)
        AND ("pos_order_discounts"."percent_bp" IS NULL OR "pos_order_discounts"."percent_bp" BETWEEN 1 AND 10000)),
	CONSTRAINT "pos_order_discounts_amount_check" CHECK ("pos_order_discounts"."amount_idr" > 0),
	CONSTRAINT "pos_order_discounts_manual_note_check" CHECK ("pos_order_discounts"."source" <> 'manual' OR "pos_order_discounts"."reason_note" IS NOT NULL),
	CONSTRAINT "pos_order_discounts_approval_pair_check" CHECK (("pos_order_discounts"."approved_by" IS NULL) = ("pos_order_discounts"."approval_request_id" IS NULL)),
	CONSTRAINT "pos_order_discounts_removed_pair_check" CHECK (("pos_order_discounts"."removed_at" IS NULL) = ("pos_order_discounts"."removed_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "pos_order_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"operation" varchar(40) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_order_idempotency_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_order_idempotency_key" UNIQUE("tenant_id","outlet_id","key")
);
--> statement-breakpoint
CREATE TABLE "pos_order_items" (
	"item_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"held_by_cashier" boolean DEFAULT false NOT NULL,
	"fired_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason_note" varchar(500),
	"void_approval_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_order_items_pkey" PRIMARY KEY("tenant_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "pos_order_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_idr" bigint NOT NULL,
	"reason" varchar(30) NOT NULL,
	"reason_note" varchar(500) NOT NULL,
	"lines" jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"refunded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_order_refunds_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_order_refunds_amount_check" CHECK ("pos_order_refunds"."amount_idr" > 0),
	CONSTRAINT "pos_order_refunds_lines_check" CHECK (jsonb_typeof("pos_order_refunds"."lines") = 'array' AND jsonb_array_length("pos_order_refunds"."lines") > 0),
	CONSTRAINT "pos_order_refunds_approver_check" CHECK (lower("pos_order_refunds"."requested_by") <> lower("pos_order_refunds"."approved_by"))
);
--> statement-breakpoint
CREATE TABLE "pos_order_tenders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"method" varchar(20) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"payment_link_id" uuid,
	"payment_link_token_sealed" text,
	"payment_intent_id" uuid,
	"amount_idr" bigint NOT NULL,
	"received_idr" bigint,
	"change_idr" bigint,
	"reference" varchar(100),
	"edc_transaction_id" uuid,
	"points_used" integer,
	"status" varchar(20) NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"captured_by" text,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_order_tenders_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_order_tenders_method_check" CHECK ("pos_order_tenders"."method" IN ('cash', 'qris', 'va', 'ewallet', 'card', 'edc_card', 'edc_qris', 'points')),
	CONSTRAINT "pos_order_tenders_provider_check" CHECK ("pos_order_tenders"."provider" IN ('doit', 'duitku', 'edc', 'manual')),
	CONSTRAINT "pos_order_tenders_status_check" CHECK ("pos_order_tenders"."status" IN ('authorized', 'captured', 'failed', 'voided')),
	CONSTRAINT "pos_order_tenders_amount_check" CHECK ("pos_order_tenders"."amount_idr" > 0),
	CONSTRAINT "pos_order_tenders_cash_check" CHECK (("pos_order_tenders"."method" = 'cash') = ("pos_order_tenders"."received_idr" IS NOT NULL)
        AND ("pos_order_tenders"."received_idr" IS NULL) = ("pos_order_tenders"."change_idr" IS NULL)
        AND ("pos_order_tenders"."received_idr" IS NULL OR "pos_order_tenders"."change_idr" = "pos_order_tenders"."received_idr" - "pos_order_tenders"."amount_idr")
        AND ("pos_order_tenders"."change_idr" IS NULL OR "pos_order_tenders"."change_idr" >= 0)),
	CONSTRAINT "pos_order_tenders_points_check" CHECK (("pos_order_tenders"."method" = 'points') = ("pos_order_tenders"."points_used" IS NOT NULL)),
	CONSTRAINT "pos_order_tenders_resolved_check" CHECK (("pos_order_tenders"."status" = 'authorized') = ("pos_order_tenders"."resolved_at" IS NULL)),
	CONSTRAINT "pos_order_tenders_link_pair_check" CHECK (("pos_order_tenders"."payment_link_id" IS NULL) = ("pos_order_tenders"."payment_link_token_sealed" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "pos_order_voids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"receipt_number" varchar(30) NOT NULL,
	"amount_idr" bigint NOT NULL,
	"reason" varchar(30) NOT NULL,
	"reason_note" varchar(500) NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"voided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_order_voids_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pos_order_voids_order_key" UNIQUE("tenant_id","order_id"),
	CONSTRAINT "pos_order_voids_amount_check" CHECK ("pos_order_voids"."amount_idr" > 0),
	CONSTRAINT "pos_order_voids_approver_check" CHECK (lower("pos_order_voids"."requested_by") <> lower("pos_order_voids"."approved_by"))
);
--> statement-breakpoint
CREATE TABLE "pos_orders" (
	"order_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"channel" varchar(20) NOT NULL,
	"external_ref" varchar(100),
	"shift_id" uuid,
	"device_id" uuid,
	"cashier_id" text,
	"hold_items" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"void_reason_note" varchar(500),
	"void_approved_by" text,
	"void_approval_request_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_orders_pkey" PRIMARY KEY("tenant_id","order_id"),
	CONSTRAINT "pos_orders_channel_check" CHECK ("pos_orders"."channel" IN ('pos', 'captain', 'gofood', 'grabfood', 'shopeefood', 'reservation', 'kiosk')),
	CONSTRAINT "pos_orders_version_check" CHECK ("pos_orders"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "edge_inbound_events" ADD CONSTRAINT "edge_inbound_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_inbound_events" ADD CONSTRAINT "edge_inbound_events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_inbound_events" ADD CONSTRAINT "edge_inbound_events_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_nodes" ADD CONSTRAINT "edge_nodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_nodes" ADD CONSTRAINT "edge_nodes_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_nodes" ADD CONSTRAINT "edge_nodes_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_outbound_queue" ADD CONSTRAINT "edge_outbound_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_outbound_queue" ADD CONSTRAINT "edge_outbound_queue_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_outbound_queue" ADD CONSTRAINT "edge_outbound_queue_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_sync_conflicts" ADD CONSTRAINT "edge_sync_conflicts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_sync_conflicts" ADD CONSTRAINT "edge_sync_conflicts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_sync_conflicts" ADD CONSTRAINT "edge_sync_conflicts_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_approval_policies" ADD CONSTRAINT "pos_approval_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_approval_policies" ADD CONSTRAINT "pos_approval_policies_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_approval_policies" ADD CONSTRAINT "pos_approval_policies_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_approval_uses" ADD CONSTRAINT "pos_order_approval_uses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_approval_uses" ADD CONSTRAINT "pos_order_approval_uses_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_approval_uses" ADD CONSTRAINT "pos_order_approval_uses_pos_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."pos_orders"("tenant_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_approval_uses" ADD CONSTRAINT "pos_order_approval_uses_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_discounts" ADD CONSTRAINT "pos_order_discounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_discounts" ADD CONSTRAINT "pos_order_discounts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_discounts" ADD CONSTRAINT "pos_order_discounts_pos_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."pos_orders"("tenant_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_discounts" ADD CONSTRAINT "pos_order_discounts_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_idempotency" ADD CONSTRAINT "pos_order_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_idempotency" ADD CONSTRAINT "pos_order_idempotency_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_idempotency" ADD CONSTRAINT "pos_order_idempotency_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_items" ADD CONSTRAINT "pos_order_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_items" ADD CONSTRAINT "pos_order_items_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_items" ADD CONSTRAINT "pos_order_items_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."order_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_items" ADD CONSTRAINT "pos_order_items_pos_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."pos_orders"("tenant_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_items" ADD CONSTRAINT "pos_order_items_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_refunds" ADD CONSTRAINT "pos_order_refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_refunds" ADD CONSTRAINT "pos_order_refunds_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_refunds" ADD CONSTRAINT "pos_order_refunds_pos_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."pos_orders"("tenant_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_refunds" ADD CONSTRAINT "pos_order_refunds_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_tenders" ADD CONSTRAINT "pos_order_tenders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_tenders" ADD CONSTRAINT "pos_order_tenders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_tenders" ADD CONSTRAINT "pos_order_tenders_pos_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."pos_orders"("tenant_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_tenders" ADD CONSTRAINT "pos_order_tenders_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_voids" ADD CONSTRAINT "pos_order_voids_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_voids" ADD CONSTRAINT "pos_order_voids_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_voids" ADD CONSTRAINT "pos_order_voids_pos_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."pos_orders"("tenant_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_order_voids" ADD CONSTRAINT "pos_order_voids_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edge_inbound_events_aggregate_idx" ON "edge_inbound_events" USING btree ("tenant_id","edge_node_id","aggregate_type","aggregate_id","aggregate_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "edge_nodes_active_role_key" ON "edge_nodes" USING btree ("tenant_id","outlet_id","role") WHERE "edge_nodes"."status" = 'active';--> statement-breakpoint
CREATE INDEX "edge_outbound_queue_pending_idx" ON "edge_outbound_queue" USING btree ("tenant_id","edge_node_id","direction","status","link_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_approval_policies_outlet_key" ON "pos_approval_policies" USING btree ("tenant_id","outlet_id") WHERE "pos_approval_policies"."outlet_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_approval_policies_tenant_key" ON "pos_approval_policies" USING btree ("tenant_id") WHERE "pos_approval_policies"."outlet_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_order_discounts_one_promo_key" ON "pos_order_discounts" USING btree ("tenant_id","order_id") WHERE "pos_order_discounts"."removed_at" IS NULL AND "pos_order_discounts"."source" IN ('promo', 'voucher');--> statement-breakpoint
CREATE INDEX "pos_order_discounts_order_idx" ON "pos_order_discounts" USING btree ("tenant_id","order_id","created_at");--> statement-breakpoint
CREATE INDEX "pos_order_items_order_idx" ON "pos_order_items" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "pos_order_refunds_order_idx" ON "pos_order_refunds" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_order_tenders_payment_link_key" ON "pos_order_tenders" USING btree ("tenant_id","payment_link_id") WHERE "pos_order_tenders"."payment_link_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pos_order_tenders_order_idx" ON "pos_order_tenders" USING btree ("tenant_id","order_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_orders_external_ref_key" ON "pos_orders" USING btree ("tenant_id","outlet_id","channel","external_ref") WHERE "pos_orders"."external_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pos_orders_outlet_idx" ON "pos_orders" USING btree ("tenant_id","outlet_id","created_at");--> statement-breakpoint
CREATE INDEX "pos_orders_shift_idx" ON "pos_orders" USING btree ("tenant_id","shift_id");