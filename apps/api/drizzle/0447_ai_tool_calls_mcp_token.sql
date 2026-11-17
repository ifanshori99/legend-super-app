-- legend-39d.4: which MCP token made a tool call (audit). Nullable: app calls
-- and rows written before this migration have none. Composite FK to
-- mcp_tokens like mcp_client_id. ai_tool_calls stays insert-only (REVOKE
-- UPDATE/DELETE from 0114_ai_rls.sql) and tenant RLS is unchanged: ADD COLUMN
-- keeps both. No backfill, so no NO FORCE ROW LEVEL SECURITY dance.
ALTER TABLE "ai_tool_calls" ADD COLUMN "mcp_token_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_mcp_token_fk" FOREIGN KEY ("tenant_id","mcp_token_id") REFERENCES "public"."mcp_tokens"("tenant_id","id") ON DELETE no action ON UPDATE no action;
