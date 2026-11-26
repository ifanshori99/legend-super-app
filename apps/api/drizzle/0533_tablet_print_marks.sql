-- 1272 P3 (legend-wasr7.4): which kitchen tickets and shift reports a tablet
-- printer was already asked to print, so a second print always carries
-- "CETAK ULANG". Temporary number 0533 (0532 is the last on int/rc2); the merge
-- train may renumber. New table only. Foreign keys are inline in CREATE TABLE
-- (contracts.md legend-m007 pattern 1, as 0530).
CREATE TABLE "tablet_print_marks" (
	"tenant_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"ref_id" varchar(40) NOT NULL,
	"outlet_id" uuid NOT NULL,
	"first_printed_by" text NOT NULL,
	"first_printed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_printed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"print_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tablet_print_marks_tenant_id_kind_ref_id_pk" PRIMARY KEY("tenant_id","kind","ref_id"),
	CONSTRAINT "tablet_print_marks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "tablet_print_marks_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "tablet_print_marks_kind_check" CHECK ("tablet_print_marks"."kind" IN ('kds_ticket', 'shift_report')),
	CONSTRAINT "tablet_print_marks_count_check" CHECK ("tablet_print_marks"."print_count" > 0)
);
--> statement-breakpoint
-- Tenant RLS (TEN-01/02) plus the outlet backstop (TEN-03).
SELECT app.enforce_tenant_rls('public.tablet_print_marks'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.tablet_print_marks'::regclass);
