// /kelola/karyawan/$employeeId — one employee's profile (PRD v1.7 §3 F24,
// HR-03): identity and employment facts, the masked PII panel with its
// write-only edit flow, and the contract/document tabs. Tabs are links with a
// search param (`?tab=kontrak|dokumen`) like the inventory pages, so a section
// is linkable and the loader can prefetch it.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Calculator,
  KeyRound,
  Lock,
  UserRoundCog,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api/errors";
import type { MessageKey } from "@starter/shared/i18n";
import {
  useEmployee,
  useEmployees,
  useOrgUnits,
  useOutlets,
  usePositions,
} from "../hooks";
import {
  HRIS_TIME_ZONE,
  employeeName,
  formatBusinessDate,
  orgUnitName,
  outletName,
  positionName,
} from "../lib";
import {
  EMPLOYMENT_TYPE_LABEL,
  EmployeeStatusPill,
  EmploymentTypeBadge,
} from "./employee-status";
import { PtkpCorrectionDialog } from "./ptkp-correction-dialog";
import { PayslipPinResetDialog } from "./payslip-pin-reset-dialog";
import { ManagerChangeDialog } from "./manager-change-dialog";
import { EmployeePiiPanel } from "./pii-panel";
import { EmployeeContracts } from "./profile-contracts";
import { EmployeeDocuments } from "./profile-documents";

export type ProfileTab = "kontrak" | "dokumen";

const TABS: readonly { key: ProfileTab; labelKey: MessageKey }[] = [
  { key: "kontrak", labelKey: "employeeMaster.profile.tabs.contracts" },
  { key: "dokumen", labelKey: "employeeMaster.profile.tabs.documents" },
];

export function EmployeeProfilePage({
  employeeId,
  tab,
  locked,
  canEditPii,
  canResetPin = false,
  canCorrectPtkp = false,
}: {
  employeeId: string;
  tab: ProfileTab;
  /** Payslip PIN reset (bead legend-ilzrj): needs `payroll.run`. */
  canResetPin?: boolean;
  /** Koreksi status PTKP (bead 1223): `hr.employee.manage` + `payroll.run`. */
  canCorrectPtkp?: boolean;
  /** HR-03: `hr.employee.manage` opens the write-only edit flow. */
  canEditPii: boolean;
  /**
   * HR-03: the profile guard refuses employee data without
   * `hr.employee.view`; the screen shows the locked state instead of a 404 so
   * the visitor learns why (page guard in features/ws10-employee-master/guard).
   */
  locked: boolean;
}) {
  if (locked) return <LockedProfile />;
  return (
    <ProfileBody
      employeeId={employeeId}
      tab={tab}
      canEditPii={canEditPii}
      canResetPin={canResetPin}
      canCorrectPtkp={canCorrectPtkp}
    />
  );
}

function LockedProfile() {
  const t = useT();
  return (
    <CardShell aria-labelledby="profile-locked-title">
      <CardShellBody className="items-center gap-3 p-8 text-center">
        <span className="grid size-12 place-items-center rounded-container border-(length:--border-w) bg-shell text-muted-foreground shadow-hairline">
          <Lock className="size-6" aria-hidden="true" />
        </span>
        <Badge tone="warning">
          {t("employeeMaster.profile.pii.lockedBadge")}
        </Badge>
        <h2 id="profile-locked-title" className="type-title">
          {t("employeeMaster.profile.pii.lockedTitle")}
        </h2>
        <p className="max-w-md text-sm leading-5 text-muted-foreground">
          {t("employeeMaster.profile.pii.lockedHint")}
        </p>
      </CardShellBody>
    </CardShell>
  );
}

function ProfileBody({
  employeeId,
  tab,
  canEditPii,
  canResetPin,
  canCorrectPtkp,
}: {
  employeeId: string;
  tab: ProfileTab;
  canEditPii: boolean;
  canResetPin: boolean;
  canCorrectPtkp: boolean;
}) {
  const t = useT();
  const [resetOpen, setResetOpen] = React.useState(false);
  const [ptkpOpen, setPtkpOpen] = React.useState(false);
  const [changingManager, setChangingManager] = React.useState(false);
  const employeeQuery = useEmployee(employeeId);
  const employeesQuery = useEmployees();
  const positionsQuery = usePositions();
  const unitsQuery = useOrgUnits();
  const outletsQuery = useOutlets();

  const employee = employeeQuery.data?.data;
  const canChangeManager = employee?.canChangeManager === true;
  const employees = React.useMemo(
    () => employeesQuery.data?.data ?? [],
    [employeesQuery.data],
  );
  const positions = React.useMemo(
    () => positionsQuery.data?.data ?? [],
    [positionsQuery.data],
  );
  const units = React.useMemo(
    () => unitsQuery.data?.data ?? [],
    [unitsQuery.data],
  );
  const outlets = React.useMemo(
    () => outletsQuery.data?.data ?? [],
    [outletsQuery.data],
  );

  if (employeeQuery.isPending) return <ProfileSkeleton />;

  if (employeeQuery.isError) {
    const missing =
      employeeQuery.error instanceof ApiError &&
      employeeQuery.error.status === 404;
    return (
      <CardShell aria-labelledby="profile-state-title">
        <CardShellBody className="p-card">
          <h2 id="profile-state-title" className="type-title">
            {missing
              ? t("employeeMaster.profile.notFoundTitle")
              : t("employeeMaster.profile.errorTitle")}
          </h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {missing
              ? t("employeeMaster.profile.notFoundHint")
              : t("employeeMaster.profile.errorHint")}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {!missing && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void employeeQuery.refetch()}
              >
                {t("common.retry")}
              </Button>
            )}
            <Button asChild variant="outline" size="sm">
              <Link to="/kelola/karyawan">
                <ArrowLeft aria-hidden="true" />
                {t("employeeMaster.profile.backToDirectory")}
              </Link>
            </Button>
          </div>
        </CardShellBody>
      </CardShell>
    );
  }

  if (!employee) return <ProfileSkeleton />;

  const manager = employeeName(employees, employee.managerId);
  // Contract reminders and document expiry count days in the employee's
  // home-outlet time zone (D-CORE-6), not the browser's.
  const timeZone =
    outlets.find((outlet) => outlet.id === employee.homeOutletId)?.timeZone ??
    HRIS_TIME_ZONE;

  return (
    <div className="grid min-w-0 gap-5">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 className="type-title">
            {t("employeeMaster.profile.sectionTitle")}
          </h2>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("employeeMaster.profile.subtitle")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canCorrectPtkp && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPtkpOpen(true)}
            >
              <Calculator aria-hidden="true" />
              {t("employeeMaster.profile.ptkp.trigger")}
            </Button>
          )}
          {canResetPin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setResetOpen(true)}
            >
              <KeyRound aria-hidden="true" />
              {t("payslipPin.hrReset.trigger")}
            </Button>
          )}
          <Button asChild variant="ghost" size="sm">
            <Link to="/kelola/karyawan">
              <ArrowLeft aria-hidden="true" />
              {t("employeeMaster.profile.backToDirectory")}
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <CardShell aria-labelledby="identity-title">
          <CardShellBody className="gap-4 p-card">
            <div className="grid gap-2">
              <h3 id="identity-title" className="type-heading">
                {t("employeeMaster.profile.identityTitle")}
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xl leading-7 font-semibold">
                  {employee.fullName}
                </p>
                <EmployeeStatusPill status={employee.status} />
                <EmploymentTypeBadge type={employee.employmentType} />
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">
                  {t("employeeMaster.profile.fields.employeeNo")}
                </dt>
                <dd className="tabular">{employee.employeeNo}</dd>
              </dl>
            </div>

            <div className="grid gap-2 border-t pt-4">
              <p className="type-eyebrow text-muted-foreground">
                {t("employeeMaster.profile.employmentTitle")}
              </p>
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <Fact
                  label={t("employeeMaster.profile.fields.position")}
                  value={
                    positionName(positions, employee.positionId) ??
                    t("employeeMaster.profile.notSet")
                  }
                />
                <Fact
                  label={t("employeeMaster.profile.fields.unit")}
                  value={
                    orgUnitName(units, employee.orgUnitId) ??
                    t("employeeMaster.profile.notSet")
                  }
                />
                <Fact
                  label={t("employeeMaster.profile.fields.manager")}
                  value={
                    employee.managerId === null
                      ? t("employeeMaster.profile.noManager")
                      : (manager ?? t("employeeMaster.profile.notSet"))
                  }
                  action={
                    canChangeManager ? (
                      <Button
                        variant="outline"
                        onClick={() => setChangingManager(true)}
                      >
                        <UserRoundCog aria-hidden="true" />
                        {t("employeeMaster.profile.manager.change")}
                      </Button>
                    ) : undefined
                  }
                />
                <Fact
                  label={t("employeeMaster.profile.fields.outlet")}
                  value={
                    outletName(outlets, employee.homeOutletId) ??
                    t("employeeMaster.profile.notSet")
                  }
                />
                <Fact
                  label={t("employeeMaster.profile.fields.employmentType")}
                  value={t(EMPLOYMENT_TYPE_LABEL[employee.employmentType])}
                />
                <Fact
                  label={t("employeeMaster.profile.fields.joinDate")}
                  value={formatBusinessDate(employee.joinDate)}
                />
                <Fact
                  label={t("employeeMaster.profile.fields.endDate")}
                  value={
                    employee.endDate === null
                      ? t("employeeMaster.profile.noEndDate")
                      : formatBusinessDate(employee.endDate)
                  }
                />
                <Fact
                  label={t("employeeMaster.profile.fields.ptkp")}
                  value={
                    employee.ptkpStatus ?? t("employeeMaster.profile.notSet")
                  }
                />
              </dl>
            </div>
          </CardShellBody>
        </CardShell>

        <EmployeePiiPanel employee={employee} canEdit={canEditPii} />
      </div>

      {canChangeManager && (
        <ManagerChangeDialog
          employee={employee}
          open={changingManager}
          onOpenChange={setChangingManager}
        />
      )}

      <nav aria-label={t("employeeMaster.profile.tabsLabel")}>
        <div className={tabsListClass}>
          {TABS.map((item) => {
            const current = item.key === tab;
            return (
              <Link
                key={item.key}
                to="/kelola/karyawan/$employeeId"
                params={{ employeeId }}
                search={{ tab: item.key }}
                aria-current={current ? "page" : undefined}
                className={tabsTriggerClass}
              >
                {t(item.labelKey)}
              </Link>
            );
          })}
        </div>
      </nav>

      {tab === "kontrak" ? (
        <EmployeeContracts employeeId={employeeId} timeZone={timeZone} />
      ) : (
        <EmployeeDocuments employeeId={employeeId} timeZone={timeZone} />
      )}

      {canCorrectPtkp && (
        <PtkpCorrectionDialog
          employee={employee}
          open={ptkpOpen}
          onOpenChange={setPtkpOpen}
        />
      )}

      {canResetPin && (
        <PayslipPinResetDialog
          employee={employee}
          open={resetOpen}
          onOpenChange={setResetOpen}
        />
      )}
    </div>
  );
}

function Fact({
  label,
  value,
  action,
}: {
  label: string;
  value: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs leading-4 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium break-words">{value}</dd>
      {action && <dd className="mt-1">{action}</dd>}
    </div>
  );
}

function ProfileSkeleton() {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-5" aria-busy="true">
      <span className="sr-only">{t("employeeMaster.profile.loading")}</span>
      <div className="grid gap-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {[0, 1].map((card) => (
          <CardShell key={card}>
            <CardShellBody className="gap-3 p-card">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-7 w-48" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </CardShellBody>
          </CardShell>
        ))}
      </div>
      <Skeleton className="h-control w-64" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
