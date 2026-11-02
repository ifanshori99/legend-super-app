// Profile tab "Dokumen": PRD §6 H `employee_documents` (KTP, NPWP, BPJS,
// contract, certificate) with its expiry date and verification state. The
// download link is whatever short-lived URL the API minted; the storage key
// never reaches the browser.
import { ExternalLink } from "lucide-react";
import type {
  EmployeeDocument,
  EmployeeDocumentType,
} from "@starter/shared/hris";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDocuments } from "../hooks";
import {
  DASH,
  businessDateToday,
  formatBusinessDate,
  formatInstantDate,
} from "../lib";
import { DocumentVerificationBadges } from "./employee-status";

const TYPE_LABEL: Record<EmployeeDocumentType, MessageKey> = {
  ktp: "employeeMaster.profile.documents.types.ktp",
  npwp: "employeeMaster.profile.documents.types.npwp",
  bpjs: "employeeMaster.profile.documents.types.bpjs",
  contract: "employeeMaster.profile.documents.types.contract",
  certificate: "employeeMaster.profile.documents.types.certificate",
  education: "employeeMaster.profile.documents.types.education",
  other: "employeeMaster.profile.documents.types.other",
};

export function EmployeeDocuments({ employeeId }: { employeeId: string }) {
  const t = useT();
  const today = businessDateToday();
  const documentsQuery = useDocuments(employeeId);
  const rows = documentsQuery.data?.data ?? [];

  const pending = documentsQuery.isPending;
  const failed = documentsQuery.isError;
  const state: DataState = pending
    ? "loading"
    : failed
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  return (
    <DataTableShell
      title={t("employeeMaster.profile.documents.title")}
      description={t("employeeMaster.profile.documents.description")}
      state={state}
      onRetry={() => void documentsQuery.refetch()}
      rowCount={rows.length}
      loadingRows={3}
      empty={{
        title: t("employeeMaster.profile.documents.emptyTitle"),
        description: t("employeeMaster.profile.documents.emptyHint"),
      }}
    >
      {/* Phones: stacked document rows. */}
      <ul className="divide-y px-4 md:hidden">
        {rows.map((document) => (
          <li key={document.id} className="grid gap-1.5 py-3">
            <div className="flex items-start justify-between gap-2">
              <DocumentTypeBadge document={document} />
              <DocumentVerificationBadges document={document} today={today} />
            </div>
            <p className="text-sm text-muted-foreground">
              {t("employeeMaster.profile.documents.columns.uploaded")}
              {": "}
              {formatInstantDate(document.uploadedAt)}
              {" · "}
              {t("employeeMaster.profile.documents.columns.expires")}
              {": "}
              {document.expiresOn === null
                ? DASH
                : formatBusinessDate(document.expiresOn)}
            </p>
            <DocumentFileLink document={document} />
          </li>
        ))}
      </ul>

      {/* Tablet and desktop. */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("employeeMaster.profile.documents.columns.type")}
              </TableHead>
              <TableHead>
                {t("employeeMaster.profile.documents.columns.uploaded")}
              </TableHead>
              <TableHead>
                {t("employeeMaster.profile.documents.columns.expires")}
              </TableHead>
              <TableHead>
                {t("employeeMaster.profile.documents.columns.verification")}
              </TableHead>
              <TableHead>
                {t("employeeMaster.profile.documents.columns.file")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((document) => (
              <TableRow key={document.id}>
                <TableCell>
                  <DocumentTypeBadge document={document} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatInstantDate(document.uploadedAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {document.expiresOn === null
                    ? DASH
                    : formatBusinessDate(document.expiresOn)}
                </TableCell>
                <TableCell>
                  <DocumentVerificationBadges
                    document={document}
                    today={today}
                  />
                </TableCell>
                <TableCell>
                  <DocumentFileLink document={document} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </DataTableShell>
  );
}

function DocumentTypeBadge({ document }: { document: EmployeeDocument }) {
  const t = useT();
  return <Badge tone="neutral">{t(TYPE_LABEL[document.type])}</Badge>;
}

function DocumentFileLink({ document }: { document: EmployeeDocument }) {
  const t = useT();
  const label = t("employeeMaster.profile.documents.download", {
    type: t(TYPE_LABEL[document.type]),
  });
  if (document.downloadUrl === null)
    return (
      <span className="text-sm text-muted-foreground">
        {t("employeeMaster.profile.documents.noFile")}
      </span>
    );
  return (
    <a
      href={document.downloadUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-sm font-semibold text-primary underline-offset-4 hover:underline"
    >
      {label}
      <ExternalLink className="size-3.5" aria-hidden="true" />
    </a>
  );
}
