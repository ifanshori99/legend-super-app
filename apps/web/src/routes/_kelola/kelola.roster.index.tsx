import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { addBusinessDays } from "@starter/shared/hris";
import { RosterPage } from "@/features/ws10-roster/components/roster-page";
import { RosterShell } from "@/features/ws10-roster/components/roster-shell";
import { rosterGuard } from "@/features/ws10-roster/guard";
import {
  isMockScenarioRequest,
  normalizeWeekStart,
} from "@/features/ws10-roster/lib";
import {
  employeesQuery,
  holidaysQuery,
  positionsQuery,
  weekShiftsQuery,
} from "@/features/ws10-roster/queries";

// /kelola/roster — weekly roster calendar (PRD v1.7 §3 Kelompok D 28, F26,
// HR-05). `?week=YYYY-MM-DD` picks the ISO week (any day normalizes to its
// Monday); without it the screen opens on the current outlet week.
export const Route = createFileRoute("/_kelola/kelola/roster/")({
  validateSearch: z.object({
    week: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  }),
  beforeLoad: rosterGuard(["hr.schedule.manage"]),
  loaderDeps: ({ search }) => ({ weekStart: normalizeWeekStart(search.week) }),
  loader: ({ context, deps, location }) => {
    if (isMockScenarioRequest(location.searchStr)) return undefined;
    const weekStart = deps.weekStart;
    return Promise.all([
      context.queryClient.ensureQueryData(employeesQuery()),
      context.queryClient.ensureQueryData(positionsQuery()),
      context.queryClient.ensureQueryData(weekShiftsQuery(weekStart)),
      context.queryClient.ensureQueryData(
        weekShiftsQuery(addBusinessDays(weekStart, -7)),
      ),
      context.queryClient.ensureQueryData(holidaysQuery(weekStart)),
    ]);
  },
  component: RosterScreen,
});

function RosterScreen() {
  const { week } = Route.useSearch();
  return (
    <RosterShell active="roster">
      <RosterPage weekStart={normalizeWeekStart(week)} />
    </RosterShell>
  );
}
