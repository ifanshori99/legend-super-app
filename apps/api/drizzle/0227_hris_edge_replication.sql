-- HRIS edge replication (bead legend-hwn02, C1; design
-- docs/design/hris-edge-replication.md section 8). Provisional number 0227,
-- renumbered by the merge train if taken. New empty tables only, plus the
-- attendance_logs method CHECK widened with 'outlet_device'. The foreign keys
-- sit inside CREATE TABLE (docs/plan/contracts.md pattern 1): no validation
-- scan, so a plain non-superuser migrator needs no FORCE RLS lift.
CREATE TABLE "edge_attendance_qr_keys" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"day_index" integer NOT NULL,
	"key" "bytea" NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_attendance_qr_keys_tenant_id_outlet_id_day_index_pk" PRIMARY KEY("tenant_id","outlet_id","day_index"),
	CONSTRAINT "edge_attendance_qr_keys_key_check" CHECK (octet_length("edge_attendance_qr_keys"."key") = 32),
	CONSTRAINT "edge_attendance_qr_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_attendance_qr_keys_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_attendance_qr_keys_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "edge_people_sync_state" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"snapshot_etag" text,
	"snapshot_generated_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"selfie_seal_kid" text,
	"selfie_seal_public_key" text,
	CONSTRAINT "edge_people_sync_state_tenant_id_outlet_id_pk" PRIMARY KEY("tenant_id","outlet_id"),
	CONSTRAINT "edge_people_sync_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_people_sync_state_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_people_sync_state_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "edge_received_selfies" (
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"sealed_sha256" "bytea" NOT NULL,
	"state" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edge_received_selfies_tenant_id_object_id_pk" PRIMARY KEY("tenant_id","object_id"),
	CONSTRAINT "edge_received_selfies_state_check" CHECK ("edge_received_selfies"."state" IN ('stored', 'discarded')),
	CONSTRAINT "edge_received_selfies_sealed_sha256_check" CHECK (octet_length("edge_received_selfies"."sealed_sha256") = 32),
	CONSTRAINT "edge_received_selfies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_received_selfies_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_received_selfies_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "edge_selfie_uploads" (
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"attendance_log_id" uuid,
	"file_path" text NOT NULL,
	"sealed_sha256" "bytea" NOT NULL,
	"sealed_bytes" integer NOT NULL,
	"seal_kid" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	CONSTRAINT "edge_selfie_uploads_tenant_id_object_id_pk" PRIMARY KEY("tenant_id","object_id"),
	CONSTRAINT "edge_selfie_uploads_state_check" CHECK ("edge_selfie_uploads"."state" IN ('pending', 'uploaded', 'rejected', 'expired')),
	CONSTRAINT "edge_selfie_uploads_sealed_sha256_check" CHECK (octet_length("edge_selfie_uploads"."sealed_sha256") = 32),
	CONSTRAINT "edge_selfie_uploads_attempts_check" CHECK ("edge_selfie_uploads"."attempts" >= 0),
	CONSTRAINT "edge_selfie_uploads_sealed_bytes_check" CHECK ("edge_selfie_uploads"."sealed_bytes" > 0),
	CONSTRAINT "edge_selfie_uploads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_selfie_uploads_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_selfie_uploads_outlet_fk" FOREIGN KEY ("tenant_id","outlet_id") REFERENCES "public"."outlets"("tenant_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "attendance_logs" DROP CONSTRAINT "attendance_logs_method_check";--> statement-breakpoint
CREATE INDEX "edge_selfie_uploads_state_next_idx" ON "edge_selfie_uploads" USING btree ("state","next_attempt_at");--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_method_check" CHECK ("attendance_logs"."method" IN ('selfie_geo', 'rotating_qr', 'manual_correction', 'outlet_device'));
--> statement-breakpoint
-- HRIS edge replication (bead legend-hwn02, C1; design
-- docs/design/hris-edge-replication.md section 8). Folded into migration 0227
-- after the CREATE TABLEs. The three edge tables are tenant + outlet owned;
-- edge_received_selfies (cloud) is tenant RLS only and append-only.
SELECT app.enforce_tenant_rls('public.edge_people_sync_state'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_people_sync_state'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_attendance_qr_keys'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_attendance_qr_keys'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_selfie_uploads'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_selfie_uploads'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_received_selfies'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_received_selfies'::regclass);
--> statement-breakpoint
CREATE TRIGGER edge_received_selfies_append_only BEFORE UPDATE OR DELETE ON public.edge_received_selfies
FOR EACH ROW EXECUTE FUNCTION app.reject_edge_sync_log_mutation();
