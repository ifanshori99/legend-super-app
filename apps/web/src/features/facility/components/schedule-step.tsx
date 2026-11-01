// Step 2: area and time (PRD §3 F22 "Pemesanan", alur S langkah 3). The guest
// picks the area (recorded on the ticket only, FAC-09), then "masuk sekarang"
// with the wait estimate, or a slot; when no unit is free the wait queue is the
// way in. FAC-06: units that are dirty or under maintenance are shown as
// blocked and never offered.
import { CalendarClock, Clock, Users } from "lucide-react";
import type {
  FacilityAvailability,
  FacilityQueueEntry,
} from "@starter/shared/facility";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "cn";
import {
  availableSlots,
  blockedUnits,
  enterNowAvailable,
  findArea,
  formatClock,
  slotCleaningMinutes,
  slotSessionMinutes,
  type BookingDraft,
} from "../flow";
import { LoadingCard, Section, ApiFailure } from "./shared";

export function ScheduleStep({
  availability,
  dayOffset,
  onDayChange,
  draft,
  onDraftChange,
  queueEntry,
  onJoinQueue,
  onLeaveQueue,
  queuePending,
  queueError,
  onContinue,
}: {
  availability: {
    data: FacilityAvailability | undefined;
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => void;
  };
  dayOffset: 0 | 1;
  onDayChange: (offset: 0 | 1) => void;
  draft: BookingDraft;
  onDraftChange: (draft: BookingDraft) => void;
  queueEntry: FacilityQueueEntry | null | undefined;
  onJoinQueue: (areaId: string) => void;
  onLeaveQueue: (entryId: string) => void;
  queuePending: boolean;
  queueError: unknown;
  onContinue: () => void;
}) {
  const t = useT();
  const data = availability.data;
  const area = findArea(data, draft.areaId);
  const timingKind = draft.timing?.kind ?? null;

  if (availability.isPending) return <LoadingCard lines={5} />;
  if (availability.isError)
    return (
      <ErrorState
        onRetry={() => availability.refetch()}
        description={t("state.errorHint")}
      />
    );
  if (!data || data.areas.length === 0)
    return (
      <EmptyState
        icon={CalendarClock}
        title={t("facility.schedule.noAreas")}
        description={t("facility.schedule.noAreasHint")}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => availability.refetch()}
          >
            {t("common.retry")}
          </Button>
        }
      />
    );

  const slots = availableSlots(data, draft.areaId);
  const firstSlot = area?.units[0]?.slots[0];
  const nowAvailable = area ? enterNowAvailable(area) : false;
  const blocked = area ? blockedUnits(area).length : 0;
  const waitNow = data.waitEstimate.estimatedWaitMinutes === 0;

  function setTiming(kind: string) {
    if (kind === "now") {
      onDraftChange({ ...draft, timing: { kind: "now" } });
      return;
    }
    const first = slots[0];
    onDraftChange({
      ...draft,
      timing: first ? { kind: "slot", startsAt: first.startsAt } : null,
    });
  }

  return (
    <div className="grid gap-5">
      <h2 className="text-xl leading-7 font-semibold">
        {t("facility.schedule.title")}
      </h2>

      <Section title={t("facility.schedule.dayLabel")}>
        <SegmentedControl
          label={t("facility.schedule.dayLabel")}
          value={String(dayOffset)}
          onValueChange={(value) => onDayChange(value === "1" ? 1 : 0)}
          options={[
            { value: "0", label: t("facility.schedule.dayToday") },
            { value: "1", label: t("facility.schedule.dayTomorrow") },
          ]}
        />
      </Section>

      <Section title={t("facility.schedule.areaLabel")}>
        <SegmentedControl
          label={t("facility.schedule.areaLabel")}
          value={draft.areaId ?? ""}
          onValueChange={(areaId) =>
            onDraftChange({ ...draft, areaId, timing: null })
          }
          options={data.areas.map((item) => ({
            value: item.areaId,
            label: item.name,
          }))}
        />
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facility.schedule.areaHint")}
        </p>
      </Section>

      {queueEntry ? (
        <Section title={t("facility.schedule.joinedTitle")}>
          <div className="grid gap-2 rounded-xl border-(length:--border-w) bg-card p-card">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">
                {t("facility.schedule.joinedTitle")}
              </p>
              <Badge tone="info">
                {t(`facility.schedule.queueStatus.${queueEntry.status}`)}
              </Badge>
            </div>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("facility.schedule.joinedBody")}
            </p>
            <p className="text-sm leading-5 text-muted-foreground tabular">
              {t("facility.schedule.joinedAt", {
                time: formatClock(queueEntry.joinedAt),
              })}
            </p>
            <Button
              variant="outline"
              onClick={() => onLeaveQueue(queueEntry.id)}
              loading={queuePending}
            >
              {t("facility.schedule.leaveQueue")}
            </Button>
            {queueError !== null && <ApiFailure error={queueError} />}
          </div>
        </Section>
      ) : (
        <>
          <Section title={t("facility.schedule.timingLabel")}>
            <SegmentedControl
              label={t("facility.schedule.timingLabel")}
              value={timingKind ?? ""}
              onValueChange={setTiming}
              options={[
                { value: "now", label: t("facility.schedule.now") },
                { value: "slot", label: t("facility.schedule.slot") },
              ]}
            />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm leading-5 text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Users className="size-4" aria-hidden="true" />
                {t("facility.schedule.queueLength", {
                  count: data.waitEstimate.queueLength,
                })}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Clock className="size-4" aria-hidden="true" />
                {waitNow
                  ? t("facility.schedule.waitEstimateNow")
                  : t("facility.schedule.waitEstimate", {
                      minutes: data.waitEstimate.estimatedWaitMinutes,
                    })}
              </span>
            </div>
          </Section>

          {timingKind === "now" && (
            <div className="grid gap-2 rounded-xl border-(length:--border-w) bg-card p-card">
              <p className="font-semibold">
                {nowAvailable
                  ? t("facility.schedule.nowAvailable", {
                      count:
                        area?.units.filter(
                          (unit) =>
                            unit.bookable && unit.status === "available",
                        ).length ?? 0,
                    })
                  : t("facility.schedule.nowUnavailable")}
              </p>
              {nowAvailable && firstSlot && (
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("facility.schedule.slotHint", {
                    minutes: slotSessionMinutes(firstSlot),
                    cleaning: slotCleaningMinutes(firstSlot),
                  })}
                </p>
              )}
              {!nowAvailable && area && (
                <>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("facility.schedule.blockedHint")}
                  </p>
                  <Button
                    variant="secondary"
                    onClick={() => onJoinQueue(area.areaId)}
                    loading={queuePending}
                  >
                    {t("facility.schedule.joinQueue")}
                  </Button>
                  {queueError !== null && <ApiFailure error={queueError} />}
                </>
              )}
            </div>
          )}

          {timingKind === "slot" && (
            <Section title={t("facility.schedule.slot")}>
              {slots.length === 0 ? (
                <EmptyState
                  icon={CalendarClock}
                  title={t("facility.schedule.noSlots")}
                  description={t("facility.schedule.noSlotsHint")}
                />
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {slots.map((slot) => {
                      const selected =
                        draft.timing?.kind === "slot" &&
                        draft.timing.startsAt === slot.startsAt;
                      return (
                        <button
                          key={slot.startsAt}
                          type="button"
                          aria-pressed={selected}
                          onClick={() =>
                            onDraftChange({
                              ...draft,
                              timing: { kind: "slot", startsAt: slot.startsAt },
                            })
                          }
                          className={cn(
                            "flex h-control items-center justify-center rounded-control border-(length:--border-w) text-sm font-semibold tabular transition-colors duration-(--duration-fast)",
                            selected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-input bg-background hover:bg-accent",
                          )}
                        >
                          {formatClock(slot.startsAt)}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {slots[0] &&
                      t("facility.schedule.slotHint", {
                        minutes: slotSessionMinutes(slots[0]),
                        cleaning: slotCleaningMinutes(slots[0]),
                      })}
                  </p>
                </>
              )}
            </Section>
          )}

          {blocked > 0 && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("facility.schedule.blockedUnits", { count: blocked })}{" "}
              {t("facility.schedule.blockedHint")}
            </p>
          )}
        </>
      )}

      <Button
        size="lg"
        onClick={onContinue}
        disabled={
          !draft.areaId ||
          !draft.timing ||
          (draft.timing.kind === "slot" && draft.timing.startsAt === "")
        }
      >
        {t("common.next")}
      </Button>
    </div>
  );
}
