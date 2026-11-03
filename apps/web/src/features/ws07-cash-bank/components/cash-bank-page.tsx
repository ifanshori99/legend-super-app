// Kas & Bank screen (bead legend-53q; PRD v1.7 §3 F19 "Kas & Bank [P0]";
// ACC-04, ACC-05). Sections: one KPI strip, the bank accounts, the CSV import
// wizard and match workspace, then cash deposits and the ACC-05 warning band.
// Back-office density comes from ManagementShell; this file only composes.
import * as React from "react";
import type { BankAccount } from "@starter/shared/accounting";
import type { DataState } from "@/components/ui/data-table-shell";
import { businessDateToday, monthRange } from "../lib";
import { useBankAccounts } from "../hooks";
import { useAccounts } from "@/features/ws07-accounting/hooks";
import { useCanPostJournals } from "@/features/ws07-accounting/guard";
import { BankAccountsCard } from "./bank-accounts-card";
import { BankAccountDialog } from "./account-form-dialog";
import { CashDepositDialog } from "./cash-deposit-dialog";
import { CashSummaryStrip } from "./cash-summary-strip";
import { DepositsSection } from "./deposits-section";
import { MatchWorkspace } from "./match-workspace";
import { StatementImportDialog } from "./statement-import-dialog";

export function CashBankPage({ legalEntityId }: { legalEntityId: string }) {
  const accountsQuery = useBankAccounts(legalEntityId);
  const glAccounts = useAccounts(legalEntityId);
  const canWrite = useCanPostJournals();
  const accounts: readonly BankAccount[] = accountsQuery.data ?? [];
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected =
    accounts.find((account) => account.id === selectedId) ?? accounts[0];
  const [accountDialogOpen, setAccountDialogOpen] = React.useState(false);
  const [importDialogOpen, setImportDialogOpen] = React.useState(false);
  const [depositDialogOpen, setDepositDialogOpen] = React.useState(false);
  const range = monthRange(businessDateToday());
  const accountsState: DataState = accountsQuery.isPending
    ? "loading"
    : accountsQuery.isError
      ? "error"
      : accounts.length === 0
        ? "empty"
        : "ready";

  return (
    <div className="grid min-w-0 gap-5">
      <CashSummaryStrip
        legalEntityId={legalEntityId}
        account={selected}
        from={range.from}
        to={range.to}
      />
      <BankAccountsCard
        accounts={accounts}
        glAccounts={glAccounts.data ?? []}
        state={accountsState}
        onRetry={() => {
          void accountsQuery.refetch();
        }}
        canWrite={canWrite}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
        onAdd={() => setAccountDialogOpen(true)}
      />
      <MatchWorkspace
        legalEntityId={legalEntityId}
        accounts={accounts}
        account={selected}
        onAccountChange={setSelectedId}
        canWrite={canWrite}
        onImport={() => setImportDialogOpen(true)}
        onAddAccount={() => setAccountDialogOpen(true)}
      />
      <DepositsSection
        legalEntityId={legalEntityId}
        accounts={accounts}
        canWrite={canWrite}
        onAdd={() => setDepositDialogOpen(true)}
      />
      <BankAccountDialog
        open={accountDialogOpen}
        onOpenChange={setAccountDialogOpen}
        legalEntityId={legalEntityId}
        glAccounts={glAccounts.data ?? []}
      />
      <StatementImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        accounts={accounts}
        defaultBankAccountId={selected?.id}
      />
      <CashDepositDialog
        open={depositDialogOpen}
        onOpenChange={setDepositDialogOpen}
        accounts={accounts}
        defaultBankAccountId={selected?.id}
      />
    </div>
  );
}
