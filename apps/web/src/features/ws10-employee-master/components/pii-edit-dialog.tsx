// HR-03 edit flow: the form collects new PII values, validates them with the
// contract's own input schema, and sends them write-only. The response carries
// masked values only, so the profile refetches the guarded endpoint.
import * as React from "react";
import { TriangleAlert } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useUpdateEmployeePii } from "../hooks";
import { BANK_NAME, BANK_OPTIONS, bankCodeLabel } from "./bank-code-options";
import { PII_FIELD_LABEL, PII_FIELDS, type PiiField } from "./pii-fields";

/** Select sentinels: Radix items cannot carry an empty value. */
const KEEP = "__keep";
const CLEAR = "__clear";

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
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
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
        {/* Mounting the form only while the dialog is open is the reset: a
            fresh write starts with no stale values and a fresh idempotency
            key (no setState in an effect). */}
        {open ? <PiiEditForm employee={employee} onDone={close} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PiiEditForm({
  employee,
  onDone,
}: {
  employee: Employee;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const updatePii = useUpdateEmployeePii();

  const [values, setValues] =
    React.useState<Record<PiiField, string>>(EMPTY_VALUES);
  // Like the text fields, "keep" means the column is not sent and stays as is.
  const [bankCode, setBankCode] = React.useState<string>(KEEP);
  const [errors, setErrors] = React.useState<
    Partial<Record<PiiField | "bankCode", string>>
  >({});
  const [formError, setFormError] = React.useState<string>();
  const idempotencyKey = React.useRef(newIdempotencyKey());

  // Server rule: a new account without a code empties the old code, so the
  // stale code never lands in a transfer file. Warn before it happens.
  const accountWithoutCode =
    values.bankAccount.trim() !== "" && bankCode === KEEP;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(undefined);

    const input: Partial<Record<PiiField, string>> & {
      bankCode?: string | null;
    } = {};
    for (const field of PII_FIELDS) {
      const value = values[field].trim();
      if (value !== "") input[field] = value;
    }
    if (bankCode === CLEAR) input.bankCode = null;
    else if (bankCode !== KEEP) input.bankCode = bankCode;
    if (Object.keys(input).length === 0) {
      setFormError(t("employeeMaster.profile.pii.editEmpty"));
      return;
    }

    // The contract owns the bounds; the catalog owns the wording.
    const parsed = updateEmployeePiiInputSchema.safeParse(input);
    if (!parsed.success) {
      const next: Partial<Record<PiiField | "bankCode", string>> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "");
        if (isPiiField(field)) next[field] = t(ERROR[field]);
        else if (field === "bankCode")
          next.bankCode = t("employeeMaster.profile.pii.bankCode.error");
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
          onDone();
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
    <form className="grid gap-4" onSubmit={submit} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        {PII_FIELDS.map((field) => (
          <React.Fragment key={field}>
            <FormField
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
            {field === "bankAccount" && (
              <FormField
                label={t("employeeMaster.profile.pii.bankCode.label")}
                id="pii-bankCode"
                hint={t("employeeMaster.profile.pii.bankCode.hint")}
                error={errors.bankCode}
              >
                <Select
                  value={bankCode}
                  onValueChange={(next) => {
                    setBankCode(next);
                    setErrors((current) => ({
                      ...current,
                      bankCode: undefined,
                    }));
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={KEEP}>
                      {t("employeeMaster.profile.pii.bankCode.keep")}
                    </SelectItem>
                    <SelectItem value={CLEAR}>
                      {t("employeeMaster.profile.pii.bankCode.clear")}
                    </SelectItem>
                    <SelectSeparator />
                    {BANK_OPTIONS.map((code) => (
                      <SelectItem
                        key={code}
                        value={code}
                        textValue={BANK_NAME[code]}
                      >
                        {bankCodeLabel(code)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
            {field === "bankAccount" && (
              // Always mounted so assistive tech announces the text when it
              // appears; empty it takes no space (sr-only, no grid gap).
              <div
                role="status"
                className={
                  accountWithoutCode
                    ? "flex items-start gap-2 rounded-container bg-warning-subtle px-3 py-2 text-sm leading-5 font-medium text-warning sm:col-span-2"
                    : "sr-only"
                }
              >
                {accountWithoutCode && (
                  <>
                    <TriangleAlert
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span>
                      {t("employeeMaster.profile.pii.bankCode.clearedHint")}
                    </span>
                  </>
                )}
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
      {formError && (
        <p className="text-sm leading-5 font-medium text-danger" role="alert">
          {formError}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={updatePii.isPending}>
          {t("employeeMaster.profile.pii.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
