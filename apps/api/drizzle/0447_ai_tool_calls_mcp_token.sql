-- legend-39d.4: which MCP token made a tool call (audit). Nullable: app calls
-- and rows written before this migration have none. Composite FK to
-- mcp_tokens like mcp_client_id. ai_tool_calls stays insert-only (REVOKE
-- UPDATE/DELETE from 0114_ai_rls.sql) and tenant RLS is unchanged: ADD COLUMN
-- keeps both. No backfill, but adding the FK validates existing rows with a
-- join of ai_tool_calls with mcp_tokens, which raises "tenant context is required" under FORCE
-- ROW LEVEL SECURITY when the migrator is a plain table owner (no SUPERUSER, no
-- BYPASSRLS; see 0065). Lift FORCE on both tables for this transaction only;
-- it is restored at the end of this migration (drizzle applies pending
-- migrations in one transaction).
ALTER TABLE public.ai_tool_calls NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mcp_tokens NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD COLUMN "mcp_token_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_mcp_token_fk" FOREIGN KEY ("tenant_id","mcp_token_id") REFERENCES "public"."mcp_tokens"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE public.ai_tool_calls FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mcp_tokens FORCE ROW LEVEL SECURITY;
