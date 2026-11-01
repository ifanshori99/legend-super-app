CREATE TABLE "core_storage_objects" (
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"purpose" varchar(32) NOT NULL,
	"object_key" text NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"thumbnail_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_storage_objects_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);

--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.core_storage_objects'::regclass);
