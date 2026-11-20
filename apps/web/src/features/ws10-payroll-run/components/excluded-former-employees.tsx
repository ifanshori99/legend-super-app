// Former employees left out of a run (legend-1220). The simulate, approve and
// lock responses list everyone the run does not pay because they ended in an
// earlier year than the pay date: their last pay has to be settled outside the
// run, so the reviewer must not forget them. The field is optional: an older
// response without it, or an empty list, renders nothing.
import { UserMinus } from "lucide-react";
import type { PayrollRun } from "@starter/shared/hris/payroll";
import { useT } from "@/components/i18n";

// Decided at simulate and reported until the run is locked, like the held
// overtime block next to it.
const VISIBLE_STATUS: ReadonlySet<string> = new Set([
  "simulated",
  "hr_approved",
  "approved",
  "locked",
]);

export function ExcludedFormerEmployees({
  run,
  canViewSalaries,
}: {
  run: PayrollRun;
  canViewSalaries: boolean;
}) {
  const t = useT();
  const excluded = run.excludedFormerEmployees;
  if (!excluded || excluded.length === 0 || !VISIBLE_STATUS.has(run.status))
    return null;

  return (
    <section
      role="status"
      aria-labelledby="excluded-former-title"
      className="grid min-w-0 gap-3 rounded-lg border border-warning/40 bg-warning-subtle p-4"
    >
      <div className="flex items-start gap-3">
        <UserMinus
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-warning"
        />
        <div className="grid min-w-0 gap-1">
          <h2 id="excluded-former-title" className="type-title">
            {t("payrollRun.excluded.title")}
            <span className="ml-2 align-middle text-sm font-normal">
              {t("payrollRun.excluded.count", { count: excluded.length })}
            </span>
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("payrollRun.excluded.description")}
          </p>
        </div>
      </div>
      {canViewSalaries ? (
        <ul className="grid gap-2">
          {excluded.map((item) => (
            <li
              key={item.employeeId}
              className="min-w-0 rounded-md bg-background p-3 text-sm break-words"
            >
              {item.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("payrollRun.excluded.restrictedNote")}
        </p>
      )}
    </section>
  );
}
