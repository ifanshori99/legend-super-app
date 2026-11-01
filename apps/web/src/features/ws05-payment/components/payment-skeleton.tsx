// Loading shape of the payment screen: title, bill card, method list. Shaped
// like the real content so the page does not jump when data arrives.
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function PaymentSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" data-slot="payment-skeleton" className="grid gap-4">
      <span className="sr-only">{t("common.loading")}</span>
      <Skeleton className="h-7 w-40" />
      <Card>
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-4 w-48" />
        <div className="grid gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      </Card>
      <Card>
        <Skeleton className="h-5 w-52" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-12 w-full" />
      </Card>
    </div>
  );
}
