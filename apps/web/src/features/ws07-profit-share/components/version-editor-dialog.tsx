// Create a version by copying one, or edit a draft: integer basis points per
// shareholder, percentage shown alongside. A draft may be incomplete (the live
// sum says how far it is); the contract refuses to submit anything that is not
// exactly 10,000 bp, and a shareholder at 0 bp is not part of a submitted
// version at all (SH-03).
import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import type {
  ShareAllocationVersion,
  Shareholder,
} from "@starter/shared/accounting";
import { ApiError } from "@/lib/api/errors";
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
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useCreateShareVersion, useUpdateShareVersion } from "../hooks";
import { formatShareBp, parseShareBpInput, shareholdersNotIn } from "../lib";
import { ShareSumIndicator } from "./share-sum-indicator";

type Row = { shareholderId: Shareholder["id"]; bp: string };

function initialRows(version: ShareAllocationVersion | null): Row[] {
  return (version?.allocations ?? []).map((row) => ({
    shareholderId: row.shareholderId,
    bp: String(row.shareBp),
  }));
}

export function VersionEditorDialog({
  open,
  onOpenChange,
  profitEntityId,
  version,
  baseVersion,
  suggestedDate,
  shareholders,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profitEntityId: string;
  /** null = create a new version. */
  version: ShareAllocationVersion | null;
  /** The version a new draft copies (the active or focused one). */
  baseVersion: ShareAllocationVersion | null;
  suggestedDate: string;
  shareholders: readonly Shareholder[];
}) {
  // Radix unmounts DialogContent on close, so the form re-seeds every opening.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <VersionEditorForm
          onOpenChange={onOpenChange}
          profitEntityId={profitEntityId}
          version={version}
          baseVersion={baseVersion}
          suggestedDate={suggestedDate}
          shareholders={shareholders}
        />
      </DialogContent>
    </Dialog>
  );
}

function VersionEditorForm({
  onOpenChange,
  profitEntityId,
  version,
  baseVersion,
  suggestedDate,
  shareholders,
}: {
  onOpenChange: (open: boolean) => void;
  profitEntityId: string;
  version: ShareAllocationVersion | null;
  baseVersion: ShareAllocationVersion | null;
  suggestedDate: string;
  shareholders: readonly Shareholder[];
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateShareVersion(profitEntityId);
  const update = useUpdateShareVersion(profitEntityId);
  const [effectiveFrom, setEffectiveFrom] = React.useState(suggestedDate);
  const [rows, setRows] = React.useState<Row[]>(() =>
    initialRows(version ?? baseVersion),
  );
  const [addId, setAddId] = React.useState("");
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [rowErrors, setRowErrors] = React.useState<
    Record<number, string | undefined>
  >({});
  const [serverError, setServerError] = React.useState<string | null>(null);

  const byId = React.useMemo(
    () => new Map(shareholders.map((row) => [row.id, row])),
    [shareholders],
  );
  const candidates = shareholdersNotIn(shareholders, rows);
  const pending = create.isPending || update.isPending;
  const totalBp = rows.reduce(
    (total, row) => total + (parseShareBpInput(row.bp) ?? 0),
    0,
  );

  const patchRow = (index: number, bp: string) =>
    setRows((current) =>
      current.map((row, position) =>
        position === index ? { ...row, bp } : row,
      ),
    );

  const addRow = () => {
    if (addId === "") return;
    const shareholder = byId.get(addId as Shareholder["id"]);
    if (!shareholder) return;
    setRows((current) => [
      ...current,
      { shareholderId: shareholder.id, bp: "" },
    ]);
    setAddId("");
  };

  const submit = async () => {
    setServerError(null);
    setErrors({});
    if (effectiveFrom.trim() === "") {
      setErrors({ effectiveFrom: t("form.invalid") });
      return;
    }
    if (rows.length === 0) {
      setServerError(t("accounting.share.editor.noShareholders"));
      return;
    }
    const nextRowErrors: Record<number, string | undefined> = {};
    const allocations = rows.map((row, index) => {
      const bp = parseShareBpInput(row.bp);
      if (bp === null || bp === 0) {
        nextRowErrors[index] = t("accounting.share.editor.bpInvalid");
        return { shareholderId: row.shareholderId, shareBp: 0 };
      }
      return { shareholderId: row.shareholderId, shareBp: bp };
    });
    if (Object.keys(nextRowErrors).length > 0) {
      setRowErrors(nextRowErrors);
      return;
    }
    setRowErrors({});
    try {
      if (version) {
        await update.mutateAsync({
          version: version.version,
          body: { effectiveFrom, allocations },
        });
      } else {
        await create.mutateAsync({ effectiveFrom, allocations });
      }
      toast({ title: t("accounting.share.editor.saved") });
      onOpenChange(false);
    } catch (error) {
      setServerError(
        error instanceof ApiError ? error.message : t("errorPage.errorTitle"),
      );
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {version
            ? t("accounting.share.editor.titleEdit", {
                version: version.version,
              })
            : t("accounting.share.editor.titleCreate")}
        </DialogTitle>
        <DialogDescription>
          {t("accounting.share.editor.description")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField
          label={t("accounting.share.editor.effectiveFrom")}
          hint={t("accounting.share.editor.effectiveHint")}
          error={errors.effectiveFrom}
          required
        >
          <Input
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
        </FormField>

        <ShareSumIndicator totalBp={totalBp} />
        <p className="text-sm leading-5 text-muted-foreground">
          {t("accounting.share.editor.zeroRule")}
        </p>

        {rows.length === 0 ? (
          <p className="rounded-lg border-(length:--border-w) border-border bg-surface-2 p-3 text-sm text-muted-foreground">
            {t("accounting.share.editor.empty")}
          </p>
        ) : (
          <ul className="grid gap-2">
            {rows.map((row, index) => {
              const shareholder = byId.get(row.shareholderId);
              const bp = parseShareBpInput(row.bp);
              return (
                <li
                  key={row.shareholderId}
                  className="grid gap-2 rounded-lg border-(length:--border-w) border-border p-3 sm:grid-cols-[minmax(0,1fr)_9rem_6rem_auto] sm:items-center"
                >
                  <div className="grid min-w-0">
                    <span className="truncate font-medium">
                      {shareholder?.name ??
                        t("accounting.share.allocations.unknown")}
                    </span>
                    <span className="text-sm text-muted-foreground tabular">
                      {shareholder?.npwpMasked ??
                        t("accounting.share.shareholders.noNpwp")}
                    </span>
                  </div>
                  <FormField
                    label={t("accounting.share.editor.columns.bp")}
                    error={rowErrors[index]}
                    required
                  >
                    <Input
                      value={row.bp}
                      onChange={(event) => patchRow(index, event.target.value)}
                      inputMode="numeric"
                      className="tabular"
                    />
                  </FormField>
                  <div className="grid gap-1">
                    <span className="text-sm font-medium text-muted-foreground">
                      {t("accounting.share.editor.columns.percent")}
                    </span>
                    <span className="tabular text-base">
                      {formatShareBp(bp ?? 0)}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("accounting.share.editor.removeAria", {
                      name:
                        shareholder?.name ??
                        t("accounting.share.allocations.unknown"),
                    })}
                    onClick={() =>
                      setRows((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="grid gap-2 rounded-lg border-(length:--border-w) border-border bg-surface-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <FormField
            label={t("accounting.share.editor.addShareholder")}
            hint={
              candidates.length === 0
                ? t("accounting.share.editor.duplicate")
                : t("accounting.share.editor.zeroRule")
            }
          >
            <Select
              value={addId}
              onValueChange={setAddId}
              disabled={candidates.length === 0}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t("accounting.share.editor.addPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <Button
            type="button"
            variant="outline"
            onClick={addRow}
            disabled={addId === ""}
          >
            <Plus aria-hidden="true" />
            {t("accounting.share.editor.add")}
          </Button>
        </div>

        {serverError && (
          <p
            role="alert"
            className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
          >
            {serverError}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={pending}>
            {t("accounting.share.editor.save")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
