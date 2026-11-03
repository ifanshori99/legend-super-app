import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PayrollConfigPage } from "@/features/ws10-payroll-config/components/payroll-config-page";
import { ComponentsTab } from "@/features/ws10-payroll-config/components/components-tab";
import { PoliciesTab } from "@/features/ws10-payroll-config/components/policies-tab";
import { StatutoryTab } from "@/features/ws10-payroll-config/components/statutory-tab";
import { ThrTab } from "@/features/ws10-payroll-config/components/thr-tab";
import {
  PAYROLL_VIEW_PERMISSION,
  payrollConfigAccess,
  payrollConfigGuard,
} from "@/features/ws10-payroll-config/guard";
import {
  payComponentsDefaultQuery,
  payrollPoliciesDefaultQuery,
  statutoryTablesDefaultQuery,
  thrSchedulesDefaultQuery,
} from "@/features/ws10-payroll-config/queries";
import { API_MOCK } from "@/lib/api/mock-flag";

// /kelola/payroll/pengaturan — payroll configuration (PRD v1.7 §3 F30,
// PAYR-02): policies and cycles, pay components, versioned BPJS/PTKP/TER
// tables, the overtime formula and THR schedules. One route; the section is a
// validated ?tab= search param so links and reloads keep it.
export const Route = createFileRoute("/_kelola/kelola/payroll/pengaturan")({
  validateSearch: z.object({
    tab: z
      .enum(["policies", "components", "statutory", "thr"])
      .catch("policies"),
  }),
  beforeLoad: payrollConfigGuard([PAYROLL_VIEW_PERMISSION]),
  loader: ({ context }) =>
    API_MOCK
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(statutoryTablesDefaultQuery()),
          context.queryClient.ensureQueryData(payrollPoliciesDefaultQuery()),
          context.queryClient.ensureQueryData(payComponentsDefaultQuery()),
          context.queryClient.ensureQueryData(thrSchedulesDefaultQuery()),
        ]),
  component: PayrollConfigScreen,
});

function PayrollConfigScreen() {
  const { tab } = Route.useSearch();
  const { access } = Route.useRouteContext();
  const { canRun } = payrollConfigAccess(access);
  // The management topbar owns the h1 (DESIGN.md v3 §5); the shared frame adds
  // the tab strip and each tab renders its own section heading.
  return (
    <PayrollConfigPage active={tab} canRun={canRun}>
      {tab === "policies" && <PoliciesTab canRun={canRun} />}
      {tab === "components" && <ComponentsTab canRun={canRun} />}
      {tab === "statutory" && <StatutoryTab canRun={canRun} />}
      {tab === "thr" && <ThrTab canRun={canRun} />}
    </PayrollConfigPage>
  );
}
