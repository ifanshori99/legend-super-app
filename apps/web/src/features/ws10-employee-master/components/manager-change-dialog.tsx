// Ubah atasan: HR or a brand GM sets (or clears) one employee's direct manager.
// The API owns every rule (cycle, active manager, role level, who may call);
// this form only maps its error codes to plain Indonesian.
import * as React from "react";
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
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useChangeEmployeeManager, useEmployees } from "../hooks";

/** Radix Select items cannot carry an empty value, so "no manager" has a sentinel. */
const NO_MANAGER = "__none__";
const REASON_MAX = 200;

const ERROR_BY_CODE: Record<string, MessageKey> = {
  MANAGER_CYCLE: "employeeMaster.profile.manager.errors.cycle",
  MANAGER_NOT_ELIGIBLE: "employeeMaster.profile.manager.errors.notEligible",
  MANAGER_ROLE_TOO_LOW: "employeeMaster.profile.manager.errors.roleTooLow",
  FORBIDDEN: "employeeMaster.profile.manager.errors.forbidden",
  VALIDATION_ERROR: "employeeMaster.profile.manager.errors.validation",
};

export function ManagerChangeDialog({
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("employeeMaster.profile.manager.title", {
              name: employee.fullName,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("employeeMaster.profile.manager.description")}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: each attempt starts from the saved manager
            with a fresh idempotency key. */}
        {open ? <ManagerChangeForm employee={employee} onDone={close} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ManagerChangeForm({
  employee,
  onDone,
}: {
  employee: Employee;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const change = useChangeEmployeeManager();
  const employeesQuery = useEmployees();

  const candidates = React.useMemo(
    () =>
      (employeesQuery.data?.data ?? []).filter(
        (row) => row.status === "active" && row.id !== employee.id,
      ),
    [employeesQuery.data, employee.id],
  );

  const initial = employee.managerId ?? NO_MANAGER;
  const [selected, setSelected] = React.useState<string>(initial);
  const [reason, setReason] = React.useState("");
  const [formError, setFormError] = React.useState<string>();
  const idempotencyKey = React.useRef(newIdempotencyKey());

  const unchanged = selected === initial;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (unchanged) return;
    setFormError(undefined);

    const managerId = selected === NO_MANAGER ? null : selected;
    const trimmed = reason.trim();
    const managerName =
      candidates.find((row) => row.id === managerId)?.fullName ?? "";

    change.mutate(
      {
        params: { employeeId: employee.id },
        body: {
          managerId,
          ...(trimmed === "" ? {} : { reason: trimmed }),
          idempotencyKey: idempotencyKey.current,
        },
      },
      {
        onSuccess: () => {
          toast({
            title: t("employeeMaster.profile.manager.savedTitle"),
            description:
              managerId === null
                ? t("employeeMaster.profile.manager.savedBodyNone", {
                    name: employee.fullName,
                  })
                : t("employeeMaster.profile.manager.savedBody", {
                    name: employee.fullName,
                    manager: managerName,
                  }),
            tone: "success",
          });
          onDone();
        },
        onError: (error) => {
          // A failed attempt may be retried with other input: new key.
          idempotencyKey.current = newIdempotencyKey();
          setFormError(
            t(
              (error instanceof ApiError && ERROR_BY_CODE[error.code]) ||
                "employeeMaster.profile.manager.errors.generic",
            ),
          );
        },
      },
    );
  }

  return (
    <form className="grid gap-4" onSubmit={submit} noValidate>
      <FormField
        label={t("employeeMaster.profile.manager.selectLabel")}
        id="manager-select"
      >
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger>
            <SelectValue
              placeholder={t(
                "employeeMaster.profile.manager.selectPlaceholder",
              )}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_MANAGER}>
              {t("employeeMaster.profile.manager.none")}
            </SelectItem>
            {candidates.map((row) => (
              <SelectItem key={row.id} value={row.id}>
                {t("employeeMaster.profile.manager.optionLabel", {
                  name: row.fullName,
                  employeeNo: row.employeeNo,
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <FormField
        label={t("employeeMaster.profile.manager.reasonLabel")}
        id="manager-reason"
        hint={t("employeeMaster.profile.manager.reasonHint")}
      >
        <Input
          id="manager-reason"
          autoComplete="off"
          maxLength={REASON_MAX}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </FormField>
      {formError && (
        <p className="text-sm leading-5 font-medium text-danger" role="alert">
          {formError}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={change.isPending} disabled={unchanged}>
          {t("employeeMaster.profile.manager.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
