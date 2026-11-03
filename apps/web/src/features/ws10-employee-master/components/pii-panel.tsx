// HR-03 panel: masked personal data from the guarded endpoint. Raw values are
// write-only, so the panel only ever renders `masked` forms and refetches after
// an edit; a visitor without `hr.employee.view` never reaches this component
// (the profile shows its locked state instead). A role that holds
// `hr.employee.view` but whose viewer kind sees none of the PII classes (owner,
// GM, outlet manager: pii.ts HRIS_PII_VISIBILITY) gets 403 from the API and a
// restricted note here; a field the role may not see arrives as null. Editing
// needs `hr.employee.manage`.
import * as React from "react";
import { Lock, Pencil } from "lucide-react";
import type { Employee } from "@starter/shared/hris";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors";
import { useEmployeePii } from "../hooks";
import { PII_FIELD_LABEL, PII_FIELDS } from "./pii-fields";
import { PiiEditDialog } from "./pii-edit-dialog";

export function EmployeePiiPanel({
  employee,
  canEdit,
}: {
  employee: Employee;
  /** `hr.employee.manage`; the API re-checks it on the write. */
  canEdit: boolean;
}) {
  const t = useT();
  const piiQuery = useEmployeePii(employee.id, true);
  const [editing, setEditing] = React.useState(false);

  const pending = piiQuery.isPending;
  const restricted =
    piiQuery.error instanceof ApiError && piiQuery.error.status === 403;
  const failed = piiQuery.isError && !restricted;
  const pii = piiQuery.data?.data;

  return (
    <CardShell aria-labelledby="pii-title">
      <CardShellBody className="gap-3 p-card">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 id="pii-title" className="type-heading">
              {t("employeeMaster.profile.pii.title")}
            </h3>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("employeeMaster.profile.pii.hint")}
            </p>
          </div>
          {canEdit && !pending && !failed && !restricted && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              <Pencil aria-hidden="true" />
              {t("employeeMaster.profile.pii.edit")}
            </Button>
          )}
        </div>

        {pending ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <span className="sr-only">{t("common.loading")}</span>
            {PII_FIELDS.map((field) => (
              <div key={field} className="grid gap-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-5 w-32" />
              </div>
            ))}
          </div>
        ) : restricted ? (
          <div className="flex items-start gap-2 text-sm leading-5 text-muted-foreground">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>{t("employeeMaster.profile.pii.restricted")}</p>
          </div>
        ) : failed ? (
          <ErrorState onRetry={() => void piiQuery.refetch()} />
        ) : (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {PII_FIELDS.map((field) => (
              <PiiValue
                key={field}
                label={t(PII_FIELD_LABEL[field])}
                value={pii?.[field]?.masked ?? null}
                emptyLabel={t("employeeMaster.profile.pii.emptyValue")}
              />
            ))}
          </dl>
        )}
      </CardShellBody>

      {canEdit && !failed && !restricted && (
        <PiiEditDialog
          employee={employee}
          open={editing}
          onOpenChange={setEditing}
        />
      )}
    </CardShell>
  );
}

function PiiValue({
  label,
  value,
  emptyLabel,
}: {
  label: string;
  value: string | null;
  emptyLabel: string;
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs leading-4 text-muted-foreground">{label}</dt>
      <dd
        className={
          value === null
            ? "text-sm leading-5 text-muted-foreground"
            : "text-sm leading-5 font-medium tabular"
        }
      >
        {value ?? emptyLabel}
      </dd>
    </div>
  );
}
