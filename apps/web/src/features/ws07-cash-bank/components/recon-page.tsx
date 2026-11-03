// Rekonsiliasi gateway screen (bead legend-53q; PRD v1.7 §3 F19 "Rekonsiliasi
// Gateway [P0]"; ACC-04). One selected bank account's period: the settlement
// vs bank breakdown, the auto-match rate against the ≥99% target, and every
// difference as a case with a PIC.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import type { BankAccount } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccounts } from "@/features/ws07-accounting/hooks";
import { useCanPostJournals } from "@/features/ws07-accounting/guard";
import { businessDateToday, monthRange } from "../lib";
import { useBankAccounts } from "../hooks";
import { GatewaySettlementCard } from "./gateway-settlement-card";
import { ReconciliationCasesCard } from "./recon-cases-card";
import { ReconciliationCaseDrawer } from "./recon-case-drawer";
import { ReconSummaryStrip } from "./recon-summary-strip";

export function ReconciliationPage({
  legalEntityId,
}: {
  legalEntityId: string;
}) {
  const t = useT();
  const accountsQuery = useBankAccounts(legalEntityId);
  const glAccounts = useAccounts(legalEntityId);
  const canWrite = useCanPostJournals();
  const accounts: readonly BankAccount[] = accountsQuery.data ?? [];
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected =
    accounts.find((account) => account.id === selectedId) ?? accounts[0];
  const [range, setRange] = React.useState(() =>
    monthRange(businessDateToday()),
  );
  const [openCaseId, setOpenCaseId] = React.useState<string | null>(null);

  if (accountsQuery.isPending)
    return (
      <CardShell>
        <CardShellBody>
          <div className="grid gap-2 p-card" aria-busy="true">
            <span className="sr-only">{t("common.loading")}</span>
            <Skeleton className="h-control-sm w-64" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </CardShellBody>
      </CardShell>
    );

  if (accountsQuery.isError)
    return (
      <CardShell>
        <CardShellBody>
          <ErrorState
            onRetry={() => {
              void accountsQuery.refetch();
            }}
          />
        </CardShellBody>
      </CardShell>
    );

  if (!selected)
    return (
      <CardShell>
        <CardShellBody>
          <EmptyState
            title={t("accounting.cash.accounts.emptyTitle")}
            description={t("accounting.cash.accounts.emptyHint")}
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/kelola/akuntansi/kas-bank">
                  {t("accounting.cash.accounts.add")}
                </Link>
              </Button>
            }
          />
        </CardShellBody>
      </CardShell>
    );

  return (
    <div className="grid min-w-0 gap-5">
      <section
        aria-label={t("accounting.cash.recon.title")}
        className="grid gap-3 rounded-container border-(length:--border-w) border-border bg-card p-card shadow-hairline sm:grid-cols-2 lg:grid-cols-4"
      >
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">
            {t("accounting.cash.recon.account")}
          </span>
          <Select value={selected.id} onValueChange={setSelectedId}>
            <SelectTrigger
              className="h-control-sm"
              aria-label={t("accounting.cash.recon.account")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {`${account.bank} · ${account.accountNumberMasked}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">
            {t("accounting.cash.recon.from")}
          </span>
          <Input
            type="date"
            value={range.from}
            max={range.to}
            className="tabular"
            aria-label={t("accounting.cash.recon.from")}
            onChange={(event) =>
              setRange((current) => ({
                from: event.target.value,
                to:
                  event.target.value > current.to
                    ? event.target.value
                    : current.to,
              }))
            }
          />
        </div>
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">
            {t("accounting.cash.recon.to")}
          </span>
          <Input
            type="date"
            value={range.to}
            min={range.from}
            className="tabular"
            aria-label={t("accounting.cash.recon.to")}
            onChange={(event) =>
              setRange((current) => ({
                from:
                  event.target.value < current.from
                    ? event.target.value
                    : current.from,
                to: event.target.value,
              }))
            }
          />
        </div>
      </section>

      <ReconSummaryStrip account={selected} from={range.from} to={range.to} />

      <GatewaySettlementCard
        legalEntityId={legalEntityId}
        account={selected}
        glAccounts={glAccounts.data ?? []}
        from={range.from}
        to={range.to}
        canWrite={canWrite}
      />

      <ReconciliationCasesCard
        legalEntityId={legalEntityId}
        onOpenCase={setOpenCaseId}
      />

      <ReconciliationCaseDrawer
        caseId={openCaseId}
        open={openCaseId !== null}
        onOpenChange={(open) => {
          if (!open) setOpenCaseId(null);
        }}
        canWrite={canWrite}
      />
    </div>
  );
}
