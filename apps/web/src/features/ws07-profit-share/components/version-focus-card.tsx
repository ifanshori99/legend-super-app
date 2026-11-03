// The version the page focuses on (the latest by default): its effective date,
// status, allocations and SH-03's live sum. Submit/activate are disabled unless
// the total is exactly 10,000 bp, with the reason spelled out beside them.
import * as React from "react";
import {
  CalendarDays,
  CircleCheck,
  Pencil,
  Send,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type {
  ShareAllocationVersion,
  Shareholder,
} from "@starter/shared/accounting";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  CardShell,
  CardShellBody,
  CardShellFooter,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ReasonDialog } from "@/features/ws07-accounting/components/reason-dialog";
import { useDecideShareVersion, useSubmitShareVersion } from "../hooks";
import {
  canActivateVersion,
  formatShareBp,
  formatShareBpInteger,
  formatShareDate,
  isVersionEditable,
  versionTotalBp,
} from "../lib";
import { ShareSumIndicator } from "./share-sum-indicator";
import { VersionStatusBadge } from "./share-status";

export function VersionFocusCard({
  version,
  shareholders,
  canWrite,
  onEdit,
}: {
  version: ShareAllocationVersion;
  shareholders: readonly Shareholder[];
  canWrite: boolean;
  onEdit: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const submit = useSubmitShareVersion(version.profitEntityId);
  const decide = useDecideShareVersion(version.profitEntityId);
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const byId = React.useMemo(
    () => new Map(shareholders.map((row) => [row.id, row])),
    [shareholders],
  );
  const totalBp = versionTotalBp(version);
  const exact = canActivateVersion(totalBp);
  const pending = submit.isPending || decide.isPending;

  const run = async (action: () => Promise<unknown>, success: string) => {
    setError(null);
    try {
      await action();
      toast({ title: success });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : t("errorPage.errorTitle"),
      );
    }
  };

  return (
    <CardShell>
      <CardShellBody>
        <header className="flex flex-wrap items-start justify-between gap-3 border-b p-card">
          <div className="grid min-w-0 gap-1">
            <p className="type-eyebrow text-muted-foreground">
              {t("accounting.share.versions.focusEyebrow")}
            </p>
            <h2 className="type-title">
              {t("accounting.share.versions.versionLabel", {
                version: version.version,
              })}
            </h2>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <CalendarDays className="size-4" aria-hidden="true" />
              {t("accounting.share.versions.effectiveFrom", {
                date: formatShareDate(version.effectiveFrom),
              })}
            </p>
          </div>
          <VersionStatusBadge status={version.status} />
        </header>
        <div className="grid gap-4 p-card">
          <ShareSumIndicator totalBp={totalBp} />

          <section className="grid gap-2">
            <h3 className="type-heading">
              {t("accounting.share.allocations.title")}
            </h3>
            <Table className="min-w-[34rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {t("accounting.share.allocations.columns.shareholder")}
                  </TableHead>
                  <TableHead>
                    {t("accounting.share.allocations.columns.npwp")}
                  </TableHead>
                  <TableHead numeric>
                    {t("accounting.share.allocations.columns.share")}
                  </TableHead>
                  <TableHead>
                    {t("accounting.share.allocations.columns.payout")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {version.allocations.map((allocation) => {
                  const shareholder = byId.get(allocation.shareholderId);
                  return (
                    <TableRow key={allocation.id}>
                      <TableCell className="font-medium">
                        {shareholder?.name ??
                          t("accounting.share.allocations.unknown")}
                      </TableCell>
                      <TableCell className="tabular text-muted-foreground">
                        {shareholder?.npwpMasked ??
                          t("accounting.share.shareholders.noNpwp")}
                      </TableCell>
                      <TableCell numeric>
                        <span className="font-semibold">
                          {formatShareBp(allocation.shareBp)}
                        </span>
                        <span className="ml-1.5 text-sm text-muted-foreground">
                          {t("accounting.share.bpUnit", {
                            bp: formatShareBpInteger(allocation.shareBp),
                          })}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {shareholder?.payoutAccount
                          ? `${shareholder.payoutAccount.bank} ${shareholder.payoutAccount.accountNumberMasked}`
                          : t("accounting.share.shareholders.noPayout")}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </section>

          {isVersionEditable(version) && (
            <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-prose text-sm leading-5 text-muted-foreground">
                {exact
                  ? t("accounting.share.versions.approverNote")
                  : t("accounting.share.versions.submitBlocked", {
                      bp: formatShareBpInteger(totalBp),
                    })}
              </p>
              {canWrite && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onEdit}
                    disabled={pending}
                  >
                    <Pencil aria-hidden="true" />
                    {t("accounting.share.versions.edit")}
                  </Button>
                  <Button
                    type="button"
                    disabled={!exact || pending}
                    loading={submit.isPending}
                    onClick={() =>
                      void run(
                        () => submit.mutateAsync(version.version),
                        t("accounting.share.versions.submittedToast"),
                      )
                    }
                  >
                    <Send aria-hidden="true" />
                    {t("accounting.share.versions.submit")}
                  </Button>
                </div>
              )}
            </div>
          )}

          {version.status === "pending_approval" && (
            <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-prose text-sm leading-5 text-muted-foreground">
                {exact
                  ? t("accounting.share.versions.approverNote")
                  : t("accounting.share.versions.activateBlocked", {
                      bp: formatShareBpInteger(totalBp),
                    })}
              </p>
              {canWrite && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRejectOpen(true)}
                    disabled={pending}
                  >
                    <XCircle aria-hidden="true" />
                    {t("accounting.share.versions.reject")}
                  </Button>
                  <Button
                    type="button"
                    disabled={!exact || pending}
                    loading={decide.isPending}
                    onClick={() =>
                      void run(
                        () =>
                          decide.mutateAsync({
                            version: version.version,
                            decision: "approve",
                            note: null,
                          }),
                        t("accounting.share.versions.approvedToast"),
                      )
                    }
                  >
                    <ShieldCheck aria-hidden="true" />
                    {t("accounting.share.versions.activate")}
                  </Button>
                </div>
              )}
            </div>
          )}

          {version.status === "approved" && (
            <p className="flex items-center gap-1.5 border-t pt-4 text-sm leading-5 text-success">
              <CircleCheck className="size-4" aria-hidden="true" />
              {t("accounting.share.versions.approvedNote")}
            </p>
          )}

          {(version.status === "rejected" ||
            version.status === "cancelled") && (
            <p className="border-t pt-4 text-sm leading-5 text-muted-foreground">
              {version.status === "rejected"
                ? t("accounting.share.versions.rejectedNote")
                : t("accounting.share.versions.cancelledNote")}
              {version.decisionNote ? ` ${version.decisionNote}` : ""}
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
            >
              {error}
            </p>
          )}
        </div>
      </CardShellBody>
      <CardShellFooter>
        {version.decidedBy
          ? t("accounting.share.wizard.runMeta.approvedBy", {
              ref: version.decidedBy.slice(-6).toUpperCase(),
              date: formatShareDate(
                (version.decidedAt ?? version.requestedAt).slice(0, 10),
              ),
            })
          : t("accounting.share.wizard.runMeta.requested", {
              ref: version.requestedBy.slice(-6).toUpperCase(),
              date: formatShareDate(version.requestedAt.slice(0, 10)),
            })}
      </CardShellFooter>
      <ReasonDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title={t("accounting.share.versions.rejectTitle")}
        label={t("accounting.share.versions.rejectLabel")}
        hint={t("accounting.share.versions.rejectHint")}
        submitLabel={t("accounting.share.versions.reject")}
        pending={decide.isPending}
        onSubmit={(note) => {
          setRejectOpen(false);
          void run(
            () =>
              decide.mutateAsync({
                version: version.version,
                decision: "reject",
                note,
              }),
            t("accounting.share.versions.rejectedToast"),
          );
        }}
      />
    </CardShell>
  );
}
