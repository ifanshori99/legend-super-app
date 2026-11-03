// Frame shared by the five statement renderers: DataTableShell owns the
// loading, empty and error states, so every statement behaves the same. The
// header always carries the official/estimate label of the figures.
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  STATEMENT_SUBTITLE_KEYS,
  STATEMENT_TYPE_KEYS,
  type StatementBasisKind,
  type StatementType,
} from "../lib";
import { StatementBasisBadge } from "./status-badges";

export function StatementFrame({
  type,
  pending,
  failed,
  empty,
  onRetry,
  onReset,
  actions,
  basis,
  children,
}: {
  type: StatementType;
  pending: boolean;
  failed: boolean;
  empty: boolean;
  onRetry: () => void;
  onReset: () => void;
  actions?: ReactNode;
  /** Null while the fiscal periods are still loading. */
  basis: StatementBasisKind | null;
  children: ReactNode;
}) {
  const t = useT();
  const state: DataState = pending
    ? "loading"
    : failed
      ? "error"
      : empty
        ? "empty"
        : "ready";
  return (
    <DataTableShell
      title={t(STATEMENT_TYPE_KEYS[type])}
      description={t(STATEMENT_SUBTITLE_KEYS[type])}
      state={state}
      onRetry={onRetry}
      loadingRows={8}
      actions={
        basis || actions ? (
          <div className="flex flex-wrap items-center gap-2">
            {basis && <StatementBasisBadge basis={basis} />}
            {actions}
          </div>
        ) : undefined
      }
      empty={{
        title: t("accounting.report.statement.emptyTitle"),
        description: t("accounting.report.statement.emptyHint"),
        action: (
          <Button type="button" variant="outline" size="sm" onClick={onReset}>
            {t("accounting.report.statement.resetRange")}
          </Button>
        ),
      }}
    >
      {children}
    </DataTableShell>
  );
}
