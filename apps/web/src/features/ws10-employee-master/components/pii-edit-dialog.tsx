// HR-03 edit flow: the form collects new PII values, validates them with the
// contract's own input schema, and sends them write-only. The response carries
// masked values only, so the profile refetches the guarded endpoint.
import * as React from "react";
import { updateEmployeePiiInputSchema } from "@starter/shared/hris";
import type { Employee } from "@starter/shared/hris";
import type { MessageKey } from "@starter/shared/i18n";
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
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useUpdateEmployeePii } from "../hooks";
import { PII_FIELD_LABEL, PII_FIELDS, type PiiField } from "./pii-fields";

const HINT: Record<PiiField, MessageKey> = {
  nik: "employeeMaster.profile.pii.editHints.nik",
  npwp: "employeeMaster.profile.pii.editHints.npwp",
  bpjsKesNo: "employeeMaster.profile.pii.editHints.bpjsKesNo",
  bpjsTkNo: "employeeMaster.profile.pii.editHints.bpjsTkNo",
  bankAccount: "employeeMaster.profile.pii.editHints.bankAccount",
  emergencyContactName:
    "employeeMaster.profile.pii.editHints.emergencyContactName",
  emergencyContactPhone:
    "employeeMaster.profile.pii.editHints.emergencyContactPhone",
};

const ERROR: Record<PiiField, MessageKey> = {
  nik: "employeeMaster.profile.pii.editErrors.nik",
  npwp: "employeeMaster.profile.pii.editErrors.npwp",
  bpjsKesNo: "employeeMaster.profile.pii.editErrors.bpjsKesNo",
  bpjsTkNo: "employeeMaster.profile.pii.editErrors.bpjsTkNo",
  bankAccount: "employeeMaster.profile.pii.editErrors.bankAccount",
  emergencyContactName:
    "employeeMaster.profile.pii.editErrors.emergencyContactName",
  emergencyContactPhone:
    "employeeMaster.profile.pii.editErrors.emergencyContactPhone",
};

/** Numeric keypads where the value is mostly digits. */
const INPUT_MODE: Partial<Record<PiiField, "numeric" | "tel">> = {
  nik: "numeric",
  bpjsKesNo: "numeric",
  bpjsTkNo: "numeric",
  bankAccount: "numeric",
  emergencyContactPhone: "tel",
};

const EMPTY_VALUES = Object.fromEntries(
  PII_FIELDS.map((field) => [field, ""]),
) as Record<PiiField, string>;

function isPiiField(value: string): value is PiiField {
  return (PII_FIELDS as readonly string[]).includes(value);
}

export function PiiEditDialog({
  employee,
  open,
  onOpenChange,
}: {
  employee: Employee;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const updatePii = useUpdateEmployeePii();

  const [values, setValues] =
    React.useState<Record<PiiField, string>>(EMPTY_VALUES);
  const [errors, setErrors] = React.useState<Partial<Record<PiiField, string>>>(
    {},
  );
  const [formError, setFormError] = React.useState<string>();
  const idempotencyKey = React.useRef(newIdempotencyKey());

  // A fresh dialog is a fresh write: no stale values, no reused key.
  React.useEffect(() => {
    if (!open) return;
    setValues(EMPTY_VALUES);
    setErrors({});
    setFormError(undefined);
    idempotencyKey.current = newIdempotencyKey();
  }, [open]);

  function close() {
    onOpenChange(false);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(undefined);

    const input: Partial<Record<PiiField, string>> = {};
    for (const field of PII_FIELDS) {
      const value = values[field].trim();
      if (value !== "") input[field] = value;
    }
    if (Object.keys(input).length === 0) {
      setFormError(t("employeeMaster.profile.pii.editEmpty"));
      return;
    }

    // The contract owns the bounds; the catalog owns the wording.
    const parsed = updateEmployeePiiInputSchema.safeParse(input);
    if (!parsed.success) {
      const next: Partial<Record<PiiField, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "");
        if (isPiiField(field)) next[field] = t(ERROR[field]);
      }
      setErrors(next);
      return;
    }
    setErrors({});

    updatePii.mutate(
      {
        params: { employeeId: employee.id },
        body: { ...parsed.data, idempotencyKey: idempotencyKey.current },
      },
      {
        onSuccess: () => {
          toast({
            title: t("employeeMaster.profile.pii.savedTitle"),
            description: t("employeeMaster.profile.pii.savedBody"),
            tone: "success",
          });
          close();
        },
        onError: (error) =>
          setFormError(
            error instanceof ApiError
              ? error.message
              : t("employeeMaster.profile.pii.saveFailed"),
          ),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t("employeeMaster.profile.pii.editTitle", {
              name: employee.fullName,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("employeeMaster.profile.pii.editDescription")}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            {PII_FIELDS.map((field) => (
              <FormField
                key={field}
                label={t(PII_FIELD_LABEL[field])}
                id={`pii-${field}`}
                hint={t(HINT[field])}
                error={errors[field]}
              >
                <Input
                  id={`pii-${field}`}
                  autoComplete="off"
                  inputMode={INPUT_MODE[field]}
                  value={values[field]}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field]: event.target.value,
                    }))
                  }
                />
              </FormField>
            ))}
          </div>
          {formError && (
            <p
              className="text-sm leading-5 font-medium text-danger"
              role="alert"
            >
              {formError}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={updatePii.isPending}>
              {t("employeeMaster.profile.pii.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
