// Kas & Bank screen (bead legend-53q; PRD v1.7 §3 F19 "Kas & Bank [P0]";
// ACC-04, ACC-05). Sections: one KPI strip, the bank accounts, the CSV import
// wizard and match workspace, then cash deposits and the ACC-05 warning band,
// then (by permission) cash in/out/transfers and petty cash (legend-4961).
// Back-office density comes from ManagementShell; this file only composes.
import * as React from "react";
import type {
  BankAccount,
  CreatableCashBankEntryKind,
} from "@starter/shared/accounting";
import type { DataState } from "@/components/ui/data-table-shell";
import { businessDateToday, monthRange } from "../lib";
import { useBankAccounts } from "../hooks";
import { useCanManagePettyCash, useCanRecordCashBank } from "../guard";
import { useAccounts } from "@/features/ws07-accounting/hooks";
import { useCanPostJournals } from "@/features/ws07-accounting/guard";
import { BankAccountsCard } from "./bank-accounts-card";
import { BankAccountDialog } from "./account-form-dialog";
import { CashDepositDialog } from "./cash-deposit-dialog";
import { CashEntriesSection } from "./cash-entries-section";
import { CashEntryDialog } from "./cash-entry-dialog";
import { CashSummaryStrip } from "./cash-summary-strip";
import { DepositsSection } from "./deposits-section";
import { MatchWorkspace } from "./match-workspace";
import { PettyCashCard, type PettyMovementRequest } from "./petty-cash-card";
import { PettyCashMovementDialog } from "./petty-cash-movement-dialog";
import { StatementImportDialog } from "./statement-import-dialog";

export function CashBankPage({ legalEntityId }: { legalEntityId: string }) {
  const accountsQuery = useBankAccounts(legalEntityId);
  const glAccounts = useAccounts(legalEntityId);
  const canWrite = useCanPostJournals();
  const canRecordCashBank = useCanRecordCashBank();
  const canManagePetty = useCanManagePettyCash();
  const accounts: readonly BankAccount[] = accountsQuery.data ?? [];
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected =
    accounts.find((account) => account.id === selectedId) ?? accounts[0];
  const [accountDialogOpen, setAccountDialogOpen] = React.useState(false);
  const [importDialogOpen, setImportDialogOpen] = React.useState(false);
  const [depositDialogOpen, setDepositDialogOpen] = React.useState(false);
  const [entryKind, setEntryKind] =
    React.useState<CreatableCashBankEntryKind | null>(null);
  const [lastEntryKind, setLastEntryKind] =
    React.useState<CreatableCashBankEntryKind>("cash_in");
  const [pettyMove, setPettyMove] = React.useState<PettyMovementRequest | null>(
    null,
  );
  const [lastPettyMove, setLastPettyMove] =
    React.useState<PettyMovementRequest>({
      kind: "topup",
      outletId: undefined,
    });
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
      <div id="bank-accounts" className="min-w-0 scroll-mt-20">
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
      </div>
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
      {canRecordCashBank ? (
        <CashEntriesSection
          legalEntityId={legalEntityId}
          accounts={accounts}
          accountsReady={accountsQuery.isSuccess}
          onAdd={(kind) => {
            setLastEntryKind(kind);
            setEntryKind(kind);
          }}
        />
      ) : null}
      {canManagePetty ? (
        <PettyCashCard
          legalEntityId={legalEntityId}
          hasBankAccounts={accounts.length > 0}
          accountsReady={accountsQuery.isSuccess}
          onMove={(request) => {
            setLastPettyMove(request);
            setPettyMove(request);
          }}
        />
      ) : null}
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
      <CashEntryDialog
        open={entryKind !== null}
        onOpenChange={(open) => {
          if (!open) setEntryKind(null);
        }}
        kind={lastEntryKind}
        legalEntityId={legalEntityId}
        accounts={accounts}
        glAccounts={glAccounts.data ?? []}
        defaultBankAccountId={selected?.id}
      />
      <PettyCashMovementDialog
        open={pettyMove !== null}
        onOpenChange={(open) => {
          if (!open) setPettyMove(null);
        }}
        kind={lastPettyMove.kind}
        legalEntityId={legalEntityId}
        defaultOutletId={lastPettyMove.outletId}
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
