-- legend-qmte follow-up (F3, CTO decision): a collective-leave day given back
-- by a worked-day reversal (0277) whose `in` log is LATER rejected or
-- re-flagged (it stops qualifying) is taken back by a NEW ledger row, never a
-- delete: kind `collective_leave_rededuction` (28 characters, fits
-- varchar(30)), days -1 like the original deduction, period = the holiday
-- date. Doubt restricts payment. A unique partial index keeps it once per
-- employee and date, so a replay or a racing worker never takes the day back
-- twice; after it the day stays deducted for good (the reversal row is unique
-- too, so a log accepted again gives nothing back). RLS and grants of
-- leave_accruals (0078) are unchanged: the table is the same, no new table.
ALTER TABLE "leave_accruals" DROP CONSTRAINT "leave_accruals_kind_check";--> statement-breakpoint
ALTER TABLE "leave_accruals" ADD CONSTRAINT "leave_accruals_kind_check" CHECK ("leave_accruals"."kind" IN ('grant', 'carry_over', 'carry_over_expiry', 'collective_leave', 'collective_leave_reversal', 'collective_leave_rededuction'));--> statement-breakpoint
CREATE UNIQUE INDEX "leave_accruals_collective_leave_rededuction_key" ON "leave_accruals" USING btree ("tenant_id","employee_id","period") WHERE "leave_accruals"."kind" = 'collective_leave_rededuction';
