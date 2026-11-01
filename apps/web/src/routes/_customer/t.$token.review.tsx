import { createFileRoute } from "@tanstack/react-router";
import { ReviewPage } from "@/features/ws03-qr-order/components/recovery";

// "/t/[token]/review" — post-meal review (PRD §3 "Ulasan Pascamakan").
export const Route = createFileRoute("/_customer/t/$token/review")({
  component: ReviewPage,
});
