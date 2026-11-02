// Capacity rule editor (PRD §3 F12 "Order Pacing"): the whole rule list of one
// station is replaced in one call, so the dialog edits every window together.
// Rules are validated here with the same limits the contract enforces, and the
// form keeps the user's text until it is valid.
import * as React from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import type { CapacityRule, CapacityRuleInput } from "@starter/shared/kitchen";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CAPACITY_CHANNELS,
  CAPACITY_WINDOWS,
  DAY_NUMBERS,
  defaultRuleDraft,
  draftProblem,
  draftsToRuleInputs,
  moveChannel,
  rulesToDrafts,
  type CapacityChannel,
  type DraftProblem,
  type RuleDraft,
} from "../lib.ts";

const PROBLEM_KEY: Record<DraftProblem, MessageKey> = {
  capacity: "kitchenConfig.capacity.dialog.problemCapacity",
  near: "kitchenConfig.capacity.dialog.problemNear",
  schedules: "kitchenConfig.capacity.dialog.problemSchedules",
  days: "kitchenConfig.capacity.dialog.problemDays",
  time: "kitchenConfig.capacity.dialog.problemTime",
  channels: "kitchenConfig.capacity.dialog.problemChannels",
};

export function CapacityRuleEditor({
  stationName,
  rules,
  pending,
  saveError,
  onSave,
  onCancel,
}: {
  stationName: string;
  rules: readonly CapacityRule[];
  pending: boolean;
  saveError: string | null;
  onSave: (rules: CapacityRuleInput[]) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [drafts, setDrafts] = React.useState<RuleDraft[]>(() =>
    rules.length > 0 ? rulesToDrafts(rules) : [defaultRuleDraft()],
  );
  const [problem, setProblem] = React.useState<DraftProblem | null>(null);
  const idPrefix = React.useId();

  function updateDraft(index: number, next: RuleDraft) {
    setDrafts((current) =>
      current.map((draft, position) => (position === index ? next : draft)),
    );
  }

  function updateSchedule(
    ruleIndex: number,
    scheduleIndex: number,
    patch: Partial<RuleDraft["schedules"][number]>,
  ) {
    setDrafts((current) =>
      current.map((draft, position) =>
        position === ruleIndex
          ? {
              ...draft,
              schedules: draft.schedules.map((schedule, entry) =>
                entry === scheduleIndex ? { ...schedule, ...patch } : schedule,
              ),
            }
          : draft,
      ),
    );
  }

  function toggleDay(ruleIndex: number, scheduleIndex: number, day: number) {
    const schedule = drafts[ruleIndex].schedules[scheduleIndex];
    const daysOfWeek = schedule.daysOfWeek.includes(day)
      ? schedule.daysOfWeek.filter((value) => value !== day)
      : [...schedule.daysOfWeek, day];
    updateSchedule(ruleIndex, scheduleIndex, { daysOfWeek });
  }

  function toggleChannel(ruleIndex: number, channel: CapacityChannel) {
    const draft = drafts[ruleIndex];
    const selected = draft.channelPriority.includes(channel);
    updateDraft(ruleIndex, {
      ...draft,
      channelPriority: selected
        ? draft.channelPriority.filter((value) => value !== channel)
        : [...draft.channelPriority, channel],
    });
  }

  function save() {
    for (const draft of drafts) {
      const nextProblem = draftProblem(draft);
      if (nextProblem !== null) {
        setProblem(nextProblem);
        return;
      }
    }
    const input = draftsToRuleInputs(drafts);
    if (input === null) {
      setProblem("capacity");
      return;
    }
    setProblem(null);
    onSave(input);
  }

  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>
          {t("kitchenConfig.capacity.dialog.title", { station: stationName })}
        </DialogTitle>
        <DialogDescription>
          {t("kitchenConfig.capacity.dialog.hint")}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4">
        {drafts.map((draft, ruleIndex) => {
          const ruleId = `${idPrefix}-${ruleIndex}`;
          return (
            <fieldset
              key={ruleId}
              aria-label={`${t("kitchenConfig.capacity.rulesTitle")} ${ruleIndex + 1}`}
              className="grid min-w-0 gap-3 rounded-container border-(length:--border-w) p-card"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">
                  {t("kitchenConfig.capacity.rulesTitle")} {ruleIndex + 1}
                </p>
                {drafts.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setDrafts((current) =>
                        current.filter((_, position) => position !== ruleIndex),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" />
                    {t("kitchenConfig.capacity.dialog.removeRule")}
                  </Button>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <FormField
                  label={t("kitchenConfig.capacity.dialog.window")}
                  hint={t("kitchenConfig.capacity.dialog.windowHint")}
                  required
                >
                  <Select
                    value={String(draft.windowMinutes)}
                    onValueChange={(value) =>
                      updateDraft(ruleIndex, {
                        ...draft,
                        windowMinutes: Number(value),
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CAPACITY_WINDOWS.map((minutes) => (
                        <SelectItem key={minutes} value={String(minutes)}>
                          {t("kitchenConfig.capacity.ruleWindow", { minutes })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField
                  label={t("kitchenConfig.capacity.dialog.capacity")}
                  hint={t("kitchenConfig.capacity.dialog.capacityHint")}
                  required
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={10_000}
                    step={1}
                    value={draft.capacityPoints}
                    onChange={(event) =>
                      updateDraft(ruleIndex, {
                        ...draft,
                        capacityPoints: event.target.value,
                      })
                    }
                  />
                </FormField>
                <FormField
                  label={t("kitchenConfig.capacity.dialog.near")}
                  hint={t("kitchenConfig.capacity.dialog.nearHint")}
                  required
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={100}
                    step={1}
                    value={draft.nearPercent}
                    onChange={(event) =>
                      updateDraft(ruleIndex, {
                        ...draft,
                        nearPercent: event.target.value,
                      })
                    }
                  />
                </FormField>
              </div>

              <div className="grid gap-2">
                {draft.schedules.map((schedule, scheduleIndex) => (
                  <div
                    key={`${ruleId}-schedule-${scheduleIndex}`}
                    className="grid gap-2 rounded-container bg-surface-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <fieldset className="grid gap-1.5">
                      <legend className="text-sm font-semibold">
                        {t("kitchenConfig.capacity.dialog.days")}
                      </legend>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {DAY_NUMBERS.map((day) => {
                          const dayId = `${ruleId}-${scheduleIndex}-${day}`;
                          return (
                            <div
                              key={day}
                              className="flex min-h-control-sm items-center gap-1.5"
                            >
                              <Checkbox
                                id={dayId}
                                checked={schedule.daysOfWeek.includes(day)}
                                onCheckedChange={() =>
                                  toggleDay(ruleIndex, scheduleIndex, day)
                                }
                              />
                              <Label htmlFor={dayId} className="text-sm">
                                {t(
                                  `kitchenConfig.capacity.dialog.dayShort.${day}` as MessageKey,
                                )}
                              </Label>
                            </div>
                          );
                        })}
                      </div>
                    </fieldset>
                    <div className="flex flex-wrap items-end gap-2">
                      <FormField
                        label={t("kitchenConfig.capacity.dialog.start")}
                        required
                      >
                        <Input
                          type="time"
                          value={schedule.start}
                          onChange={(event) =>
                            updateSchedule(ruleIndex, scheduleIndex, {
                              start: event.target.value,
                            })
                          }
                        />
                      </FormField>
                      <FormField
                        label={t("kitchenConfig.capacity.dialog.end")}
                        required
                      >
                        <Input
                          type="time"
                          value={schedule.end}
                          onChange={(event) =>
                            updateSchedule(ruleIndex, scheduleIndex, {
                              end: event.target.value,
                            })
                          }
                        />
                      </FormField>
                      {draft.schedules.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t(
                            "kitchenConfig.capacity.dialog.removeSchedule",
                          )}
                          onClick={() =>
                            updateDraft(ruleIndex, {
                              ...draft,
                              schedules: draft.schedules.filter(
                                (_, entry) => entry !== scheduleIndex,
                              ),
                            })
                          }
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  onClick={() =>
                    updateDraft(ruleIndex, {
                      ...draft,
                      schedules: [
                        ...draft.schedules,
                        {
                          daysOfWeek: [...DAY_NUMBERS],
                          start: "08:00",
                          end: "22:00",
                        },
                      ],
                    })
                  }
                >
                  <Plus aria-hidden="true" />
                  {t("kitchenConfig.capacity.dialog.addSchedule")}
                </Button>
              </div>

              <fieldset className="grid gap-2">
                <legend className="text-sm font-semibold">
                  {t("kitchenConfig.capacity.dialog.channels")}
                </legend>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("kitchenConfig.capacity.dialog.channelsHint")}
                </p>
                <ul className="grid gap-1">
                  {CAPACITY_CHANNELS.map((channel) => {
                    const channelId = `${ruleId}-channel-${channel}`;
                    const selected = draft.channelPriority.indexOf(channel);
                    const label = t(`menu.prices.channels.${channel}`);
                    return (
                      <li
                        key={channel}
                        className="flex min-h-control-sm items-center gap-2"
                      >
                        <Checkbox
                          id={channelId}
                          checked={selected >= 0}
                          onCheckedChange={() =>
                            toggleChannel(ruleIndex, channel)
                          }
                        />
                        <Label
                          htmlFor={channelId}
                          className="flex min-w-0 flex-1 items-center gap-2 text-sm"
                        >
                          <span className="truncate">{label}</span>
                          {selected >= 0 && (
                            <span className="text-xs font-semibold text-muted-foreground tabular">
                              #{selected + 1}
                            </span>
                          )}
                        </Label>
                        {selected >= 0 && (
                          <div className="flex shrink-0 gap-0.5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t(
                                "kitchenConfig.capacity.dialog.moveUp",
                                { channel: label },
                              )}
                              disabled={selected === 0}
                              onClick={() =>
                                updateDraft(ruleIndex, {
                                  ...draft,
                                  channelPriority: moveChannel(
                                    draft.channelPriority,
                                    channel,
                                    -1,
                                  ),
                                })
                              }
                            >
                              <ArrowUp aria-hidden="true" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t(
                                "kitchenConfig.capacity.dialog.moveDown",
                                { channel: label },
                              )}
                              disabled={
                                selected === draft.channelPriority.length - 1
                              }
                              onClick={() =>
                                updateDraft(ruleIndex, {
                                  ...draft,
                                  channelPriority: moveChannel(
                                    draft.channelPriority,
                                    channel,
                                    1,
                                  ),
                                })
                              }
                            >
                              <ArrowDown aria-hidden="true" />
                            </Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            </fieldset>
          );
        })}

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() =>
            setDrafts((current) => [...current, defaultRuleDraft()])
          }
        >
          <Plus aria-hidden="true" />
          {t("kitchenConfig.capacity.dialog.addRule")}
        </Button>

        <div aria-live="polite">
          {(problem !== null || saveError !== null) && (
            <p className="text-sm leading-5 font-medium text-danger">
              {saveError ?? (problem ? t(PROBLEM_KEY[problem]) : null)}
            </p>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          {t("kitchenConfig.capacity.dialog.cancel")}
        </Button>
        <Button type="button" loading={pending} onClick={save}>
          {t("kitchenConfig.capacity.dialog.save")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
