// The "Baris jurnal" block shared by the manual form and the recurring dialog.
// It loads the accounts and the outlets (ACC-03 per-line attribution) and owns
// the account loading, error and empty states, so both forms behave the same.
// Outlets never block: without them every line stays entity-level.
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccounts, useOutlets } from "../hooks";
import { postableAccounts, type DraftEvaluation } from "../lib";
import {
  JournalLinesEditor,
  type EditorLine,
  type OutletsState,
} from "./lines-editor";

export function JournalLinesSection({
  legalEntityId,
  heading,
  rows,
  onChange,
  evaluation,
  disabled = false,
}: {
  legalEntityId: string;
  heading: string;
  rows: readonly EditorLine[];
  onChange: (rows: EditorLine[]) => void;
  evaluation: DraftEvaluation;
  disabled?: boolean;
}) {
  const t = useT();
  const accountsQuery = useAccounts(legalEntityId);
  const outletsQuery = useOutlets();
  const accounts = postableAccounts(accountsQuery.data ?? []);
  // Only active outlets of this legal entity, plus any outlet a row already
  // uses (a saved journal may point at one that has since closed).
  const outlets = (outletsQuery.data ?? []).filter(
    (outlet) =>
      (outlet.legalEntityId === legalEntityId && outlet.status === "active") ||
      rows.some((row) => row.outletId === outlet.id),
  );
  const outletsState: OutletsState = outletsQuery.isPending
    ? "loading"
    : outletsQuery.isError
      ? "error"
      : "ready";

  let body: ReactNode;
  if (accountsQuery.isPending) {
    body = (
      <div className="grid gap-2" aria-busy="true">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <p className="text-sm leading-5 text-muted-foreground">
          {t("accounting.manual.form.linesLoading")}
        </p>
      </div>
    );
  } else if (accountsQuery.isError) {
    body = (
      <ErrorState
        title={t("accounting.manual.form.linesErrorTitle")}
        description={t("accounting.manual.form.linesErrorHint")}
        error={accountsQuery.error}
        onRetry={() => {
          void accountsQuery.refetch();
        }}
      />
    );
  } else if (accounts.length === 0) {
    body = (
      <EmptyState
        title={t("accounting.manual.form.linesEmptyTitle")}
        description={t("accounting.manual.form.linesEmptyHint")}
      />
    );
  } else {
    body = (
      <JournalLinesEditor
        accounts={accounts}
        outlets={outlets}
        outletsState={outletsState}
        onRetryOutlets={() => {
          void outletsQuery.refetch();
        }}
        rows={rows}
        onChange={onChange}
        evaluation={evaluation}
        disabled={disabled}
      />
    );
  }

  return (
    <div className="grid gap-2">
      <h3 className="text-base leading-6 font-semibold">{heading}</h3>
      {body}
    </div>
  );
}
