// One booth on the staff status board. The tile surface follows the unit state
// (DESIGN.md §4 "Operations": Q25/Q27 — occupied = warm grey, urgent = 2px
// border + 6px start rule, cleaning = dashed, maintenance = muted), and the
// FAC-06 bookable rule is visible as text, not only as a colour.
import * as React from "react";
import { cn } from "cn";
import {
  CircleCheck,
  CircleSlash,
  Clock,
  SprayCan,
  Wrench,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  isUnitBookable,
  type Facility,
  type FacilityUnitBoardRow,
} from "@starter/shared/facility";
import {
  UNIT_STATUS_META,
  UNIT_TILE_LOOK,
  clock,
  nextAvailableAt,
  remainingMinutes,
} from "../view.ts";

export function UnitTile({
  row,
  areaName,
  facility,
  timeZone,
  serverTime,
  busy,
  onMarkCleaning,
  onFlagMaintenance,
  onReleaseMaintenance,
}: {
  row: FacilityUnitBoardRow;
  areaName: string;
  facility: Facility;
  timeZone: string;
  serverTime: string;
  busy: boolean;
  onMarkCleaning: () => void;
  onFlagMaintenance: () => void;
  onReleaseMaintenance: () => void;
}) {
  const t = useT();
  const headingId = React.useId();
  const inUseHintId = React.useId();
  const { unit } = row;
  const meta = UNIT_STATUS_META[unit.status];
  const look = UNIT_TILE_LOOK[unit.status];
  // FAC-06: the contract's unit machine decides bookability, never the tile.
  const bookable = isUnitBookable(unit.status);
  const session = row.currentTicket;
  const task = row.cleaningTask;

  return (
    <article
      data-slot="facility-unit"
      data-unit-code={unit.code}
      data-unit-status={unit.status}
      data-bookable={bookable ? "true" : "false"}
      aria-labelledby={headingId}
      className={cn(
        "flex flex-col gap-3 rounded-container p-card text-foreground",
        look.surface,
        look.muted && "text-muted-foreground",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h3
            id={headingId}
            className="text-3xl leading-9 font-semibold tracking-tight tabular"
          >
            {unit.code}
          </h3>
          <p className="text-sm text-muted-foreground">{areaName}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <StatusPill
            status={meta.tone}
            solid={unit.status === "needs_cleaning"}
            className="text-sm"
          >
            {t(meta.labelKey)}
          </StatusPill>
          <Badge tone={bookable ? "success" : "danger"} data-slot="bookable">
            {bookable ? (
              <CircleCheck aria-hidden="true" />
            ) : (
              <CircleSlash aria-hidden="true" />
            )}
            {t(
              bookable
                ? "facilityStaff.board.bookableYes"
                : "facilityStaff.board.bookableNo",
            )}
          </Badge>
        </div>
      </div>

      {session && (
        <div className="grid gap-0.5 text-sm">
          <p className="flex items-center gap-1.5 tabular">
            <Clock className="size-4 shrink-0" aria-hidden="true" />
            {t("facilityStaff.board.session", {
              start: clock(session.startedAt, timeZone),
              end: clock(session.scheduledEndsAt, timeZone),
            })}
          </p>
          <p className="text-muted-foreground tabular">
            {t("facilityStaff.board.remaining", {
              minutes: remainingMinutes(session.scheduledEndsAt, serverTime),
            })}
            <span aria-hidden="true"> · </span>
            {t("facilityStaff.board.nextAvailable", {
              time: clock(
                nextAvailableAt(
                  session.scheduledEndsAt,
                  facility.cleaningMinutes,
                ),
                timeZone,
              ),
            })}
          </p>
        </div>
      )}

      {unit.status === "needs_cleaning" && (
        <p className="text-sm text-muted-foreground tabular">
          {task
            ? t("facilityStaff.board.waitingSince", {
                time: clock(task.createdAt, timeZone),
              })
            : t("facilityStaff.board.waitingNoTask")}
        </p>
      )}

      {unit.status === "cleaning" && task?.startedAt && (
        <p className="text-sm text-muted-foreground tabular">
          {t("facilityStaff.board.cleaningStarted", {
            time: clock(task.startedAt, timeZone),
          })}
        </p>
      )}

      {unit.status === "maintenance" && (
        <p className="text-sm text-muted-foreground">
          {t("facilityStaff.board.maintenanceHint")}
        </p>
      )}

      {unit.status === "in_use" && (
        <p id={inUseHintId} className="text-sm text-muted-foreground">
          {t("facilityStaff.board.inUseHint")}
        </p>
      )}

      <div className="mt-auto flex flex-wrap gap-2">
        {(unit.status === "available" ||
          (unit.status === "needs_cleaning" && !task)) && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={onMarkCleaning}
          >
            <SprayCan aria-hidden="true" />
            {t("facilityStaff.board.action.markCleaning")}
          </Button>
        )}

        {(unit.status === "needs_cleaning" || unit.status === "cleaning") &&
          task && (
            <Button asChild variant="secondary" size="sm">
              <Link
                to="/fasilitas/kebersihan"
                search={{ facilityId: unit.facilityId, taskId: task.id }}
              >
                <SprayCan aria-hidden="true" />
                {t("facilityStaff.board.action.finishCleaning")}
              </Link>
            </Button>
          )}

        {unit.status === "in_use" && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled
            aria-describedby={inUseHintId}
          >
            <SprayCan aria-hidden="true" />
            {t("facilityStaff.board.action.markCleaning")}
          </Button>
        )}

        {unit.status !== "maintenance" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={busy}
            onClick={onFlagMaintenance}
          >
            <Wrench aria-hidden="true" />
            {t("facilityStaff.board.action.flagMaintenance")}
          </Button>
        )}

        {unit.status === "maintenance" && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={onReleaseMaintenance}
          >
            <Wrench aria-hidden="true" />
            {t("facilityStaff.board.action.releaseMaintenance")}
          </Button>
        )}
      </div>

      {unit.status === "maintenance" && (
        <p className="text-sm text-muted-foreground">
          {t("facilityStaff.board.releaseHint")}
        </p>
      )}
    </article>
  );
}
