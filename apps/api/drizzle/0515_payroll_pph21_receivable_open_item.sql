-- legend-itph: the employee PPh 21 receivable (account 1204) is a receivable
-- open item whose counterparty is an employee. Only the CHECK widens: a
-- receivable may be owed by an employee too; a payable is still a supplier.
ALTER TABLE "accounting_open_items" DROP CONSTRAINT "accounting_open_items_counterparty_check";
--> statement-breakpoint
ALTER TABLE "accounting_open_items" ADD CONSTRAINT "accounting_open_items_counterparty_check" CHECK (("accounting_open_items"."kind" = 'payable' AND "accounting_open_items"."counterparty_type" = 'supplier') OR ("accounting_open_items"."kind" = 'receivable' AND "accounting_open_items"."counterparty_type" IN ('corporate_account', 'event_customer', 'employee')));
