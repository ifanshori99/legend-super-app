-- Custom SQL migration file, put your code below! ---
-- legend-2dnh: a refund the system creates (POS or QR late payment,
-- reservation deposit) opens its approval chain at creation, but
-- approval_requests.requested_by is a NOT NULL foreign key to "user". Give the
-- chain a reserved requester: banned, no account row (it cannot sign in), no
-- role and no assignment (it cannot decide, and the decided_by <> requested_by
-- check keeps it out of every chain it opened). The id is the constant
-- SYSTEM_APPROVAL_REQUESTER in payment-refund.service.ts.
INSERT INTO "user" (id, name, email, email_verified, banned, ban_reason, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000002', 'Sistem', 'system@legend.invalid', false, true, 'system account', now(), now())
ON CONFLICT (id) DO NOTHING;
