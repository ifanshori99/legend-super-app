CREATE TABLE "shareholder_document_files" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"profit_entity_id" uuid NOT NULL,
	"file_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shareholder_document_files_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "shareholder_document_files_tenant_file_key" UNIQUE("tenant_id","file_key"),
	CONSTRAINT "shareholder_document_files_tenant_entity_file_key" UNIQUE("tenant_id","profit_entity_id","file_key"),
	CONSTRAINT "shareholder_document_files_content_type_check" CHECK ("shareholder_document_files"."content_type" = 'application/pdf'),
	CONSTRAINT "shareholder_document_files_size_check" CHECK ("shareholder_document_files"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "shareholder_documents" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"profit_entity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"file_key" text NOT NULL,
	"visibility" text NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shareholder_documents_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "shareholder_documents_tenant_file_key" UNIQUE("tenant_id","file_key"),
	CONSTRAINT "shareholder_documents_kind_check" CHECK ("shareholder_documents"."kind" IN ('monthly_report', 'general_meeting_minutes', 'other')),
	CONSTRAINT "shareholder_documents_visibility_check" CHECK ("shareholder_documents"."visibility" IN ('shareholders', 'management')),
	CONSTRAINT "shareholder_documents_published_check" CHECK (("shareholder_documents"."published_at" IS NULL) = ("shareholder_documents"."published_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "shareholder_document_files" ADD CONSTRAINT "shareholder_document_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shareholder_documents" ADD CONSTRAINT "shareholder_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shareholder_documents" ADD CONSTRAINT "shareholder_documents_file_fk" FOREIGN KEY ("tenant_id","profit_entity_id","file_key") REFERENCES "public"."shareholder_document_files"("tenant_id","profit_entity_id","file_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shareholder_documents_entity_created_idx" ON "shareholder_documents" USING btree ("tenant_id","profit_entity_id","created_at" DESC NULLS LAST,"id");