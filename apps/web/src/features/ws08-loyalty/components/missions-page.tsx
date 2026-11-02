// Missions and stamp cards (/kelola/loyalty/misi; PRD v1.7 §3.20 "Mission":
// behaviour challenges — visit N times a month, try a new menu, come on a
// weekday — that pay points or a voucher, with the digital stamp card as one
// kind). The rule is built from the chosen mission type, so rule.kind always
// matches type as the contract requires.
import * as React from "react";
import { Pencil, Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogContent,
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { formatRupiah } from "@starter/shared/i18n";
import type { Mission, MissionType } from "@starter/shared/crm";
import {
  useCreateMission,
  useMenuItems,
  useMissions,
  useUpdateMission,
} from "../hooks";
import {
  emptyMissionForm,
  formatDateLabel,
  hasErrors,
  missionBody,
  missionFormFrom,
  missionPeriodKey,
  missionPeriodSummary,
  missionRewardSummary,
  missionRuleSummary,
  missionTypeKey,
  rewardKindKey,
  validateMissionForm,
  WEEKDAY_KEYS,
  type MissionField,
  type MissionForm,
  type ValidationErrors,
} from "../lib";

type Editor = { mode: "new" } | { mode: "edit"; mission: Mission };
type ActiveFilter = "all" | "true" | "false";

const MISSION_TYPES: readonly MissionType[] = [
  "visit_count",
  "try_new_item",
  "weekday_visit",
  "stamp_card",
];

function StatusBadge({ active }: { active: boolean }) {
  const t = useT();
  return (
    <Badge tone={active ? "success" : "neutral"}>
      {active ? t("loyalty.missions.active") : t("loyalty.missions.inactive")}
    </Badge>
  );
}

export function MissionsPage() {
  const t = useT();
  const toast = useToast();
  const [filter, setFilter] = React.useState<ActiveFilter>("all");
  const missionsQuery = useMissions(filter === "all" ? undefined : filter);
  const menuItemsQuery = useMenuItems();
  const createMission = useCreateMission();
  const updateMission = useUpdateMission();

  const [search, setSearch] = React.useState("");
  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [form, setForm] = React.useState<MissionForm>(emptyMissionForm);
  const [errors, setErrors] = React.useState<ValidationErrors<MissionField>>(
    {},
  );
  const [saveFailed, setSaveFailed] = React.useState(false);

  const missions = missionsQuery.data?.data ?? [];
  const filtered = missions.filter((mission) =>
    mission.name
      .toLocaleLowerCase("id-ID")
      .includes(search.trim().toLocaleLowerCase("id-ID")),
  );
  const menuItems = menuItemsQuery.data ?? [];

  const ruleLine = (mission: Mission) => {
    const summary = missionRuleSummary(mission.rule, (day) =>
      t(WEEKDAY_KEYS[day] ?? WEEKDAY_KEYS[0]),
    );
    return summary.vars ? t(summary.key, summary.vars) : t(summary.key);
  };
  const rewardLine = (mission: Mission) => {
    const summary = missionRewardSummary(mission.reward, formatRupiah);
    return summary.vars ? t(summary.key, summary.vars) : t(summary.key);
  };
  const periodLine = (mission: Mission) => {
    const summary = missionPeriodSummary(mission.period, formatDateLabel);
    return summary.vars ? t(summary.key, summary.vars) : t(summary.key);
  };

  function openNew() {
    setForm(emptyMissionForm());
    setErrors({});
    setSaveFailed(false);
    setEditor({ mode: "new" });
  }

  function openEdit(mission: Mission) {
    setForm(missionFormFrom(mission));
    setErrors({});
    setSaveFailed(false);
    setEditor({ mode: "edit", mission });
  }

  function set<Field extends MissionField>(
    field: Field,
    value: MissionForm[Field],
  ) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSaveFailed(false);
  }

  function toggleWeekday(day: number, checked: boolean) {
    set(
      "weekdays",
      checked
        ? [...form.weekdays, day].sort((a, b) => a - b)
        : form.weekdays.filter((candidate) => candidate !== day),
    );
  }

  function toggleMenuItem(id: string, checked: boolean) {
    set(
      "menuItemIds",
      checked
        ? [...form.menuItemIds, id]
        : form.menuItemIds.filter((candidate) => candidate !== id),
    );
  }

  function save() {
    const next = validateMissionForm(form);
    setErrors(next);
    if (hasErrors(next)) return;
    const body = missionBody(form);
    const onSuccess = (saved: Mission) => {
      toast({
        title:
          editor?.mode === "edit"
            ? t("loyalty.missions.updatedToast", { name: saved.name })
            : t("loyalty.missions.createdToast", { name: saved.name }),
        tone: "success",
      });
      setEditor(null);
    };
    const onError = () => setSaveFailed(true);
    if (editor?.mode === "edit")
      updateMission.mutate(
        { missionId: editor.mission.id, body },
        { onSuccess, onError },
      );
    else createMission.mutate(body, { onSuccess, onError });
  }

  const pending = createMission.isPending || updateMission.isPending;
  const state = missionsQuery.isPending
    ? "loading"
    : missionsQuery.isError
      ? "error"
      : missions.length === 0
        ? "empty"
        : "ready";

  return (
    <>
      <DataTableShell
        title={t("loyalty.missions.title")}
        description={t("loyalty.missions.description")}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t("loyalty.missions.searchPlaceholder"),
        }}
        actions={
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              value={filter}
              onValueChange={(value) => setFilter(value as ActiveFilter)}
            >
              <SelectTrigger
                aria-label={t("loyalty.missions.filterLabel")}
                className="sm:w-44"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("loyalty.missions.filter.all")}
                </SelectItem>
                <SelectItem value="true">
                  {t("loyalty.missions.filter.active")}
                </SelectItem>
                <SelectItem value="false">
                  {t("loyalty.missions.filter.inactive")}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button type="button" onClick={openNew}>
              <Plus aria-hidden="true" />
              {t("loyalty.missions.add")}
            </Button>
          </div>
        }
        onRetry={() => void missionsQuery.refetch()}
        empty={{
          title: t("loyalty.missions.emptyTitle"),
          description: t("loyalty.missions.emptyHint"),
          action: (
            <Button type="button" variant="outline" onClick={openNew}>
              {t("loyalty.missions.add")}
            </Button>
          ),
        }}
        noResults={filtered.length === 0 && missions.length > 0}
        rowCount={filtered.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("loyalty.missions.columns.name")}</TableHead>
                <TableHead>{t("loyalty.missions.columns.type")}</TableHead>
                <TableHead>{t("loyalty.missions.columns.rule")}</TableHead>
                <TableHead>{t("loyalty.missions.columns.reward")}</TableHead>
                <TableHead>{t("loyalty.missions.columns.period")}</TableHead>
                <TableHead>{t("loyalty.missions.columns.status")}</TableHead>
                <TableHead numeric>
                  {t("loyalty.missions.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((mission) => (
                <TableRow key={mission.id}>
                  <TableCell className="font-medium">{mission.name}</TableCell>
                  <TableCell>
                    <Badge tone="neutral">
                      {t(missionTypeKey(mission.type))}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular text-sm">
                    {ruleLine(mission)}
                  </TableCell>
                  <TableCell className="tabular text-sm">
                    {rewardLine(mission)}
                  </TableCell>
                  <TableCell className="tabular text-sm">
                    {periodLine(mission)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge active={mission.isActive} />
                  </TableCell>
                  <TableCell numeric>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("loyalty.missions.edit", {
                          name: mission.name,
                        })}
                        onClick={() => openEdit(mission)}
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {filtered.map((mission) => (
            <li
              key={mission.id}
              className="grid gap-2 border-b px-card py-3 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-medium">{mission.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {t(missionTypeKey(mission.type))} · {ruleLine(mission)}
                  </span>
                  <span className="tabular text-sm text-muted-foreground">
                    {rewardLine(mission)} · {periodLine(mission)}
                  </span>
                </div>
                <StatusBadge active={mission.isActive} />
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => openEdit(mission)}
                >
                  <Pencil aria-hidden="true" />
                  {t("loyalty.missions.edit", { name: mission.name })}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </DataTableShell>

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => !open && !pending && setEditor(null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === "edit"
                ? t("loyalty.missions.editTitle")
                : t("loyalty.missions.newTitle")}
            </DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("loyalty.missions.fields.name")}
              error={errors.name && t(errors.name)}
              required
              className="sm:col-span-2"
            >
              <Input
                value={form.name}
                onChange={(event) => set("name", event.target.value)}
                autoComplete="off"
              />
            </FormField>

            <FormField
              label={t("loyalty.missions.fields.description")}
              className="sm:col-span-2"
            >
              <Input
                value={form.description}
                onChange={(event) => set("description", event.target.value)}
                autoComplete="off"
              />
            </FormField>

            <FormField
              id="mission-type"
              label={t("loyalty.missions.fields.type")}
              required
              className="sm:col-span-2"
            >
              <Select
                value={form.type}
                onValueChange={(value) => set("type", value as MissionType)}
              >
                <SelectTrigger id="mission-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MISSION_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(missionTypeKey(type))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            {form.type === "visit_count" && (
              <FormField
                label={t("loyalty.missions.fields.targetVisits")}
                error={errors.targetVisits && t(errors.targetVisits)}
                required
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={form.targetVisits}
                  onChange={(event) => set("targetVisits", event.target.value)}
                />
              </FormField>
            )}

            {form.type === "try_new_item" && (
              <>
                <FormField
                  label={t("loyalty.missions.fields.targetItems")}
                  hint={t("loyalty.missions.fields.targetItemsHint")}
                  error={errors.targetItems && t(errors.targetItems)}
                  required
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={form.targetItems}
                    onChange={(event) => set("targetItems", event.target.value)}
                  />
                </FormField>
                <fieldset className="grid gap-2 sm:col-span-2">
                  <legend className="text-sm leading-5 font-semibold">
                    {t("loyalty.missions.fields.menuChoices")}
                  </legend>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("loyalty.missions.fields.menuChoicesHint")}
                  </p>
                  <div className="grid max-h-48 gap-2 overflow-y-auto rounded-lg border-(length:--border-w) p-3 sm:grid-cols-2">
                    {menuItems.map((item) => (
                      <div key={item.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`mission-item-${item.id}`}
                          checked={form.menuItemIds.includes(item.id)}
                          onCheckedChange={(checked) =>
                            toggleMenuItem(item.id, checked === true)
                          }
                        />
                        <Label
                          htmlFor={`mission-item-${item.id}`}
                          className="truncate font-normal"
                        >
                          {item.name}
                        </Label>
                      </div>
                    ))}
                  </div>
                </fieldset>
              </>
            )}

            {form.type === "weekday_visit" && (
              <>
                <FormField
                  label={t("loyalty.missions.fields.targetVisits")}
                  error={errors.targetVisits && t(errors.targetVisits)}
                  required
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={form.targetVisits}
                    onChange={(event) =>
                      set("targetVisits", event.target.value)
                    }
                  />
                </FormField>
                <fieldset className="grid gap-2 sm:col-span-2">
                  <legend className="text-sm leading-5 font-semibold">
                    {t("loyalty.missions.fields.weekdays")}
                  </legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg border-(length:--border-w) p-3">
                    {WEEKDAY_KEYS.map((key, day) => (
                      <div key={key} className="flex items-center gap-2">
                        <Checkbox
                          id={`mission-day-${day}`}
                          checked={form.weekdays.includes(day)}
                          onCheckedChange={(checked) =>
                            toggleWeekday(day, checked === true)
                          }
                        />
                        <Label
                          htmlFor={`mission-day-${day}`}
                          className="font-normal"
                        >
                          {t(key)}
                        </Label>
                      </div>
                    ))}
                  </div>
                  {errors.weekdays && (
                    <p role="alert" className="text-sm leading-5 text-danger">
                      {t(errors.weekdays)}
                    </p>
                  )}
                </fieldset>
              </>
            )}

            {form.type === "stamp_card" && (
              <FormField
                label={t("loyalty.missions.fields.stamps")}
                hint={t("loyalty.missions.stampsHint")}
                error={errors.stamps && t(errors.stamps)}
                required
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={form.stamps}
                  onChange={(event) => set("stamps", event.target.value)}
                />
              </FormField>
            )}

            <FormField
              id="mission-reward-kind"
              label={t("loyalty.missions.fields.rewardKind")}
              required
            >
              <Select
                value={form.rewardKind}
                onValueChange={(value) =>
                  set("rewardKind", value as MissionForm["rewardKind"])
                }
              >
                <SelectTrigger id="mission-reward-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["points", "voucher"] as const).map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(rewardKindKey(kind))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            {form.rewardKind === "points" ? (
              <FormField
                label={t("loyalty.missions.fields.pointsReward")}
                error={errors.points && t(errors.points)}
                required
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={form.points}
                  onChange={(event) => set("points", event.target.value)}
                />
              </FormField>
            ) : (
              <>
                <FormField
                  label={t("loyalty.missions.fields.voucherValue")}
                  error={errors.voucherValue && t(errors.voucherValue)}
                  required
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={form.voucherValue}
                    onChange={(event) =>
                      set("voucherValue", event.target.value)
                    }
                  />
                </FormField>
                <FormField
                  label={t("loyalty.missions.fields.voucherValidDays")}
                  error={errors.voucherValidDays && t(errors.voucherValidDays)}
                  required
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={365}
                    value={form.voucherValidDays}
                    onChange={(event) =>
                      set("voucherValidDays", event.target.value)
                    }
                  />
                </FormField>
              </>
            )}

            <FormField
              id="mission-period"
              label={t("loyalty.missions.fields.period")}
              required
            >
              <Select
                value={form.period}
                onValueChange={(value) =>
                  set("period", value as MissionForm["period"])
                }
              >
                <SelectTrigger id="mission-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["monthly", "weekly", "date_range"] as const).map(
                    (period) => (
                      <SelectItem key={period} value={period}>
                        {t(missionPeriodKey(period))}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </FormField>

            {form.period === "date_range" && (
              <>
                <FormField
                  label={t("loyalty.missions.fields.periodStart")}
                  error={errors.periodStart && t(errors.periodStart)}
                  required
                >
                  <Input
                    type="date"
                    value={form.periodStart}
                    onChange={(event) => set("periodStart", event.target.value)}
                  />
                </FormField>
                <FormField
                  label={t("loyalty.missions.fields.periodEnd")}
                  error={errors.periodEnd && t(errors.periodEnd)}
                  required
                >
                  <Input
                    type="date"
                    value={form.periodEnd}
                    onChange={(event) => set("periodEnd", event.target.value)}
                  />
                </FormField>
              </>
            )}

            <div className="flex items-start justify-between gap-4 rounded-lg border-(length:--border-w) p-3 sm:col-span-2">
              <div className="grid gap-0.5">
                <Label htmlFor="mission-active">
                  {t("loyalty.missions.fields.isActive")}
                </Label>
              </div>
              <Switch
                id="mission-active"
                checked={form.isActive}
                onCheckedChange={(checked) => set("isActive", checked)}
              />
            </div>
          </div>

          {saveFailed && (
            <p role="alert" className="text-sm leading-5 text-danger">
              {t("loyalty.missions.saveFailed")}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditor(null)}
              disabled={pending}
            >
              {t("common.cancel")}
            </Button>
            <Button type="button" loading={pending} onClick={save}>
              {t("loyalty.missions.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
