-- legend-39d.4: replace the `[ai:<id>]` marker that the TL-15 executor appended
-- to promotions.description with a real idempotency column. A retried
-- execution of the same action request now hits the partial unique index
-- instead of creating a second promotion (money: a double promo would give
-- the discount twice). Nullable: promotions made by hand have no request.
-- Old rows are backfilled from the marker. If a past retry already made two
-- promotions with one marker, only the earliest keeps the key (the unique
-- index must be creatable); the later one stays a normal promotion.
-- No FK on purpose: the column is a replay guard, not a join target.
ALTER TABLE "promotions" ADD COLUMN "ai_action_request_id" uuid;--> statement-breakpoint
ALTER TABLE public.promotions NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
WITH marked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY tenant_id, lower(substring(description from '\[ai:([0-9a-fA-F-]{36})\]\s*$'))
      ORDER BY created_at, id
    ) AS rn,
    lower(substring(description from '\[ai:([0-9a-fA-F-]{36})\]\s*$'))::uuid AS request_id
  FROM public.promotions
  WHERE description ~ '\[ai:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\]\s*$'
)
UPDATE public.promotions AS p
SET ai_action_request_id = marked.request_id
FROM marked
WHERE p.id = marked.id AND marked.rn = 1;
--> statement-breakpoint
ALTER TABLE public.promotions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "promotions_tenant_ai_action_request_key" ON "promotions" USING btree ("tenant_id","ai_action_request_id") WHERE "promotions"."ai_action_request_id" IS NOT NULL;
