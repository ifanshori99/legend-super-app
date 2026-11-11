-- Card lnbtp: remember the account a WhatsApp login challenge created for a
-- new sender, so "Bukan saya" can remove it again when it was never used.
-- Null for older rows and for senders that already had an account.
ALTER TABLE "login_challenges" ADD COLUMN "auto_created_user_id" text;
