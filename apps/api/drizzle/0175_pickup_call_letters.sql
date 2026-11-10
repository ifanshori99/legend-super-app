ALTER TABLE "pickup_calls" DROP CONSTRAINT "pickup_calls_channel_check";--> statement-breakpoint
ALTER TABLE "pickup_calls" DROP CONSTRAINT "pickup_calls_number_check";--> statement-breakpoint
ALTER TABLE "pickup_calls" ALTER COLUMN "number" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "pickup_calls" ADD CONSTRAINT "pickup_calls_channel_check" CHECK ("pickup_calls"."channel" IN ('takeaway', 'delivery', 'gofood', 'grabfood', 'shopeefood'));--> statement-breakpoint
ALTER TABLE "pickup_calls" ADD CONSTRAINT "pickup_calls_number_check" CHECK ("pickup_calls"."number" >= 1);