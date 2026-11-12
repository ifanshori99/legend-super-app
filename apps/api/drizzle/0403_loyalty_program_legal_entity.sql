ALTER TABLE "loyalty_programs" ADD COLUMN "legal_entity_id" uuid;
--> statement-breakpoint
-- FK validation runs as the non-superuser migrator; restore FORCE in the same transaction.
ALTER TABLE public.loyalty_programs NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.legal_entities NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD CONSTRAINT "loyalty_programs_legal_entity_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE public.legal_entities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.loyalty_programs FORCE ROW LEVEL SECURITY;
