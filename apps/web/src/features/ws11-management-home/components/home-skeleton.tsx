// Loading shape of the management home: toolbar, section heading, one stat
// strip and the queue cards (DESIGN.md: skeletons mirror the content shape).
import { useT } from "@/components/i18n";
import { Skeleton } from "@/components/ui/skeleton";

export function HomeSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <span className="sr-only">{t("common.loading")}</span>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
          <Skeleton className="h-10 w-80 max-w-full rounded-control" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-control-sm w-28 rounded-control" />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-40 rounded-shell" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
        <Skeleton className="h-36 rounded-shell" />
        <Skeleton className="h-36 rounded-shell" />
      </div>
    </div>
  );
}
