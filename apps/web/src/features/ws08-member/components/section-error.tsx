import { RotateCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";

// Compact error for one section of the overview: the page stays usable while
// this block explains the failure and offers the retry (DESIGN.md: every error
// has a fix hint).
export function SectionError({
  title,
  onRetry,
}: {
  title?: string;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-(length:--border-w) bg-card p-card"
    >
      <p className="text-sm leading-5 font-medium">
        {title ?? t("state.errorTitle")}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCw aria-hidden="true" />
        {t("common.retry")}
      </Button>
    </div>
  );
}
