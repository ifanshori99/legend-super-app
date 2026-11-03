// Menu bulk import screen (bead legend-b6r; PRD v1.7 §3 F8, §8 "Impor
// Massal"). Template download, CSV preview with per-row validation, then an
// explicit commit that creates drafts and appends their prices. CSV only:
// XLSX parsing is deferred to bead legend-az32, so the picker offers .csv and
// an .xlsx picked anyway gets a "save as CSV" message, never a fake preview.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Download, FileUp, Upload, UtensilsCrossed } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money, NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { StatusPill } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOnline } from "@/lib/use-online";
import { useRefreshMenu } from "../hooks";
import {
  analyzeImport,
  pickImportPriceList,
  type ImportAnalysis,
  type ImportFileIssue,
  type ImportIssue,
} from "../import-lib";
import {
  commitImport,
  downloadImportTemplate,
  importReferencesQuery,
  type ImportCommitOutcome,
} from "../import-api";
import { businessDateToday, formatBusinessDate } from "../lib";

type FileError = "xlsx" | "unsupported" | "unreadable";

function issueMessage(
  t: ReturnType<typeof useT>,
  issue: ImportIssue | ImportFileIssue,
): string {
  const field =
    "field" in issue ? t(`menuImport.fields.${issue.field}`) : undefined;
  return t(`menuImport.errors.${issue.code}`, {
    ...(field === undefined ? {} : { field }),
    ...issue.params,
  });
}

function ImportPreview({
  analysis,
  priceList,
  online,
  committing,
  progress,
  outcome,
  onCommit,
  onReset,
}: {
  analysis: ImportAnalysis;
  priceList: ReturnType<typeof pickImportPriceList>;
  online: boolean;
  committing: boolean;
  progress: { done: number; total: number } | null;
  outcome: ImportCommitOutcome | null;
  onCommit: () => void;
  onReset: () => void;
}) {
  const t = useT();
  const { counts } = analysis;
  return (
    <>
      <StatStrip label={t("menuImport.preview.summaryLabel")} columns={3}>
        <StatTile
          label={t("menuImport.preview.total")}
          value={<NumberDisplay value={counts.total} size="stat" />}
        />
        <StatTile
          label={t("menuImport.preview.valid")}
          value={<NumberDisplay value={counts.valid} size="stat" />}
        />
        <StatTile
          label={t("menuImport.preview.invalid")}
          value={<NumberDisplay value={counts.invalid} size="stat" />}
        />
      </StatStrip>

      <Card>
        <CardHeader>
          <CardTitle>{t("menuImport.preview.title")}</CardTitle>
          <CardDescription>
            {t("menuImport.preview.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {t("menuImport.preview.counts", counts)}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">
                  {t("menuImport.preview.columns.row")}
                </TableHead>
                <TableHead>{t("menuImport.preview.columns.status")}</TableHead>
                <TableHead className="min-w-48">
                  {t("menuImport.preview.columns.item")}
                </TableHead>
                <TableHead className="hidden sm:table-cell">
                  {t("menuImport.preview.columns.category")}
                </TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("menuImport.preview.columns.type")}
                </TableHead>
                <TableHead numeric>
                  {t("menuImport.preview.columns.price")}
                </TableHead>
                <TableHead className="hidden lg:table-cell">
                  {t("menuImport.preview.columns.station")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analysis.rows.map((row) => (
                <React.Fragment key={`${row.rowNumber}-${row.raw.name}`}>
                  <TableRow>
                    <TableCell className="tabular">{row.rowNumber}</TableCell>
                    <TableCell>
                      <StatusPill status={row.valid ? "success" : "danger"}>
                        {row.valid
                          ? t("menuImport.preview.valid")
                          : t("menuImport.preview.invalid")}
                      </StatusPill>
                    </TableCell>
                    <TableCell>
                      <div className="grid gap-0.5">
                        <span className="font-medium">
                          {row.raw.name || t("menuImport.preview.emptyValue")}
                        </span>
                        {row.raw.description && (
                          <span className="line-clamp-1 text-sm text-muted-foreground">
                            {row.raw.description}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {row.raw.category || t("menuImport.preview.emptyValue")}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {row.parsed.type
                        ? t(`menu.editor.type.${row.parsed.type}`)
                        : row.raw.type || t("menuImport.preview.emptyValue")}
                    </TableCell>
                    <TableCell numeric>
                      {row.parsed.priceIdr === undefined ? (
                        <span className="text-sm text-muted-foreground">
                          {row.raw.priceIdr ||
                            t("menuImport.preview.emptyValue")}
                        </span>
                      ) : (
                        <Money amount={row.parsed.priceIdr} size="sm" />
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {row.raw.station || t("menuImport.preview.emptyValue")}
                    </TableCell>
                  </TableRow>
                  {row.issues.length > 0 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell aria-hidden="true" />
                      <TableCell colSpan={6} className="pt-0">
                        <ul className="grid gap-1 text-sm leading-5 font-medium text-danger">
                          {row.issues.map((issue, index) => (
                            <li key={index}>{issueMessage(t, issue)}</li>
                          ))}
                        </ul>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("menuImport.preview.commitTitle")}</CardTitle>
          <CardDescription>
            {t("menuImport.preview.commitHint")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {priceList ? (
            <p className="text-sm text-muted-foreground">
              {t("menuImport.preview.priceNote", {
                channel: t(`menu.prices.channels.${priceList.channel}`),
                date: formatBusinessDate(priceList.effectiveFrom),
              })}
            </p>
          ) : (
            <p className="text-sm font-medium text-danger" role="alert">
              {t("menuImport.preview.priceListMissing")}{" "}
              <Link
                to="/kelola/menu/harga"
                className="font-semibold underline underline-offset-4"
              >
                {t("menuImport.preview.goToPrices")}
              </Link>
            </p>
          )}
          {!online && (
            <p className="text-sm font-medium text-warning" role="status">
              {t("menuImport.import.offline")}
            </p>
          )}
          {committing && progress && (
            <p className="text-sm font-medium" role="status" aria-live="polite">
              {t("menuImport.preview.committing", {
                current: progress.done,
                total: progress.total,
              })}
            </p>
          )}
          {counts.valid === 0 && (
            <p className="text-sm text-muted-foreground" role="status">
              {t("menuImport.preview.noValidRows")}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              loading={committing}
              disabled={
                !online ||
                committing ||
                counts.valid === 0 ||
                // A file-level problem (e.g. an unterminated quote) makes
                // every row after it suspect: fix the file before importing.
                analysis.fileIssues.length > 0 ||
                !priceList ||
                outcome !== null
              }
              onClick={onCommit}
            >
              <Upload aria-hidden="true" />
              {t("menuImport.preview.commit", { count: counts.valid })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={committing}
              onClick={onReset}
            >
              {t("menuImport.preview.reset")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {outcome && <ImportOutcome outcome={outcome} onReset={onReset} />}
    </>
  );
}

function ImportOutcome({
  outcome,
  onReset,
}: {
  outcome: ImportCommitOutcome;
  onReset: () => void;
}) {
  const t = useT();
  const created = outcome.results.filter(
    (row) => row.status === "created",
  ).length;
  const failed = outcome.results.length - created;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("menuImport.results.title")}</CardTitle>
        <CardDescription>
          {t("menuImport.results.summary", {
            created,
            failed,
            total: outcome.results.length,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {outcome.priceError !== undefined && (
          <p
            className="rounded-container bg-danger-subtle p-card text-sm font-medium text-danger"
            role="alert"
          >
            {t("menuImport.results.priceFailed", {
              message:
                outcome.priceError ||
                t("menuImport.results.priceFailedGeneric"),
            })}
          </p>
        )}
        {outcome.priceError === undefined &&
          !outcome.priceSaved &&
          outcome.priceList === null &&
          created > 0 && (
            <p
              className="rounded-container bg-warning-subtle p-card text-sm font-medium text-warning"
              role="alert"
            >
              {t("menuImport.results.priceListMissing")}
            </p>
          )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("menuImport.results.columns.row")}</TableHead>
              <TableHead>{t("menuImport.results.columns.item")}</TableHead>
              <TableHead>{t("menuImport.results.columns.status")}</TableHead>
              <TableHead>{t("menuImport.results.columns.message")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {outcome.results.map((row) => (
              <TableRow key={`${row.rowNumber}-${row.name}`}>
                <TableCell className="tabular">{row.rowNumber}</TableCell>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell>
                  <StatusPill
                    status={row.status === "created" ? "success" : "danger"}
                  >
                    {row.status === "created"
                      ? t("menuImport.results.created")
                      : t("menuImport.results.failed")}
                  </StatusPill>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {row.status === "failed"
                    ? (row.message ?? t("menuImport.results.failedGeneric"))
                    : t("menuImport.preview.emptyValue")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <Link to="/kelola/menu">
              <UtensilsCrossed aria-hidden="true" />
              {t("menuImport.results.viewItems")}
            </Link>
          </Button>
          <Button type="button" variant="ghost" onClick={onReset}>
            {t("menuImport.results.importAnother")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function MenuImportPage() {
  const t = useT();
  const online = useOnline();
  const references = useQuery(importReferencesQuery);
  const refreshMenu = useRefreshMenu();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = React.useState<string | null>(null);
  const [fileText, setFileText] = React.useState<string | null>(null);
  const [fileError, setFileError] = React.useState<FileError | null>(null);
  const [reading, setReading] = React.useState(false);
  const [committing, setCommitting] = React.useState(false);
  const [progress, setProgress] = React.useState<{
    done: number;
    total: number;
  } | null>(null);
  const [outcome, setOutcome] = React.useState<ImportCommitOutcome | null>(
    null,
  );

  const analysis = React.useMemo(
    () =>
      fileText === null || references.data === undefined
        ? null
        : analyzeImport(fileText, {
            categories: references.data.categories,
            stations: references.data.stations,
          }),
    [fileText, references.data],
  );

  const priceList = references.data
    ? pickImportPriceList(references.data.priceLists, businessDateToday())
    : undefined;

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setFileText(null);
    setFileError(null);
    setProgress(null);
    setOutcome(null);
    const extension = file.name.split(".").pop()?.toLocaleLowerCase("id-ID");
    // No XLSX parser exists in the app and no dependency may be added: say so
    // and ask for a CSV instead of showing a fabricated preview.
    if (extension === "xlsx") {
      setFileError("xlsx");
      return;
    }
    if (extension !== "csv") {
      setFileError("unsupported");
      return;
    }
    setReading(true);
    try {
      setFileText(await file.text());
    } catch {
      setFileError("unreadable");
    } finally {
      setReading(false);
    }
  }

  function resetFile() {
    setFileName(null);
    setFileText(null);
    setFileError(null);
    setProgress(null);
    setOutcome(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function commit() {
    if (!analysis || analysis.fileIssues.length > 0 || !priceList || committing)
      return;
    setCommitting(true);
    setProgress({ done: 0, total: analysis.counts.valid });
    setOutcome(null);
    try {
      const result = await commitImport({
        rows: analysis.rows.filter((row) => row.valid),
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setOutcome(result);
      // Item list, availability and price grids all changed. A failed
      // refresh must not hide the outcome that is already on screen.
      await refreshMenu().catch(() => undefined);
      void references.refetch();
    } finally {
      setCommitting(false);
    }
  }

  if (references.isPending)
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only" role="status">
          {t("common.loading")}
        </span>
        <Skeleton className="h-48" />
        <Skeleton className="h-64" />
      </div>
    );

  if (references.isError)
    return (
      <ErrorState
        description={!online ? t("menuImport.import.offline") : undefined}
        onRetry={() => void references.refetch()}
      />
    );

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{t("menuImport.import.title")}</CardTitle>
          <CardDescription>
            {t("menuImport.import.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="rounded-container bg-surface-2 p-card text-sm leading-5">
            {t("menuImport.import.photoNote")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={downloadImportTemplate}
            >
              <Download aria-hidden="true" />
              {t("menuImport.import.downloadTemplate")}
            </Button>
            <Button
              type="button"
              variant="outline"
              loading={reading}
              disabled={committing}
              onClick={() => inputRef.current?.click()}
            >
              <FileUp aria-hidden="true" />
              {fileName
                ? t("menuImport.import.changeFile")
                : t("menuImport.import.upload")}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              tabIndex={-1}
              aria-label={t("menuImport.import.uploadLabel")}
              onChange={(event) => {
                void handleFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
          <div className="grid gap-1">
            <p className="text-sm text-muted-foreground">
              {t("menuImport.import.templateHint")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("menuImport.import.acceptHint")}
            </p>
            {fileName && (
              <p className="text-sm font-medium">
                {t("menuImport.import.selectedFile", { name: fileName })}
              </p>
            )}
            {reading && (
              <p className="text-sm text-muted-foreground" role="status">
                {t("menuImport.import.reading")}
              </p>
            )}
          </div>
          {!online && (
            <p className="text-sm font-medium text-warning" role="status">
              {t("menuImport.import.offline")}
            </p>
          )}
          {fileError && (
            <p
              className="rounded-container bg-danger-subtle p-card text-sm leading-5 font-medium text-danger"
              role="alert"
            >
              {t(
                fileError === "xlsx"
                  ? "menuImport.import.xlsxUnsupported"
                  : fileError === "unsupported"
                    ? "menuImport.import.unsupportedType"
                    : "menuImport.import.unreadable",
              )}
            </p>
          )}
          {analysis && analysis.fileIssues.length > 0 && (
            <div
              className="grid gap-1 rounded-container bg-danger-subtle p-card text-sm text-danger"
              role="alert"
            >
              <p className="font-semibold">
                {t("menuImport.import.fileErrorTitle")}
              </p>
              <ul className="list-disc pl-5">
                {analysis.fileIssues.map((issue, index) => (
                  <li key={index}>{issueMessage(t, issue)}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {analysis && analysis.rows.length > 0 && (
        <ImportPreview
          analysis={analysis}
          priceList={priceList}
          online={online}
          committing={committing}
          progress={progress}
          outcome={outcome}
          onCommit={() => void commit()}
          onReset={resetFile}
        />
      )}

      {analysis &&
        analysis.rows.length === 0 &&
        analysis.fileIssues.length === 0 &&
        fileText !== null && (
          <EmptyState
            title={t("menuImport.preview.title")}
            description={t("menuImport.preview.noValidRows")}
          />
        )}

      {fileName === null && (
        <EmptyState
          title={t("menuImport.preview.title")}
          description={t("menuImport.import.acceptHint")}
          icon={FileUp}
        />
      )}
    </div>
  );
}
