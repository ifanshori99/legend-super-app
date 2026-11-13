-- New empty tenant-level table: no anonymous lookups or outlet exceptions.
SELECT app.enforce_tenant_rls('public.ai_chatgpt_connections'::regclass);
