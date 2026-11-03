// Export result of a final recap. The official Coretax XML is the server's
// artifact: the API writes it into object storage and returns a short-lived
// signed URL, which "Unduh berkas Coretax" downloads as-is. "Unduh CSV" is a
// secondary check copy that serialises the stored recap lines (values exactly
// as returned); no amount is recomputed and the XML is never built here.
import { Download, FileDown } from "lucide-react";
import {
  taxReportExportSchema,
  type TaxReport,
} from "@starter/shared/accounting";
import type { z } from "zod";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  formatTaxPeriod,
  formatTaxTimestamp,
  taxRecapCsvFileName,
  taxSubjectLabelKey,
  taxTypeLabelKey,
  toTaxRecapCsv,
  type TaxCsvHeaders,
} from "../lib";
import { downloadTextFile } from "./download";

export type TaxExportArtifact = z.infer<typeof taxReportExportSchema>;

export function ExportArtifactDialog({
  open,
  onOpenChange,
  report,
  artifact,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  report: TaxReport | null;
  artifact: TaxExportArtifact | null;
}) {
  const t = useT();
  const toast = useToast();
  if (report === null || artifact === null) return null;

  const download = () => {
    const headers: TaxCsvHeaders = {
      subjectType: t("accounting.tax.csv.subjectType"),
      subjectTypes: {
        outlet: t(taxSubjectLabelKey("outlet")),
        employee: t(taxSubjectLabelKey("employee")),
        supplier: t(taxSubjectLabelKey("supplier")),
      },
      subjectName: t("accounting.tax.csv.subjectName"),
      taxId: t("accounting.tax.csv.taxId"),
      base: t("accounting.tax.csv.base"),
      tax: t("accounting.tax.csv.tax"),
      references: t("accounting.tax.csv.references"),
      total: t("accounting.tax.csv.total"),
    };
    const downloaded = downloadTextFile(
      taxRecapCsvFileName(report),
      toTaxRecapCsv(report, headers),
    );
    if (downloaded)
      toast({
        title: t("accounting.tax.toasts.downloaded"),
        tone: "success",
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("accounting.tax.exportDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("accounting.tax.exportDialog.description", {
              type: t(taxTypeLabelKey(report.type)),
              period: formatTaxPeriod(report.period),
            })}
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">
            {t("accounting.tax.exportDialog.fileName")}
          </dt>
          <dd className="font-medium break-all">{artifact.fileName}</dd>
          <dt className="text-muted-foreground">
            {t("accounting.tax.exportDialog.format")}
          </dt>
          <dd>
            {/* The export endpoint is the Coretax export; the contract's
                exportFormat enum has exactly this value once exported. The
                artifact itself carries no format field. */}
            {t("accounting.tax.exportDialog.formatCoretaxXml")}
          </dd>
          <dt className="text-muted-foreground">
            {t("accounting.tax.exportDialog.fileKey")}
          </dt>
          <dd className="break-all text-muted-foreground tabular">
            {artifact.fileKey}
          </dd>
          <dt className="text-muted-foreground">
            {t("accounting.tax.exportDialog.rowCount")}
          </dt>
          <dd className="tabular">
            {t("accounting.tax.exportDialog.rowCountValue", {
              count: report.lines.length,
            })}
          </dd>
          <dt className="text-muted-foreground">
            {t("accounting.tax.exportDialog.expiresAt")}
          </dt>
          <dd className="tabular">{formatTaxTimestamp(artifact.expiresAt)}</dd>
        </dl>

        <p className="text-sm leading-5 text-muted-foreground">
          {t("accounting.tax.exportDialog.downloadNote")}
        </p>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.close")}
          </Button>
          <Button type="button" variant="outline" onClick={download}>
            <Download aria-hidden="true" />
            {t("accounting.tax.exportDialog.confirm")}
          </Button>
          {/* The server's signed URL (Content-Disposition: attachment); the
              `download` name only applies to same-origin URLs. */}
          <Button asChild>
            <a
              href={artifact.downloadUrl}
              download={artifact.fileName}
              rel="noopener noreferrer"
            >
              <FileDown aria-hidden="true" />
              {t("accounting.tax.exportDialog.downloadXml")}
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
