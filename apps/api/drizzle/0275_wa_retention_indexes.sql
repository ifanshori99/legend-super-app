-- WhatsApp inbound retention (card w8dfz.2). The daily purge of
-- wa_inbound_messages (90 days) and finished login_challenges (30 days) walks
-- both tables by created_at across all tenants; neither table had an index that
-- serves that scan. Temporary number 0275; the merge train assigns the final one.
CREATE INDEX "wa_inbound_messages_created_idx" ON "wa_inbound_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "login_challenges_created_idx" ON "login_challenges" USING btree ("created_at");
