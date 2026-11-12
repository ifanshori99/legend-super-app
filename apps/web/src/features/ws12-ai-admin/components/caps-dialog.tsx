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

const CAPS_FIELD_ORDER: CapsField[] = [
  "monthlyBudgetIdr",
  "warnPct",
  "stopPct",
  "rateLimit",
  "maxRows",
];

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

  const formRef = React.useRef<HTMLFormElement>(null);
  const limits = {
    maxRateLimit: AI_MCP_RATE_LIMIT_MAX_PER_MINUTE,
    maxRows: AI_MAX_ROWS_PER_RESPONSE,
  };

  const set =
    (field: CapsField) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setDraft((current) => ({ ...current, [field]: event.target.value }));

  // Blur: run the same validateCaps and keep only this field's result. The
  // warn/stop pair depends on each other (the "order" error sits on warnPct),
  // so the partner is recomputed too when it currently shows an error.
  // Focus moving to a footer button skips this: a new error line would push
  // the button away from the pointer before the click lands. Submit still
  // validates everything.
  const blur =
    (field: CapsField) => (event: React.FocusEvent<HTMLInputElement>) => {
      if (event.relatedTarget instanceof HTMLButtonElement) return;
      const result = validateCaps(
        { ...draft, [field]: event.target.value },
        limits,
      );
      const found = result.ok ? {} : result.errors;
      const partner: CapsField | undefined =
        field === "warnPct"
          ? "stopPct"
          : field === "stopPct"
            ? "warnPct"
            : undefined;
      setErrors((current) => {
        const next = { ...current };
        const apply = (target: CapsField) => {
          const kind = found[target];
          if (kind === undefined) delete next[target];
          else next[target] = kind;
        };
        apply(field);
        if (partner && current[partner] !== undefined) apply(partner);
        return next;
      });
    };

  const fieldProps = (field: CapsField) => ({
    name: field,
    autoComplete: "off",
    inputMode: "numeric" as const,
    value: draft[field],
    onChange: set(field),
    onBlur: blur(field),
  });

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
    const result = validateCaps(draft, limits);
    if (!result.ok) {
      setErrors(result.errors);
      const first = CAPS_FIELD_ORDER.find((field) => result.errors[field]);
      const control = first && formRef.current?.elements.namedItem(first);
      if (control instanceof HTMLElement) control.focus();
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
    <form ref={formRef} onSubmit={submit} noValidate className="grid gap-4">
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
        <Input {...fieldProps("monthlyBudgetIdr")} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label={t("aiAdmin.caps.warn")}
          error={message("warnPct")}
          required
        >
          <Input {...fieldProps("warnPct")} />
        </FormField>
        <FormField
          label={t("aiAdmin.caps.stop")}
          error={message("stopPct")}
          required
        >
          <Input {...fieldProps("stopPct")} />
        </FormField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label={t("aiAdmin.caps.rate")}
          error={message("rateLimit")}
          required
        >
          <Input {...fieldProps("rateLimit")} />
        </FormField>
        <FormField
          label={t("aiAdmin.caps.rows")}
          error={message("maxRows")}
          required
        >
          <Input {...fieldProps("maxRows")} />
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
