// "Ubah": the monthly cap, the warn and stop percents, the MCP rate limit and
// the row cap. Checked with validateCaps before sending; a 422 from the API is
// shown under its field.
import * as React from "react";
import {
  AI_MAX_ROWS_PER_RESPONSE,
  AI_MCP_RATE_LIMIT_MAX_PER_MINUTE,
  type AiGovernanceSettings,
} from "@starter/shared/ai";
import { idr } from "@starter/shared/core";
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
import { useToast } from "@/components/ui/toast";
import { useUpdateGovernance } from "../hooks";
import {
  validateCaps,
  type CapsDraft,
  type CapsErrorKind,
  type CapsField,
} from "../logic";
import { saveErrorText, serverFieldErrors } from "./shared";

export function CapsDialog({
  open,
  settings,
  onClose,
}: {
  open: boolean;
  settings: AiGovernanceSettings;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        {open && <CapsForm settings={settings} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

const SERVER_FIELD: Record<string, CapsField> = {
  monthlyBudgetIdr: "monthlyBudgetIdr",
  budgetWarnPct: "warnPct",
  budgetStopPct: "stopPct",
  mcpRateLimitPerMinute: "rateLimit",
  maxRowsPerResponse: "maxRows",
};

function CapsForm({
  settings,
  onClose,
}: {
  settings: AiGovernanceSettings;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const update = useUpdateGovernance();
  const [draft, setDraft] = React.useState<CapsDraft>({
    monthlyBudgetIdr: String(settings.monthlyBudgetIdr),
    warnPct: String(settings.budgetWarnPct),
    stopPct: String(settings.budgetStopPct),
    rateLimit: String(settings.mcpRateLimitPerMinute),
    maxRows: String(settings.maxRowsPerResponse),
  });
  const [errors, setErrors] = React.useState<
    Partial<Record<CapsField, CapsErrorKind>>
  >({});
  const [serverErrors, setServerErrors] = React.useState<
    Partial<Record<CapsField, string>>
  >({});

  const set =
    (field: CapsField) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setDraft((current) => ({ ...current, [field]: event.target.value }));

  const message = (field: CapsField): string | undefined => {
    const kind = errors[field];
    if (kind === undefined) return serverErrors[field];
    switch (kind) {
      case "budget":
        return t("aiAdmin.caps.budgetError");
      case "percent":
        return t("aiAdmin.caps.percentError");
      case "order":
        return t("aiAdmin.caps.orderError");
      case "rate":
        return t("aiAdmin.caps.rateError", {
          max: AI_MCP_RATE_LIMIT_MAX_PER_MINUTE,
        });
      case "rows":
        return t("aiAdmin.caps.rowsError", { max: AI_MAX_ROWS_PER_RESPONSE });
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setServerErrors({});
    const result = validateCaps(draft, {
      maxRateLimit: AI_MCP_RATE_LIMIT_MAX_PER_MINUTE,
      maxRows: AI_MAX_ROWS_PER_RESPONSE,
    });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    update.mutate(
      {
        ...result.value,
        monthlyBudgetIdr: idr(result.value.monthlyBudgetIdr),
      },
      {
        onSuccess: () => {
          toast({ title: t("aiAdmin.caps.saved"), tone: "success" });
          onClose();
        },
        onError: (error) => {
          const mapped: Partial<Record<CapsField, string>> = {};
          for (const [field, text] of Object.entries(
            serverFieldErrors(error),
          )) {
            const key = SERVER_FIELD[field];
            if (key) mapped[key] = text;
          }
          setServerErrors(mapped);
        },
      },
    );
  };

  const hasFieldErrors =
    Object.keys(errors).length > 0 || Object.keys(serverErrors).length > 0;

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("aiAdmin.caps.title")}</DialogTitle>
        <DialogDescription>{t("aiAdmin.caps.description")}</DialogDescription>
      </DialogHeader>

      <FormField
        label={t("aiAdmin.caps.budget")}
        hint={t("aiAdmin.caps.budgetHint")}
        error={message("monthlyBudgetIdr")}
        required
      >
        <Input
          inputMode="numeric"
          value={draft.monthlyBudgetIdr}
          onChange={set("monthlyBudgetIdr")}
        />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label={t("aiAdmin.caps.warn")}
          error={message("warnPct")}
          required
        >
          <Input
            inputMode="numeric"
            value={draft.warnPct}
            onChange={set("warnPct")}
          />
        </FormField>
        <FormField
          label={t("aiAdmin.caps.stop")}
          error={message("stopPct")}
          required
        >
          <Input
            inputMode="numeric"
            value={draft.stopPct}
            onChange={set("stopPct")}
          />
        </FormField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label={t("aiAdmin.caps.rate")}
          error={message("rateLimit")}
          required
        >
          <Input
            inputMode="numeric"
            value={draft.rateLimit}
            onChange={set("rateLimit")}
          />
        </FormField>
        <FormField
          label={t("aiAdmin.caps.rows")}
          error={message("maxRows")}
          required
        >
          <Input
            inputMode="numeric"
            value={draft.maxRows}
            onChange={set("maxRows")}
          />
        </FormField>
      </div>

      {update.isError && (
        <p role="alert" className="text-sm leading-5 font-medium text-danger">
          {hasFieldErrors
            ? t("aiAdmin.caps.error")
            : saveErrorText(t, update.error)}
        </p>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={update.isPending}
        >
          {t("aiAdmin.caps.cancel")}
        </Button>
        <Button type="submit" loading={update.isPending}>
          {t("aiAdmin.caps.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
