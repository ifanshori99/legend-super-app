-- legend-d78a: private waste evidence uses the receipt transport and its own
-- source-kind authorization. Existing storage objects are preserved unchanged.
ALTER TABLE "core_storage_objects" DROP CONSTRAINT "core_storage_objects_source_kind_check";
--> statement-breakpoint
ALTER TABLE "core_storage_objects" ADD CONSTRAINT "core_storage_objects_source_kind_check" CHECK ("core_storage_objects"."source_kind" IS NULL OR "core_storage_objects"."source_kind" IN ('purchase_invoice', 'goods_receipt', 'expense', 'cash_deposit', 'reimbursement', 'attendance', 'employee_document', 'employment_contract', 'leave_request', 'menu_item', 'petty_purchase', 'waste_log'));
