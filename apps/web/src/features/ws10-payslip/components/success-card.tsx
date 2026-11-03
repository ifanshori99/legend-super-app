// Confirmation of a finished request (kasbon / reimbursement). A card instead
// of a toast, because the next step ("lihat daftar") is part of the message and
// a toast may disappear before the employee taps it.
import { CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function SuccessCard({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <Card role="status" className="gap-3">
      <span className="grid size-12 place-items-center rounded-container bg-success-subtle text-success">
        <CircleCheck className="size-6" aria-hidden="true" />
      </span>
      <div className="grid gap-1">
        <p className="type-heading">{title}</p>
        <p className="text-sm leading-5 text-muted-foreground">{description}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={onAction}
      >
        {actionLabel}
      </Button>
    </Card>
  );
}
