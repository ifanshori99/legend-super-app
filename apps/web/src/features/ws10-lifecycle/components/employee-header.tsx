// Employee header of an onboarding/offboarding detail screen: who the
// checklist belongs to, their position, org unit, outlet and dates (PRD v1.7
// §3 D26 "Profil Karyawan" / "Kontrak Kerja" as the checklist context).
import { ChevronLeft } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";
import type { OrgUnit, Position } from "@starter/shared/hris";
import type { Employee } from "@starter/shared/hris";
import {
  formatBusinessDate,
  orgUnitName,
  outletName,
  positionName,
} from "../lib.ts";
import { EmployeeStatusPill } from "./task-status.tsx";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="type-eyebrow text-muted-foreground">{label}</dt>
      <dd className="text-(length:--density-text)">{value}</dd>
    </div>
  );
}

export function EmployeeHeader({
  employee,
  positions,
  orgUnits,
  backTo,
  backLabel,
}: {
  employee: Employee;
  positions: readonly Position[];
  orgUnits: readonly OrgUnit[];
  backTo: "/kelola/onboarding" | "/kelola/offboarding";
  backLabel: string;
}) {
  const t = useT();
  return (
    <div className="grid gap-3">
      <Link
        to={backTo}
        className="inline-flex w-fit items-center gap-1 text-sm font-semibold text-primary underline-offset-4 hover:underline"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        {backLabel}
      </Link>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <h2 className="type-title">{employee.fullName}</h2>
            <p className="text-sm text-muted-foreground">
              {t("lifecycle.header.subtitle", {
                position: positionName(positions, employee.positionId),
                nip: employee.employeeNo,
              })}
            </p>
          </div>
          <EmployeeStatusPill status={employee.status} />
        </div>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label={t("lifecycle.common.orgUnit")}
            value={orgUnitName(orgUnits, employee.orgUnitId)}
          />
          <Field
            label={t("lifecycle.common.outlet")}
            value={outletName(employee.homeOutletId)}
          />
          <Field
            label={t("lifecycle.common.joinDate")}
            value={formatBusinessDate(employee.joinDate)}
          />
          <Field
            label={t("lifecycle.common.exitDate")}
            value={
              employee.endDate === null
                ? t("lifecycle.common.noValue")
                : formatBusinessDate(employee.endDate)
            }
          />
        </dl>
      </Card>
    </div>
  );
}
