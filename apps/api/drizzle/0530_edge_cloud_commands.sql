-- Edge -> cloud commands (card F1, brief 1269). Expand-only: two new tables,
-- nothing existing changes; deploy the cloud before the edge. Foreign keys are
-- declared inline while the tables are empty (see 0352).
CREATE TABLE "edge_command_executions" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"edge_instance_id" uuid NOT NULL,
	"kind" varchar(60) NOT NULL,
	"body_sha256" varchar(64) NOT NULL,
	"status" varchar(20) NOT NULL,
	"result" jsonb,
	"code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "edge_command_executions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "edge_command_executions_kind_check" CHECK ("edge_command_executions"."kind" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
	CONSTRAINT "edge_command_executions_sha_check" CHECK ("edge_command_executions"."body_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "edge_command_executions_status_check" CHECK (("edge_command_executions"."status" = 'executing' AND "edge_command_executions"."decided_at" IS NULL AND "edge_command_executions"."result" IS NULL AND "edge_command_executions"."code" IS NULL)
        OR ("edge_command_executions"."status" = 'succeeded' AND "edge_command_executions"."decided_at" IS NOT NULL AND "edge_command_executions"."result" IS NOT NULL AND "edge_command_executions"."code" IS NULL)
        OR ("edge_command_executions"."status" = 'refused' AND "edge_command_executions"."decided_at" IS NOT NULL AND "edge_command_executions"."result" IS NULL AND "edge_command_executions"."code" IS NOT NULL)
        OR ("edge_command_executions"."status" IN ('expired', 'absent') AND "edge_command_executions"."decided_at" IS NOT NULL AND "edge_command_executions"."result" IS NULL AND "edge_command_executions"."code" IS NULL)),
	CONSTRAINT "edge_command_executions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_command_executions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_command_executions_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "edge_command_requests" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"edge_node_id" uuid NOT NULL,
	"kind" varchar(60) NOT NULL,
	"subject_type" varchar(40) NOT NULL,
	"subject_id" varchar(36) NOT NULL,
	"body" text NOT NULL,
	"body_sha256" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "edge_command_requests_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "edge_command_requests_kind_check" CHECK ("edge_command_requests"."kind" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
	CONSTRAINT "edge_command_requests_sha_check" CHECK ("edge_command_requests"."body_sha256" ~ '^[0-9a-f]{64}$' AND "edge_command_requests"."body_sha256" = encode(sha256(convert_to("edge_command_requests"."body", 'UTF8')), 'hex')),
	CONSTRAINT "edge_command_requests_status_check" CHECK (("edge_command_requests"."status" IN ('pending', 'unknown') AND "edge_command_requests"."settled_at" IS NULL AND "edge_command_requests"."result" IS NULL AND "edge_command_requests"."code" IS NULL)
        OR ("edge_command_requests"."status" = 'succeeded' AND "edge_command_requests"."settled_at" IS NOT NULL AND "edge_command_requests"."result" IS NOT NULL AND "edge_command_requests"."code" IS NULL)
        OR ("edge_command_requests"."status" = 'refused' AND "edge_command_requests"."settled_at" IS NOT NULL AND "edge_command_requests"."result" IS NULL AND "edge_command_requests"."code" IS NOT NULL)
        OR ("edge_command_requests"."status" IN ('expired', 'absent') AND "edge_command_requests"."settled_at" IS NOT NULL AND "edge_command_requests"."result" IS NULL AND "edge_command_requests"."code" IS NULL)),
	CONSTRAINT "edge_command_requests_attempts_check" CHECK ("edge_command_requests"."attempts" >= 0 AND ("edge_command_requests"."attempts" > 0) = ("edge_command_requests"."last_attempt_at" IS NOT NULL) AND ("edge_command_requests"."status" <> 'pending' OR "edge_command_requests"."attempts" = 0)),
	CONSTRAINT "edge_command_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_command_requests_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "edge_command_requests_edge_node_fk" FOREIGN KEY ("tenant_id","outlet_id","edge_node_id") REFERENCES "public"."edge_nodes"("tenant_id","outlet_id","id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "edge_command_executions_node_idx" ON "edge_command_executions" USING btree ("tenant_id","edge_node_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "edge_command_requests_open_subject_key" ON "edge_command_requests" USING btree ("tenant_id","outlet_id","subject_type","subject_id") WHERE "edge_command_requests"."status" IN ('pending', 'unknown');--> statement-breakpoint
CREATE INDEX "edge_command_requests_open_idx" ON "edge_command_requests" USING btree ("tenant_id","outlet_id","created_at") WHERE "edge_command_requests"."status" IN ('pending', 'unknown');
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_command_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_command_requests'::regclass);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_command_executions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_command_executions'::regclass);
--> statement-breakpoint
-- The key and the frozen body never change, the state only moves forward
-- (pending -> unknown -> final) and a final row is frozen. Never deleted.
CREATE FUNCTION app.guard_edge_command_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'edge commands are never deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.id <> OLD.id OR NEW.edge_node_id <> OLD.edge_node_id
     OR NEW.kind <> OLD.kind OR NEW.subject_type <> OLD.subject_type
     OR NEW.subject_id <> OLD.subject_id OR NEW.body <> OLD.body
     OR NEW.body_sha256 <> OLD.body_sha256 OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an edge command is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status NOT IN ('pending', 'unknown')
     OR (OLD.status = 'unknown' AND NEW.status = 'pending')
     OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'an edge command state only moves forward' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_command_requests_guard BEFORE UPDATE OR DELETE ON public.edge_command_requests
FOR EACH ROW EXECUTE FUNCTION app.guard_edge_command_request();
--> statement-breakpoint
-- The cloud record: only the executing transaction moves it, once, to its
-- outcome; the key is spent forever (a tombstone never becomes an execution).
CREATE FUNCTION app.guard_edge_command_execution() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'edge command outcomes are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'executing' OR NEW.status NOT IN ('succeeded', 'refused', 'expired')
     OR NEW.tenant_id <> OLD.tenant_id OR NEW.outlet_id <> OLD.outlet_id
     OR NEW.id <> OLD.id OR NEW.edge_node_id <> OLD.edge_node_id
     OR NEW.edge_instance_id <> OLD.edge_instance_id OR NEW.kind <> OLD.kind
     OR NEW.body_sha256 <> OLD.body_sha256 OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an edge command outcome is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER edge_command_executions_guard BEFORE UPDATE OR DELETE ON public.edge_command_executions
FOR EACH ROW EXECUTE FUNCTION app.guard_edge_command_execution();
