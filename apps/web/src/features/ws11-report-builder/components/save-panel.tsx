// Save the current builder query as a report (PRD v1.7 §3 F36 "simpan"). New
// reports are created; one opened from the list can be updated in place or
// saved as a copy. The query sent is the one the preview ran (contract-valid).
import { useState } from "react";
import { Save } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type {
  ReportBuilderQuery,
  SavedReport,
} from "@starter/shared/dashboard";
import { reportErrorCodeOf } from "../builder";
import { reportErrorText } from "../format";
import {
  useAttemptKey,
  useCreateSavedReport,
  useUpdateSavedReport,
} from "../hooks";
import { StepCard } from "./step-card";

export function SavePanel({
  query,
  loaded,
  onSaved,
  offline,
}: {
  /** Null while the draft is not a valid query. */
  query: ReportBuilderQuery | null;
  /** The saved report being edited, if any. */
  loaded: SavedReport | null;
  onSaved: (report: SavedReport) => void;
  offline: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateSavedReport();
  const update = useUpdateSavedReport();
  const attemptKey = useAttemptKey();
  const [name, setName] = useState(loaded?.name ?? "");
  const [description, setDescription] = useState(loaded?.description ?? "");
  const [nameError, setNameError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [syncedId, setSyncedId] = useState<string | null>(loaded?.id ?? null);

  // Opening another saved report swaps the form to its name and description.
  if ((loaded?.id ?? null) !== syncedId) {
    setSyncedId(loaded?.id ?? null);
    setName(loaded?.name ?? "");
    setDescription(loaded?.description ?? "");
    setNameError(undefined);
    setFailure(null);
  }

  const busy = create.isPending || update.isPending;
  const trimmed = name.trim();

  const run = (mode: "create" | "update") => {
    if (query === null) return;
    if (trimmed === "" || trimmed.length > 120) {
      setNameError(t("reportBuilder.save.nameRequired"));
      return;
    }
    setNameError(undefined);
    setFailure(null);
    const text = description.trim();
    // DASH-04: the server refuses turning a mailed report into personal data.
    const onError = (error: unknown) =>
      setFailure(
        mode === "update" &&
          reportErrorCodeOf(error) === "EXPORT_PII_APPROVAL_REQUIRED"
          ? t("reportBuilder.save.scheduledPersonal")
          : reportErrorText(t, error),
      );
    const onSuccess = (report: SavedReport) => {
      toast({
        title: t(
          mode === "create"
            ? "reportBuilder.save.created"
            : "reportBuilder.save.updated",
          { name: report.name },
        ),
        tone: "success",
      });
      onSaved(report);
    };
    if (mode === "update" && loaded !== null)
      update.mutate(
        {
          id: loaded.id,
          input: {
            name: trimmed,
            description: text === "" ? null : text,
            query,
          },
        },
        { onSuccess, onError },
      );
    else {
      const input = {
        name: trimmed,
        ...(text === "" ? {} : { description: text }),
        query,
      };
      create.mutate(
        { input, idempotencyKey: attemptKey(input) },
        { onSuccess, onError },
      );
    }
  };

  return (
    <StepCard
      title={t("reportBuilder.save.title")}
      hint={t("reportBuilder.save.hint")}
    >
      <form
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          run(loaded !== null ? "update" : "create");
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            label={t("reportBuilder.save.name")}
            error={nameError}
            required
          >
            <Input
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("reportBuilder.save.namePlaceholder")}
            />
          </FormField>
          <FormField label={t("reportBuilder.save.description")}>
            <Textarea
              rows={2}
              maxLength={500}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </FormField>
        </div>
        {failure && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {failure}
          </p>
        )}
        {offline && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("reportBuilder.save.offlineHint")}
          </p>
        )}
        {query === null && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("reportBuilder.save.invalidHint")}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            loading={busy}
            disabled={query === null || offline}
          >
            <Save aria-hidden="true" />
            {loaded !== null
              ? t("reportBuilder.save.update")
              : t("reportBuilder.save.create")}
          </Button>
          {loaded !== null && (
            <Button
              type="button"
              variant="outline"
              disabled={query === null || busy || offline}
              onClick={() => run("create")}
            >
              {t("reportBuilder.save.saveCopy")}
            </Button>
          )}
        </div>
      </form>
    </StepCard>
  );
}
