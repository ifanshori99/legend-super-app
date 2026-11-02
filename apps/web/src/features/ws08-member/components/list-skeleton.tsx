import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Skeleton } from "@/components/ui/skeleton";

// Loading placeholder shaped like the list it replaces. The region is busy for
// assistive tech and carries an sr-only label (DESIGN.md Skeleton).
export function ListSkeleton({
  rows = 3,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  const t = useT();
  return (
    <div aria-busy="true" className={cn("grid gap-2", className)}>
      <span className="sr-only">{t("common.loading")}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-20 w-full rounded-container" />
      ))}
    </div>
  );
}
