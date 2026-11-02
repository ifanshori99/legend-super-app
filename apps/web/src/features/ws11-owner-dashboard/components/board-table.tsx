// A dashboard table in the shared list frame, so it inherits the four states
// and the source-report link (DASH-01). The feature owns the rows.
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { DataTableShell } from "@/components/ui/data-table-shell";
import type { BoardReportStatus } from "../hooks";

export function BoardTable({
  title,
  description,
  status,
  onRetry,
  source,
  children,
}: {
  title: string;
  description?: string;
  status: BoardReportStatus;
  onRetry: () => void;
  /** The DASH-01 source link of the report behind the rows. */
  source?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <DataTableShell
      title={title}
      description={description}
      state={status}
      onRetry={onRetry}
      actions={source}
      loadingRows={4}
      empty={{
        title: t("ownerDashboard.empty.title"),
        description: t("ownerDashboard.empty.hint"),
      }}
      className="min-w-0"
    >
      {children}
    </DataTableShell>
  );
}
