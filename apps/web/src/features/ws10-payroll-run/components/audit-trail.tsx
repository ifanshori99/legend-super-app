// Audit strip of a run (Alur K): every state transition the contract stamps on
// the row, in order, with its time and the actor's short id. Nothing is
// invented here — an entry exists only when its timestamp exists.
import type { PayrollRun } from "@starter/shared/hris/payroll";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, shortId } from "../lib";

type AuditEntry = {
  key: string;
  labelKey: MessageKey;
  at: string;
  actor: string | null;
  note: string;
};

export function AuditTrail({ run }: { run: PayrollRun }) {
  const t = useT();
  const entries: AuditEntry[] = [
    {
      key: "created",
      labelKey: "payrollRun.audit.created",
      at: run.createdAt,
      actor: run.createdBy,
      note: t("payrollRun.audit.createdNote"),
    },
  ];
  if (run.lastSimulatedAt !== null)
    entries.push({
      key: "simulate",
      labelKey: "payrollRun.audit.simulated",
      at: run.lastSimulatedAt,
      actor: null,
      note: t("payrollRun.audit.simulatedNote", {
        count: run.simulationCount,
      }),
    });
  if (run.approvedByHrAt !== null)
    entries.push({
      key: "approve_hr",
      labelKey: "payrollRun.audit.approvedHr",
      at: run.approvedByHrAt,
      actor: run.approvedByHr,
      note: t("payrollRun.audit.approvedHrNote"),
    });
  if (run.approvedByFinanceAt !== null)
    entries.push({
      key: "approve_final",
      labelKey: "payrollRun.audit.approvedFinal",
      at: run.approvedByFinanceAt,
      actor: run.approvedByFinance,
      note: t("payrollRun.audit.approvedFinalNote"),
    });
  if (run.lockedAt !== null)
    entries.push({
      key: "lock",
      labelKey: "payrollRun.audit.locked",
      at: run.lockedAt,
      actor: run.lockedBy,
      note: t("payrollRun.audit.lockedNote"),
    });
  if (run.paidAt !== null)
    entries.push({
      key: "paid",
      labelKey: "payrollRun.audit.paid",
      at: run.paidAt,
      actor: run.paidBy,
      note: t("payrollRun.audit.paidNote"),
    });
  if (run.reversal !== null) {
    entries.push({
      key: "reversal_request",
      labelKey: "payrollRun.audit.reversalRequested",
      at: run.reversal.requestedAt,
      actor: run.reversal.requestedBy,
      note: run.reversal.reason,
    });
    if (run.reversal.decidedAt !== null)
      entries.push({
        key: "reversal_decision",
        labelKey: "payrollRun.audit.reversalDecided",
        at: run.reversal.decidedAt,
        actor: run.reversal.decidedBy,
        note: t(
          run.reversal.status === "approved"
            ? "payrollRun.reversal.approved"
            : "payrollRun.reversal.rejected",
        ),
      });
  }
  const ordered = entries.sort((a, b) => a.at.localeCompare(b.at));

  return (
    <DataTableShell
      title={t("payrollRun.audit.title")}
      description={t("payrollRun.audit.description")}
      state="ready"
      rowCount={ordered.length}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("payrollRun.audit.columnEvent")}</TableHead>
            <TableHead>{t("payrollRun.audit.columnTime")}</TableHead>
            <TableHead>{t("payrollRun.audit.columnActor")}</TableHead>
            <TableHead>{t("payrollRun.audit.columnNote")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map((entry) => (
            <TableRow key={entry.key}>
              <TableCell>
                <StatusPill status="info">{t(entry.labelKey)}</StatusPill>
              </TableCell>
              <TableCell className="tabular">
                {formatDateTime(entry.at)}
              </TableCell>
              <TableCell className="tabular">
                {entry.actor === null ? (
                  <span className="text-muted-foreground">
                    {t("payrollRun.audit.system")}
                  </span>
                ) : (
                  t("payrollRun.audit.actor", { id: shortId(entry.actor) })
                )}
              </TableCell>
              <TableCell className="max-w-80 whitespace-normal">
                {entry.note}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}
