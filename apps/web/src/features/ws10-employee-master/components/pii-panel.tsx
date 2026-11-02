// HR-03 panel: masked personal data from the guarded endpoint. Raw values are
// write-only, so the panel only ever renders `masked` forms and refetches after
// an edit; a visitor without `hr.employee.view` never reaches this component
// (the profile shows its locked state instead).
import * as React from "react";
import { Pencil } from "lucide-react";
import type { Employee } from "@starter/shared/hris";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useEmployeePii } from "../hooks";
import { PII_FIELD_LABEL, PII_FIELDS } from "./pii-fields";
import { PiiEditDialog } from "./pii-edit-dialog";

export function EmployeePiiPanel({ employee }: { employee: Employee }) {
  const t = useT();
  const piiQuery = useEmployeePii(employee.id, true);
  const [editing, setEditing] = React.useState(false);

  const pending = piiQuery.isPending;
  const failed = piiQuery.isError;
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
          {!pending && !failed && (
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

      {!failed && (
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
