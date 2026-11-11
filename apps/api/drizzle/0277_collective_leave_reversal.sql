-- legend-qmte follow-up (502 item A, decision M1): a collective-leave deduction
-- whose day was worked later (flagged review accepted, approved correction,
-- edge sync) is reversed by a compensating +1 ledger row, never a delete.
-- `kind` is widened (the new kind is 25 characters), the kind check accepts it,
-- and a unique partial index keeps it once per employee and date, so a replay
-- or a racing worker never gives the day back twice. RLS and grants of
-- leave_accruals (0078) are unchanged: the table is the same, no new table.
ALTER TABLE "leave_accruals" ALTER COLUMN "kind" TYPE varchar(30);--> statement-breakpoint
ALTER TABLE "leave_accruals" DROP CONSTRAINT "leave_accruals_kind_check";--> statement-breakpoint
ALTER TABLE "leave_accruals" ADD CONSTRAINT "leave_accruals_kind_check" CHECK ("leave_accruals"."kind" IN ('grant', 'carry_over', 'carry_over_expiry', 'collective_leave', 'collective_leave_reversal'));--> statement-breakpoint
CREATE UNIQUE INDEX "leave_accruals_collective_leave_reversal_key" ON "leave_accruals" USING btree ("tenant_id","employee_id","period") WHERE "leave_accruals"."kind" = 'collective_leave_reversal';
