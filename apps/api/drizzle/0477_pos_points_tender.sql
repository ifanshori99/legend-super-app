-- 936 (legend-hpgyw part B): points paid as a POS tender. A `redeem` ledger row
-- may now come from a POS tender (source_type 'pos_tender', source_id = the
-- tender id) besides a reward redemption. The sale's loyalty_liability move is
-- booked by order.paid (paidPointsIdr), never by a points.redeemed journal.
-- Keep this file and the schema (crm-ledger.ts) in step.
-- point_ledger is written on every paid order: wait at most 5s for its
-- ACCESS EXCLUSIVE lock, then restore the migrator's value (contracts.md,
-- bead legend-76azz).
SELECT set_config('legend.lock_timeout_before_0670', current_setting('lock_timeout'), true);--> statement-breakpoint
SELECT set_config('lock_timeout', '5s', true);--> statement-breakpoint
ALTER TABLE "point_ledger" DROP CONSTRAINT "point_ledger_source_type_check";--> statement-breakpoint
ALTER TABLE "point_ledger" ADD CONSTRAINT "point_ledger_source_type_check" CHECK (CASE "point_ledger"."type"
            WHEN 'earn' THEN "point_ledger"."source_type" IN ('order', 'table_claim')
            WHEN 'bonus' THEN "point_ledger"."source_type" IN ('mission', 'referral', 'birthday', 'adjustment')
            WHEN 'redeem' THEN "point_ledger"."source_type" IN ('reward_redemption', 'pos_tender')
            WHEN 'expire' THEN "point_ledger"."source_type" = 'expiry'
            WHEN 'reverse' THEN "point_ledger"."source_type" IN ('refund', 'void')
            ELSE "point_ledger"."source_type" = 'adjustment' END) NOT VALID;--> statement-breakpoint
ALTER TABLE "point_ledger" VALIDATE CONSTRAINT "point_ledger_source_type_check";
--> statement-breakpoint
SELECT set_config('lock_timeout', COALESCE(NULLIF(current_setting('legend.lock_timeout_before_0670', true), ''), current_setting('lock_timeout')), true);
