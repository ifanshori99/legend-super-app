// Bank statement CSV import wizard (PRD §3.19 "Kas & Bank": "rekonsiliasi bank
// dengan impor mutasi (CSV)"). Three steps: account + file, column mapping,
// preview with duplicates and row errors; the contract's own parsers and
// dedupe key decide what is importable. The error stays next to the offending
// row — never a toast that disappears.
import * as React from "react";
import { Upload } from "lucide-react";
import type { BankAccount, BankCsvMapping } from "@starter/shared/accounting";
import { bankCsvMappingSchema } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import type { MessageKey } from "@starter/shared/i18n";
import {
  CSV_COLUMN_LIMIT,
  IMPORT_ROW_ERROR_KEYS,
  MAX_IMPORT_CSV_CHARS,
  buildImportPreview,
  csvColumnCount,
  defaultCsvMapping,
  detectMapping,
  formatBusinessDate,
  type ImportPreview,
} from "../lib";
import { useImportBankStatement, useStatementLineDedupeKeys } from "../hooks";

type Step = 1 | 2 | 3;

export function StatementImportDialog({
  open,
  onOpenChange,
  accounts,
  defaultBankAccountId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: readonly BankAccount[];
  defaultBankAccountId: string | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <StatementImportWizard
          accounts={accounts}
          defaultBankAccountId={defaultBankAccountId}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function StepBadge({ step, active }: { step: Step; active: boolean }) {
  const t = useT();
  const label =
    step === 1
      ? t("accounting.cash.import.steps.source")
      : step === 2
        ? t("accounting.cash.import.steps.mapping")
        : t("accounting.cash.import.steps.preview");
  return (
    <Badge tone={active ? "solid" : "neutral"}>
      {step}
      <span aria-hidden="true">·</span>
      {label}
    </Badge>
  );
}

function StatementImportWizard({
  accounts,
  defaultBankAccountId,
  onClose,
}: {
  accounts: readonly BankAccount[];
  defaultBankAccountId: string | undefined;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const importStatement = useImportBankStatement();
  const [step, setStep] = React.useState<Step>(1);
  const [accountId, setAccountId] = React.useState(
    defaultBankAccountId ?? accounts[0]?.id ?? "",
  );
  const [fileName, setFileName] = React.useState("");
  const [csv, setCsv] = React.useState("");
  const [sourceError, setSourceError] = React.useState<MessageKey | null>(null);
  const [reading, setReading] = React.useState(false);
  const [mapping, setMapping] =
    React.useState<BankCsvMapping>(defaultCsvMapping());
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const dedupeKeys = useStatementLineDedupeKeys(accountId || undefined);

  const delimiter = mapping.delimiter;
  const columnCount = csv === "" ? 0 : csvColumnCount(csv, delimiter);
  const columns = Math.min(Math.max(columnCount, 1), CSV_COLUMN_LIMIT);
  const columnIndexes = Array.from({ length: columns }, (_, index) => index);
  const mappingError = React.useMemo(() => {
    const used = [
      mapping.dateColumn,
      mapping.descriptionColumn,
      ...(mapping.amount.kind === "signed"
        ? [mapping.amount.column]
        : [mapping.amount.debitColumn, mapping.amount.creditColumn]),
      ...(mapping.referenceColumn === null ? [] : [mapping.referenceColumn]),
    ];
    if (used.some((index) => index >= columns)) return true;
    if (
      mapping.amount.kind === "debit_credit" &&
      mapping.amount.debitColumn === mapping.amount.creditColumn
    )
      return true;
    return !bankCsvMappingSchema.safeParse(mapping).success;
  }, [columns, mapping]);

  const updateMapping = (patch: Partial<BankCsvMapping>) => {
    setMapping((current) => ({ ...current, ...patch }));
    setPreview(null);
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setSourceError(null);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setSourceError("accounting.cash.import.source.unreadable");
      return;
    }
    if (file.size > MAX_IMPORT_CSV_CHARS) {
      setSourceError("accounting.cash.import.source.tooLarge");
      return;
    }
    setReading(true);
    try {
      setCsv(await file.text());
    } catch {
      setSourceError("accounting.cash.import.source.unreadable");
    } finally {
      setReading(false);
    }
  };

  const toStepTwo = () => {
    const body = csv.trim();
    if (body === "") {
      setSourceError("accounting.cash.import.source.empty");
      return;
    }
    if (csv.length > MAX_IMPORT_CSV_CHARS) {
      setSourceError("accounting.cash.import.source.tooLarge");
      return;
    }
    if (accountId === "") return;
    setMapping(detectMapping(csv));
    setSourceError(null);
    setStep(2);
  };

  const toStepThree = () => {
    if (mappingError) return;
    const existing = dedupeKeys.data?.data.map((line) => line.dedupeKey) ?? [];
    setPreview(buildImportPreview(csv, mapping, existing));
    setStep(3);
  };

  const submit = () => {
    if (!preview || preview.errorCount > 0 || preview.readyCount === 0) return;
    setSubmitError(null);
    importStatement.mutate(
      { bankAccountId: accountId, input: { fileName, csv, mapping } },
      {
        onSuccess: (record) => {
          toast({
            title: t("accounting.cash.import.result", {
              count: record.lineCount,
              duplicates: record.duplicateCount,
              auto: record.autoMatchedCount,
            }),
            tone: "success",
          });
          onClose();
        },
        onError: (error) => {
          setSubmitError(
            error instanceof ApiError
              ? error.message
              : t("accounting.cash.import.failed"),
          );
        },
      },
    );
  };

  const accountLabelText = (account: BankAccount) =>
    `${account.bank} · ${account.accountNumberMasked}`;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("accounting.cash.import.title")}</DialogTitle>
        <DialogDescription>
          {t("accounting.cash.import.description")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        {([1, 2, 3] as const).map((item) => (
          <StepBadge key={item} step={item} active={item === step} />
        ))}
      </div>

      {step === 1 && (
        <div className="grid gap-4">
          <FormField
            label={t("accounting.cash.import.source.account")}
            hint={t("accounting.cash.import.source.accountHint")}
            required
          >
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {accountLabelText(account)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("accounting.cash.import.source.file")}
            hint={t("accounting.cash.import.source.fileHint")}
            error={sourceError ? t(sourceError) : undefined}
            required
          >
            <Input
              type="file"
              accept=".csv,text/csv"
              disabled={reading}
              onChange={(event) => {
                void readFile(event.target.files?.[0]);
              }}
            />
          </FormField>
          {fileName !== "" && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("accounting.cash.import.source.fileSelected", {
                name: fileName,
              })}
            </p>
          )}
          <FormField label={t("accounting.cash.import.source.paste")}>
            <Textarea
              value={csv}
              onChange={(event) => {
                setCsv(event.target.value);
                setSourceError(null);
              }}
              rows={6}
              placeholder={t("accounting.cash.import.source.pastePlaceholder")}
              className="font-mono text-sm"
              spellCheck={false}
            />
          </FormField>
        </div>
      )}

      {step === 2 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <p className="text-sm leading-5 text-muted-foreground sm:col-span-2">
            {t("accounting.cash.import.mapping.title")}.{" "}
            {t("accounting.cash.import.mapping.description")}{" "}
            {t("accounting.cash.import.mapping.columnsDetected", {
              count: columnCount,
            })}
          </p>
          <FormField
            label={t("accounting.cash.import.mapping.delimiter")}
            required
          >
            <Select
              value={mapping.delimiter}
              onValueChange={(value) =>
                updateMapping({
                  delimiter: value as BankCsvMapping["delimiter"],
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value=",">
                  {t("accounting.cash.import.mapping.delimiterComma")}
                </SelectItem>
                <SelectItem value=";">
                  {t("accounting.cash.import.mapping.delimiterSemicolon")}
                </SelectItem>
                <SelectItem value={"\t"}>
                  {t("accounting.cash.import.mapping.delimiterTab")}
                </SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <div className="flex items-end gap-2 pb-2">
            <Checkbox
              id="cash-csv-header"
              checked={mapping.hasHeader}
              onCheckedChange={(checked) =>
                updateMapping({ hasHeader: checked === true })
              }
            />
            <Label htmlFor="cash-csv-header">
              {t("accounting.cash.import.mapping.hasHeader")}
            </Label>
          </div>
          <FormField
            label={t("accounting.cash.import.mapping.dateColumn")}
            required
          >
            <Select
              value={String(mapping.dateColumn)}
              onValueChange={(value) =>
                updateMapping({ dateColumn: Number(value) })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {columnIndexes.map((index) => (
                  <SelectItem key={index} value={String(index)}>
                    {t("accounting.cash.import.mapping.columnOption", {
                      index,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("accounting.cash.import.mapping.dateFormat")}
            required
          >
            <Select
              value={mapping.dateFormat}
              onValueChange={(value) =>
                updateMapping({
                  dateFormat: value as BankCsvMapping["dateFormat"],
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["DD/MM/YYYY", "DD-MM-YYYY", "YYYY-MM-DD"] as const).map(
                  (format) => (
                    <SelectItem key={format} value={format}>
                      <span className="tabular">{format}</span>
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("accounting.cash.import.mapping.descriptionColumn")}
            required
          >
            <Select
              value={String(mapping.descriptionColumn)}
              onValueChange={(value) =>
                updateMapping({ descriptionColumn: Number(value) })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {columnIndexes.map((index) => (
                  <SelectItem key={index} value={String(index)}>
                    {t("accounting.cash.import.mapping.columnOption", {
                      index,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("accounting.cash.import.mapping.amountKind")}
            required
          >
            <Select
              value={mapping.amount.kind}
              onValueChange={(value) =>
                updateMapping({
                  amount:
                    value === "debit_credit"
                      ? {
                          kind: "debit_credit",
                          debitColumn: 2,
                          creditColumn: 3,
                        }
                      : { kind: "signed", column: 2 },
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="signed">
                  {t("accounting.cash.import.mapping.amountSigned")}
                </SelectItem>
                <SelectItem value="debit_credit">
                  {t("accounting.cash.import.mapping.amountDebitCredit")}
                </SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          {mapping.amount.kind === "signed" ? (
            <FormField
              label={t("accounting.cash.import.mapping.amountColumn")}
              required
            >
              <Select
                value={String(mapping.amount.column)}
                onValueChange={(value) =>
                  updateMapping({
                    amount: { kind: "signed", column: Number(value) },
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {columnIndexes.map((index) => (
                    <SelectItem key={index} value={String(index)}>
                      {t("accounting.cash.import.mapping.columnOption", {
                        index,
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          ) : (
            <>
              <FormField
                label={t("accounting.cash.import.mapping.debitColumn")}
                required
              >
                <Select
                  value={String(mapping.amount.debitColumn)}
                  onValueChange={(value) => {
                    if (mapping.amount.kind !== "debit_credit") return;
                    updateMapping({
                      amount: {
                        kind: "debit_credit",
                        debitColumn: Number(value),
                        creditColumn: mapping.amount.creditColumn,
                      },
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {columnIndexes.map((index) => (
                      <SelectItem key={index} value={String(index)}>
                        {t("accounting.cash.import.mapping.columnOption", {
                          index,
                        })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField
                label={t("accounting.cash.import.mapping.creditColumn")}
                required
              >
                <Select
                  value={String(mapping.amount.creditColumn)}
                  onValueChange={(value) => {
                    if (mapping.amount.kind !== "debit_credit") return;
                    updateMapping({
                      amount: {
                        kind: "debit_credit",
                        debitColumn: mapping.amount.debitColumn,
                        creditColumn: Number(value),
                      },
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {columnIndexes.map((index) => (
                      <SelectItem key={index} value={String(index)}>
                        {t("accounting.cash.import.mapping.columnOption", {
                          index,
                        })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </>
          )}
          <FormField
            label={t("accounting.cash.import.mapping.decimalSeparator")}
            required
          >
            <Select
              value={mapping.decimalSeparator}
              onValueChange={(value) =>
                updateMapping({
                  decimalSeparator: value as BankCsvMapping["decimalSeparator"],
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value=",">{","}</SelectItem>
                <SelectItem value=".">{"."}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("accounting.cash.import.mapping.referenceColumn")}
          >
            <Select
              value={
                mapping.referenceColumn === null
                  ? "none"
                  : String(mapping.referenceColumn)
              }
              onValueChange={(value) =>
                updateMapping({
                  referenceColumn: value === "none" ? null : Number(value),
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  {t("accounting.cash.import.mapping.noReference")}
                </SelectItem>
                {columnIndexes.map((index) => (
                  <SelectItem key={index} value={String(index)}>
                    {t("accounting.cash.import.mapping.columnOption", {
                      index,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {mappingError && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger sm:col-span-2"
            >
              {t("accounting.cash.import.mapping.invalid")}
            </p>
          )}
        </div>
      )}

      {step === 3 && preview && (
        <div className="grid gap-4">
          <p className="text-sm leading-5 text-muted-foreground">
            {t("accounting.cash.import.preview.description")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success">
              {t("accounting.cash.import.preview.ready", {
                count: preview.readyCount,
              })}
            </Badge>
            <Badge tone="neutral">
              {t("accounting.cash.import.preview.duplicates", {
                count: preview.duplicateCount,
              })}
            </Badge>
            {preview.errorCount > 0 && (
              <Badge tone="danger">
                {t("accounting.cash.import.preview.errors", {
                  count: preview.errorCount,
                })}
              </Badge>
            )}
          </div>
          {preview.rows.length === 0 ? (
            <p className="text-sm leading-5 font-medium text-danger">
              {t("accounting.cash.import.preview.empty")}
            </p>
          ) : (
            <div className="max-h-80 overflow-auto rounded-container border-(length:--border-w)">
              <Table className="min-w-[36rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {t("accounting.cash.import.preview.columns.row")}
                    </TableHead>
                    <TableHead>
                      {t("accounting.cash.import.preview.columns.date")}
                    </TableHead>
                    <TableHead>
                      {t("accounting.cash.import.preview.columns.description")}
                    </TableHead>
                    <TableHead numeric>
                      {t("accounting.cash.import.preview.columns.amount")}
                    </TableHead>
                    <TableHead>
                      {t("accounting.cash.import.preview.columns.status")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((row) => (
                    <TableRow key={row.rowNumber}>
                      <TableCell className="tabular">{row.rowNumber}</TableCell>
                      <TableCell className="tabular whitespace-nowrap">
                        {row.postedOn === null
                          ? "—"
                          : formatBusinessDate(row.postedOn)}
                      </TableCell>
                      <TableCell className="max-w-64 truncate">
                        {row.description === "" ? "—" : row.description}
                      </TableCell>
                      <TableCell numeric>
                        {row.amountIdr === null ? (
                          "—"
                        ) : (
                          <Money amount={row.amountIdr} size="sm" />
                        )}
                      </TableCell>
                      <TableCell>
                        {row.status === "ready" && (
                          <Badge tone="success">
                            {t("accounting.cash.import.preview.statusReady")}
                          </Badge>
                        )}
                        {row.status === "duplicate" && (
                          <Badge tone="neutral">
                            {t(
                              "accounting.cash.import.preview.statusDuplicate",
                            )}
                          </Badge>
                        )}
                        {row.status === "error" && (
                          <div className="grid gap-1">
                            <Badge tone="danger">
                              {t("accounting.cash.import.preview.statusError")}
                            </Badge>
                            <span className="text-sm leading-5 font-medium text-danger">
                              {row.errorCode === null
                                ? ""
                                : t(IMPORT_ROW_ERROR_KEYS[row.errorCode])}
                            </span>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {preview.errorCount > 0 && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {t("accounting.cash.import.preview.fixErrors", {
                count: preview.errorCount,
              })}
            </p>
          )}
          {submitError && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {submitError}
            </p>
          )}
        </div>
      )}

      <DialogFooter>
        {step > 1 && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setStep((current) => (current === 3 ? 2 : 1))}
            disabled={importStatement.isPending}
          >
            {t("accounting.cash.import.back")}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={importStatement.isPending}
        >
          {t("common.cancel")}
        </Button>
        {step === 1 && (
          <Button
            type="button"
            onClick={toStepTwo}
            disabled={accountId === "" || reading}
          >
            <Upload aria-hidden="true" />
            {t("accounting.cash.import.next")}
          </Button>
        )}
        {step === 2 && (
          <Button type="button" onClick={toStepThree} disabled={mappingError}>
            {t("accounting.cash.import.next")}
          </Button>
        )}
        {step === 3 && preview && (
          <Button
            type="button"
            onClick={submit}
            loading={importStatement.isPending}
            disabled={preview.errorCount > 0 || preview.readyCount === 0}
          >
            {t("accounting.cash.import.submit", {
              count: preview.readyCount,
            })}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
